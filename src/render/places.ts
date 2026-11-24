// The place queue: machine-wide admission by a fixed number of drawing processes at once, in two lanes, with no memory
// estimates. It is the queue of macOS (see admission.ts). On a machine whose CPU and GPU share one memory the shared
// GPU limits drawing long before memory does, and the operating system's count of free pages leaves out the memory it
// reclaims at once, so a memory floor would hold every request back.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { alive, defaultSlotDir, locked, readJson, writeJson, type RenderLease } from './queue.ts';

/** Long places: the chunk workers of renders and drawing commands of more than `MAX_LIGHT_FRAMES` frames. */
export const DEFAULT_MAC_RENDERS = 4;
/** Short places: drawing commands of at most `MAX_LIGHT_FRAMES` frames. */
export const DEFAULT_MAC_SHORT = 4;
const ADMISSION_POLL_MS = 175;
const PRESSURE_SAMPLE_MS = 500;
/** A file of its own, so that a memory queue's state in the same directory cannot confuse it. */
const STATE_FILE = 'places-queue.json';
const PRESSURE_FILE = 'places-pressure.json';
/** macOS's `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
const NORMAL_PRESSURE = 1;

export type Lane = 'long' | 'short';

export interface PlacesConfig {
  readonly dir: string;
  /** How many long places are held at once. */
  readonly long: number;
  /** How many short places are held at once. */
  readonly short: number;
}

/** The memory pressure macOS reports (1 normal, 2 warn, 4 critical), or null when it cannot be read. */
export type PressureLevel = number | null;

export interface PlaceAsk {
  readonly what: string;
  readonly lane: Lane;
  /** Shown by `skink3 queue`; the place queue does not limit groups. */
  readonly group?: string;
  /** Called when the request starts to wait, and again when the reason it waits for changes. */
  readonly onWait?: (waiting: PlaceWaiting) => void;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  /** An injected pressure reader, for tests. By default macOS's, sampled at most every 500 ms across processes. */
  readonly pressure?: () => PressureLevel;
}

export interface PlaceWaiting {
  readonly queue: 'places';
  /** `lane`: every place of the lane is held or promised to earlier requests; `pressure`: memory pressure is above normal. */
  readonly reason: 'lane' | 'pressure';
  readonly lane: Lane;
  /** Places of the lane held now. */
  readonly busy: number;
  readonly limit: number;
  /** Requests of the lane that arrived earlier and still wait. */
  readonly ahead: number;
  readonly pressure: PressureLevel;
}

export interface PlaceEntry {
  readonly token: string;
  readonly pid: number;
  readonly lane: Lane;
  readonly group: string;
  readonly what: string;
  readonly since: number;
  readonly phase: 'waiting' | 'holding' | 'draining';
  readonly children: readonly number[];
}

export interface LaneState {
  readonly limit: number;
  /** Holding and draining entries, in arrival order. */
  readonly active: readonly PlaceEntry[];
  /** Waiting entries, first in line first. */
  readonly waiting: readonly PlaceEntry[];
}

export interface PlacesState {
  readonly long: LaneState;
  readonly short: LaneState;
  readonly pressure: PressureLevel;
}

function places(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + ' must be a positive integer');
  return value;
}

export function placesConfig(env: NodeJS.ProcessEnv = process.env): PlacesConfig {
  return {
    dir: resolve(env['SKINK3_SLOT_DIR']?.trim() || defaultSlotDir()),
    long: places(env, 'SKINK3_MAC_RENDERS', DEFAULT_MAC_RENDERS),
    short: places(env, 'SKINK3_MAC_SHORT', DEFAULT_MAC_SHORT),
  };
}

/** macOS's memory pressure, sampled at most every 500 ms for all processes sharing the directory. Call it under the lock. */
function macPressure(dir: string): PressureLevel {
  const file = join(dir, PRESSURE_FILE);
  const now = Date.now();
  const cached = readJson<{ at: number; level: PressureLevel } | null>(file, null);
  if (cached && now - cached.at >= 0 && now - cached.at < PRESSURE_SAMPLE_MS) return cached.level;
  const query = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 1_000, windowsHide: true });
  const read = query.status === 0 ? Number(query.stdout.trim()) : NaN;
  const level = Number.isSafeInteger(read) && read > 0 ? read : null;
  writeJson(file, { at: Date.now(), level });
  return level;
}

/** A place is freed when its process is dead and so is every child it tracks (an encoder that still writes keeps it). */
function sweep(entries: readonly PlaceEntry[]): PlaceEntry[] {
  return entries.flatMap((entry) => {
    if (entry.phase !== 'draining' && alive(entry.pid)) return [entry];
    const children = entry.children.filter(alive);
    return children.length > 0 ? [{ ...entry, children, phase: 'draining' as const }] : [];
  });
}

/** All decisions and publications take the lock the memory queue takes, in the same directory. */
function edit<T>(dir: string, action: (entries: PlaceEntry[]) => T): T {
  return locked(dir, () => {
    const file = join(dir, STATE_FILE);
    const previous = readJson<PlaceEntry[]>(file, []);
    const entries = sweep(previous);
    const before = JSON.stringify(previous);
    const result = action(entries);
    if (JSON.stringify(entries) !== before) writeJson(file, entries);
    return result;
  });
}

