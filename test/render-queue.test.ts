// The render queue (src/render/queue.ts): a limit, for the whole machine, on the processes that draw on the GPU at
// once. These tests run separate processes against a slot directory of their own, never the machine's.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { chunkFrames, renderPlan } from '../src/render/parallel.ts';
import { acquireSlot, parsePriority, queueConfig, queueState, renderPriority, type Priority } from '../src/render/queue.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const HOLDER = join(ROOT, 'test', 'fixtures', 'queue-holder.ts');
const MINIMAL = join(ROOT, 'examples', 'minimal', 'scene.ts');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HolderOptions {
  dir: string;
  slots: number;
  priority: Priority;
  name: string;
  log: string;
  holdMs?: number;
  until?: string;
  agingMs?: number;
}

function holder(o: HolderOptions): ChildProcess {
  return spawn(process.execPath, [HOLDER, JSON.stringify(o)], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.on('close', (code) => resolve(code));
  });
}

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []);

/** The names in the order they took a slot. */
const takers = (log: string): string[] => lines(log).filter((l) => l.endsWith(' got')).map((l) => l.split(' ')[0]!);

function scratch(): { dir: string; slots: string; log: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-queue-'));
  return { dir, slots: join(dir, 'slots'), log: join(dir, 'log.txt'), done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

/** The files of a slot directory other than its lock. */
const leftInQueue = (slots: string): string[] => (existsSync(slots) ? readdirSync(slots).filter((f) => f !== 'lock') : []);

test('render queue: at most N processes hold a slot at once, across separate processes', async () => {
  const t = scratch();
  try {
    const procs = Array.from({ length: 6 }, (_, i) => holder({ dir: t.slots, slots: 2, priority: 'high', name: `p${i}`, log: t.log, holdMs: 600 }));
    assert.deepEqual(await Promise.all(procs.map(exited)), [0, 0, 0, 0, 0, 0]);
    // "got" is written after a slot is taken and "done" before it is given back, so the log never shows more at once
    // than there were.
    let held = 0;
    let most = 0;
    for (const line of lines(t.log)) {
      if (line.endsWith(' got')) most = Math.max(most, ++held);
      if (line.endsWith(' done')) held--;
    }
    assert.equal(most, 2, 'two at once: never more, and the queue holds nobody back while a slot is free');
    assert.equal(takers(t.log).length, 6, 'everyone was served');
    assert.deepEqual(leftInQueue(t.slots), [], 'every slot and ticket was given back');
  } finally {
    t.done();
  }
});

test('render queue: the slot of a killed holder is free at once; so is one nobody refreshes, and a lock left behind', async () => {
  const t = scratch();
  const config = { slots: 1, dir: t.slots };
  const take = async (): Promise<number> => {
    const t0 = performance.now();
    const slot = await acquireSlot(config, { priority: 'high', what: 'test', pollMs: 20 });
    assert.ok(slot, 'the queue is on');
    slot.release();
    return performance.now() - t0;
  };
  try {
    const k = holder({ dir: t.slots, slots: 1, priority: 'high', name: 'k', log: t.log, holdMs: -1 });
    await until(() => takers(t.log).includes('k'), 'the holder to take its slot');
    assert.equal(queueState(config).held[0]?.pid, k.pid, 'while it runs, the slot is its own');
    k.kill('SIGKILL');
    await exited(k);
    assert.ok(existsSync(join(t.slots, 'slot-0')), 'a killed process cannot clean up: its slot file is left');
    assert.equal(queueState(config).held[0], null, 'but it counts as free');
    assert.ok((await take()) < 2000, 'and the next process takes it at once');

    // A slot whose process number runs (this very process) but that nobody has refreshed for ten minutes: the number
    // has been given to another process since.
    writeFileSync(join(t.slots, 'slot-0'), JSON.stringify({ pid: process.pid, token: 'old', priority: 'low', since: 0, what: 'old' }));
    const old = (Date.now() - 600_000) / 1000;
    utimesSync(join(t.slots, 'slot-0'), old, old);
    assert.ok((await take()) < 2000, 'a slot nobody refreshes is taken for gone');

    // The lock of the directory, left by a process that died holding it.
    writeFileSync(join(t.slots, 'lock'), String(k.pid));
    assert.ok((await take()) < 2000, 'a lock of a dead process does not block');
    assert.deepEqual(leftInQueue(t.slots), []);
  } finally {
    t.done();
  }
});

test('render queue: quick work goes first, each class in its order of arrival', async () => {
  const t = scratch();
  const go = join(t.dir, 'go');
  try {
    const first = holder({ dir: t.slots, slots: 1, priority: 'high', name: 'h', log: t.log, until: go });
    await until(() => takers(t.log).includes('h'), 'the first holder');
    const procs: ChildProcess[] = [];
    // One after the other, each once the one before waits: their order of arrival is known.
    for (const [name, priority] of [['l1', 'low'], ['q1', 'high'], ['l2', 'low'], ['q2', 'high']] as const) {
      procs.push(holder({ dir: t.slots, slots: 1, priority, name, log: t.log, holdMs: 30 }));
      await until(() => lines(t.log).includes(`${name} waits`), `${name} to wait`);
    }
    assert.deepEqual(queueState({ slots: 1, dir: t.slots }).waiting.map((w) => w.what), ['q1', 'q2', 'l1', 'l2'], 'the turns while they wait');
    writeFileSync(go, '');
    assert.deepEqual(await Promise.all([first, ...procs].map(exited)), [0, 0, 0, 0, 0]);
    assert.deepEqual(takers(t.log), ['h', 'q1', 'q2', 'l1', 'l2']);
    assert.deepEqual(leftInQueue(t.slots), []);
  } finally {
    t.done();
  }
});

test('render queue: a low waiter is served in the end, however much quick work comes after it', async () => {
  const t = scratch();
  const go = join(t.dir, 'go');
  const agingMs = 400;
  try {
    const first = holder({ dir: t.slots, slots: 1, priority: 'high', name: 'h', log: t.log, until: go, agingMs });
    await until(() => takers(t.log).includes('h'), 'the first holder');
    const procs: ChildProcess[] = [];
    for (const [name, priority] of [['low', 'low'], ['q1', 'high'], ['q2', 'high'], ['q3', 'high']] as const) {
      procs.push(holder({ dir: t.slots, slots: 1, priority, name, log: t.log, holdMs: 30, agingMs }));
      await until(() => lines(t.log).includes(`${name} waits`), `${name} to wait`);
    }
    const config = { slots: 1, dir: t.slots };
    assert.deepEqual(queueState(config, 1e9).waiting.map((w) => w.what), ['q1', 'q2', 'q3', 'low'], 'before it has waited long enough');
    assert.deepEqual(queueState(config, 0).waiting.map((w) => w.what), ['low', 'q1', 'q2', 'q3'], 'after');
    await sleep(agingMs + 200);
    writeFileSync(go, '');
    assert.deepEqual(await Promise.all([first, ...procs].map(exited)), [0, 0, 0, 0, 0]);
    assert.deepEqual(takers(t.log), ['h', 'low', 'q1', 'q2', 'q3'], 'it came first of all that waited, by its arrival');
  } finally {
    t.done();
  }
});

test('render queue: its settings, and SKINK3_RENDER_SLOTS=0 turns it off', async () => {
  assert.equal(queueConfig({}).slots, 3, 'three slots unless set');
  assert.equal(queueConfig({ SKINK3_RENDER_SLOTS: '0' }).slots, 0);
  assert.equal(queueConfig({ SKINK3_RENDER_SLOTS: ' 5 ' }).slots, 5);
  assert.equal(queueConfig({ SKINK3_SLOT_DIR: 'somewhere' }).dir, 'somewhere');
  assert.ok(queueConfig({}).dir.includes('skink3'), 'a directory of the user outside any repository');
  assert.throws(() => queueConfig({ SKINK3_RENDER_SLOTS: 'two' }), /SKINK3_RENDER_SLOTS must be a whole number of render slots, 0 for no limit; got "two"/);
  assert.throws(() => queueConfig({ SKINK3_RENDER_SLOTS: '-1' }), /SKINK3_RENDER_SLOTS must be a whole number/);
  assert.equal(parsePriority('low', '--priority'), 'low');
  assert.equal(parsePriority(undefined, '--priority'), undefined);
  assert.throws(() => parsePriority('urgent', '--priority'), /--priority must be high or low, got "urgent"/);
  assert.equal(renderPriority(1920), 'high', 'a preview is quick work');
  assert.equal(renderPriority(3840), 'low', 'a master is long work');
  const t = scratch();
  try {
    assert.equal(await acquireSlot({ slots: 0, dir: t.slots }, { priority: 'high', what: 'test' }), null, 'no limit: nothing to wait for');
    assert.equal(existsSync(t.slots), false, 'and nothing is written');
    // A wait given up leaves no ticket.
    const first = await acquireSlot({ slots: 1, dir: t.slots }, { priority: 'high', what: 'first' });
    const abort = new AbortController();
    const second = acquireSlot({ slots: 1, dir: t.slots }, { priority: 'high', what: 'second', pollMs: 20, signal: abort.signal });
    await until(() => queueState({ slots: 1, dir: t.slots }).waiting.length === 1, 'the second to wait');
    abort.abort();
    assert.equal(await second, null);
    assert.equal(queueState({ slots: 1, dir: t.slots }).waiting.length, 0);
    first?.release();
    assert.deepEqual(leftInQueue(t.slots), []);
  } finally {
    t.done();
  }
});

test('render queue: a still waits for the slot and says so once; with the queue off or on the CPU it does not wait', async () => {
  const t = scratch();
  const go = join(t.dir, 'go');
  const still = (...extra: string[]): string[] => [CLI, 'still', MINIMAL, '--frame', '60', '--width', '320', '--hash', '--cache', join(t.dir, 'cache'), ...extra];
  const env = (slots: string): NodeJS.ProcessEnv => ({ ...process.env, SKINK3_SLOT_DIR: t.slots, SKINK3_RENDER_SLOTS: slots });
  const sha = (out: string): string | undefined => /sha256 ([0-9a-f]{64})/.exec(out)?.[1];
  try {
    const first = holder({ dir: t.slots, slots: 1, priority: 'high', name: 'h', log: t.log, until: go });
    await until(() => takers(t.log).includes('h'), 'the holder');
    const off = spawnSync(process.execPath, still(), { cwd: t.dir, env: env('0'), encoding: 'utf8' });
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /waiting/, 'SKINK3_RENDER_SLOTS=0: no queue');
    const cpu = spawnSync(process.execPath, still('--cpu'), { cwd: t.dir, env: env('1'), encoding: 'utf8' });
    assert.equal(cpu.status, 0, cpu.stderr);
    assert.doesNotMatch(cpu.stdout, /waiting/, 'the CPU takes no slot');
    const none = spawnSync(process.execPath, [CLI, 'trail', MINIMAL, '--node', 'nobody', '--cache', join(t.dir, 'cache')], { cwd: t.dir, env: env('1'), encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.doesNotMatch(none.stdout, /waiting/, 'a command that stops before it draws never waits');

    const on = spawn(process.execPath, still(), { cwd: t.dir, env: env('1'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    on.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    on.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    await until(() => out.includes('waiting for a render slot: 1 of 1 busy'), 'the still to say that it waits');
    assert.equal(queueState({ slots: 1, dir: t.slots }).waiting.length, 1);
    writeFileSync(go, '');
    assert.equal(await exited(on), 0, out);
    assert.equal(await exited(first), 0);
    assert.equal(out.match(/waiting for a render slot/g)?.length, 1, 'said once');
    assert.equal(sha(out), sha(off.stdout), 'the same pixels, waited for or not');
    assert.deepEqual(leftInQueue(t.slots), []);
  } finally {
    t.done();
  }
});

test('render plan: chunks in a multiple of the workers at once, none longer than asked, one after the other', () => {
  const cases: [number, number, number, number, number][] = [
    [0, 900, 4, 3, 225],
    [10, 1000, 8, 3, 900],
    [0, 3600, 4, 3, 225],
    [0, 120, 4, 0, 14400],
    [0, 5, 8, 3, 2],
    [0, 100, 4, 3, 0],
    [0, 1, 4, 3, 900],
  ];
  for (const [from, to, workers, slots, chunk] of cases) {
    const p = renderPlan(from, to, workers, { slots, chunk });
    const name = `${from}..${to} with ${workers} workers, ${slots} slots, chunks of ${chunk}`;
    assert.equal(p.chunks[0]!.from, from, name);
    assert.equal(p.chunks.at(-1)!.to, to, name);
    p.chunks.forEach((c, i) => {
      assert.ok(c.to > c.from, `${name}: chunk ${i} is not empty`);
      if (i > 0) assert.equal(c.from, p.chunks[i - 1]!.to, `${name}: chunk ${i} follows the one before`);
      if (chunk > 0) assert.ok(c.to - c.from <= chunk, `${name}: chunk ${i} is not longer than ${chunk}`);
    });
    assert.equal(p.atOnce, Math.min(workers, to - from, slots > 0 ? slots : Infinity), name);
    if (chunk > 0 && p.chunks.length < to - from) assert.equal(p.chunks.length % p.atOnce, 0, `${name}: a multiple of the workers at once`);
  }
  assert.equal(renderPlan(0, 120, 4, { slots: 0, chunk: 14400 }).chunks.length, 4, 'a short render without a queue: one chunk per worker, as ever');
  assert.equal(renderPlan(0, 100, 4, { slots: 3, chunk: 0 }).chunks.length, 4, 'chunk 0: one chunk per worker');
  assert.equal(renderPlan(0, 3600, 4, { slots: 3, chunk: 225 }).chunks.length, 18);
  assert.equal(chunkFrames(1920), 900);
  assert.equal(chunkFrames(3840), 225, 'as many pixels at 4K');
});

test('render queue: a render has the same frames with the queue on and off, in any chunks, and says once that it waits', { skip: !ffmpegAvailable() }, async () => {
  const t = scratch();
  const go = join(t.dir, 'go');
  const args = (out: string, ...extra: string[]): string[] => [CLI, 'render', MINIMAL, '--width', '320', '--hashes', '--cache', join(t.dir, 'cache'), '--out', join(t.dir, out), ...extra];
  const env = (slots: string): NodeJS.ProcessEnv => ({ ...process.env, SKINK3_SLOT_DIR: t.slots, SKINK3_RENDER_SLOTS: slots });
  const hashes = (out: string): string => readFileSync(join(t.dir, `${out}.hashes.txt`), 'utf8');
  try {
    const one = spawnSync(process.execPath, args('one.mp4', '--workers', '1', '--chunk', '0'), { cwd: t.dir, env: env('0'), encoding: 'utf8' });
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /1 worker\(s\), 1 chunk\(s\)/);
    assert.equal(hashes('one.mp4').trim().split('\n').length, 240);

    const many = spawnSync(process.execPath, args('many.mp4', '--workers', '3', '--chunk', '7'), { cwd: t.dir, env: env('2'), encoding: 'utf8' });
    assert.equal(many.status, 0, many.stderr);
    assert.match(many.stdout, /2 worker\(s\) at once \(3 asked, 2 render slots\), 36 chunk\(s\)/);
    assert.equal(hashes('many.mp4'), hashes('one.mp4'), '36 chunks, two at a time, against one chunk without a queue');

    // The one slot is taken: the render waits, says so once, and goes on when it is given back.
    const first = holder({ dir: t.slots, slots: 1, priority: 'high', name: 'h', log: t.log, until: go });
    await until(() => takers(t.log).includes('h'), 'the holder');
    const queued = spawn(process.execPath, args('queued.mp4', '--workers', '2'), { cwd: t.dir, env: env('1'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    queued.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    queued.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    await until(() => out.includes('waiting for a render slot: 1 of 1 busy'), 'the render to say that it waits');
    writeFileSync(go, '');
    assert.equal(await exited(queued), 0, out);
    assert.equal(await exited(first), 0);
    assert.match(out, /1 worker\(s\) at once \(2 asked, 1 render slots\), 1 chunk\(s\)/);
    assert.equal(out.match(/waiting for a render slot/g)?.length, 1, 'said once');
    assert.equal(hashes('queued.mp4'), hashes('one.mp4'));
    assert.deepEqual(leftInQueue(t.slots), []);
  } finally {
    t.done();
  }
});
