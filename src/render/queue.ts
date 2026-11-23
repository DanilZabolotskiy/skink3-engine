// Machine-wide admission for render work. Heavy chunks and short commands have independent process limits.
// Both reserve RAM before loading a shot, and share the GPU slots already understood by the legacy renderer.

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { constants as osConstants, freemem, homedir } from 'node:os';
import { join } from 'node:path';

/** Short drawing commands admitted at once, independent of heavy chunks. */
export const DEFAULT_LIGHT_PLACES = 6;

/** Upper bound for the short drawing lane, in scene frames. */
export const MAX_LIGHT_FRAMES = 60;

/**
 * CPU places of a machine when SKINK3_CPU_PLACES is not set: the processes that draw frames at once. Ten since
 * November 23, 2026, on a machine of 8 cores and 16 threads.
 */
export const DEFAULT_CPU_PLACES = 10;

/** GPU places shared by both lanes and by old GPU renders. */
export const DEFAULT_GPU_PLACES = 6;

/** Shared GPU capacity a whole-job reservation leaves available for other rendering. */
export const GPU_PLACES_OUTSIDE_MASTER = 2;

/** Free physical memory, in GB, below which no CPU place is given, when SKINK3_FREE_RAM_GB is not set. */
export const DEFAULT_FREE_RAM_GB = 8;

/** The memory counted for a process that has its CPU place and has not yet loaded its scene. */
export const STARTING_GB = 2;

/** A process that has not said within this long that it has loaded its scene counts as loaded. */
const STARTING_MS = 60_000;

/** How often a process waiting for admission looks for its turn. */
const ADMISSION_POLL_MS = 200;

/** The longest pause of a process waiting for a GPU place between two looks, in ms; it starts at 1 and doubles. */
const GPU_POLL_MAX_MS = 8;

/** How often a waiter for a GPU place looks whether a holder has died. */
const GPU_DEAD_MS = 250;

/** How often a holder and a waiter show that they are alive. */
const HEARTBEAT_MS = 5_000;

/** A place or a ticket that has not been refreshed for this long is gone, even if a process of its number runs. */
const STALE_MS = 120_000;

/** A lock is held for milliseconds; one older than this was left by a process that hung or died holding it. */
const LOCK_STALE_MS = 10_000;

/** Errors of the file system that pass: a file being deleted, or opened by a scanner for a moment. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** The version of the entries this code writes; an entry without it is a slot of the code before the pools. */
const VERSION = 2;

export type RenderLane = 'heavy' | 'light';

export interface QueueConfig {
  /** Most heavy workers at once. */
  readonly cpu: number;
  /** Most short drawing processes at once. */
  readonly light: number;
  /** The slot range understood by legacy processes during rollout. */
  readonly legacyGpu: number;
  /** Most frames drawn on the GPU at once; 0: no limit. */
  readonly gpu: number;
  /** Most GPU places a single master may reserve. */
  readonly masterGpu: number;
  /** Free physical memory, in GB, below which no CPU place is given; 0: no guard. */
  readonly freeRamGb: number;
  /** The directory every process of the machine shares. */
  readonly dir: string;
}

/** What a waiter is told, once, when it has to wait for a CPU place. */
export interface Waiting {
  readonly lane: RenderLane;
  /** What it waits for: a CPU place, or free memory. */
  readonly reason: 'places' | 'memory';
  /** CPU places taken, and how many there are. */
  readonly busy: number;
  readonly places: number;
  /** Waiters whose turn comes first. */
  readonly ahead: number;
  /** Free physical memory, and how much a new place needs, in GB. */
  readonly freeGb: number;
  readonly needGb: number;
}

export interface PlaceRequest {
  /** Short drawing commands use the separate light lane. Defaults to heavy. */
  readonly lane?: RenderLane;
  /** What the process draws, for `skink3 queue`. */
  readonly what: string;
  /** The render the process belongs to: the workers of one render share it. Default: this process alone. */
  readonly job?: string;
  /** Called once if the process has to wait. */
  readonly onWait?: (waiting: Waiting) => void;
  /** Overrides how often a waiter looks for its turn (tests). */
  readonly pollMs?: number;
  /** Gives the wait up: `acquireCpuPlace` then returns null and leaves no ticket. */
  readonly signal?: AbortSignal;
  /** Free physical memory in bytes, now (tests). Default: what the system reports. */
  readonly freeMemory?: () => number;
}

export interface CpuPlace {
  readonly index: number;
  /** Says that the process has loaded its scene: it no longer counts as starting for the memory guard. */
  loaded(): void;
  /** Gives the place back. Safe to call more than once. */
  release(): void;
}