const limitOf = (config: PlacesConfig, lane: Lane): number => (lane === 'long' ? config.long : config.short);

function lane(config: PlacesConfig, entries: readonly PlaceEntry[], which: Lane): LaneState {
  const own = entries.filter((entry) => entry.lane === which);
  return { limit: limitOf(config, which), active: own.filter((entry) => entry.phase !== 'waiting'), waiting: own.filter((entry) => entry.phase === 'waiting') };
}

/** How `skink3 queue` and the waiting line name a pressure level. */
export const pressureName = (level: PressureLevel): string => (level === null ? 'unknown' : level <= NORMAL_PRESSURE ? 'normal' : level >= 4 ? 'critical' : 'warn');

export function placeWaitingLine(waiting: PlaceWaiting): string {
  if (waiting.reason === 'pressure') return 'waiting for memory pressure to return to normal (macOS reports ' + pressureName(waiting.pressure) + ')';
  return 'waiting for a ' + waiting.lane + ' place (' + waiting.busy + '/' + waiting.limit + ' held'
    + (waiting.ahead > 0 ? ', ' + waiting.ahead + ' earlier in line' : '') + ')';
}

const idle: RenderLease = { verify: () => {}, trackChild: () => {}, release: () => {} };

/** A lease that holds nothing: for work that draws nothing, which the place queue lets through. */
export function idleLease(): RenderLease {
  return idle;
}

/**
 * Waits for a place in a lane, first come first served within the lane: a request is admitted while the places held
 * and the requests ahead of it leave one free, and no new place is granted while memory pressure is above normal.
 * Resolves to null when the signal aborts the wait.
 */
export async function acquirePlace(config: PlacesConfig, ask: PlaceAsk): Promise<RenderLease | null> {
  if (ask.signal?.aborted) return null;
  if (ask.lane !== 'long' && ask.lane !== 'short') throw new Error('A place request needs the lane long or short');
  mkdirSync(config.dir, { recursive: true });
  const token = process.pid + '-' + randomBytes(8).toString('hex');
  const pressure = ask.pressure ?? (() => macPressure(config.dir));
  let admitted = false;
  let told: PlaceWaiting['reason'] | null = null;
  try {
    while (!ask.signal?.aborted) {
      const result = edit(config.dir, (entries) => {
        let own = entries.find((entry) => entry.token === token);
        if (!own) {
          own = {
            token, pid: process.pid, lane: ask.lane, group: ask.group ?? '', what: ask.what,
            since: Date.now(), phase: 'waiting', children: [],
          };
          entries.push(own);
        }
        const { limit, active, waiting } = lane(config, entries, ask.lane);
        const ahead = waiting.indexOf(own);
        const base = { queue: 'places', lane: ask.lane, busy: active.length, limit, ahead } as const;
        if (active.length + ahead >= limit) return { ...base, reason: 'lane', pressure: null } satisfies PlaceWaiting;
        const level = pressure();
        if (level !== null && level > NORMAL_PRESSURE) return { ...base, reason: 'pressure', pressure: level } satisfies PlaceWaiting;
        entries[entries.indexOf(own)] = { ...own, phase: 'holding' };
        return null;
      });
      if (result === null) {
        admitted = true;
        return hold(config, token);
      }
      if (told !== result.reason) {
        told = result.reason;
        ask.onWait?.(result);
      }
      await new Promise<void>((done) => setTimeout(done, ask.pollMs ?? ADMISSION_POLL_MS));
    }
    return null;
  } finally {
    if (!admitted) {
      edit(config.dir, (entries) => {
        const i = entries.findIndex((entry) => entry.token === token);
        if (i >= 0) entries.splice(i, 1);
      });
    }
  }
}

function hold(config: PlacesConfig, token: string): RenderLease {
  let released = false;
  const update = (action: (entries: PlaceEntry[], i: number, own: PlaceEntry) => void): void => {
    edit(config.dir, (entries) => {
      const i = entries.findIndex((entry) => entry.token === token);
      if (i >= 0) action(entries, i, entries[i]!);
    });
  };
  return {
    // A place has no estimate to reconcile.
    verify: () => {},
    trackChild: (pid) => {
      if (!released && Number.isSafeInteger(pid) && pid > 0) {
        update((entries, i, own) => { entries[i] = { ...own, children: [...own.children, pid] }; });
      }
    },
    release: () => {
      if (released) return;
      released = true;
      update((entries, i, own) => {
        const children = own.children.filter(alive);
        if (children.length > 0) entries[i] = { ...own, children, phase: 'draining' };
        else entries.splice(i, 1);
      });
    },
  };
}

/** The lanes of the machine, after dead places are freed, and the memory pressure now. */
export function placesState(config: PlacesConfig, pressure?: () => PressureLevel): PlacesState {
  mkdirSync(config.dir, { recursive: true });
  return edit(config.dir, (entries) => ({
    long: lane(config, entries, 'long'),
    short: lane(config, entries, 'short'),
    pressure: (pressure ?? (() => macPressure(config.dir)))(),
  }));
}
