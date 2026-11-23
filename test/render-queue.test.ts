// Synthetic contenders use temporary queue directories and allocate no GPU resources.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { renderGroup } from '../src/render/group.ts';
import { startMasterGpuJob } from '../src/render/master-gpu.ts';
import { GIB, renderMemory } from '../src/render/memory.ts';
import { chunkFrames, planOf, renderPlan } from '../src/render/parallel.ts';
import { acquireRenderLease, queueConfig, queueState, type QueueMemory, type Waiting } from '../src/render/queue.ts';

const CLI = fileURLToPath(new URL('../bin/skink3.mjs', import.meta.url));
const HOLDER = fileURLToPath(new URL('./fixtures/queue-holder.ts', import.meta.url));
const sceneUrl = new URL('../examples/minimal/scene.ts', import.meta.url);
const MINIMAL = fileURLToPath(sceneUrl);

const memory = (ram: number, vram: number): QueueMemory => ({
  ram: { free: ram * GIB, total: 64 * GIB, source: 'test' },
  vram: { free: vram * GIB, total: 32 * GIB, source: 'test' },
});

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

function scratch(snapshot = memory(24, 24)) {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-memory-queue-'));
  const config = { ...queueConfig({}), freeRamGb: 1, freeVramGb: 1, dir: join(dir, 'slots') };
  const children: ChildProcess[] = [];
  const env = { ...process.env, SKINK3_SLOT_DIR: config.dir, SKINK3_FREE_RAM_GB: '0', SKINK3_TEST_FAIL_AT_FRAME: '' };
  const state = () => queueState(config, () => snapshot);
  const child = (args: string[], options = env): ChildProcess => {
    const processChild = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: options });
    processChild.stdout?.resume();
    processChild.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    children.push(processChild);
    return processChild;
  };
  const holder = (name: string, options: { group?: string; ram?: number; vram?: number; short?: boolean; worker?: number } = {}) => {
    const release = join(dir, 'release-' + name);
    const proc = child([HOLDER, JSON.stringify({
      config, snapshot, name, group: options.group ?? name, ram: (options.ram ?? 1) * GIB,
      vram: (options.vram ?? 0) * GIB, until: release, short: options.short, worker: options.worker,
    })]);
    let waiting: Waiting | undefined;
    let admitted = false;
    proc.on('message', (message: { waiting?: Waiting; admitted?: string }) => {
      waiting ??= message.waiting;
      admitted ||= message.admitted === name;
    });
    return {
      proc, release: () => writeFileSync(release, ''), admitted: () => until(() => admitted, name + ' admission'),
      waits: async (reason: Waiting['reason']) => {
        await until(() => waiting !== undefined, name + ' to wait');
        assert.equal(waiting?.reason, reason);
      },
    };
  };
  const done = async (): Promise<void> => {
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await Promise.all(children.map(exited));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  };
  return { dir, config, env, state, holder, child, done };
}

test('config sets memory floors, preserves legacy chunk splitting, and accepts old assemblers', async () => {
  const defaults = queueConfig({});
  assert.deepEqual([defaults.freeRamGb, defaults.freeVramGb, defaults.legacyGpu], [5, 2, 4]);
  const settings = queueConfig({
    SKINK3_FREE_RAM_GB: '4', SKINK3_FREE_VRAM_GB: '1', SKINK3_RENDER_SLOTS: '0',
    SKINK3_GPU_BUDGET_GB: '15.5', SKINK3_GPU_INDEX: '1', SKINK3_CPU_PLACES: '1',
  });
  assert.deepEqual([settings.freeRamGb, settings.freeVramGb, settings.legacyGpu, settings.gpuBudgetGb, settings.gpuIndex], [4, 1, 0, 15.5, 1]);
  assert.throws(() => queueConfig({ SKINK3_FREE_VRAM_GB: '-1' }), /SKINK3_FREE_VRAM_GB/);
  assert.equal(await startMasterGpuJob({ workers: 4, what: 'film' }), null);
  const job = { from: 10, to: 2000, gpu: true, width: 3840, workers: 8 };
  const plan = planOf(job);
  const legacy = renderPlan(job.from, job.to, job.workers, { slots: queueConfig().legacyGpu, chunk: chunkFrames(job.width) });
  assert.equal(plan.atOnce, 4);
  assert.deepEqual(plan.chunks, legacy.chunks);
  assert.equal(chunkFrames(1920), 900);
  assert.equal(chunkFrames(3840), 225);
});

