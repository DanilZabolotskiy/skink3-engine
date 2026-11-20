// A process that takes a render slot, holds it and gives it back, writing what it does to a log: the tests of the
// render queue run several of them at once.
//
//   node test/fixtures/queue-holder.ts '<options as JSON>'
//
// Options: dir and slots (the queue), priority, name, log (the file the lines "<name> waits", "<name> got" and
// "<name> done" are appended to), and how long it holds the slot: holdMs (-1: until it is killed) or until (until
// that file exists). agingMs overrides the time after which a low waiter goes first.

import { appendFileSync, existsSync } from 'node:fs';
import { acquireSlot, type Priority } from '../../src/render/queue.ts';

interface Options {
  readonly dir: string;
  readonly slots: number;
  readonly priority: Priority;
  readonly name: string;
  readonly log: string;
  readonly holdMs?: number;
  readonly until?: string;
  readonly agingMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function hold(o: Options): Promise<void> {
  const note = (what: string): void => appendFileSync(o.log, `${o.name} ${what}\n`);
  const slot = await acquireSlot(
    { slots: o.slots, dir: o.dir },
    { priority: o.priority, what: o.name, pollMs: 20, onWait: () => note('waits'), ...(o.agingMs === undefined ? {} : { agingMs: o.agingMs }) },
  );
  note('got');
  if (o.until !== undefined) {
    while (!existsSync(o.until)) await sleep(20);
  } else if ((o.holdMs ?? 0) >= 0) {
    await sleep(o.holdMs ?? 0);
  } else {
    // Until it is killed.
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  }
  note('done');
  slot?.release();
}

// `node --test` runs every file under test/, this one too: without options it does nothing.
const raw = process.argv[2];
if (raw !== undefined) await hold(JSON.parse(raw) as Options);
