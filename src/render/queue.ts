// The render queue: a limit, for the whole machine, on the processes that draw on the GPU at once.
//
// Several programs may render on one machine at the same time: from other checkouts and worktrees of the engine,
// from other working copies of a production, from other sessions. Past a few processes the GPU only shares its time
// out among them, every render gets slower, and a large frame may find no memory. So every process that is about to
// draw frames on the GPU first takes one of the machine's render slots, and gives it back when it is done; one that
// finds them all taken waits for its turn.
//
// - The slots are small files in a directory outside any repository, the same for every process of the user
//   (SKINK3_SLOT_DIR). Their number is SKINK3_RENDER_SLOTS: 3 when it is not set, 0 for no limit and no queue.
// - Waiting is first come, first served, in two classes: quick work (a still, a sheet, a render at preview size)
//   before long work (a render wider than the preview, or one marked low). A low waiter that has waited AGING_MS
//   counts as quick, in its place by arrival, so it is served in the end however much quick work comes.
// - A slot or a waiter's ticket names its process. One whose process is gone is free: a crash or a kill leaves nothing
//   that blocks. One that has not been refreshed for STALE_MS is taken as gone too, for a process number that the
//   system has given to another process since.
// - Every change of the directory is made under a short lock (a file created exclusively), and a slot is itself a
//   file created exclusively, so that two processes never hold the same slot.
//
// The queue decides only when a process starts to draw. It never changes what is drawn: a frame is the same frame
// whoever waited for what.

import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { join } from 'node:path';

/** The class of a waiter: quick work goes first. */
export type Priority = 'high' | 'low';

/** Render slots of a machine when SKINK3_RENDER_SLOTS is not set. */
export const DEFAULT_SLOTS = 3;

/** The width of a preview. A render wider than this is long work (low) unless it is marked. */
export const PREVIEW_WIDTH = 1920;

/** A low waiter that has waited this long goes before quick work that came after it. */
export const AGING_MS = 5 * 60_000;

/** How often a waiter looks for its turn. */
const POLL_MS = 200;

/** How often a holder and a waiter show that they are alive. */
const HEARTBEAT_MS = 5_000;

/** A slot or a ticket that has not been refreshed for this long is gone, even if a process of its number runs. */
const STALE_MS = 120_000;

/** The lock is held for milliseconds; one older than this was left by a process that hung or died holding it. */
const LOCK_STALE_MS = 10_000;

/** Errors of the file system that pass: a file being deleted, or opened by a scanner for a moment. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface QueueConfig {
  /** Most processes drawing on the GPU at once; 0: no limit, no queue. */
  readonly slots: number;
  /** The directory every process of the machine shares. */
  readonly dir: string;
}

/** What a waiter is told, once, when it has to wait. */
export interface Waiting {
  /** Slots taken. */
  readonly busy: number;
  readonly slots: number;
  /** Waiters whose turn comes first. */
  readonly ahead: number;
}

export interface SlotRequest {
  readonly priority: Priority;
  /** What the process draws, for `skink3 queue`. */
  readonly what: string;
  /** Called once if the process has to wait. */
  readonly onWait?: (waiting: Waiting) => void;
  /** Overrides AGING_MS (tests). */
  readonly agingMs?: number;
  /** Overrides how often a waiter looks for its turn (tests). */
  readonly pollMs?: number;
  /** Gives the wait up: `acquireSlot` then returns null and leaves no ticket. */
  readonly signal?: AbortSignal;
}

export interface Slot {
  readonly index: number;
  /** Gives the slot back. Safe to call more than once. */
  release(): void;
}

/** A slot or a ticket, as it is written in its file. */
interface Entry {
  readonly pid: number;
  readonly token: string;
  readonly priority: Priority;
  /** When the process asked for its slot (ms since the epoch): its place in the queue. */
  readonly since: number;
  readonly what: string;
}

/** The default directory of the slots: in the user's local data, the same for every checkout and every session. */
export function defaultSlotDir(): string {
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'skink3', 'render-slots');
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'skink3', 'render-slots');
}

/** The queue of this machine, from SKINK3_RENDER_SLOTS and SKINK3_SLOT_DIR. */
export function queueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const raw = env['SKINK3_RENDER_SLOTS']?.trim();
  let slots = DEFAULT_SLOTS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`SKINK3_RENDER_SLOTS must be a whole number of render slots, 0 for no limit; got "${raw}"`);
    slots = n;
  }
  return { slots, dir: env['SKINK3_SLOT_DIR']?.trim() || defaultSlotDir() };
}

/** A priority given by name: --priority, or SKINK3_RENDER_PRIORITY. */
export function parsePriority(value: string | undefined, source: string): Priority | undefined {
  const v = value?.trim();
  if (v === undefined || v === '') return undefined;
  if (v !== 'high' && v !== 'low') throw new Error(`${source} must be high or low, got "${value}"`);
  return v;
}

