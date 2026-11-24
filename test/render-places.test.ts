// The place queue (macOS's render queue) and the selector, tested on every system: synthetic contenders in temporary
// queue directories, an injected platform and injected memory pressure; the commands started here draw on the CPU.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireRenderLease, admissionWaitingLine, queueKind } from '../src/render/admission.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { GIB } from '../src/render/memory.ts';
import {
  acquirePlace, DEFAULT_MAC_RENDERS, DEFAULT_MAC_SHORT, placesConfig, placesState, placeWaitingLine,
  type Lane, type PlacesConfig, type PlaceWaiting, type PressureLevel,
} from '../src/render/places.ts';
import { acquireRenderLease as acquireMemoryLease, queueConfig, queueState, waitingLine, type QueueMemory, type RenderLease, type Waiting } from '../src/render/queue.ts';

const CLI = fileURLToPath(new URL('../bin/skink3.mjs', import.meta.url));
const HOLDER = fileURLToPath(new URL('./fixtures/place-holder.ts', import.meta.url));
const MINIMAL = fileURLToPath(new URL('../examples/minimal/scene.ts', import.meta.url));

async function until(read: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 12_000;
  while (!read()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for ' + what);
    await setTimeout(15);
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

const normal = (): PressureLevel => 1;

function scratch(limits: { long: number; short: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-place-queue-'));
  const config: PlacesConfig = { dir: join(dir, 'slots'), ...limits };
  const children: ChildProcess[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env, SKINK3_QUEUE: 'places', SKINK3_SLOT_DIR: config.dir,
    SKINK3_MAC_RENDERS: String(limits.long), SKINK3_MAC_SHORT: String(limits.short),
  };
  delete env['SKINK3_TEST_FAIL_AT_FRAME'];
  const state = () => placesState(config, normal);
  const child = (args: string[]): ChildProcess => {
    const proc = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
    proc.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    children.push(proc);
    return proc;
  };
  /** A request of this process: admitted, the lease, and what it was told while it waited. */
  const ask = (what: string, lane: Lane, pressure: () => PressureLevel = normal, signal?: AbortSignal) => {
    const waits: PlaceWaiting[] = [];
    let lease: RenderLease | null | undefined;
    const promise = acquirePlace(config, { what, lane, pressure, pollMs: 10, onWait: (w) => waits.push(w), signal });
    void promise.then((l) => { lease = l; });
    return { promise, waits, admitted: () => lease !== undefined && lease !== null, lease: () => lease! };
  };
  /** A request of another process, which can be killed. */
  const holder = (name: string, lane: Lane, encoder?: number) => {
    const release = join(dir, 'release-' + name);
    const proc = child([HOLDER, JSON.stringify({ config, name, lane, until: release, child: encoder })]);
    proc.stdout?.resume();
    let admitted = false;
    proc.on('message', (message: { admitted?: string }) => { admitted ||= message.admitted === name; });
    return { proc, release: () => writeFileSync(release, ''), admitted: () => until(() => admitted, name + ' admission') };
  };
  const done = async (): Promise<void> => {
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await Promise.all(children.map(exited));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  };
  return { dir, config, env, state, child, ask, holder, done };
}

test('place queue: macOS takes places, every other system the memory queue, and SKINK3_QUEUE overrides the choice', () => {
  assert.equal(queueKind({}, 'darwin'), 'places');
  assert.equal(queueKind({}, 'win32'), 'memory');
  assert.equal(queueKind({}, 'linux'), 'memory');
  assert.equal(queueKind({ SKINK3_QUEUE: 'memory' }, 'darwin'), 'memory');
  assert.equal(queueKind({ SKINK3_QUEUE: ' places ' }, 'win32'), 'places');
  assert.equal(queueKind({ SKINK3_QUEUE: '' }, 'win32'), 'memory');
  assert.throws(() => queueKind({ SKINK3_QUEUE: 'slots' }, 'darwin'), /SKINK3_QUEUE must be memory or places/);
  const defaults = placesConfig({ SKINK3_SLOT_DIR: '/tmp/q' });
  assert.deepEqual([defaults.long, defaults.short, DEFAULT_MAC_RENDERS, DEFAULT_MAC_SHORT], [4, 4, 4, 4]);
  assert.equal(defaults.dir, queueConfig({ SKINK3_SLOT_DIR: '/tmp/q' }).dir, 'both queues share the slot directory');
  const set = placesConfig({ SKINK3_MAC_RENDERS: '2', SKINK3_MAC_SHORT: '6' });
  assert.deepEqual([set.long, set.short], [2, 6]);
  for (const bad of ['0', '-1', '1.5', 'four']) assert.throws(() => placesConfig({ SKINK3_MAC_RENDERS: bad }), /SKINK3_MAC_RENDERS must be a positive integer/);
  // The waiting line of each queue is the line that queue writes.
  const memoryWait: Waiting = { reason: 'ram', group: 'g', busy: 1, freeRam: GIB, freeVram: null, needRam: 2 * GIB, needVram: 0 };
  assert.equal(admissionWaitingLine(memoryWait), waitingLine(memoryWait));
  const placeWait: PlaceWaiting = { queue: 'places', reason: 'lane', lane: 'long', busy: 4, limit: 4, ahead: 2, pressure: null };
  assert.equal(admissionWaitingLine(placeWait), 'waiting for a long place (4/4 held, 2 earlier in line)');
  assert.equal(placeWaitingLine({ ...placeWait, lane: 'short', busy: 1, ahead: 0 }), 'waiting for a short place (1/4 held)');
});

test('place queue: each lane holds its own limit, short work passes waiting long work, and a lane is first come first served', async () => {
  const t = scratch({ long: 2, short: 1 });
  try {
    const order: string[] = [];
    const long = ['L1', 'L2', 'L3', 'L4', 'L5'].map((name) => {
      const request = t.ask(name, 'long');
      void request.promise.then(() => order.push(name));
      return request;
    });
    await Promise.all([long[0]!.promise, long[1]!.promise]);
    await until(() => long.slice(2).every((r) => r.waits.length === 1), 'three long requests to wait');
    assert.deepEqual(long.slice(2).map((r) => [r.waits[0]!.reason, r.waits[0]!.busy, r.waits[0]!.ahead]), [['lane', 2, 0], ['lane', 2, 1], ['lane', 2, 2]]);
    assert.equal(placeWaitingLine(long[4]!.waits[0]!), 'waiting for a long place (2/2 held, 2 earlier in line)');
    // Short work is admitted at once while long work waits; the short lane has a limit of its own.
    const s1 = t.ask('S1', 'short');
    assert.ok(await s1.promise);
    const s2 = t.ask('S2', 'short');
    await until(() => s2.waits.length === 1, 'the second short request to wait');
    assert.deepEqual([s2.waits[0]!.lane, s2.waits[0]!.busy, s2.waits[0]!.limit], ['short', 1, 1]);
    const lanes = t.state();
    assert.deepEqual([lanes.long.active.length, lanes.long.waiting.length, lanes.short.active.length, lanes.short.waiting.length], [2, 3, 1, 1]);
    assert.deepEqual(lanes.long.waiting.map((e) => e.what), ['L3', 'L4', 'L5']);
    // A freed place goes to the earliest waiter of its lane, and to no one behind it.
    long[0]!.lease().release();
    await long[2]!.promise;
    await setTimeout(80);
    assert.deepEqual([long[3]!.admitted(), long[4]!.admitted(), s2.admitted()], [false, false, false]);
    long[1]!.lease().release();
    await long[3]!.promise;
    long[2]!.lease().release();
    await long[4]!.promise;
    assert.deepEqual(order, ['L1', 'L2', 'L3', 'L4', 'L5']);
    s1.lease().release();
    await s2.promise;
    for (const r of [long[3]!, long[4]!, s2]) r.lease().release();
    const empty = t.state();
    assert.deepEqual([empty.long.active, empty.long.waiting, empty.short.active, empty.short.waiting], [[], [], [], []]);
  } finally { await t.done(); }
});

test('place queue: a dead holder frees its place, but not while an encoder it tracks still runs', async () => {
  const t = scratch({ long: 1, short: 1 });
  try {
    const encoder = t.child(['-e', 'setInterval(() => {}, 100)']);
    assert.ok(encoder.pid);
    const holder = t.holder('render-worker', 'long', encoder.pid);
    await holder.admitted();
    const short = t.holder('still', 'short');
    await short.admitted();
    const nextLong = t.ask('next-long', 'long');
    const nextShort = t.ask('next-short', 'short');
    await until(() => nextLong.waits.length === 1 && nextShort.waits.length === 1, 'both lanes to be full');
    short.proc.kill('SIGKILL');
    await exited(short.proc);
    await nextShort.promise;
    holder.proc.kill('SIGKILL');
    await exited(holder.proc);
    assert.deepEqual(t.state().long.active.map((e) => [e.what, e.phase]), [['render-worker', 'draining']]);
    await setTimeout(80);
    assert.equal(nextLong.admitted(), false, 'the encoder of a dead worker keeps its place');
    encoder.kill('SIGKILL');
    await exited(encoder);
    await nextLong.promise;
    nextLong.lease().release();
    nextShort.lease().release();
  } finally { await t.done(); }
});

test('place queue: memory pressure above normal holds every new place back without failing, then admits', async () => {
  const t = scratch({ long: 4, short: 4 });
  let level: PressureLevel = 2;
  const read = (): PressureLevel => level;
  try {
    const long = t.ask('long', 'long', read);
    const short = t.ask('short', 'short', read);
    await until(() => long.waits.length === 1 && short.waits.length === 1, 'both requests to wait');
    assert.deepEqual([long.waits[0]!.reason, long.waits[0]!.pressure, short.waits[0]!.reason], ['pressure', 2, 'pressure']);
    assert.equal(placeWaitingLine(long.waits[0]!), 'waiting for memory pressure to return to normal (macOS reports warn)');
    level = 4;
    await setTimeout(80);
    assert.deepEqual([long.admitted(), short.admitted()], [false, false]);
    assert.equal(t.state().long.waiting.length, 1);
    level = 1;
    await Promise.all([long.promise, short.promise]);
    // A level that cannot be read admits as normal pressure does.
    level = null;
    const unread = t.ask('unread', 'long', read);
    assert.ok(await unread.promise);
    assert.equal(unread.waits.length, 0);
    for (const r of [long, short, unread]) r.lease().release();
    // The pressure macOS reports is sampled for the whole directory; elsewhere it cannot be read.
    const sampled = placesState(t.config).pressure;
    if (process.platform === 'darwin') assert.ok(sampled !== null && sampled >= 1, 'macOS reports its memory pressure');
    else assert.ok(sampled === null || sampled >= 1);
    assert.deepEqual(JSON.parse(readFileSync(join(t.config.dir, 'places-pressure.json'), 'utf8')).level, sampled);
  } finally { await t.done(); }
});

test('place queue: an aborted wait leaves nothing behind, and a memory queue in the same directory does not count', async () => {
  const t = scratch({ long: 1, short: 1 });
  try {
    // A memory queue holding all the memory of the machine, in the same directory, under the same lock.
    const memory: QueueMemory = { ram: { free: 8 * GIB, total: 64 * GIB, source: 'test' }, vram: null };
    const memoryConfig = { ...queueConfig({}), dir: t.config.dir, freeRamGb: 0 };
    const reserved = await acquireMemoryLease(memoryConfig, { group: 'g', what: 'memory holder', memory: { ram: 8 * GIB, vram: 0 }, sample: () => memory });
    assert.ok(reserved);
    const first = t.ask('first', 'long');
    assert.ok(await first.promise, 'a memory queue entry takes no place');
    assert.equal(queueState(memoryConfig, () => memory).active.length, 1, 'and a place takes nothing from the memory queue');
    reserved.release();
    const cancel = new AbortController();
    const second = t.ask('second', 'long', normal, cancel.signal);
    await until(() => second.waits.length === 1, 'the second request to wait');
    cancel.abort();
    assert.equal(await second.promise, null);
    assert.deepEqual(t.state().long.waiting, []);
    first.lease().release();
    assert.deepEqual(t.state().long.active, []);
  } finally { await t.done(); }
});

test('place queue: the selector lets work that draws nothing through and gives short and long places', async () => {
  const t = scratch({ long: 1, short: 1 });
  const before = process.env['SKINK3_QUEUE'];
  try {
    process.env['SKINK3_QUEUE'] = 'places';
    const config = { ...queueConfig({}), dir: t.config.dir };
    const none = await acquireRenderLease(config, { group: 'g', what: 'scene preflight', memory: { ram: 0, vram: 0 }, draws: false });
    assert.ok(none);
    const short = await acquireRenderLease(config, { group: 'g', what: 'still', memory: { ram: 0, vram: 0 }, short: true });
    const long = await acquireRenderLease(config, { group: 'g', what: 'render worker', memory: { ram: 0, vram: 0 } });
    const lanes = t.state();
    assert.deepEqual([lanes.short.active.map((e) => e.what), lanes.long.active.map((e) => e.what)], [['still'], ['render worker']]);
    for (const lease of [none, short, long]) lease?.release();
    assert.deepEqual([t.state().short.active, t.state().long.active], [[], []]);
  } finally {
    if (before === undefined) delete process.env['SKINK3_QUEUE'];
    else process.env['SKINK3_QUEUE'] = before;
    await t.done();
  }
});

test('place queue: through the CLI, commands that draw nothing pass, a still takes a short place, and the queue shows both lanes', async () => {
  const t = scratch({ long: 1, short: 1 });
  try {
    const long = t.ask('long holder', 'long');
    const short = t.ask('short holder', 'short');
    await Promise.all([long.promise, short.promise]);
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: t.dir, env: t.env, encoding: 'utf8' });
    const checked = run(['check', MINIMAL]);
    assert.equal(checked.status, 0, checked.stderr);
    const shown = run(['queue']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /places: 1 long, 1 short; memory pressure (normal|warn|critical|unknown)/);
    assert.match(shown.stdout, /^long: 1\/1 held, 0 waiting\n {2}holding {2}pid \d+ {2}long holder$/m);
    assert.match(shown.stdout, /^short: 1\/1 held, 0 waiting\n {2}holding {2}pid \d+ {2}short holder$/m);
    // A still waits for a short place, not for the long lane.
    const still = t.child([CLI, 'still', MINIMAL, '--cpu', '--frame', '0', '--width', '128', '--hash']);
    let out = '';
    still.stdout?.on('data', (data: Buffer) => { out += data.toString(); });
    await until(() => t.state().short.waiting.some((e) => e.pid === still.pid), 'the still to wait for a short place');
    assert.equal(t.state().short.waiting[0]!.what, 'still minimal/scene.ts 128x72');
    await until(() => out.includes('waiting for a short place (1/1 held)'), 'the waiting line of the still');
    short.lease().release();
    assert.equal(await exited(still), 0);
    assert.match(out, /frame 0 {2}.+ {2}sha256 [0-9a-f]{64}/);
    const quick = run(['still', MINIMAL, '--cpu', '--frame', '0', '--width', '128']);
    assert.equal(quick.status, 0, quick.stderr);
    assert.doesNotMatch(quick.stdout, /waiting/, 'a still is admitted at once while the long lane is full');
    long.lease().release();
  } finally { await t.done(); }
});

test('place queue: a render takes one long place for each worker, one worker by default, and its parent takes none', { skip: !ffmpegAvailable() }, async () => {
  const t = scratch({ long: 1, short: 1 });
  try {
    const long = t.ask('long holder', 'long');
    assert.ok(await long.promise);
    const render = t.child([CLI, 'render', MINIMAL, '--cpu', '--width', '128', '--to', '12', '--chunk', '4', '--hashes', '--out', join(t.dir, 'clip.mp4')]);
    let out = '';
    render.stdout?.on('data', (data: Buffer) => { out += data.toString(); });
    await until(() => t.state().long.waiting.length === 1, 'the first worker to wait for a long place');
    const lanes = t.state();
    assert.match(lanes.long.waiting[0]!.what, /^_chunk minimal\/scene\.ts 128x72 frames 0\.\.3$/);
    assert.ok(![...lanes.long.active, ...lanes.long.waiting, ...lanes.short.active].some((e) => e.pid === render.pid), 'the parent holds no place');
    await until(() => out.includes('waiting for a long place (1/1 held)'), 'the waiting line of the render');
    assert.match(out, /1 worker\(s\), 3 chunk\(s\)/);
    long.lease().release();
    assert.equal(await exited(render), 0);
    assert.equal(readFileSync(join(t.dir, 'clip.mp4.hashes.txt'), 'utf8').trim().split('\n').length, 12);
    assert.deepEqual([t.state().long.active, t.state().long.waiting], [[], []]);
  } finally { await t.done(); }
});
