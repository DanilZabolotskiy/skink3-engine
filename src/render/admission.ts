// The one place that chooses a machine's render queue. macOS takes the place queue (places.ts): a fixed number of
// drawing processes at once, in a long and a short lane. Every other system takes the memory queue (queue.ts), which
// reserves estimated RAM and VRAM. SKINK3_QUEUE=memory|places overrides the choice, for tests and emergencies.
import { acquirePlace, idleLease, placesConfig, placeWaitingLine, type PlaceWaiting } from './places.ts';
import { acquireRenderLease as acquireMemoryLease, waitingLine, type PlaceRequest, type QueueConfig, type RenderLease, type Waiting } from './queue.ts';

export type QueueKind = 'memory' | 'places';

/** The queue of this machine: `places` on macOS, `memory` elsewhere, unless SKINK3_QUEUE names one. */
export function queueKind(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): QueueKind {
  const forced = env['SKINK3_QUEUE']?.trim();
  if (forced) {
    if (forced === 'memory' || forced === 'places') return forced;
    throw new Error('SKINK3_QUEUE must be memory or places');
  }
  return platform === 'darwin' ? 'places' : 'memory';
}

/** Why a request waits, in either queue. */
export type AdmissionWaiting = Waiting | PlaceWaiting;

/** The line a command prints for a waiting request, in either queue. */
export function admissionWaitingLine(waiting: AdmissionWaiting): string {
  return 'queue' in waiting && waiting.queue === 'places' ? placeWaitingLine(waiting) : waitingLine(waiting as Waiting);
}

export interface AdmissionRequest extends Omit<PlaceRequest, 'onWait'> {
  readonly onWait?: (waiting: AdmissionWaiting) => void;
}

/**
 * Admits a drawing process through the queue of the machine, with the lease the memory queue gives. In the memory
 * queue this is its own `acquireRenderLease`. In the place queue a request that draws (`draws`, by default true)
 * takes a short place when `short` is set and a long one otherwise, with no memory estimate, and one that draws
 * nothing is let through at once with a lease that holds nothing.
 */
export async function acquireRenderLease(config: QueueConfig, request: AdmissionRequest): Promise<RenderLease | null> {
  if (queueKind() === 'memory') return acquireMemoryLease(config, request);
  if (request.signal?.aborted) return null;
  if (request.draws === false) return idleLease();
  return acquirePlace({ ...placesConfig(), dir: config.dir }, {
    what: request.what, group: request.group, lane: request.short ? 'short' : 'long',
    onWait: request.onWait, signal: request.signal, pollMs: request.pollMs,
  });
}