/** The priority of SKINK3_RENDER_PRIORITY, if it is set. */
export function envPriority(env: NodeJS.ProcessEnv = process.env): Priority | undefined {
  return parsePriority(env['SKINK3_RENDER_PRIORITY'], 'SKINK3_RENDER_PRIORITY');
}

/** The priority of a render that nobody marked: long work when it is wider than a preview (a master), quick otherwise. */
export function renderPriority(width: number): Priority {
  return width > PREVIEW_WIDTH ? 'low' : 'high';
}

/** The line a waiting process prints. */
export function waitingLine(w: Waiting): string {
  return `waiting for a render slot: ${w.busy} of ${w.slots} busy${w.ahead > 0 ? `, ${w.ahead} ahead` : ''}`;
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
    // Gone: the next look at the queue writes it again (a ticket) or finds the slot taken over.
  }
}

type Read = { readonly entry: Entry; readonly mtime: number } | 'missing' | 'busy' | 'broken';

/** A slot or a ticket: its entry and when it was last refreshed; 'busy' when the system refuses it for a moment. */
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
    const e = JSON.parse(text) as Partial<Entry>;
    if (typeof e.pid !== 'number' || typeof e.token !== 'string' || typeof e.since !== 'number' || (e.priority !== 'high' && e.priority !== 'low')) return 'broken';
    return { entry: { pid: e.pid, token: e.token, priority: e.priority, since: e.since, what: typeof e.what === 'string' ? e.what : '' }, mtime };
  } catch {
    // Every entry is written whole under the lock, so a part of one is what a process left when it died writing it.
    return 'broken';
  }
}

/** An entry is held while its process runs and refreshes it. */
function live(r: { readonly entry: Entry; readonly mtime: number }, now: number): boolean {
  return now - r.mtime < STALE_MS && processAlive(r.entry.pid);
}

const slotFile = (dir: string, index: number): string => join(dir, `slot-${index}`);
const TICKET = 'wait-';
const ticketFile = (dir: string, token: string): string => join(dir, `${TICKET}${token}`);

/** Runs `fn` while this process alone may change the directory. */
function withLock<T>(dir: string, fn: () => T): T {
  const file = join(dir, 'lock');
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

/** The order of the turns: quick work (and low work that has waited long enough) first, each by arrival. */
function byTurn(now: number, agingMs: number): (a: Entry, b: Entry) => number {
  const cls = (e: Entry): number => (e.priority === 'high' || now - e.since >= agingMs ? 0 : 1);
  return (a, b) => cls(a) - cls(b) || a.since - b.since || a.pid - b.pid || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
}

/** The slots and the tickets of the directory, with what is gone taken away (under the lock). */
function survey(dir: string, slots: number, now: number, sweep: boolean): { held: (Entry | null)[]; busy: number; free: number[]; waiting: Entry[] } {
  const held: (Entry | null)[] = [];
  const free: number[] = [];
  let busy = 0;
  for (let i = 0; i < slots; i++) {
    const file = slotFile(dir, i);
    const r = readEntry(file);
    if (r === 'missing') {
      held.push(null);
      free.push(i);
    } else if (r === 'busy') {
      held.push(null);
      busy++;
    } else if (r === 'broken' || !live(r, now)) {
      held.push(null);
      if (!sweep) continue;
      if (removeFile(file)) free.push(i);
      else busy++;
    } else {
      held.push(r.entry);
      busy++;
    }
  }
  const waiting: Entry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // No directory yet: nobody waits.
  }
  for (const name of names) {
    if (!name.startsWith(TICKET)) continue;
    const file = join(dir, name);
    const r = readEntry(file);
    if (r === 'missing' || r === 'busy') continue;
    if (r === 'broken' || !live(r, now)) {
      if (sweep) removeFile(file);
      continue;
    }
    waiting.push(r.entry);
  }
  return { held, busy, free, waiting };
}

/** One look at the queue by a waiter (under the lock): it takes a slot when its turn has come, or keeps its ticket. */
function lookForTurn(dir: string, slots: number, me: Entry, agingMs: number): { claimed: number | null; waiting: Waiting } {
  const now = Date.now();
  const { busy, free, waiting } = survey(dir, slots, now, true);
  const mine = waiting.some((w) => w.token === me.token);
  const order = mine ? waiting : [...waiting, me];
  order.sort(byTurn(now, agingMs));
  const ahead = order.findIndex((w) => w.token === me.token);
  if (ahead < free.length) {
    for (const index of free) {
      // A slot's entry says since when it is held; a ticket's, since when it waits.
      if (createExclusive(slotFile(dir, index), JSON.stringify({ ...me, since: now }))) {
        if (mine) removeFile(ticketFile(dir, me.token));
        return { claimed: index, waiting: { busy, slots, ahead: 0 } };
      }
    }
  }
  // Not yet: the ticket keeps the place. A ticket taken for gone is written again with its first arrival.
  if (!mine) writeFileSync(ticketFile(dir, me.token), JSON.stringify(me));
  return { claimed: null, waiting: { busy, slots, ahead } };
}

