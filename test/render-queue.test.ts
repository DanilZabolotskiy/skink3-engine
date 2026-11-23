// Synthetic holders use private directories and never draw on the production GPU.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { startMasterGpuJob } from '../src/render/master-gpu.ts';
import { chunkFrames, renderPlan } from '../src/render/parallel.ts';
import { acquireCpuPlace, queueConfig, queueState, takeGpuPlace, useGpuPlaces, type QueueConfig } from '../src/render/queue.ts';

const CLI = fileURLToPath(new URL('../bin/skink3.mjs', import.meta.url));
const HOLDER = fileURLToPath(new URL('./fixtures/queue-holder.ts', import.meta.url));
const MINIMAL = fileURLToPath(new URL('../examples/minimal/scene.ts', import.meta.url));
const GiB = 2 ** 30;

async function until(read: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!read()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

function scratch(options: Partial<QueueConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-queue-'));
  const config = { ...queueConfig({}), freeRamGb: 0, dir: join(dir, 'slots'), ...options };
  const log = join(dir, 'log.txt');
  const children: ChildProcess[] = [];
  const state = () => queueState(config);
  const logs = (): string[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [];
  const note = (line: string) => until(() => logs().includes(line), line);
  const remaining = () => existsSync(config.dir) ? readdirSync(config.dir) : [];
  const holder = (name: string, mode: string, opts: Record<string, unknown> = {}, env = process.env): ChildProcess => {
    const child = spawn(process.execPath, [HOLDER, JSON.stringify({ config, log, name, mode, ...opts })], { stdio: ['ignore', 'ignore', 'inherit'], env });
    children.push(child);
    return child;
  };
  const done = async (): Promise<void> => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(exited));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  };
  return { dir, config, state, logs, note, remaining, holder, done };
}

test('render queue defaults, overrides and legacy opt-outs', async () => {
  const defaults = queueConfig({});
  assert.deepEqual([defaults.cpu, defaults.light, defaults.gpu, defaults.masterGpu, defaults.freeRamGb], [10, 6, 6, 4, 8]);
  const off = queueConfig({ SKINK3_RENDER_SLOTS: '0' });
  assert.deepEqual([off.cpu, off.light, off.gpu, off.masterGpu, off.freeRamGb], [0, 0, 0, 0, 0]);
  assert.equal(queueConfig({ SKINK3_RENDER_SLOTS: '5' }).gpu, 5);
  assert.equal(queueConfig({ SKINK3_MASTER_GPU_PLACES: '30' }).masterGpu, 4);
  assert.throws(() => queueConfig({ SKINK3_LIGHT_PLACES: '-1' }), /SKINK3_LIGHT_PLACES/);
  const t = scratch({ masterGpu: 0 });
  try {
    assert.equal(await startMasterGpuJob({ workers: 1, what: 'off' }, t.config), null);
    assert.deepEqual(t.remaining(), []);
  } finally { await t.done(); }
});

