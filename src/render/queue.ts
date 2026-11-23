// Shared, atomic RAM and VRAM admission for commands and chunk workers.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, homedir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { GIB, type RenderMemory } from './memory.ts';

export const GROUP_WORKERS = 4;
export const DEFAULT_FREE_RAM_GB = 5;
export const DEFAULT_FREE_VRAM_GB = 2;
export const MAX_LIGHT_FRAMES = 60;
const ADMISSION_POLL_MS = 175;
const GPU_SAMPLE_MS = 500;
const FAIRNESS_MS = 3_000;

export interface QueueConfig {
  readonly dir: string;
  readonly freeRamGb: number;
  readonly freeVramGb: number;
  /** Legacy GPU chunk boundaries use this setting. Admission never uses it. */
  readonly legacyGpu: number;
  readonly gpuIndex?: number;
  /** Explicit device capacity for systems that cannot report live VRAM. */
  readonly gpuBudgetGb?: number;
}

export interface MemorySample {
  readonly free: number;
  readonly total: number;
  /** Optional bytes resident in a process, already included in total minus free. */
  readonly resident?: Readonly<Record<number, number>>;
  readonly source: string;
}

export interface QueueMemory {
  readonly ram: MemorySample;
  readonly vram: MemorySample | null;
}

export interface PlaceRequest {
  readonly group: string;
  readonly what: string;
  readonly memory: RenderMemory;
  /** Scene preflight reserves RAM independently of the four drawing workers. */
  readonly draws?: boolean;
  readonly short?: boolean;
  readonly onWait?: (waiting: Waiting) => void;
  readonly onPressure?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  /** An injected reader for simultaneous, controlled admission tests. */
  readonly sample?: () => QueueMemory;
}

export interface Waiting {
  readonly reason: 'group' | 'ram' | 'vram' | 'turn';
  readonly group: string;
  readonly busy: number;
  readonly freeRam: number;
  readonly freeVram: number | null;
  readonly needRam: number;
  readonly needVram: number;
}

export interface RenderLease {
  /** Reconciles observed use and can grow the reservation before further allocation. */
  verify(remainingRam?: number): void;
  /** Holds the reservation if the worker exits before its encoder. */
  trackChild(pid: number): void;
  release(): void;
}

interface RecordEntry {
  readonly token: string;
  readonly pid: number;
  readonly group: string;
  readonly what: string;
  readonly since: number;
  readonly draws: boolean;
  readonly short: boolean;
  readonly phase: 'waiting' | 'holding' | 'draining';
  readonly memory: RenderMemory;
  readonly children: readonly number[];
}

export type QueueEntry = RecordEntry;
export interface QueueState {
  readonly active: readonly QueueEntry[];
  readonly waiting: readonly QueueEntry[];
  readonly memory: QueueMemory;
  readonly available: { readonly ram: number; readonly vram: number | null };
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const transient = (error: unknown): boolean => /^(EPERM|EACCES|EBUSY)$/.test((error as NodeJS.ErrnoException).code ?? '');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const pause = (): void => { Atomics.wait(sleeper, 0, 0, 1); };

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function deleteFile(file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      unlinkSync(file);
      return;
    } catch (error) {
      if (missing(error)) return;
      if (!transient(error) || attempt === 50) throw error;
      pause();
    }
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** Use unique lock tickets so a dead owner's cleanup cannot unlink a successor's lock. */
function locked<T>(dir: string, action: () => T): T {
  const name = 'memory-lock-' + process.pid + '-' + randomBytes(6).toString('hex');
  const file = join(dir, name);
  const contenders = (): string[] => list(dir).filter((n) => n.startsWith('memory-lock-') && n !== name);
  const number = (other: string): number => {
    const path = join(dir, other);
    const pid = Number(/^memory-lock-(\d+)-[0-9a-f]+$/.exec(other)?.[1] ?? 0);
    if (!pid) return -1;
    if (!alive(pid)) {
      deleteFile(path);
      return -1;
    }
    try {
      const match = /^(\d+)\n$/.exec(readFileSync(path, 'utf8'));
      return match ? Number(match[1]) : 0;
    } catch (error) {
      if (missing(error)) return -1;
      if (transient(error)) return 0;
      throw error;
    }
  };
  writeFileSync(file, '', { flag: 'wx' });
  try {
    const own = 1 + Math.max(0, ...contenders().map(number));
    writeFileSync(file, own + '\n');
    for (const other of contenders()) {
      for (;;) {
        const n = number(other);
        if (n < 0 || n > own || (n === own && other > name)) break;
        pause();
      }
    }
    return action();
  } finally {
    deleteFile(file);
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if (missing(error)) return fallback;
    throw error;
  }
}

function writeJson(file: string, value: unknown): void {
  const part = file + '.' + process.pid + '.part';
  writeFileSync(part, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(part, file);
      return;
    } catch (error) {
      if (!transient(error) || attempt === 50) throw error;
      pause();
    }
  }
}