test('one group admits four mixed drawing workers while other groups use all remaining memory', async () => {
  const t = scratch();
  try {
    const a = Array.from({ length: 4 }, (_, i) => t.holder('draw-' + i, { group: 'one episode', short: i % 2 === 0, vram: i % 2 }));
    await Promise.all(a.map((h) => h.admitted()));
    const next = t.holder('second-language-still', { group: 'one episode', short: true });
    await next.waits('group');
    const others = Array.from({ length: 8 }, (_, i) => t.holder('other-' + i, { vram: 1 }));
    await Promise.all(others.map((h) => h.admitted()));
    assert.equal(t.state().active.length, 12);
    a[0]!.release();
    await next.admitted();
    assert.equal(t.state().active.filter((entry) => entry.group === 'one episode').length, 4);
  } finally { await t.done(); }
});

test('simultaneous admissions cannot overbook RAM and VRAM; a CPU worker uses no VRAM', async () => {
  const t = scratch(memory(10, 7));
  try {
    const gpu = Array.from({ length: 7 }, (_, i) => t.holder('gpu-' + i, { ram: 2, vram: 2 }));
    await until(() => t.state().waiting.length === 4 && t.state().active.length === 3, 'three memory reservations');
    assert.equal(t.state().available.vram, 0);
    const cpu = t.holder('cpu', { ram: 2, short: true });
    await cpu.admitted();
    assert.equal(t.state().active.length, 4);
    const ram = t.holder('ram', { ram: 2, short: true });
    await ram.waits('ram');
    cpu.release();
    await ram.admitted();
    const owner = t.state().active.find((e) => e.what.startsWith('gpu-'))!;
    const killed = gpu.find((h) => h.proc.pid === owner.pid)!;
    killed.proc.kill('SIGKILL');
    await exited(killed.proc);
    ram.release();
    await until(() => t.state().active.filter((e) => e.what.startsWith('gpu-')).length === 3 && t.state().waiting.length === 3, 'replacement after worker death');
  } finally { await t.done(); }
});

test('an orphaned child pins memory until it exits, then the queue reclaims it', async () => {
  const t = scratch(memory(7, 12));
  try {
    const child = t.child(['-e', 'setInterval(() => {}, 100)']);
    assert.ok(child.pid);
    const parent = t.holder('parent', { ram: 5, worker: child.pid });
    await parent.admitted();
    const next = t.holder('next', { ram: 4 });
    await next.waits('ram');
    parent.proc.kill('SIGKILL');
    await exited(parent.proc);
    assert.equal(t.state().active[0]?.phase, 'draining');
    child.kill('SIGKILL');
    await exited(child);
    await next.admitted();
  } finally { await t.done(); }
});

test('a complete snapshot credits allocations already reflected in measured free memory', async () => {
  const t = scratch(memory(10, 10));
  const read = (): QueueMemory => reading;
  let reading = memory(10, 10);
  try {
    const a = await acquireRenderLease(t.config, { group: 'a', what: 'a', memory: { ram: 5 * GIB, vram: 5 * GIB }, sample: read });
    assert.ok(a);
    const current = memory(6, 6);
    const resident = { [process.pid]: 4 * GIB };
    reading = { ram: { ...current.ram, resident }, vram: { ...current.vram!, resident } };
    assert.deepEqual(queueState(t.config, read).available, { ram: 4 * GIB, vram: 4 * GIB });
    const cancel = new AbortController();
    const second = acquireRenderLease(t.config, {
      group: 'b', what: 'b', memory: { ram: 5 * GIB, vram: 5 * GIB }, sample: read, pollMs: 10, signal: cancel.signal,
    });
    assert.equal(queueState(t.config, read).waiting.length, 1);
    cancel.abort();
    assert.equal(await second, null);
    a.release();
    assert.equal(queueState(t.config, read).waiting.length, 0);
  } finally { await t.done(); }
});

test('verification grows an estimate atomically and reports an observed low floor', async () => {
  const t = scratch();
  const read = (): QueueMemory => reading;
  let reading = memory(10, 10);
  const pressure: string[] = [];
  try {
    const lease = await acquireRenderLease(t.config, {
      group: 'work', what: 'work', memory: { ram: 2 * GIB, vram: 2 * GIB }, sample: read,
      onPressure: (message) => pressure.push(message),
    });
    assert.ok(lease);
    const resident = { [process.pid]: 2 * GIB };
    reading = { ...reading, ram: { ...reading.ram, resident } };
    lease.verify(1 * GIB);
    assert.equal(queueState(t.config, read).active[0]?.memory.ram, 3 * GIB);
    reading = memory(8, 0.5);
    lease.verify();
    lease.verify();
    assert.deepEqual(pressure, ['work measured below the free VRAM floor during work']);
    assert.throws(() => lease.verify(10 * GIB), /exceeded its RAM estimate/);
    lease.release();
  } finally { await t.done(); }
});

