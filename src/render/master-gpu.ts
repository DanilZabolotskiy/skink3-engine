// An assembly keeps one supervised GPU reservation across its shot processes. The engine never assumes
// that resolution alone predicts GPU load: the caller selects this mode for an appropriate job.

import { fork } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { queueConfig, type QueueConfig } from './queue.ts';

const GRANT_ENV = 'SKINK3_MASTER_GPU_GRANT';
const SUPERVISOR = fileURLToPath(new URL('./master-gpu-supervisor.ts', import.meta.url));

export interface MasterGpuRequest {
  readonly workers: number;
  readonly what: string;
  readonly onWait?: (message: string) => void;
}

export interface MasterGpuJob {
  /** Pass only to the GPU render child. Its chunk workers inherit the grant. */
  readonly env: NodeJS.ProcessEnv;
  readonly workers: number;
  release(): Promise<void>;
}

export interface MasterGrant {
  readonly port: number;
  readonly token: string;
  readonly supervisor: number;
  readonly workers: number;
}

export interface SupervisorSettings {
  readonly config: QueueConfig;
  readonly workers: number;
  readonly what: string;
}

/**
 * Waits for the turn to run a GPU-busy master. The supervisor reserves GPU places when the first
 * admitted worker joins. It retains them across shots and throughout a synchronous assembler wait.
 */
export async function startMasterGpuJob(request: MasterGpuRequest, config = queueConfig()): Promise<MasterGpuJob | null> {
  if (!Number.isSafeInteger(request.workers) || request.workers < 1) throw new Error('a master must ask for at least one worker');
  const workers = Math.min(request.workers, config.masterGpu, config.cpu || Infinity);
  if (workers < 1) return null;
  const settings: SupervisorSettings = { config, workers, what: request.what };
  const supervisor = fork(SUPERVISOR, [JSON.stringify(settings)], {
    detached: true,
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>((resolve) => {
    supervisor.once('exit', () => resolve());
    supervisor.once('error', () => resolve());
  });
  const grant = await new Promise<MasterGrant>((resolve, reject) => {
    supervisor.on('message', (message: { grant?: MasterGrant; waiting?: string; error?: string }) => {
      if (message.waiting) request.onWait?.(message.waiting);
      if (message.grant) resolve(message.grant);
      if (message.error) reject(new Error(message.error));
    });
    supervisor.once('error', reject);
    supervisor.once('exit', (code, signal) => reject(new Error(`master GPU supervisor stopped (${signal ?? code})`)));
  }).catch(async (error: unknown) => {
    if (supervisor.connected) supervisor.disconnect();
    await exited;
    throw error;
  });
  return {
    workers,
    env: { ...process.env, [GRANT_ENV]: JSON.stringify(grant) },
    release: async () => {
      if (supervisor.connected) supervisor.disconnect();
      await exited;
    },
  };
}

/** Internal worker metadata. Joining the authenticated supervisor is required to draw with these places. */
export function masterGpuGrant(env: NodeJS.ProcessEnv = process.env): MasterGrant | null {
  const value = env[GRANT_ENV];
  if (!value) return null;
  const grant = JSON.parse(value) as MasterGrant;
  if (!Number.isSafeInteger(grant.port) || grant.port < 1 || grant.port > 65535 ||
      !Number.isSafeInteger(grant.supervisor) || grant.supervisor < 1 ||
      !Number.isSafeInteger(grant.workers) || grant.workers < 1 || !/^[a-f0-9]{64}$/.test(grant.token)) {
    throw new Error('invalid master GPU grant');
  }
  return grant;
}

/** Registers one admitted worker. Keeping this connection open pins its part of the reservation. */
export function joinMasterGpuJob(grant: MasterGrant, onLost: () => void): Promise<{ release(): void }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: grant.port });
    let joined = false;
    let releasing = false;
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${grant.token}\n`));
    let reply = '';
    socket.on('data', (data: string) => {
      reply += data;
      if (!reply.includes('\n')) return;
      if (reply !== 'ok\n') {
        socket.destroy();
        return;
      }
      joined = true;
      resolve({
        release: () => {
          releasing = true;
          socket.destroy();
        },
      });
    });
    socket.on('error', reject);
    socket.once('close', () => {
      if (joined && !releasing) onLost();
      else if (!joined) reject(new Error('master GPU supervisor refused or lost the worker'));
    });
  });
}