export function defaultSlotDir(): string {
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'skink3', 'render-slots');
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'skink3', 'render-slots');
}

function setting(env: NodeJS.ProcessEnv, name: string, fallback: number | undefined, integer = false): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(name + ' must be a nonnegative ' + (integer ? 'integer' : 'number'));
  }
  return value;
}

export function queueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const gpuIndex = setting(env, 'SKINK3_GPU_INDEX', undefined, true);
  const gpuBudgetGb = setting(env, 'SKINK3_GPU_BUDGET_GB', undefined);
  return {
    dir: resolve(env['SKINK3_SLOT_DIR']?.trim() || defaultSlotDir()),
    freeRamGb: setting(env, 'SKINK3_FREE_RAM_GB', DEFAULT_FREE_RAM_GB)!,
    freeVramGb: setting(env, 'SKINK3_FREE_VRAM_GB', DEFAULT_FREE_VRAM_GB)!,
    legacyGpu: setting(env, 'SKINK3_RENDER_SLOTS', 4, true)!,
    ...(gpuIndex === undefined ? {} : { gpuIndex }),
    ...(gpuBudgetGb === undefined ? {} : { gpuBudgetGb }),
  };
}

function gpuSample(config: QueueConfig): MemorySample | null {
  const file = join(config.dir, 'memory-gpu-' + (config.gpuIndex ?? 'auto') + '.json');
  const now = Date.now();
  const cached = readJson<{ at: number; value: MemorySample | null } | null>(file, null);
  if (cached && now - cached.at >= 0 && now - cached.at < GPU_SAMPLE_MS) return cached.value;
  const query = spawnSync('nvidia-smi', [
    '--query-gpu=index,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', timeout: 1_000, windowsHide: true });
  const rows = query.status === 0 ? query.stdout.trim().split(/\r?\n/) : [];
  const row = config.gpuIndex === undefined
    ? (rows.length === 1 ? rows[0] : undefined)
    : rows.find((line) => Number(line.split(',')[0]) === config.gpuIndex);
  const fields = row?.split(',').map((field) => Number(field.trim()));
  const cap = fields?.[1] ?? 0;
  const free = fields?.[2] ?? -1;
  const value = cap > 0 && free >= 0 && free <= cap
    ? { free: free * 2 ** 20, total: cap * 2 ** 20, source: 'nvidia-smi' }
    : null;
  writeJson(file, { at: Date.now(), value });
  return value;
}

function memoryOf(config: QueueConfig, gpu: boolean, sample?: () => QueueMemory): QueueMemory {
  if (sample) return sample();
  const ram: MemorySample = { free: freemem(), total: totalmem(), source: 'OS' };
  if (!gpu) return { ram, vram: null };
  const measured = gpuSample(config);
  if (measured) return { ram, vram: measured };
  const budget = (config.gpuBudgetGb ?? 0) * GIB;
  return { ram, vram: budget > 0 ? { free: budget, total: budget, source: 'configured budget' } : null };
}

function sweep(entries: readonly RecordEntry[]): RecordEntry[] {
  return entries.flatMap((entry) => {
    if (entry.phase !== 'draining' && alive(entry.pid)) return [entry];
    const children = entry.children.filter(alive);
    return children.length > 0 ? [{ ...entry, children, phase: 'draining' as const }] : [];
  });
}

/** All state publications and decisions use the same lock across worktrees. */
function edit<T>(dir: string, action: (entries: RecordEntry[]) => T): T {
  return locked(dir, () => {
    const file = join(dir, 'memory-queue.json');
    const previous = readJson<RecordEntry[]>(file, []);
    const entries = sweep(previous);
    const before = JSON.stringify(previous);
    const result = action(entries);
    const after = JSON.stringify(entries);
    if (before !== after) writeJson(file, entries);
    return result;
  });
}

function committed(entry: RecordEntry, kind: keyof RenderMemory, sample: MemorySample): number {
  // Only credit values from the same snapshot as the free memory figure.
  const observed = [entry.pid, ...entry.children].reduce((bytes, pid) => bytes + (sample.resident?.[pid] ?? 0), 0);
  return Math.max(0, entry.memory[kind] - observed);
}

