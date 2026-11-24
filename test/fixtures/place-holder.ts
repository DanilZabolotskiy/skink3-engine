// A process that holds a place of the place queue until a file appears; it can track a child as an encoder.
import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { acquirePlace, type Lane, type PlacesConfig } from '../../src/render/places.ts';

if (!process.argv[2]) process.exit(0);

const { config, name, lane, until, child } = JSON.parse(process.argv[2]!) as {
  config: PlacesConfig;
  name: string;
  lane: Lane;
  until: string;
  child?: number;
};
const lease = await acquirePlace(config, {
  what: name, lane, pressure: () => 1, pollMs: 20,
  onWait: (waiting) => process.send?.({ waiting }),
});
if (child) lease?.trackChild(child);
process.send?.({ admitted: name });
try {
  while (!existsSync(until)) await setTimeout(15);
} finally {
  lease?.release();
  process.disconnect?.();
}