/** A place or a ticket, as it is written in its file. */
interface Entry {
  readonly pid: number;
  readonly token: string;
  /** When the process asked for its place (a ticket) or took it (a place), in ms since the epoch. */
  readonly since: number;
  readonly what: string;
  /** The render it belongs to. */
  readonly job: string;
  /** Written by this code; a slot without it belongs to a process of the code before the pools. */
  readonly v: number;
  /** A CPU place whose process has loaded its scene. */
  readonly loaded: boolean;
  /** GPU places requested or held by one master. */
  readonly reservation?: number;
}

/** The default directory of the places: in the user's local data, the same for every checkout and every session. */
export function defaultSlotDir(): string {
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'skink3', 'render-slots');
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'skink3', 'render-slots');
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of places, 0 for no limit; got "${raw}"`);
  return n;
}

/** Reads the process limits and the shared slot directory. */
export function queueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const legacy = wholeNumber(env, 'SKINK3_RENDER_SLOTS', 4);
  const off = legacy === 0;
  const rawRam = env['SKINK3_FREE_RAM_GB']?.trim();
  let freeRamGb = off ? 0 : DEFAULT_FREE_RAM_GB;
  if (rawRam !== undefined && rawRam !== '') {
    freeRamGb = Number(rawRam);
    if (!Number.isFinite(freeRamGb) || freeRamGb < 0) throw new Error(`SKINK3_FREE_RAM_GB must be a number of GB, 0 for no guard; got "${rawRam}"`);
  }
  const gpu = wholeNumber(env, 'SKINK3_GPU_PLACES', env['SKINK3_RENDER_SLOTS']?.trim() ? legacy : DEFAULT_GPU_PLACES);
  const masterHeadroom = Math.max(0, gpu - GPU_PLACES_OUTSIDE_MASTER);
  return {
    cpu: wholeNumber(env, 'SKINK3_CPU_PLACES', off ? 0 : DEFAULT_CPU_PLACES),
    light: wholeNumber(env, 'SKINK3_LIGHT_PLACES', off ? 0 : DEFAULT_LIGHT_PLACES),
    gpu,
    masterGpu: Math.min(masterHeadroom, wholeNumber(env, 'SKINK3_MASTER_GPU_PLACES', 4)),
    legacyGpu: legacy,
    freeRamGb,
    dir: env['SKINK3_SLOT_DIR']?.trim() || defaultSlotDir(),
  };
}

/** The most CPU places one render holds while another render waits: half of them, at least one. */
export function renderShare(places: number): number {
  return Math.max(1, Math.floor(places / 2));
}

/** The line a process waiting for a CPU place prints. */
export function waitingLine(w: Waiting): string {
  if (w.reason === 'memory') return `waiting for memory: ${w.freeGb.toFixed(1)} GiB free, admission requires ${w.needGb.toFixed(1)} GiB`;
  const pool = w.lane === 'heavy' ? 'heavy CPU' : 'light';
  return `waiting for a ${pool} place: ${w.busy} of ${w.places} busy${w.ahead > 0 ? `, ${w.ahead} ahead` : ''}`;
}

const errorCode = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Sleeps without returning to the event loop; only for the few milliseconds of a busy lock. */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** Whether a process of this number runs (EPERM: it runs, as another user). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === 'EPERM';
  }
}

/** Creates a file that must not exist yet. False when it exists, or the system refuses for a moment. */
function createExclusive(file: string, data: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if (errorCode(e) === 'EEXIST' || TRANSIENT.has(errorCode(e))) return false;
    throw e;
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Removes a file; true when it is gone. */
function removeFile(file: string): boolean {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      unlinkSync(file);
      return true;
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return true;
      if (!TRANSIENT.has(errorCode(e))) return false;
      sleepSync(10);
    }
  }
  return false;
}

/** Marks a file as refreshed now. */
function touch(file: string): void {
  try {
    const now = Date.now() / 1000;
    utimesSync(file, now, now);
  } catch {
    // Gone: a ticket is written again at the next look; a place taken for gone is not given back twice.
  }
}

type Read = { readonly entry: Entry; readonly mtime: number } | 'missing' | 'busy' | 'broken';

/** A place, a slot or a ticket: its entry and when it was last refreshed; 'busy' when the system refuses it for a moment. */
function readEntry(file: string): Read {
  let text: string;
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return errorCode(e) === 'ENOENT' ? 'missing' : TRANSIENT.has(errorCode(e)) ? 'busy' : 'broken';
  }
  try {
    const e = JSON.parse(text) as Record<string, unknown>;
    if (typeof e['pid'] !== 'number' || typeof e['token'] !== 'string' || typeof e['since'] !== 'number') return 'broken';
    const pid = e['pid'];
    return {
      entry: {
        pid,
        token: e['token'],
        since: e['since'],
        what: typeof e['what'] === 'string' ? e['what'] : '',
        job: typeof e['job'] === 'string' ? e['job'] : `process ${pid}`,
        v: typeof e['v'] === 'number' ? e['v'] : 1,
        loaded: e['loaded'] === true,
        ...(typeof e['reservation'] === 'number' ? { reservation: e['reservation'] } : {}),
      },
      mtime,
    };
  } catch {
    // Written whole under a lock, or linked whole into place, so a part of one is what a process left when it died.
    return 'broken';
  }
}

/** An entry is held while its process runs and refreshes it. */
function live(r: { readonly entry: Entry; readonly mtime: number }, now: number): boolean {
  return now - r.mtime < STALE_MS && processAlive(r.entry.pid);
}

/** What a file of this code says: what the code before the pools reads in a slot, and what the pools add. */
function entryText(e: Entry, kind: 'cpu' | 'gpu' | 'wait'): string {
  // `priority` keeps a GPU place a valid slot for a process of the code before the pools, which would sweep it otherwise.
  return JSON.stringify({ ...e, priority: 'high', kind });
}

const gpuFile = (dir: string, index: number): string => join(dir, `slot-${index}`);
/** A GPU ticket is named `gpuwait-<since, 13 digits>-<pid>-<random>`: the order of the names is the order of the turns. */
const GPU_TICKET = /^gpuwait-(\d{13})-(\d+)-[0-9a-f]+$/;
/** The file a GPU place is linked from: `tmp-<pid>-<random>`. */
const TMP = /^tmp-(\d+)-[0-9a-f]+$/;
/** A ticket of the code before the pools: `wait-<pid>-<random>`. */
const OLD_TICKET = /^wait-(\d+)-[0-9a-f]+$/;
const MASTER_TICKET = /^master-turn-wait-(\d+)-[0-9a-f]+$/;
const MASTER_GPU_TICKET = /^master-gpu-wait-(\d+)-[0-9a-f]+$/;

/** Runs `fn` while this process alone holds the lock of that name in the directory. */
function withLock<T>(dir: string, name: string, fn: () => T): T {
  const file = join(dir, name);
  for (let attempt = 0; ; attempt++) {
    if (createExclusive(file, String(process.pid))) break;
    // Taken: by a live process for a moment, or left by one that died or hung holding it.
    let stale = false;
    try {
      const age = Date.now() - statSync(file).mtimeMs;
      const pid = Number(readFileSync(file, 'utf8').trim());
      stale = age > LOCK_STALE_MS || (pid > 0 && !processAlive(pid));
    } catch {
      // Gone or refused for a moment: try again.
    }
    if (stale) removeFile(file);
    else sleepSync(1 + (attempt % 4));
  }
  try {
    return fn();
  } finally {
    removeFile(file);
  }
}

/** The lock of the code before the pools; this code takes it only to sweep a slot of a dead process. */
const SLOT_LOCK = 'lock';

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    // No directory yet: nothing is held and nobody waits.
    return [];
  }
};

/** Signals on which a process would end without a handler: places are given back on them too. */
const SIGNALS = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const).filter((s) => osConstants.signals[s] !== undefined);

/** Runs `fn` if the process exits or is ended by a signal before `off` is called. */
function onExit(fn: () => void): () => void {
  let on = true;
  const off = (): void => {
    if (!on) return;
    on = false;
    process.off('exit', fn);
    for (const s of SIGNALS) process.off(s, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    off();
    fn();
    // A process without a handler of its own would have ended on this signal: end it as it would have.
    if (process.listenerCount(signal) === 0) process.exit(128 + (osConstants.signals[signal] ?? 0));
  };
  process.on('exit', fn);
  for (const s of SIGNALS) process.on(s, onSignal);
  return off;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const newToken = (): string => `${process.pid}-${randomBytes(6).toString('hex')}`;

// --- Process admission -------------------------------------------------------------------------------------------

const GIB = 2 ** 30;
const LANES = ['heavy', 'light'] as const;
const legacySlotName = /^slot-(\d+)$/;
const placeName = /^(heavy|light)-(\d+)$/;
const admissionTicket = /^(heavy|light)-wait-(\d+)-[0-9a-f]+$/;
const placeFile = (dir: string, lane: RenderLane, index: number): string => join(dir, `${lane}-${index}`);

interface LaneSurvey {
  readonly held: Map<number, Entry | null>;
  readonly waiting: Entry[];
}

interface AdmissionSurvey {
  readonly heavy: LaneSurvey;
  readonly light: LaneSurvey;
  readonly old: Entry[];
  unknownOld: number;
}

function byArrival(a: Entry, b: Entry): number {
  return a.since - b.since || a.pid - b.pid || a.token.localeCompare(b.token);
}

function surveyAdmission(config: QueueConfig, now: number, sweep = false): AdmissionSurvey {
  const state: AdmissionSurvey = {
    heavy: { held: new Map(), waiting: [] },
    light: { held: new Map(), waiting: [] },
    old: [],
    unknownOld: 0,
  };
  for (const name of listDir(config.dir)) {
    const place = placeName.exec(name);
    const ticket = admissionTicket.exec(name);
    const oldSlot = legacySlotName.test(name);
    if (!place && !ticket && !oldSlot) continue;
    const file = join(config.dir, name);
    const r = readEntry(file);
    if (r === 'missing') continue;
    // Old processes own their slot files. Count a partial write provisionally.
    if (oldSlot) {
      if (r === 'busy' || r === 'broken') state.unknownOld++;
      else if (r.entry.v < VERSION && live(r, now)) state.old.push(r.entry);
      continue;
    }
    const entry = typeof r === 'object' && processAlive(r.entry.pid) ? r.entry : null;
    // Admission records are created and updated under the admission lock.
    if (!entry && r !== 'busy' && sweep && removeFile(file)) continue;
    if (place && (entry || sweep || r === 'busy')) {
      state[place[1] as RenderLane].held.set(Number(place[2]), entry);
    } else if (ticket && entry) {
      state[ticket[1] as RenderLane].waiting.push(entry);
    }
  }
  for (const lane of LANES) state[lane].waiting.sort(byArrival);
  return state;
}

/**
 * Both lanes update their RAM reservations together. Each lock contender publishes its own name, chooses a
 * Lamport ticket number, then waits for lower (number, name) pairs. A dead contender cannot block the mutex.
 */
function withAdmissionLock<T>(dir: string, fn: () => T): T {
  const prefix = 'admit-';
  const own = prefix + newToken();
  const file = join(dir, own);
  const contenders = (): string[] => listDir(dir).filter((name) => name.startsWith(prefix) && name !== own);
  const number = (name: string): number => {
    const other = join(dir, name);
    if (!processAlive(Number(name.split('-')[1]))) {
      removeFile(other);
      return -1;
    }
    try {
      const match = /^(\d+)\n$/.exec(readFileSync(other, 'utf8'));
      return match ? Number(match[1]) : 0;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return -1;
      if (TRANSIENT.has(errorCode(error))) return 0;
      throw error;
    }
  };
  // A record without a complete number means the contender is choosing.
  writeFileSync(file, '');
  try {
    const chosen = 1 + Math.max(0, ...contenders().map(number));
    writeFileSync(file, `${chosen}\n`);
    for (const name of contenders()) {
      for (;;) {
        const n = number(name);
        if (n < 0 || n > chosen || (n === chosen && name > own)) break;
        sleepSync(1);
      }
    }
    return fn();
  } finally {
    removeFile(file);
  }
}

function availableRam(state: AdmissionSurvey, now: number, freeBytes: number): number {
  const starting = LANES.flatMap((lane) => [...state[lane].held.values()])
    .filter((h) => h && !h.loaded && now - h.since < STARTING_MS).length;
  return freeBytes / GIB - starting * STARTING_GB;
}

/** Older eligible requests have first call on free places. A competing heavy job limits each job's share. */
function turnOf(config: QueueConfig, state: AdmissionSurvey, lane: RenderLane, me: Entry, freeBytes: number, now: number): { claim: number | null; waiting: Waiting } {
  const { held, waiting: order } = state[lane];
  const places = lane === 'heavy' ? config.cpu : config.light;
  const old = lane === 'heavy' ? state.old : [];
  const busy = held.size + old.length + (lane === 'heavy' ? state.unknownOld : 0);
  const jobs = new Set(order.map((e) => e.job));
  const share = lane === 'heavy' && places > 0 && jobs.size > 1 ? renderShare(places) : Infinity;
  const counts = new Map<string, number>();
  for (const e of [...held.values(), ...old]) {
    if (e) counts.set(e.job, (counts.get(e.job) ?? 0) + 1);
  }
  const waiting: Waiting = { lane, reason: 'places', places, busy, ahead: 0, freeGb: freeBytes / GIB, needGb: config.freeRamGb };
  const memory = availableRam(state, now, freeBytes);
  if (config.freeRamGb > 0 && memory < config.freeRamGb) return { claim: null, waiting: { ...waiting, reason: 'memory' } };
  let ahead = 0;
  for (const e of order) {
    const count = counts.get(e.job) ?? 0;
    if (e.token === me.token) {
      if (count >= share || (places > 0 && busy + ahead >= places)) break;
      if (config.freeRamGb > 0 && memory - ahead * STARTING_GB < config.freeRamGb) {
        return { claim: null, waiting: { ...waiting, reason: 'memory', ahead } };
      }
      let index = 0;
      while (held.has(index)) index++;
      return { claim: index, waiting };
    }
    if (count >= share) continue;
    counts.set(e.job, count + 1);
    ahead++;
  }
  return { claim: null, waiting: { ...waiting, ahead } };
}

/** Takes a heavy or light place before loading the scene. A zero count limit still applies the RAM guard. */
export async function acquireCpuPlace(config: QueueConfig, request: PlaceRequest): Promise<CpuPlace | null> {
  const lane = request.lane ?? 'heavy';
  const limit = lane === 'heavy' ? config.cpu : config.light;
  if ((limit === 0 && config.freeRamGb === 0) || request.signal?.aborted) return null;
  const { dir } = config;
  mkdirSync(dir, { recursive: true });
  const token = newToken();
  const ticket = join(dir, `${lane}-wait-${token}`);
  const freeMemory = request.freeMemory ?? freemem;
  const dropTicket = (): void => {
    removeFile(ticket);
  };
  const offTicket = onExit(dropTicket);
  let me: Entry | undefined;
  let told = false;
  try {
    for (;;) {
      if (request.signal?.aborted) return null;
      const turn = withAdmissionLock(dir, () => {
        const now = Date.now();
        const state = surveyAdmission(config, now, true);
        if (!me) {
          // Serialize equal wall-clock milliseconds in registration order.
          const order = state[lane].waiting;
          const since = Math.max(now, (order.at(-1)?.since ?? 0) + 1);
          me = { pid: process.pid, token, since, what: request.what, job: request.job ?? token, v: VERSION, loaded: false };
          writeFileSync(ticket, entryText(me, 'wait'));
          order.push(me);
        }
        const t = turnOf(config, state, lane, me, freeMemory(), now);
        if (t.claim === null) return { place: null, waiting: t.waiting };
        const entry: Entry = { ...me, since: now };
        const file = placeFile(dir, lane, t.claim);
        if (!createExclusive(file, entryText(entry, 'cpu'))) return { place: null, waiting: t.waiting };
        dropTicket();
        return { place: holdCpuPlace(dir, file, t.claim, entry), waiting: t.waiting };
      });
      if (turn.place) return turn.place;
      if (!told) {
        told = true;
        request.onWait?.(turn.waiting);
      }
      await sleep(request.pollMs ?? ADMISSION_POLL_MS);
    }
  } finally {
    offTicket();
    dropTicket();
  }
}

function holdCpuPlace(dir: string, file: string, index: number, entry: Entry): CpuPlace {
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    off();
    removeFile(file);
  };
  const off = onExit(release);
  return {
    index,
    loaded: () => {
      if (held) withAdmissionLock(dir, () => writeFileSync(file, entryText({ ...entry, loaded: true }, 'cpu')));
    },
    release,
  };
}

// --- The GPU pool -------------------------------------------------------------------------------------------------

/** One set of GPU places per drawing process. A second overlapping read in that process shares its place. */
class GpuGate {
  private readonly owner: string;
  private readonly token = newToken();
  private count = 0;
  private index: number | null = null;
  private acquiring: Promise<void> | null = null;
  private ticket: string | null = null;
  private stopped = false;
  private readonly beat: ReturnType<typeof setInterval>;
  private readonly offExit: () => void;

  private readonly config: QueueConfig;
  private readonly what: string;
  private readonly onWait: ((busy: number, places: number) => void) | undefined;

  constructor(config: QueueConfig, what: string, onWait?: (busy: number, places: number) => void) {
    this.config = config;
    this.what = what;
    this.onWait = onWait;
    mkdirSync(config.dir, { recursive: true });
    this.owner = join(config.dir, `tmp-${this.token}`);
    // Every lease links this complete record to a legacy slot name. No metadata writes in the frame fast path.
    writeFileSync(this.owner, entryText(this.entry(Date.now()), 'gpu'));
    this.beat = setInterval(() => {
      // The legacy scheduler checks mtime even for a live PID. Hard links share this timestamp.
      touch(this.owner);
      if (this.ticket) touch(this.ticket);
    }, HEARTBEAT_MS);
    this.beat.unref();
    this.offExit = onExit(() => this.close());
  }

  async take(): Promise<() => void> {
    if (this.stopped) throw new Error('the GPU gate was closed before drawing');
    this.count++;
    try {
      if (this.index === null) {
        this.acquiring ??= this.acquire().finally(() => {
          this.acquiring = null;
        });
        await this.acquiring;
      }
    } catch (error) {
      this.drop();
      throw error;
    }
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.drop();
    };
  }

  /** Cancels waiting and lets a read that already started return its lease. */
  stop(): void {
    this.stopped = true;
    if (this.count === 0) this.close();
  }

  private entry(since: number): Entry {
    return { pid: process.pid, token: this.token, since, what: this.what, job: '', v: VERSION, loaded: false };
  }

  private drop(): void {
    if (--this.count !== 0) return;
    this.giveBack();
    if (this.stopped) this.close();
  }

  private close(): void {
    clearInterval(this.beat);
    this.offExit();
    this.giveBack();
    if (this.ticket) removeFile(this.ticket);
    removeFile(this.owner);
  }

  private giveBack(): void {
    if (this.index === null) return;
    const file = gpuFile(this.config.dir, this.index);
    // A live owner is never reaped by another new holder. The legacy scheduler also sees this as a live slot.
    if (!removeFile(file)) throw new Error(`cannot return GPU place ${this.index}: ${file}`);
    this.index = null;
  }

  private async acquire(): Promise<void> {
    const { dir, gpu } = this.config;
    let names = listDir(dir);
    // Uncontended frame: one directory read, one atomic link, and one unlink after readback.
    const ceiling = ordinaryGpuCeiling(this.config, names);
    if (!names.some((n) => GPU_TICKET.test(n)) && this.claim(names, this.lowest(names, ceiling), ceiling)) return;
    const since = Date.now();
    const name = `gpuwait-${String(since).padStart(13, '0')}-${this.token}`;
    const ticket = join(dir, name);
    this.ticket = ticket;
    writeFileSync(ticket, entryText(this.entry(since), 'wait'));
    let pause = 1;
    let sweepAt = 0;
    let told = false;
    try {
      for (;;) {
        if (this.stopped) throw new Error('the GPU gate was closed while waiting');
        names = listDir(dir);
        const line = names.filter((n) => {
          const pid = GPU_TICKET.exec(n)?.[2];
          return pid !== undefined && processAlive(Number(pid));
        }).sort();
        const ahead = line.indexOf(name);
        const ceiling = ordinaryGpuCeiling(this.config, names);
        const lowest = this.lowest(names, ceiling);
        const slots = new Set(names);
        let free = 0;
        for (let i = lowest; i < ceiling; i++) if (!slots.has(`slot-${i}`)) free++;
        if (ahead >= 0 && ahead < free && this.claim(names, lowest, ceiling)) return;
        if (!told) {
          told = true;
          this.onWait?.(names.filter((n) => legacySlotName.test(n)).length, gpu);
        }
        if (Date.now() >= sweepAt) {
          sweepAt = Date.now() + GPU_DEAD_MS;
          sweepGpu(this.config, names);
        }
        await sleep(pause);
        pause = Math.min(GPU_POLL_MAX_MS, pause * 2);
      }
    } finally {
      removeFile(ticket);
      this.ticket = null;
    }
  }

  /** Leave some slots available to old waiters that can only poll their original range every 200 ms. */
  private lowest(names: readonly string[], ceiling: number): number {
    const { dir, legacyGpu } = this.config;
    const oldWaiting = names.some((n) => {
      if (!OLD_TICKET.test(n)) return false;
      const r = readEntry(join(dir, n));
      return typeof r === 'object' && live(r, Date.now());
    });
    return oldWaiting ? Math.min(legacyGpu, ceiling - 1) : 0;
  }

  private claim(names: readonly string[], lowest: number, ceiling: number): boolean {
    const { dir, gpu } = this.config;
    const taken = new Set(names);
    if (names.filter((n) => legacySlotName.test(n)).length >= gpu) return false;
    // Prefer slots outside the legacy range, but share all six slots when no legacy process waits.
    for (let i = ceiling - 1; i >= lowest; i--) {
      if (taken.has(`slot-${i}`)) continue;
      try {
        linkSync(this.owner, gpuFile(dir, i));
        this.index = i;
        return true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' && !TRANSIENT.has(errorCode(error))) throw error;
      }
    }
    return false;
  }
}

function ordinaryGpuCeiling(config: QueueConfig, names: readonly string[]): number {
  for (const name of names) {
    if (!MASTER_GPU_TICKET.test(name)) continue;
    const record = readEntry(join(config.dir, name));
    if (typeof record === 'object' && processAlive(record.entry.pid)) {
      const availableToOthers = config.gpu - (record.entry.reservation ?? 0);
      // A long legacy chunk cannot yield at a frame boundary. Keep the other slots available until
      // there is room for the complete reservation after current ordinary frames finish.
      const legacy = names.filter((n) => {
        if (!legacySlotName.test(n)) return false;
        const slot = readEntry(join(config.dir, n));
        return slot === 'busy' || slot === 'broken' || (typeof slot === 'object' && slot.entry.v < VERSION && live(slot, Date.now()));
      }).length;
      return legacy > availableToOthers ? config.gpu : Math.max(1, availableToOthers);
    }
  }
  return config.gpu;
}

/** Reap dead slots under the legacy mutex so a legacy sweeper or release cannot unlink a successor. */
function sweepGpu(config: QueueConfig, names: readonly string[]): void {
  const { dir } = config;
  const isDead = (name: string): boolean => {
    const r = readEntry(join(dir, name));
    return r === 'broken' || (typeof r === 'object' && (
      r.entry.v < VERSION ? !live(r, Date.now()) : !processAlive(r.entry.pid)
    ));
  };
  const dead = names.filter((n) => legacySlotName.test(n) && isDead(n));
  if (dead.length > 0) {
    withLock(dir, SLOT_LOCK, () => {
      for (const n of dead) if (isDead(n)) removeFile(join(dir, n));
    });
  }
  for (const name of names) {
    const pid = GPU_TICKET.exec(name)?.[2] ?? TMP.exec(name)?.[1] ?? MASTER_GPU_TICKET.exec(name)?.[1];
    if (pid !== undefined && !processAlive(Number(pid))) removeFile(join(dir, name));
  }
}

type Release = () => void;

/**
 * A turn excludes other masters before their workers occupy CPU admission. It consumes no GPU places.
 * The separate supervisor process holds the turn even while its assembler is blocked in a synchronous child.
 */
export async function acquireMasterTurn(config: QueueConfig, what: string, signal: AbortSignal, onWait?: () => void): Promise<Release | null> {
  mkdirSync(config.dir, { recursive: true });
  const token = newToken();
  const turn = join(config.dir, 'master-turn');
  const ticket = join(config.dir, `master-turn-wait-${token}`);
  const entry: Entry = { pid: process.pid, token, since: Date.now(), what, job: 'master', v: VERSION, loaded: false };
  const isLive = (r: Read): r is { entry: Entry; mtime: number } => typeof r === 'object' && processAlive(r.entry.pid);
  let told = false;
  withAdmissionLock(config.dir, () => writeFileSync(ticket, entryText(entry, 'wait')));
  try {
    while (!signal.aborted) {
      const acquired = withAdmissionLock(config.dir, () => {
        const held = readEntry(turn);
        if (held === 'busy' || isLive(held)) return false;
        const waiting: Entry[] = [];
        for (const name of listDir(config.dir)) {
          if (!MASTER_TICKET.test(name)) continue;
          const file = join(config.dir, name);
          const r = readEntry(file);
          if (isLive(r)) waiting.push(r.entry);
          else if (r === 'broken' || typeof r === 'object') removeFile(file);
        }
        waiting.sort(byArrival);
        if (waiting[0]?.token !== token) return false;
        return removeFile(turn) && createExclusive(turn, entryText(entry, 'cpu'));
      });
      if (acquired) return () => { removeFile(turn); };
      if (!told) onWait?.();
      told = true;
      await sleep(ADMISSION_POLL_MS);
    }
    return null;
  } finally {
    removeFile(ticket);
  }
}

/** Claims the whole master reservation or none. Ordinary and legacy draw workers share these same slot names. */
export async function acquireMasterGpuPlaces(config: QueueConfig, places: number, what: string, signal: AbortSignal): Promise<Release | null> {
  const { dir, gpu } = config;
  const token = newToken();
  const entry: Entry = { pid: process.pid, token, since: Date.now(), what, job: 'master', v: VERSION, loaded: true, reservation: places };
  const ticket = join(dir, `master-gpu-wait-${token}`);
  const owner = join(dir, `tmp-${token}`);
  writeFileSync(owner, entryText(entry, 'gpu'));
  writeFileSync(ticket, entryText(entry, 'wait'));
  const beat = setInterval(() => touch(owner), HEARTBEAT_MS);
  beat.unref();
  let acquired = false;
  const cleanup = (): void => {
    clearInterval(beat);
    removeFile(owner);
  };
  try {
    while (!signal.aborted) {
      const names = listDir(dir);
      sweepGpu(config, names);
      const free = Array.from({ length: gpu }, (_, i) => gpu - 1 - i).filter((i) => !names.includes(`slot-${i}`));
      if (free.length >= places && names.filter((n) => legacySlotName.test(n)).length + places <= gpu) {
        const held: number[] = [];
        const release = (): void => {
          for (const i of held.splice(0)) removeFile(gpuFile(dir, i));
        };
        try {
          for (const i of free) {
            try {
              linkSync(owner, gpuFile(dir, i));
              held.push(i);
              if (held.length === places) {
                acquired = true;
                return () => { release(); cleanup(); };
              }
            } catch (error) {
              if (errorCode(error) !== 'EEXIST' && !TRANSIENT.has(errorCode(error))) throw error;
            }
          }
        } finally {
          if (!acquired) release();
        }
      }
      await sleep(ADMISSION_POLL_MS);
    }
    return null;
  } finally {
    removeFile(ticket);
    if (!acquired) cleanup();
  }
}

let gate: GpuGate | null = null;

/** Use the shared GPU queue for scene frames drawn by this process until released. */
export function useGpuPlaces(config: QueueConfig, what: string, onWait?: (busy: number, places: number) => void): { release(): void } {
  if (config.gpu <= 0) return { release: () => undefined };
  const own = new GpuGate(config, what, onWait);
  gate?.stop();
  gate = own;
  return {
    release: (): void => {
      if (gate === own) gate = null;
      own.stop();
    },
  };
}

/** Returns a release callback for the GPU draw/readback about to start. */
export async function takeGpuPlace(): Promise<() => void> {
  return gate ? gate.take() : () => undefined;
}

// --- What `skink3 queue` shows ------------------------------------------------------------------------------------

/** A place, a slot or a ticket as `queueState` reports it. */
export interface QueueEntry {
  readonly pid: number;
  /** Seconds since it took its place (a holder) or asked for one (a waiter). */
  readonly seconds: number;
  readonly what: string;
  /** The render it belongs to. */
  readonly job: string;
  /** A slot of a process of the code before the pools, which holds it for a whole chunk. */
  readonly old: boolean;
  /** Size of a persistent master reservation, if any. */
  readonly reservation: number;
}

interface PoolState {
  readonly held: (QueueEntry | null)[];
  readonly waiting: QueueEntry[];
  readonly busy: number;
}

export interface QueueState {
  /** Who holds each CPU place (null: free), and who waits for one, in the order of their turns. */
  readonly cpu: PoolState;
  /** Short drawing processes and their waiters. */
  readonly light: PoolState;
  /** Who holds each GPU place (null: free; the slots of the code before the pools among them), and who waits. */
  readonly gpu: PoolState;
  /** Whole-film masters waiting for the master turn. */
  readonly master: { readonly held: QueueEntry | null; readonly waiting: QueueEntry[] };
  /** Processes of the code before the pools that wait for a slot. */
  readonly oldWaiting: QueueEntry[];
  /** Free physical memory, in GB. */
  readonly freeGb: number;
}

/** The queue as it stands. */
export function queueState(config: QueueConfig): QueueState {
  const now = Date.now();
  const shown = (e: Entry, old = e.v < VERSION): QueueEntry => ({ pid: e.pid, seconds: Math.max(0, (now - e.since) / 1000), what: e.what, job: e.job, old, reservation: e.reservation ?? 0 });
  const entryOf = (file: string): Entry | null => {
    const r = readEntry(file);
    if (typeof r !== 'object') return null;
    return (r.entry.v < VERSION ? live(r, now) : processAlive(r.entry.pid)) ? r.entry : null;
  };
  const admitted = surveyAdmission(config, now);
  const admissionState = (lane: RenderLane, places: number): PoolState => {
    const s = admitted[lane];
    const held = Array.from({ length: Math.max(places, ...[...s.held.keys()].map((i) => i + 1)) }, (_, i) => {
      const entry = s.held.get(i);
      return entry ? shown(entry) : null;
    });
    return { held, waiting: s.waiting.map((e) => shown(e)), busy: s.held.size + (lane === 'heavy' ? admitted.old.length : 0) };
  };
  const names = listDir(config.dir);
  const gpuHeld: (QueueEntry | null)[] = [];
  for (let i = 0; i < Math.max(config.gpu, ...names.map((n) => Number(legacySlotName.exec(n)?.[1] ?? -1) + 1)); i++) {
    const e = entryOf(gpuFile(config.dir, i));
    gpuHeld.push(e ? shown(e) : null);
  }
  const waiting = (...patterns: RegExp[]): QueueEntry[] => names
    .filter((n) => patterns.some((pattern) => pattern.test(n)))
    .map((n) => entryOf(join(config.dir, n)))
    .filter((e): e is Entry => e !== null)
    .sort(byArrival)
    .map((e) => shown(e));
  const master = entryOf(join(config.dir, 'master-turn'));
  return {
    cpu: admissionState('heavy', config.cpu),
    light: admissionState('light', config.light),
    gpu: { held: gpuHeld, waiting: waiting(GPU_TICKET, MASTER_GPU_TICKET), busy: gpuHeld.filter(Boolean).length },
    master: { held: master ? shown(master) : null, waiting: waiting(MASTER_TICKET) },
    oldWaiting: waiting(OLD_TICKET),
    freeGb: freemem() / GIB,
  };
}