function available(active: readonly RecordEntry[], sample: MemorySample, kind: keyof RenderMemory, floor: number): number {
  const outstanding = active.reduce((bytes, entry) => bytes + committed(entry, kind, sample), 0);
  return sample.free - floor - outstanding;
}

function capacity(config: QueueConfig, active: readonly RecordEntry[], sample: QueueMemory): QueueState['available'] {
  return {
    ram: available(active, sample.ram, 'ram', config.freeRamGb * GIB),
    vram: sample.vram ? available(active, sample.vram, 'vram', config.freeVramGb * GIB) : null,
  };
}

function drawingCount(active: readonly RecordEntry[], group: string): number {
  return active.filter((entry) => entry.phase === 'holding' && entry.draws && entry.group === group).length;
}

function memoryReason(need: RenderMemory, free: QueueState['available']): 'ram' | 'vram' | null {
  if (need.ram > free.ram) return 'ram';
  if (need.vram > 0 && (free.vram === null || need.vram > free.vram)) return 'vram';
  return null;
}

export class GpuMemoryUnavailableError extends Error {
  constructor() {
    super('Cannot read GPU memory. Select a device with SKINK3_GPU_INDEX, set SKINK3_GPU_BUDGET_GB, or use CPU drawing with x264.');
  }
}

function impossible(config: QueueConfig, need: RenderMemory, sample: QueueMemory): void {
  if (need.ram + config.freeRamGb * GIB > sample.ram.total) {
    throw new Error('The RAM reservation and free RAM floor exceed installed RAM');
  }
  if (need.vram <= 0) return;
  if (!sample.vram) throw new GpuMemoryUnavailableError();
  if (need.vram + config.freeVramGb * GIB > sample.vram.total) {
    throw new Error('The VRAM reservation and free VRAM floor exceed the GPU memory budget');
  }
}

/** Arrival order with room for fitting short work and a bounded bypass of an older eligible waiter. */
function nextEntry(active: readonly RecordEntry[], waiting: readonly RecordEntry[], free: QueueState['available'], now: number): RecordEntry | null {
  const eligible = waiting.filter((entry) => !entry.draws || drawingCount(active, entry.group) < GROUP_WORKERS);
  const oldest = eligible[0];
  if (!oldest) return null;
  if (!memoryReason(oldest.memory, free)) {
    if (oldest.short || now - oldest.since >= FAIRNESS_MS) return oldest;
    return eligible.find((entry) => entry.short && !memoryReason(entry.memory, free)) ?? oldest;
  }
  // Once due, reserve the scarce resource for the oldest request. Other jobs can still use a resource it does not need.
  const reason = memoryReason(oldest.memory, free);
  return eligible.slice(1).find((entry) => !memoryReason(entry.memory, free)
    && (now - oldest.since < FAIRNESS_MS || (reason === 'vram' && entry.memory.vram === 0))) ?? null;
}

function gb(bytes: number): string {
  return (Math.max(0, bytes) / GIB).toFixed(2) + ' GiB';
}

export function waitingLine(waiting: Waiting): string {
  if (waiting.reason === 'group') return 'waiting for group ' + waiting.group + ' (' + waiting.busy + '/' + GROUP_WORKERS + ' drawing workers)';
  if (waiting.reason === 'turn') return 'waiting for an earlier render request';
  const free = waiting.reason === 'ram' ? waiting.freeRam : waiting.freeVram;
  const need = waiting.reason === 'ram' ? waiting.needRam : waiting.needVram;
  return 'waiting for ' + waiting.reason.toUpperCase() + ' (' + gb(free ?? 0) + ' available to reserve, ' + gb(need) + ' needed)';
}