test('heavy jobs enter in order within their share and light enters independently', async () => {
  const t = scratch({ cpu: 2, light: 1 });
  const hold = join(t.dir, 'end');
  const aGo = join(t.dir, 'a-go');
  const lightGo = join(t.dir, 'l-go');
  try {
    const a = t.holder('a', 'heavy', { job: 'a', until: aGo });
    await t.note('a got');
    const a2 = t.holder('a2', 'heavy', { job: 'a', until: hold });
    await t.note('a2 got');
    const a3 = t.holder('a3', 'heavy', { job: 'a' });
    await t.note('a3 waits');
    const b = t.holder('b', 'heavy', { until: hold });
    await t.note('b waits');
    const c = t.holder('c', 'heavy');
    await t.note('c waits');
    const l = t.holder('l', 'light', { until: lightGo });
    await t.note('l got');
    const l2 = t.holder('l2', 'light');
    await t.note('l2 waits');
    writeFileSync(lightGo, '');
    await t.note('l2 got');
    writeFileSync(aGo, '');
    await t.note('b got');
    assert.ok(!t.logs().includes('a3 got'));
    assert.ok(!t.logs().includes('c got'));
    writeFileSync(hold, '');
    assert.deepEqual(await Promise.all([a, a2, a3, b, c, l, l2].map(exited)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(t.remaining(), []);
  } finally { await t.done(); }
});

test('the RAM floor applies to the first process and counts starts across both lanes', async () => {
  const t = scratch({ freeRamGb: 8 });
  let free = 7 * GiB;
  const freeMemory = (): number => free;
  const abort = new AbortController();
  try {
    const pending = acquireCpuPlace(t.config, { what: 'first', pollMs: 10, freeMemory });
    await until(() => t.state().cpu.waiting.length === 1, 'the first worker below 8 GiB');
    assert.equal(t.state().cpu.busy, 0);
    free = 9 * GiB;
    const first = await pending;
    assert.ok(first);
    const secondP = acquireCpuPlace(t.config, { lane: 'light', what: 'second', pollMs: 10, freeMemory });
    await until(() => t.state().light.waiting.length === 1, 'light behind the RAM reservation');
    first.loaded();
    const second = await secondP;
    assert.ok(second);
    const canceled = acquireCpuPlace(t.config, { what: 'cancel', pollMs: 10, freeMemory, signal: abort.signal });
    await until(() => t.state().cpu.waiting.length === 1, 'third waiter');
    abort.abort();
    assert.equal(await canceled, null);
    first.release();
    second.release();
    assert.deepEqual(t.remaining(), []);
  } finally { await t.done(); }
});

test('killed heavy and GPU holders leave recoverable places', async () => {
  const t = scratch({ cpu: 1, gpu: 1, masterGpu: 0 });
  try {
    for (const lane of ['heavy', 'gpu'] as const) {
      const dead = t.holder(lane + '-holder', lane, { until: join(t.dir, 'never') });
      await t.note(lane + '-holder got');
      dead.kill('SIGKILL');
      await exited(dead);
      assert.equal(t.state()[lane === 'heavy' ? 'cpu' : 'gpu'].busy, 0);
      assert.equal(await exited(t.holder(lane + '-next', lane)), 0);
      assert.deepEqual(t.remaining(), []);
    }
  } finally { await t.done(); }
});

test('master waits for its first worker, survives shot boundaries, and shares with legacy', async () => {
  const t = scratch();
  const old1Go = join(t.dir, 'old1-go');
  const old2Go = join(t.dir, 'old2-go');
  const shotGo = join(t.dir, 'shot-go');
  const old1 = t.holder('old1', 'legacy', { until: old1Go });
  const old2 = t.holder('old2', 'legacy', { until: old2Go });
  const master = await startMasterGpuJob({ what: 'film', workers: 4 }, t.config);
  assert.ok(master);
  try {
    await t.note('old1 got');
    await t.note('old2 got');
    assert.equal(t.state().gpu.busy, 2);
    const one = t.holder('shot1', 'master-worker', { until: shotGo }, master.env);
    await t.note('shot1 got');
    assert.equal(t.state().gpu.busy, 6);
    const slots = t.state().gpu.held.filter((p) => p?.reservation === 4);
    assert.equal(slots.length, 4);
    const old3 = t.holder('old3', 'legacy', { until: old2Go });
    await t.note('old3 waits');
    writeFileSync(old1Go, '');
    assert.equal(await exited(old1), 0);
    await t.note('old3 got');
    assert.equal(t.state().gpu.busy, 6);
    writeFileSync(shotGo, '');
    assert.equal(await exited(one), 0);
    assert.deepEqual(t.state().gpu.held.filter((p) => p?.reservation === 4).map((p) => p?.pid), slots.map((p) => p?.pid));
    assert.equal(await exited(t.holder('shot2', 'master-worker', {}, master.env)), 0);
    writeFileSync(old2Go, '');
    assert.deepEqual(await Promise.all([old2, old3].map(exited)), [0, 0]);
  } finally {
    await t.done();
    await master.release();
  }
});

test('a reserved master leaves light GPU room and later masters wait before spawning workers', async () => {
  const t = scratch();
  const master = await startMasterGpuJob({ what: 'one', workers: 4 }, t.config);
  assert.ok(master);
  const gate = useGpuPlaces(t.config, 'short review');
  try {
    assert.equal(await exited(t.holder('worker', 'master-worker', {}, master.env)), 0);
    const giveBack = await takeGpuPlace();
    assert.equal(t.state().gpu.busy, 5);
    giveBack();
    const next = startMasterGpuJob({ what: 'two', workers: 4 }, t.config);
    await until(() => t.state().master.waiting.length === 1, 'the second master turn');
    assert.equal(t.state().cpu.busy, 0);
    await master.release();
    const second = await next;
    assert.ok(second);
    assert.equal(t.state().gpu.busy, 0);
    await second.release();
    gate.release();
    assert.deepEqual(t.remaining(), []);
  } finally {
    gate.release();
    await master.release();
    await t.done();
  }
});

test('a killed assembler keeps its reservation until the active worker exits, with independent heartbeat', async () => {
  const t = scratch();
  const hold = join(t.dir, 'hold');
  const grantFile = join(t.dir, 'grant');
  const blockWhen = join(t.dir, 'block');
  try {
    const owner = t.holder('owner', 'master-owner', { until: hold, grantFile, blockWhen });
    await t.note('owner got');
    const grant = JSON.parse(readFileSync(grantFile, 'utf8')) as string;
    const env = { ...process.env, SKINK3_MASTER_GPU_GRANT: grant };
    const worker = t.holder('worker', 'master-worker', { until: hold }, env);
    await t.note('worker got');
    const slot = join(t.config.dir, 'slot-5');
    const mtime = statSync(slot).mtimeMs;
    writeFileSync(blockWhen, '');
    await t.note('owner blocking');
    await until(() => statSync(slot).mtimeMs > mtime, 'heartbeat while the parent is blocked in spawnSync');
    assert.ok(!t.logs().includes('owner unblocked'));
    owner.kill('SIGKILL');
    await exited(owner);
    assert.equal(t.state().gpu.busy, 4, JSON.stringify({ files: t.remaining(), worker: worker.exitCode, logs: t.logs(), master: t.state().master }));
    writeFileSync(hold, '');
    assert.equal(await exited(worker), 0);
    await until(() => t.remaining().length === 0, 'the orphaned master supervisor to drain');
  } finally { await t.done(); }
});

test('report-only check bypasses the queue and a CPU still waits before importing its scene', async () => {
  const t = scratch({ light: 1 });
  const hold = join(t.dir, 'hold');
  const marker = join(t.dir, 'loaded');
  const scene = join(t.dir, 'scene.ts');
  const url = new URL('../examples/minimal/scene.ts', import.meta.url).href;
  writeFileSync(scene, "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", ''); export { default } from " + JSON.stringify(url) + ";");
  const env = { ...process.env, SKINK3_SLOT_DIR: t.config.dir, SKINK3_FREE_RAM_GB: '0', SKINK3_LIGHT_PLACES: '1' };
  try {
    const check = spawnSync(process.execPath, [CLI, 'check', MINIMAL], { cwd: t.dir, env: { ...env, SKINK3_LIGHT_PLACES: 'invalid' }, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const h = t.holder('light', 'light', { until: hold });
    await t.note('light got');
    const still = spawn(process.execPath, [CLI, 'still', scene, '--cpu', '--frame', '0', '--width', '128', '--hash'], { cwd: t.dir, env, stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      await until(() => t.state().light.waiting.length === 1, 'CPU still admission');
      assert.ok(!existsSync(marker));
      writeFileSync(hold, '');
      assert.deepEqual(await Promise.all([h, still].map(exited)), [0, 0]);
      assert.ok(existsSync(marker));
    } finally {
      if (still.exitCode === null && still.signalCode === null) still.kill('SIGKILL');
      await exited(still);
    }
  } finally { await t.done(); }
});

test('render plan respects the worker cap and contiguous chunk boundaries', () => {
  const plan = renderPlan(10, 1000, 8, { slots: 3, chunk: 225 });
  assert.equal(plan.atOnce, 3);
  assert.equal(plan.chunks[0]?.from, 10);
  assert.equal(plan.chunks.at(-1)?.to, 1000);
  assert.equal(plan.chunks.length % 3, 0);
  for (const [i, part] of plan.chunks.entries()) {
    assert.ok(part.to - part.from <= 225);
    if (i > 0) assert.equal(part.from, plan.chunks[i - 1]?.to);
  }
  assert.equal(chunkFrames(1920), 900);
  assert.equal(chunkFrames(3840), 225);
});

test('short CPU render hashes agree with and without heavy admission', { skip: !ffmpegAvailable() }, async () => {
  const t = scratch();
  try {
    const run = (out: string, places: string, workers: string): string => {
      const file = join(t.dir, out);
      const env = { ...process.env, SKINK3_SLOT_DIR: t.config.dir, SKINK3_CPU_PLACES: places, SKINK3_FREE_RAM_GB: '0' };
      const render = spawnSync(process.execPath, [CLI, 'render', MINIMAL, '--cpu', '--width', '128', '--to', '12', '--workers', workers, '--chunk', '4', '--hashes', '--out', file], { cwd: t.dir, env, encoding: 'utf8' });
      assert.equal(render.status, 0, render.stderr);
      return readFileSync(file + '.hashes.txt', 'utf8');
    };
    assert.equal(run('one.mp4', '0', '1'), run('two.mp4', '2', '3'));
    assert.deepEqual(t.remaining(), []);
  } finally { await t.done(); }
});

test('two neutral render children reuse one master reservation without frame-level slot mutations', { skip: !ffmpegAvailable() }, async () => {
  const t = scratch();
  const env = { ...process.env, SKINK3_SLOT_DIR: t.config.dir, SKINK3_FREE_RAM_GB: '0' };
  const master = await startMasterGpuJob({ what: 'two short shots', workers: 2 }, t.config);
  assert.ok(master);
  const run = async (name: string, grants: NodeJS.ProcessEnv): Promise<string> => {
    const file = join(t.dir, name + '.mp4');
    const child = spawn(process.execPath, [CLI, 'render', MINIMAL, '--width', '128', '--to', '8', '--workers', '2', '--chunk', '0', '--hashes', '--out', file], { cwd: t.dir, env: { ...grants, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let messages = '';
    child.stdout!.on('data', (data: Buffer) => { messages += data.toString(); });
    child.stderr!.on('data', (data: Buffer) => { messages += data.toString(); });
    assert.equal(await exited(child), 0, messages);
    return readFileSync(file + '.hashes.txt', 'utf8');
  };
  try {
    const first = await run('first', master.env);
    assert.equal(t.state().gpu.busy, 2);
    const changes: string[] = [];
    const watcher = watch(t.config.dir, (event, file) => {
      if (event === 'rename' && /^(?:slot-|gpuwait-|tmp-)/.test(file ?? '')) changes.push(file!);
    });
    try {
      assert.equal(await run('second', master.env), first);
      assert.deepEqual(changes, [], 'the second shot uses the existing reservation for every frame');
    } finally {
      watcher.close();
    }
    await master.release();
    assert.deepEqual(t.remaining(), []);
    assert.equal(await run('ordinary', {}), first);
  } finally {
    await master.release();
    await t.done();
  }
});