test('unavailable GPU memory fails before a reservation can be published', async () => {
  const t = scratch();
  const read = (): QueueMemory => ({ ...memory(10, 10), vram: null });
  try {
    await assert.rejects(acquireRenderLease(t.config, {
      group: 'work', what: 'work', memory: { ram: 2 * GIB, vram: 2 * GIB }, sample: read,
    }), /Cannot read GPU memory/);
    assert.deepEqual(t.state().active, []);
    assert.deepEqual(t.state().waiting, []);
  } finally { await t.done(); }
});

test('a short request can progress while a larger reservation waits, then yields to the older request', async () => {
  const t = scratch(memory(9, 9));
  try {
    const active = t.holder('active', { ram: 5 });
    await active.admitted();
    const old = t.holder('old', { ram: 5 });
    await old.waits('ram');
    const first = t.holder('short', { ram: 1, short: true });
    await first.admitted();
    first.release();
    await setTimeout(3_100);
    const later = t.holder('later', { ram: 1, short: true });
    await later.waits('turn');
    active.release();
    await old.admitted();
    await later.admitted();
  } finally { await t.done(); }
});

test('group config works through multiple checkouts and language paths, before a still imports its scene', async () => {
  const t = scratch();
  try {
    const file = (checkout: string, episode: string, language = '') => {
      const root = join(t.dir, checkout);
      const folder = join(root, 'projects', 'documentary', language, 'films', episode, 'shots');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(root, '.skink3-render.json'), JSON.stringify({
        namespace: 'examples', groups: [{ path: '^projects/([^/]+)/(?:[^/]+/)?films/([^/]+)/', group: '$1/$2' }],
      }));
      return join(folder, 'scene.ts');
    };
    const original = file('one', 'film');
    const translated = file('two', 'film', 'fr');
    const group = renderGroup(original);
    assert.equal(renderGroup(translated), group);
    // A worktree made before the config landed reads the primary checkout's policy.
    const linked = file('linked', 'film');
    rmSync(join(t.dir, 'linked', '.skink3-render.json'));
    const gitDir = join(t.dir, 'one', '.git', 'worktrees', 'linked');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..');
    writeFileSync(join(t.dir, 'linked', '.git'), 'gitdir: ' + gitDir);
    assert.equal(renderGroup(linked), group);
    assert.notEqual(renderGroup(file('two', 'other')), group);
    assert.equal(renderGroup(translated, 'explicit'), 'explicit');
    const marker = join(t.dir, 'imported');
    writeFileSync(translated, "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker)
      + ", ''); export { default } from " + JSON.stringify(sceneUrl.href) + ";");
    const workers = Array.from({ length: 4 }, (_, i) => t.holder('existing-' + i, { group }));
    await Promise.all(workers.map((h) => h.admitted()));
    const still = t.child([CLI, 'still', translated, '--cpu', '--frame', '0', '--width', '128', '--hash']);
    await until(() => t.state().waiting.some((entry) => entry.pid === still.pid), 'still queue entry');
    assert.ok(!existsSync(marker));
    workers[0]!.release();
    assert.equal(await exited(still), 0);
    assert.ok(existsSync(marker));
  } finally { await t.done(); }
});

test('larger output and encoder staging raise peak estimates, CPU x264 has zero VRAM', () => {
  const base = { width: 1920, scene: MINIMAL, gpu: true };
  const still = renderMemory(base);
  const video = renderMemory({ ...base, width: 3840, encoder: 'x264' });
  assert.ok(still.vram > 0 && video.vram > still.vram);
  assert.ok(video.ram > 4 * GIB);
  assert.equal(renderMemory({ ...base, gpu: false, encoder: 'x264' }).vram, 0);
  assert.ok(renderMemory({ ...base, gpu: false, encoder: 'nvenc' }).vram > 0);
  assert.ok(renderMemory({ ...base, sheetPixels: 5e6 }).ram > still.ram);
});

test('CPU render hashes agree at different concurrency and failure leaves no reservations or chunks', { skip: !ffmpegAvailable() }, async () => {
  const t = scratch();
  try {
    const run = (name: string, workers: string, fail = false) => {
      const file = join(t.dir, name + '.mp4');
      const result = spawnSync(process.execPath, [
        CLI, 'render', MINIMAL, '--cpu', '--width', '128', '--to', '12', '--workers', workers,
        '--chunk', '4', '--hashes', '--out', file,
      ], { cwd: t.dir, env: { ...t.env, SKINK3_TEST_FAIL_AT_FRAME: fail ? '3' : undefined }, encoding: 'utf8' });
      if (fail) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /injected failure/);
        assert.ok(!existsSync(file));
        assert.equal(readdirSync(t.dir).some((entry) => entry.startsWith(name + '.chunk')), false);
        return '';
      }
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(file + '.hashes.txt', 'utf8');
    };
    assert.equal(run('one', '1'), run('three', '3'));
    run('broken', '4', true);
    assert.deepEqual(t.state().active, []);
    assert.deepEqual(t.state().waiting, []);
  } finally { await t.done(); }
});