/** Signals on which a process would end without a handler: a slot is given back on them too. */
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

/**
 * Waits for a render slot of the machine and takes it; null when the queue is off (no limit). The slot is held until
 * `release`, and given back when the process exits or is ended by a signal; if the process is killed, the next waiter
 * finds it gone.
 */
export async function acquireSlot(config: QueueConfig, request: SlotRequest): Promise<Slot | null> {
  if (config.slots <= 0) return null;
  const { dir } = config;
  mkdirSync(dir, { recursive: true });
  const me: Entry = { pid: process.pid, token: `${process.pid}-${randomBytes(6).toString('hex')}`, priority: request.priority, since: Date.now(), what: request.what };
  const agingMs = request.agingMs ?? AGING_MS;
  const ticket = ticketFile(dir, me.token);
  const dropTicket = (): void => {
    withLock(dir, () => removeFile(ticket));
  };
  const offTicket = onExit(dropTicket);
  let told = false;
  let refreshed = Date.now();
  try {
    for (;;) {
      // Given up by its caller: no slot, and no ticket left behind.
      if (request.signal?.aborted) {
        dropTicket();
        return null;
      }
      const turn = withLock(dir, () => lookForTurn(dir, config.slots, me, agingMs));
      if (turn.claimed !== null) return holdSlot(dir, turn.claimed, me);
      if (!told) {
        told = true;
        request.onWait?.(turn.waiting);
      }
      if (Date.now() - refreshed >= HEARTBEAT_MS) {
        touch(ticket);
        refreshed = Date.now();
      }
      await sleep(request.pollMs ?? POLL_MS);
    }
  } catch (error) {
    dropTicket();
    throw error;
  } finally {
    offTicket();
  }
}

/** A slot this process has taken: refreshed while it is held, given back once. */
function holdSlot(dir: string, index: number, me: Entry): Slot {
  const file = slotFile(dir, index);
  const beat = setInterval(() => touch(file), HEARTBEAT_MS);
  beat.unref();
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    clearInterval(beat);
    off();
    withLock(dir, () => {
      // Only its own: a slot taken for gone (a process that slept past STALE_MS) may belong to another by now.
      const r = readEntry(file);
      if (typeof r === 'object' && r.entry.token === me.token) removeFile(file);
    });
  };
  const off = onExit(release);
  return { index, release };
}

/** A slot or a ticket as `queueState` reports it. */
export interface QueueEntry {
  readonly pid: number;
  readonly priority: Priority;
  /** Seconds since it took its slot (a holder) or asked for one (a waiter). */
  readonly seconds: number;
  readonly what: string;
}

/** The queue as it stands: who holds each slot (null: free), and who waits, in the order of their turns. */
export function queueState(config: QueueConfig, agingMs: number = AGING_MS): { held: (QueueEntry | null)[]; waiting: QueueEntry[] } {
  if (config.slots <= 0) return { held: [], waiting: [] };
  const look = (): ReturnType<typeof survey> => survey(config.dir, config.slots, Date.now(), false);
  let s: ReturnType<typeof survey>;
  try {
    mkdirSync(config.dir, { recursive: true });
    s = withLock(config.dir, look);
  } catch {
    s = look();
  }
  const now = Date.now();
  const shown = (e: Entry): QueueEntry => ({ pid: e.pid, priority: e.priority, seconds: Math.max(0, (now - e.since) / 1000), what: e.what });
  return { held: s.held.map((e) => (e ? shown(e) : null)), waiting: [...s.waiting].sort(byTurn(now, agingMs)).map(shown) };
}

// --- The slot of a process that draws ----------------------------------------------------------------------------

/** The slot this process takes before its first frame on the GPU, when a command has asked for one. */
let gate: { take(): Promise<void> } | null = null;

/**
 * Makes this process take a render slot before it draws its first frame on the GPU, and hold it until `release`.
 * A command that never draws on the GPU never waits. Used by the command line; without it, drawing waits for nothing.
 */
export function holdSlotForGpu(config: QueueConfig, request: SlotRequest): { release(): void } {
  if (config.slots <= 0) return { release: () => undefined };
  let pending: Promise<Slot | null> | null = null;
  let slot: Slot | null = null;
  let released = false;
  const abort = new AbortController();
  const own = {
    take: (): Promise<void> => {
      pending ??= acquireSlot(config, { ...request, signal: abort.signal }).then((s) => {
        slot = s;
        if (released) s?.release();
        return s;
      });
      return pending.then(() => undefined);
    },
  };
  gate = own;
  return {
    release: (): void => {
      released = true;
      abort.abort();
      if (gate === own) gate = null;
      (slot as Slot | null)?.release();
    },
  };
}

/** Waits, before a frame is drawn on the GPU, for the render slot of this process if a command asked for one. */
export async function waitForGpu(): Promise<void> {
  if (gate) await gate.take();
}
