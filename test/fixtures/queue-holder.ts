// Isolated contenders for the render queue tests. Nothing in this file draws or encodes a frame.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinMasterGpuJob, masterGpuGrant, startMasterGpuJob } from '../../src/render/master-gpu.ts';
import { acquireCpuPlace, takeGpuPlace, useGpuPlaces, type QueueConfig, type RenderLane } from '../../src/render/queue.ts';

interface Options {
  readonly config: QueueConfig;
  readonly mode: RenderLane | 'legacy' | 'gpu' | 'master-owner' | 'master-worker';
  readonly name: string;
  readonly log: string;
  readonly job?: string;
  readonly until?: string;
  readonly holdMs?: number;
  readonly grantFile?: string;
  readonly blockWhen?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The previous renderer's slot protocol: shared lock, wait- names, high-priority JSON and exclusive slot creation. */
async function legacyTake(o: Options, note: (text: string) => void): Promise<() => Promise<void>> {
  const { dir, legacyGpu } = o.config;
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'lock');
  const underLock = async <T>(fn: () => T): Promise<T> => {
    for (;;) {
      try {
        writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        if (!['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        await sleep(5);
      }
    }
    try { return fn(); }
    finally { rmSync(lock, { force: true }); }
  };
  const token = `${process.pid}-abcd`;
  const ticket = join(dir, `wait-${token}`);
  const entry = JSON.stringify({ pid: process.pid, token, priority: 'high', since: Date.now(), what: o.name });
  let told = false;
  for (;;) {
    const file = await underLock(() => {
      for (let i = 0; i < legacyGpu; i++) {
        const slot = join(dir, `slot-${i}`);
        if (existsSync(slot)) {
          let alive = false;
          try {
            const age = Date.now() - statSync(slot).mtimeMs;
            const held = JSON.parse(readFileSync(slot, 'utf8')) as { pid: number; priority: string };
            process.kill(held.pid, 0);
            alive = age < 120_000 && ['high', 'low'].includes(held.priority);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || ['EPERM', 'EACCES', 'EBUSY'].includes(String(code))) continue;
            // A killed holder can leave a broken record.
          }
          if (alive) continue;
          rmSync(slot, { force: true });
        }
        try {
          writeFileSync(slot, entry, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        rmSync(ticket, { force: true });
        return slot;
      }
      if (!existsSync(ticket)) writeFileSync(ticket, entry);
      return null;
    });
    if (file) return async () => { await underLock(() => rmSync(file, { force: true })); };
    if (!told) note('waits');
    told = true;
    await sleep(20);
  }
}

async function hold(o: Options): Promise<void> {
  const note = (what: string): void => appendFileSync(o.log, `${o.name} ${what}\n`);
  let release: (() => void | Promise<void>) | undefined;
  switch (o.mode) {
    case 'heavy':
    case 'light': {
      const place = await acquireCpuPlace(o.config, { lane: o.mode, what: o.name, job: o.job ?? o.name, pollMs: 20, onWait: () => note('waits') });
      place?.loaded();
      release = place?.release;
      break;
    }
    case 'gpu': {
      const gate = useGpuPlaces(o.config, o.name, () => note('waits'));
      const releasePlace = await takeGpuPlace();
      release = () => { releasePlace(); gate.release(); };
      break;
    }
    case 'legacy':
      release = await legacyTake(o, note);
      break;
    case 'master-owner': {
      const job = await startMasterGpuJob({ what: o.name, workers: 4, onWait: () => note('waits') }, o.config);
      if (!job || !o.grantFile) throw new Error('missing test master grant');
      writeFileSync(o.grantFile, JSON.stringify(job.env['SKINK3_MASTER_GPU_GRANT']));
      release = job.release;
      break;
    }
    case 'master-worker': {
      const grant = masterGpuGrant();
      if (!grant) throw new Error('missing test worker grant');
      release = (await joinMasterGpuJob(grant, () => process.exit(1))).release;
      break;
    }
  }
  note('got');
  if (o.blockWhen) {
    while (!existsSync(o.blockWhen)) await sleep(20);
    note('blocking');
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
    note('unblocked');
  }
  if (o.until !== undefined) {
    while (!existsSync(o.until)) await sleep(20);
  } else {
    await sleep(o.holdMs ?? 30);
  }
  note('done');
  await release?.();
}

const raw = process.argv[2];
if (raw !== undefined) await hold(JSON.parse(raw) as Options);
