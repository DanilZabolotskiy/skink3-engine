// This process owns the slots while the assembler waits in spawnSync, and while its admitted
// workers drain after an assembler failure. It loads no scenes or drawing libraries.

import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import type { MasterGrant, SupervisorSettings } from './master-gpu.ts';
import { acquireMasterGpuPlaces, acquireMasterTurn } from './queue.ts';

const settings = JSON.parse(process.argv[2]!) as SupervisorSettings;
const { config, workers, what } = settings;
const token = randomBytes(32).toString('hex');
const stopping = new AbortController();
const sockets = new Set<Socket>();
const waiting = new Set<Socket>();
const active = new Set<Socket>();
let reserved: (() => void) | null = null;
let acquisition: Promise<unknown> | null = null;
let finish: () => void;
const drained = new Promise<void>((resolve) => { finish = resolve; });

function send(message: object): void {
  if (process.connected) process.send?.(message, () => {});
}

function letWorkersDraw(): void {
  if (!reserved || stopping.signal.aborted) return;
  for (const socket of waiting) {
    if (active.size >= workers) break;
    waiting.delete(socket);
    active.add(socket);
    socket.write('ok\n');
  }
}

function reserve(): void {
  acquisition ??= acquireMasterGpuPlaces(config, workers, what, stopping.signal).then((release) => {
    reserved = release;
    if (release) letWorkersDraw();
  }).catch((error: unknown) => {
    send({ error: String(error) });
    stop();
  });
}

const server = createServer((socket) => {
  if (stopping.signal.aborted) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.setEncoding('utf8');
  socket.setTimeout(3000, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.once('close', () => {
    sockets.delete(socket);
    waiting.delete(socket);
    active.delete(socket);
    if (stopping.signal.aborted && active.size === 0) finish();
    else letWorkersDraw();
  });
  let request = '';
  const authenticate = (data: string): void => {
    request += data;
    if (request.length > token.length + 1) {
      socket.destroy();
      return;
    }
    if (!request.includes('\n')) return;
    if (request !== `${token}\n` || stopping.signal.aborted) {
      socket.destroy();
      return;
    }
    socket.off('data', authenticate);
    socket.setTimeout(0);
    waiting.add(socket);
    reserve();
    letWorkersDraw();
  };
  socket.on('data', authenticate);
});

function stop(): void {
  if (stopping.signal.aborted) return;
  stopping.abort();
  if (server.listening) server.close();
  // An admitted worker can finish or fail independently. Its socket pins the reservation.
  for (const socket of sockets) if (!active.has(socket)) socket.destroy();
  if (active.size === 0) finish();
}

process.once('disconnect', stop);
// A console interrupt can reach both assembler and helper. The helper must still drain registered workers.
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.platform === 'win32') process.on('SIGBREAK', stop);

const turn = await acquireMasterTurn(config, what, stopping.signal, () => send({ waiting: 'waiting for the current 4K master reservation' }));
try {
  if (turn && !stopping.signal.aborted) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    if (stopping.signal.aborted) server.close();
    else {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('cannot open the master GPU supervisor address');
      const grant: MasterGrant = { port: address.port, token, supervisor: process.pid, workers };
      send({ grant });
    }
    await drained;
  }
} catch (error) {
  send({ error: String(error) });
  stop();
  await drained;
} finally {
  await acquisition;
  // The reservation can have been acquired just before the assembler disconnected.
  const release = reserved as (() => void) | null;
  release?.();
  turn?.();
  if (process.connected) process.disconnect?.();
}
