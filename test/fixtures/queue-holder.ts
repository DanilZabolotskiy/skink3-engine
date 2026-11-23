import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { acquireRenderLease, type QueueConfig, type QueueMemory } from '../../src/render/queue.ts';

if (!process.argv[2]) process.exit(0);

const { config, name, group, ram, vram, snapshot, until, short, worker } = JSON.parse(process.argv[2]!) as {
  config: QueueConfig;
  name: string;
  group: string;
  ram: number;
  vram: number;
  snapshot: QueueMemory;
  until: string;
  short?: boolean;
  worker?: number;
};
const lease = await acquireRenderLease(config, {
  group, what: name, memory: { ram, vram }, short, sample: () => snapshot, pollMs: 20,
  onWait: (waiting) => process.send?.({ waiting }),
});
if (worker) lease?.trackChild(worker);
process.send?.({ admitted: name });
try {
  while (!existsSync(until)) await setTimeout(15);
} finally {
  lease?.release();
  process.disconnect?.();
}
