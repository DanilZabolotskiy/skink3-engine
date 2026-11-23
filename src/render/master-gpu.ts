// Older assemblers can still call this hook. Each worker now reserves its own memory.
import type { QueueConfig } from './queue.ts';

export interface MasterGpuRequest {
  readonly workers: number;
  readonly what: string;
  readonly onWait?: (message: string) => void;
}

export interface MasterGpuJob {
  readonly env: NodeJS.ProcessEnv;
  readonly workers: number;
  release(): Promise<void>;
}

/** @deprecated Pass the same render group to each command of an assembly. */
export async function startMasterGpuJob(request: MasterGpuRequest, _config?: QueueConfig): Promise<MasterGpuJob | null> {
  if (!Number.isSafeInteger(request.workers) || request.workers < 1) throw new Error('A master must ask for at least one worker');
  return null;
}