export async function acquireRenderLease(config: QueueConfig, request: PlaceRequest): Promise<RenderLease | null> {
  if (request.signal?.aborted) return null;
  if (!request.group.trim() || [request.memory.ram, request.memory.vram].some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error('A render reservation needs a group and nonnegative, finite memory estimates');
  }
  mkdirSync(config.dir, { recursive: true });
  const token = process.pid + '-' + randomBytes(8).toString('hex');
  const cancel = (): void => {
    edit(config.dir, (entries) => {
      const i = entries.findIndex((entry) => entry.token === token);
      if (i >= 0) entries.splice(i, 1);
    });
  };
  let admitted = false;
  let told = false;
  try {
    while (!request.signal?.aborted) {
      const result = edit(config.dir, (entries) => {
        const active = entries.filter((entry) => entry.phase !== 'waiting');
        const queued = entries.filter((entry) => entry.phase === 'waiting');
        const sample = memoryOf(config, request.memory.vram > 0 || queued.some((entry) => entry.memory.vram > 0), request.sample);
        impossible(config, request.memory, sample);
        const free = capacity(config, active, sample);
        let own = queued.find((entry) => entry.token === token);
        const now = Date.now();
        if (!own) {
          own = {
            token, pid: process.pid, group: request.group, what: request.what,
            since: Math.max(now, queued.at(-1)?.since ?? 0), draws: request.draws ?? true,
            short: request.short ?? false, phase: 'waiting', memory: request.memory, children: [],
          };
          entries.push(own);
          queued.push(own);
        }
        const busy = drawingCount(active, own.group);
        const wantsTurn = nextEntry(active, queued, free, now)?.token === token;
        if (wantsTurn) {
          entries[entries.indexOf(own)] = { ...own, phase: 'holding' };
          return null;
        }
        const reason = own.draws && busy >= GROUP_WORKERS ? 'group' : memoryReason(own.memory, free) ?? 'turn';
        return { reason, group: own.group, busy, freeRam: free.ram, freeVram: free.vram, needRam: own.memory.ram, needVram: own.memory.vram } satisfies Waiting;
      });
      if (result === null) {
        admitted = true;
        return hold(config, token, request);
      }
      if (!told) {
        told = true;
        request.onWait?.(result);
      }
      await new Promise<void>((done) => setTimeout(done, request.pollMs ?? ADMISSION_POLL_MS));
    }
    return null;
  } finally {
    if (!admitted) cancel();
  }
}

function hold(config: QueueConfig, token: string, request: PlaceRequest): RenderLease {
  let released = false;
  let pressureReported = false;
  const update = (action: (entries: RecordEntry[], i: number, own: RecordEntry) => void): void => {
    edit(config.dir, (entries) => {
      const i = entries.findIndex((entry) => entry.token === token);
      if (i >= 0) action(entries, i, entries[i]!);
    });
  };
  return {
    verify: (remainingRam = 0) => {
      if (released) return;
      let pressure: string | undefined;
      update((entries, i, own) => {
        const sample = memoryOf(config, own.memory.vram > 0, request.sample);
        const lowRam = sample.ram.free < config.freeRamGb * GIB;
        const lowVram = sample.vram && sample.vram.free < config.freeVramGb * GIB;
        if (!pressureReported && (lowRam || lowVram)) {
          pressureReported = true;
          pressure = own.what + ' measured below the free ' + (lowRam ? 'RAM' : 'VRAM') + ' floor during work';
        }
        const usedRam = sample.ram.resident ? [own.pid, ...own.children].reduce((sum, pid) => sum + (sample.ram.resident?.[pid] ?? 0), 0) : process.memoryUsage.rss();
        const usedVram = [own.pid, ...own.children].reduce((sum, pid) => sum + (sample.vram?.resident?.[pid] ?? 0), 0);
        const ram = Math.max(own.memory.ram, usedRam + remainingRam);
        const vram = Math.max(own.memory.vram, usedVram);
        if (ram === own.memory.ram && vram === own.memory.vram) return;
        const grown = { ...own, memory: { ram, vram } };
        const extra = {
          ram: committed(grown, 'ram', sample.ram) - committed(own, 'ram', sample.ram),
          vram: sample.vram ? committed(grown, 'vram', sample.vram) - committed(own, 'vram', sample.vram) : vram - own.memory.vram,
        };
        const free = capacity(config, entries.filter((entry) => entry.phase !== 'waiting'), sample);
        const reason = memoryReason(extra, { ram: Math.max(0, free.ram), vram: free.vram === null ? null : Math.max(0, free.vram) });
        if (reason) throw new Error(own.what + ' exceeded its ' + reason.toUpperCase() + ' estimate. Another ' + gb(extra[reason]) + ' is required, with ' + gb(free[reason] ?? 0) + ' available.');
        entries[i] = grown;
      });
      if (pressure) request.onPressure?.(pressure);
    },
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

export function queueState(config: QueueConfig, sample?: () => QueueMemory): QueueState {
  mkdirSync(config.dir, { recursive: true });
  return edit(config.dir, (entries) => {
    const active = entries.filter((entry) => entry.phase !== 'waiting');
    const waiting = entries.filter((entry) => entry.phase === 'waiting');
    const memory = memoryOf(config, true, sample);
    return { active, waiting, memory, available: capacity(config, active, memory) };
  });
}
