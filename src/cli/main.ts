// Command-line entry point: bake, still, strip, sheet, render, check, the
// motion review (motion, trail, graph), the physics review (physics), the
// sound of a shot (events, sfx), and the render queue of the machine (queue).
// Output goes to ./out and the bake cache to ./cache of the caller's working
// directory, wherever the scene module and the engine live.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadBank } from '../audio/bank.ts';
import { EVENT_KINDS, sceneEvents } from '../audio/events.ts';
import { formatSoundReport, renderSound, soundReportJson } from '../audio/track.ts';
import { formatReport, runChecks } from '../checks/index.ts';
import { FPS } from '../core/time.ts';
import { ensureBake } from '../physics/bake.ts';
import { bakeHash, readBake } from '../physics/cache.ts';
import { ffmpegAvailable, type Encoder } from '../render/encode.ts';
import { frameRaw, heightFor, rendererInfo } from '../render/frame.ts';
import { renderGroup } from '../render/group.ts';
import { GIB, renderMemory } from '../render/memory.ts';
import { chunkFrames, planOf, renderChunk, renderParallel } from '../render/parallel.ts';
import { admissionWaitingLine, queueKind } from '../render/admission.ts';
import { acquirePlace, placesConfig, placesState, placeWaitingLine, pressureName, type PlaceEntry, type PlaceWaiting } from '../render/places.ts';
import { acquireRenderLease, GpuMemoryUnavailableError, GROUP_WORKERS, MAX_LIGHT_FRAMES, queueConfig, queueState, waitingLine, type RenderLease, type QueueEntry, type Waiting } from '../render/queue.ts';
import { rawToPng, renderSheet, sheetGeometry, type SheetTile } from '../render/sheet.ts';
import { P } from '../review/physics-thresholds.ts';
import { formatPhysicsReport, physicsReportJson } from '../review/physics-report.ts';
import { reviewPhysics } from '../review/physics.ts';
import { formatMotionReport, motionReportJson, reviewMotion } from '../review/report.ts';
import { T } from '../review/thresholds.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { CAMERA_SUBJECT } from '../scene/types.ts';
import { languagesOf } from '../text/strings.ts';
import { engineVersion, physicsVersion } from '../version.ts';
import { loadShot } from './load.ts';
import { readPreparedScene } from '../render/prepared.ts';

const HELP = `skink3 <command> <scene module> [options]

Commands
  check   the palette's own rules, string tables, glyphs and text fit in every language; the reviews in short
  bake    simulate physics, springs and particles; write the cache
  still   one or more frames as PNG
  strip   a motion strip: consecutive frames side by side
  sheet   a contact sheet of the whole shot (or of chosen frames, per language)
  render  the shot as an mp4 (parallel chunk workers, joined by ffmpeg)
  motion  the motion review: jumps, missing ease, strobing speed, springs, dead areas
  physics the physics review: overlap, tunnelling, escapes, jitter, piles that do not settle, energy, unseen hits
  trail   a ghost trail: nodes drawn at every k-th frame in one picture
  graph   a speed graph of a node, an emitter or the camera
  events  what happens in the shot, as events: every intent, every contact, every burst
  sfx     the sound track of the shot, from its events and a bank of sounds
  queue   the render queue of this machine: its memory or its places, holders and waiters (takes no scene module)

Common options
  --lang <tag>        language of the string tables (default: the first table)
  --width <px>        output width, 16:9 (default 1920)
  --cpu               draw on the CPU instead of the GPU
  --group <name>      share the drawing-worker limit with other commands for this production
  --out <file>        output file (default under ./out/<shot>/)
  --cache <dir>       bake cache directory (default ./cache)

still   --frame <n[,n...]> | --time <s[,s...]>   [--hash] [--alone]
strip   --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h] [--alone]
sheet   [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h] [--alone]
render  [--workers <n>] [--chunk <frames>] [--from <frame>] [--to <frame>] [--encoder x264|nvenc] [--hashes] [--reuse-scene] [--force]
bake    [--force]
check   [--bank <bank.json>]        with a bank, a sound key it does not know fails the checks; --lang limits the text checks
motion  [--pictures [--top 3]]      report as text, and as JSON in out/<shot>/motion.json
physics [--pictures [--top 3]]      report as text, and as JSON in out/<shot>/physics.json
trail   --node <id[,id...]> [--from <frame>] [--to <frame>] | [--time <s,s>]  [--every <k>] [--space stage|screen]
graph   --node <id> | --camera      [--from <frame>] [--to <frame>] | [--time <s,s>]
events  (no options)                the events as JSON in out/<shot>/events.json
sfx     --bank <bank.json>          a WAV of 48 kHz, stereo, as long as the shot; its report as text, and as JSON in out/<shot>/sfx.json
        [--sheet [--cols 4] [--tile 480]]   also the sound sheet, out/<shot>/sfx_sheet.png: which event each sound belongs to

--crop is in stage units (1920 x 1080, origin top-left). --hash and --hashes
print or write the SHA-256 of each frame's raw RGBA pixels. --alone draws every
frame as a still of that frame alone draws it, whatever was drawn before it,
about a second slower a frame: without it, on the GPU, a frame drawn soon after a
frame of another zoom may differ by a few pixels of a curved edge. --pictures writes
pictures of the worst few subjects of the report: a trail and a graph for
motion; a close-up, a trail or a graph, by the kind of finding, for physics.
--sheet (of sfx) writes the sound sheet of the track: a tile for every sound,
with the frame it is placed on, the node it comes from ringed, an arrow along
the way of a move, and the sound, the kind of event and the time written on
it. A shower, the run of a sound that the bank sets apart, is one tile, with
its count and its length.

Every checkout shares the same render queue (SKINK3_SLOT_DIR). On Windows and
Linux it is a memory queue: each group can draw with up to four workers across
all commands, and admission reserves RAM and VRAM before work begins, with
configurable free-memory floors. On macOS it is a place queue: one place per
drawing process, at most 4 long ones (render workers and draws of more than 60
frames, SKINK3_MAC_RENDERS) and 4 short ones (SKINK3_MAC_SHORT) at once, none
granted while macOS reports memory pressure; render --workers defaults to 1
there. SKINK3_QUEUE=memory|places overrides the choice.
The default --chunk at 1920 wide is 900 frames and scales with pixel count.`;

interface Common {
  compiled: CompiledShot;
  sceneFile: string;
  lang: string;
  width: number;
  gpu: boolean;
  cacheDir: string;
  outDir: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function intList(name: string, value: string): number[] {
  return value.split(',').map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) fail(`--${name}: "${s}" is not an integer`);
    return n;
  });
}

function numList(name: string, value: string): number[] {
  return value.split(',').map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) fail(`--${name}: "${s}" is not a number`);
    return n;
  });
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer in ${min}..${max}, got "${value}"`);
  return n;
}

function crop(value: string | undefined): [number, number, number, number] | null {
  if (value === undefined) return null;
  const p = numList('crop', value);
  if (p.length !== 4 || p[2]! <= 0 || p[3]! <= 0) fail('--crop must be x,y,w,h in stage units');
  return [p[0]!, p[1]!, p[2]!, p[3]!];
}

function checkFrame(c: CompiledShot, f: number): number {
  if (f < 0 || f >= c.frames) fail(`frame ${f} is outside the shot (0..${c.frames - 1})`);
  return f;
}

function write(file: string, data: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

export async function main(argv: readonly string[]): Promise<number> {
  let release = (): void => {};
  const orphaned = (): void => process.exit(1);
  if (argv[0] === '_chunk' && typeof process.send === 'function') process.once('disconnect', orphaned);
  try {
    return await run(argv, (lease) => { release = () => lease?.release(); });
  } finally {
    process.off('disconnect', orphaned);
    release();
  }
}

/** The name of a scene module as `skink3 queue` shows it: with its directory when the file has a generic name. */
function sceneName(path: string): string {
  const file = resolve(process.cwd(), path);
  const name = basename(file);
  return /^(scene|index|shot)\.[cm]?[jt]s$/.test(name) ? `${basename(dirname(file))}/${name}` : name;
}

async function run(argv: readonly string[], keep: (lease: RenderLease | null) => void): Promise<number> {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 1;
  }
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      width: { type: 'string' },
      cpu: { type: 'boolean', default: false },
      group: { type: 'string' },
      out: { type: 'string' },
      cache: { type: 'string' },
      frame: { type: 'string' },
      time: { type: 'string' },
      hash: { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      count: { type: 'string' },
      step: { type: 'string' },
      cols: { type: 'string' },
      rows: { type: 'string' },
      tile: { type: 'string' },
      crop: { type: 'string' },
      frames: { type: 'string' },
      workers: { type: 'string' },
      encoder: { type: 'string' },
      hashes: { type: 'boolean', default: false },
      'reuse-scene': { type: 'boolean', default: false },
      'prepared-scene': { type: 'string' },
      'prepared-digest': { type: 'string' },
      'hashes-file': { type: 'string' },
      force: { type: 'boolean', default: false },
      bake: { type: 'string' },
      node: { type: 'string' },
      camera: { type: 'boolean', default: false },
      every: { type: 'string' },
      space: { type: 'string' },
      pictures: { type: 'boolean', default: false },
      top: { type: 'string' },
      bank: { type: 'string' },
      sheet: { type: 'boolean', default: false },
      // Passed to its workers by a render of the engine before the pools (November 23, 2026): accepted, and of no effect.
      priority: { type: 'string' },
      chunk: { type: 'string' },
      alone: { type: 'boolean', default: false },
    },
  });
  const str = (name: string): string | undefined => {
    const v = (values as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : undefined;
  };
  const flag = (name: string): boolean => (values as Record<string, unknown>)[name] === true;
  if (flag('alone') && command !== 'still' && command !== 'strip' && command !== 'sheet') {
    fail(`${command}: --alone is an option of still, strip and sheet${command === 'render' ? ' (a render draws its frames in a row)' : ''}`);
  }

  // The one command without a scene: the render queue of the machine.
  if (command === 'queue') {
    printQueue();
    return 0;
  }
  const scene = positionals[0];
  if (!scene) fail(`${command}: give the path of a scene module\n\n${HELP}`);
  // Estimate the requested scene frames without loading the scene or its bake.
  const worker = command === '_chunk' && typeof process.send === 'function';
  const stillFrames = (): number[] => str('frame')
    ? intList('frame', str('frame')!)
    : str('time')
      ? numList('time', str('time')!).map((s) => Math.round(s * FPS))
      : fail('still: give --frame <n[,n...]> or --time <s[,s...]>');
  const framesRequested = (): number => {
    switch (command) {
      case '_chunk': return Infinity;
      case 'still': return stillFrames().length;
      case 'strip': return int('count', str('count'), 12, 1, 200);
      case 'sheet': {
        const frames = str('frames')
          ? intList('frames', str('frames')!).length
          : int('cols', str('cols'), 6, 1, 40) * int('rows', str('rows'), 5, 1, 40);
        return frames * (str('lang')?.split(',').length ?? 1);
      }
      case 'trail': return 1; // Ghosts are vector overlays on a single background frame.
      case 'graph': return 1;
      case 'motion': return flag('pictures') ? int('top', str('top'), T.pictureSubjects, 1, 50) : 0;
      case 'physics': return flag('pictures') ? 5 * int('top', str('top'), P.pictureSubjects, 1, 50) : 0;
      case 'sfx': return flag('sheet') ? MAX_LIGHT_FRAMES : 0;
      default: return 0;
    }
  };
  const budget = framesRequested();
  const draws = budget > 0;
  const group = renderGroup(scene, str('group') ?? process.env['SKINK3_RENDER_GROUP']);
  const width = int('width', str('width'), 1920, 64, 7680);
  const gpu = !flag('cpu');
  const encodes = command === '_chunk' || command === 'render';
  const encoder = (str('encoder') ?? 'x264') as Encoder;
  if (encodes && encoder !== 'x264' && encoder !== 'nvenc') fail('--encoder must be x264 or nvenc');
  let drawWidth = draws ? width : 0;
  let sheetPixels = 0;
  if (command === 'sheet' || command === 'strip' || (command === 'sfx' && draws)) {
    const sound = command === 'sfx';
    const dimensions = sheetGeometry(budget, {
      cols: int('cols', str('cols'), sound ? 4 : 6, 1, 40),
      tileWidth: int('tile', str('tile'), 480, 64, 3840),
      crop: sound ? null : crop(str('crop')),
    });
    drawWidth = dimensions.renderW;
    sheetPixels = dimensions.cols * dimensions.rows * dimensions.tileW * dimensions.tileH;
  }
  if (command === 'physics' && draws) drawWidth = 3840;
  if (command === 'trail') drawWidth = Math.min(1920, width);
  const frameRange = worker ? ' frames ' + str('from') + '..' + (Number(str('to')) - 1) : '';
  const what = command + ' ' + sceneName(scene) + (draws ? ' ' + drawWidth + 'x' + heightFor(drawWidth) : '') + frameRange;
  const loadWork = { scene, bake: str('bake'), width: 0, gpu: false };
  const workload = {
    ...loadWork, width: drawWidth, gpu: gpu && command !== 'graph', sheetPixels,
    ...(command === '_chunk' ? { encoder } : {}),
  };
  let memory = renderMemory(workload);
  let lease: RenderLease | null = null;
  if ((draws || command === 'render') && queueKind() === 'places') {
    // A place for each drawing process, with no memory estimate. A render's parent draws nothing: its workers take places.
    if (draws) {
      lease = await acquirePlace(placesConfig(), {
        what, group, lane: budget <= MAX_LIGHT_FRAMES ? 'short' : 'long',
        onWait: worker ? (w: PlaceWaiting) => process.send?.({ waiting: w }) : (w: PlaceWaiting) => console.log(placeWaitingLine(w)),
      });
    }
  } else if (draws || command === 'render') {
    const config = queueConfig();
    const acquire = (): Promise<RenderLease | null> => acquireRenderLease(config, {
      group, what, memory, draws, short: budget <= MAX_LIGHT_FRAMES,
      onWait: worker ? (w: Waiting) => process.send?.({ waiting: w }) : (w: Waiting) => console.log(waitingLine(w)),
      onPressure: (message: string) => console.warn(message),
    });
    try {
      lease = await acquire();
    } catch (error) {
      if (!(error instanceof GpuMemoryUnavailableError) || (command === '_chunk' && encoder === 'nvenc')) throw error;
      // An 8-pixel backend probe is sufficient for Skia's established CPU fallback.
      memory = renderMemory({ ...workload, gpu: false });
      lease = await acquire();
      keep(lease);
      if (rendererInfo(true).renderer === 'GPU') throw error;
    }
  }
  keep(lease);
  const snapshot = command === '_chunk' ? str('prepared-scene') : undefined;
  const digest = snapshot && str('prepared-digest');
  const { compiled, file: sceneFile } = (snapshot && digest ? readPreparedScene(scene, snapshot, digest) : undefined) ?? await loadShot(scene);
  const langs = languagesOf(compiled.spec.strings);
  const langArg = str('lang');
  const common: Common = {
    compiled,
    sceneFile,
    lang: langArg?.split(',')[0] ?? langs[0]!,
    width,
    gpu,
    cacheDir: resolve(process.cwd(), str('cache') ?? 'cache'),
    outDir: resolve(process.cwd(), 'out', compiled.spec.id),
  };
  const wantedLangs = langArg ? langArg.split(',') : null;
  for (const l of wantedLangs ?? []) {
    if (!langs.includes(l)) fail(`--lang ${l}: no such string table (available: ${langs.join(', ')})`);
  }
  const outFile = (fallback: string): string => {
    const o = str('out');
    return o ? resolve(process.cwd(), o) : join(common.outDir, fallback);
  };
  const c = compiled;
  const drawRam = memory.ram - renderMemory(loadWork).ram;
  const loaded = (): void => lease?.verify(drawRam);
  loaded();
  /** The window of frames of `trail` and `graph`: --from and --to in frames, or --time in seconds. */
  const window = (name: string): { from?: number; to?: number } => {
    const time = str('time');
    if (time !== undefined) {
      const p = numList('time', time);
      if (p.length !== 2 || p[1]! < p[0]!) fail(`${name}: --time takes two moments in seconds, the earlier first: --time 6.5,7.8`);
      return { from: checkFrame(c, Math.round(p[0]! * FPS)), to: checkFrame(c, Math.min(c.frames - 1, Math.round(p[1]! * FPS))) };
    }
    const w: { from?: number; to?: number } = {};
    if (str('from') !== undefined) w.from = int('from', str('from'), 0, 0, c.frames - 1);
    if (str('to') !== undefined) w.to = int('to', str('to'), 0, w.from ?? 0, c.frames - 1);
    return w;
  };

  switch (command) {
    case 'check': {
      const { bake } = await ensureBake(c, common.cacheDir);
      const bankFile = str('bank');
      const report = runChecks(c, bake, wantedLangs ?? undefined, { motion: true, physics: true, contrast: true, ...(bankFile === undefined ? {} : { bank: loadBank(bankFile) }) });
      console.log(`check ${c.spec.id}: ${c.frames} frames, ${c.nodes.length} nodes, ${c.layers.length} layers`);
      console.log(formatReport(report));
      return report.ok ? 0 : 1;
    }

    case 'bake': {
      const r = await ensureBake(c, common.cacheDir, { force: flag('force') });
      const h = r.bake.header;
      console.log(`bake ${c.spec.id}: ${r.baked ? 'baked' : 'cache hit'} in ${r.seconds.toFixed(2)} s`);
      console.log(`  file    ${r.file}`);
      console.log(`  sha256  ${bakeHash(r.bake)}`);
      console.log(`  engine  ${engineVersion()}`);
      console.log(`  physics ${physicsVersion()}`);
      console.log(`  scene   ${h.sceneHash.slice(0, 16)}  seed ${h.seed}`);
      console.log(`  frames ${h.frames}, bodies ${h.bodies.length}, springs ${h.springs.length}, emitters ${h.emitters.length}, particles stored ${r.bake.particles.length / 4}, contact events ${h.events.length}`);
      return 0;
    }

    case 'still': {
      const frames = stillFrames();
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const height = heightFor(common.width);
      if (frames.length > 1 && str('out')) fail('still: --out works with a single frame');
      for (const f of frames) {
        checkFrame(c, f);
        const raw = await frameRaw(c, bake, f, { width: common.width, lang: common.lang, gpu: common.gpu, alone: flag('alone') });
        const file = outFile(`still_${String(f).padStart(5, '0')}_${common.lang}.png`);
        write(file, await rawToPng(raw, common.width, height));
        lease?.verify();
        const sum = flag('hash') ? `  sha256 ${createHash('sha256').update(raw).digest('hex')}` : '';
        console.log(`frame ${f}  ${file}${sum}`);
      }
      return 0;
    }

    case 'strip': {
      const from = checkFrame(c, int('from', str('from') ?? fail('strip: give --from <frame>'), 0, 0, 1e9));
      const count = int('count', str('count'), 12, 1, 200);
      const step = int('step', str('step'), 2, 1, 600);
      const tiles: SheetTile[] = [];
      for (let i = 0; i < count; i++) {
        const f = from + i * step;
        if (f >= c.frames) break;
        tiles.push({ frame: f, lang: common.lang });
      }
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const png = await renderSheet(c, bake, tiles, {
        cols: int('cols', str('cols'), 6, 1, 40),
        tileWidth: int('tile', str('tile'), 480, 64, 3840),
        crop: crop(str('crop')),
        gpu: common.gpu,
        alone: flag('alone'),
        captions: true,
        relative: true,
      });
      const file = outFile(`strip_${String(from).padStart(5, '0')}_${common.lang}.png`);
      write(file, png);
      console.log(`strip of ${tiles.length} frames from ${from}, step ${step}: ${file}`);
      return 0;
    }

    case 'sheet': {
      const cols = int('cols', str('cols'), 6, 1, 40);
      const rows = int('rows', str('rows'), 5, 1, 40);
      let frames: number[];
      if (str('frames')) {
        frames = intList('frames', str('frames')!).map((f) => checkFrame(c, f));
      } else {
        const n = cols * rows;
        frames = Array.from({ length: n }, (_, i) => Math.min(c.frames - 1, Math.floor(((i + 0.5) * c.frames) / n)));
      }
      const sheetLangs = wantedLangs ?? [common.lang];
      const tiles: SheetTile[] = frames.flatMap((f) => sheetLangs.map((lang) => ({ frame: f, lang })));
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const png = await renderSheet(c, bake, tiles, {
        cols,
        tileWidth: int('tile', str('tile'), 480, 64, 3840),
        crop: crop(str('crop')),
        gpu: common.gpu,
        alone: flag('alone'),
        captions: true,
        relative: false,
      });
      const file = outFile(`sheet_${sheetLangs.join('+')}.png`);
      write(file, png);
      console.log(`sheet of ${tiles.length} tiles: ${file}`);
      return 0;
    }

    case 'render': {
      if (!ffmpegAvailable()) fail('render: ffmpeg was not found (put it on PATH or set FFMPEG)');
      const baked = await ensureBake(c, common.cacheDir);
      // Checks come before any render; a failed check stops it unless forced.
      const report = runChecks(c, baked.bake, [common.lang]);
      if (!report.ok) {
        console.log(formatReport(report));
        if (!flag('force')) fail('render: the checks failed (fix the scene, or pass --force to render anyway)');
      } else {
        for (const issue of report.issues) console.log(`  warning: ${issue.message}`);
      }
      const from = int('from', str('from'), 0, 0, c.frames - 1);
      const to = int('to', str('to'), c.frames, from + 1, c.frames);
      // The place queue gives each worker a long place, so one render takes one by default.
      const workers = int('workers', str('workers'), queueKind() === 'places' ? 1 : Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))), 1, 64);
      const chunk = int('chunk', str('chunk'), chunkFrames(common.width), 0, 1e9);
      const plan = planOf({ from, to, workers, width: common.width, gpu: common.gpu, chunk });
      const atOnce = plan.atOnce + ' worker(s)' + (plan.atOnce < plan.workers ? ' at once (' + plan.workers + ' asked)' : '');
      const backend = common.gpu ? 'GPU preferred' : 'CPU';
      console.log(`render ${c.spec.id} [${common.lang}]: frames ${from}..${to - 1} at ${common.width}x${heightFor(common.width)}, ${FPS} fps, ${atOnce}, ${plan.chunks.length} chunk(s), ${backend}, ${encoder}, group ${group}`);
      // The parent is done allocating scene and bake data. Children reserve their own memory.
      lease?.release();
      console.log(`  bake ${baked.baked ? 'baked' : 'cache hit'} in ${baked.seconds.toFixed(2)} s`);
      // Progress: rewritten in place on a terminal, one line every few seconds otherwise.
      const tty = process.stdout.isTTY === true;
      let lastShown = -Infinity;
      let shown = false;
      const result = await renderParallel({
        scene: sceneFile,
        ...(flag('reuse-scene') ? { preparedScene: { spec: c.spec, sceneHash: c.sceneHash } } : {}),
        bakeFile: baked.file,
        from,
        to,
        out: outFile(`${c.spec.id}_${common.lang}.mp4`),
        lang: common.lang,
        width: common.width,
        gpu: common.gpu,
        encoder,
        workers,
        group,
        chunk,
        hashes: flag('hashes'),
        onWait: (w) => {
          if (tty && shown) process.stdout.write('\n');
          shown = false;
          console.log(`  ${admissionWaitingLine(w)}`);
        },
        onProgress: (done, total, seconds) => {
          if (seconds - lastShown < (tty ? 0.25 : 5) && done < total) return;
          lastShown = seconds;
          shown = true;
          const line = `  ${done}/${total} frames, ${Math.floor((100 * done) / total)} %, ${(done / Math.max(seconds, 1e-3)).toFixed(0)} frames/s`;
          if (tty) process.stdout.write(`\r${line}    `);
          else console.log(line);
        },
      });
      if (tty && shown) process.stdout.write('\n');
      console.log(`  ${result.frames} frames in ${result.seconds.toFixed(2)} s = ${result.fps.toFixed(1)} frames/s`);
      console.log(`  ${result.out}`);
      if (result.hashesFile) console.log(`  ${result.hashesFile}`);
      return 0;
    }

    case 'motion': {
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const { series, report } = reviewMotion(c, bake, { lang: common.lang });
      console.log(formatMotionReport(report, c));
      const file = outFile('motion.json');
      write(file, motionReportJson(report));
      console.log(`\nfull report: ${file}`);
      if (flag('pictures')) {
        const count = int('top', str('top'), T.pictureSubjects, 1, 50);
        // The picture modules are loaded only by the commands that draw them.
        const { motionPictures } = await import('../review/pictures.ts');
        const pictures = await motionPictures(c, bake, series, report, { count, gpu: common.gpu, lang: common.lang });
        if (pictures.length === 0) console.log('pictures: none (no finding on a node, an emitter or the camera)');
        for (const p of pictures) {
          const path = join(common.outDir, 'motion', p.name);
          write(path, p.png);
          console.log(`${p.kind} of ${p.subject} (${p.note}): ${path}`);
        }
      } else if (report.findings.length > 0) {
        console.log('pictures: add --pictures for a trail and a graph of the worst findings; for any node, `skink3 trail <scene> --node <id>` and `skink3 graph <scene> --node <id>`');
      }
      // Findings are warnings: they never fail the command.
      return 0;
    }

    case 'physics': {
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const report = reviewPhysics(c, bake);
      console.log(formatPhysicsReport(report));
      const file = outFile('physics.json');
      write(file, physicsReportJson(report));
      console.log(`
full report: ${file}`);
      if (flag('pictures')) {
        const count = int('top', str('top'), P.pictureSubjects, 1, 50);
        // The picture modules are loaded only by the commands that draw them.
        const { physicsPictures } = await import('../review/physics-pictures.ts');
        const { sampleMotion } = await import('../review/series.ts');
        const pictures = await physicsPictures(c, bake, sampleMotion(c, bake, { lang: common.lang, particles: false }), report, { count, gpu: common.gpu, lang: common.lang });
        if (pictures.length === 0) console.log('pictures: none (no finding on a rigid body)');
        for (const p of pictures) {
          const path = join(common.outDir, 'physics', p.name);
          write(path, p.png);
          console.log(`${p.kind} of ${p.subject} (${p.note}): ${path}`);
        }
      } else if (report.findings.length > 0) {
        console.log('pictures: add --pictures for a close-up, a trail or a graph of the worst findings');
      }
      // Findings are warnings: they never fail the command.
      return 0;
    }

    case 'trail': {
      const ids = (str('node') ?? fail('trail: give --node <id[,id...]>')).split(',').filter((s) => s.length > 0);
      const space = str('space') ?? 'stage';
      if (space !== 'stage' && space !== 'screen') fail('--space must be stage or screen');
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const { series } = reviewMotion(c, bake, { lang: common.lang });
      const every = str('every') === undefined ? undefined : int('every', str('every'), 1, 1, 600);
      const { renderTrail } = await import('../review/trail.ts');
      const trail = await renderTrail(c, bake, series, {
        nodes: ids,
        ...window('trail'),
        ...(every === undefined ? {} : { every }),
        space,
        lang: common.lang,
        gpu: common.gpu,
        maxWidth: Math.min(1920, common.width),
      });
      const file = outFile(`trail_${ids.join('+')}_${String(trail.from).padStart(5, '0')}-${String(trail.to).padStart(5, '0')}${space === 'screen' ? '_screen' : ''}.png`);
      write(file, trail.png);
      console.log(`trail of ${ids.join(', ')}: frames ${trail.from}-${trail.to}, a ghost every ${trail.every} (${trail.ghosts} ghosts), ${trail.space} space, ${trail.width}x${trail.height}: ${file}`);
      return 0;
    }

    case 'graph': {
      const subject = flag('camera') ? CAMERA_SUBJECT : (str('node') ?? fail('graph: give --node <id> or --camera'));
      const { bake } = await ensureBake(c, common.cacheDir);
      const { series, report } = reviewMotion(c, bake, { lang: common.lang });
      // Findings an intended exception covers are marked too: the graph shows what happens, wanted or not.
      const findings = [...report.findings, ...report.honoured.flatMap((h) => h.findings)];
      const { renderGraph } = await import('../review/graph.ts');
      const graph = await renderGraph(series, { subject, ...window('graph'), findings });
      const whole = graph.from === 0 && graph.to === c.frames - 1;
      const name = flag('camera') ? 'camera' : subject;
      const file = outFile(`graph_${name}${whole ? '' : `_${String(graph.from).padStart(5, '0')}-${String(graph.to).padStart(5, '0')}`}.png`);
      write(file, graph.png);
      console.log(`graph of ${subject}: frames ${graph.from}-${graph.to}, ${graph.panels.length} panel(s): ${file}`);
      return 0;
    }

    case 'events': {
      const { bake } = await ensureBake(c, common.cacheDir);
      const events = sceneEvents(c, bake, { lang: common.lang });
      const file = outFile('events.json');
      write(file, `${JSON.stringify({ shot: c.spec.id, frames: c.frames, seconds: c.frames / FPS, kinds: EVENT_KINDS, events }, null, 1)}\n`);
      const byKind = EVENT_KINDS.map((kind) => [kind, events.filter((e) => e.kind === kind).length] as const).filter(([, n]) => n > 0);
      console.log(`events ${c.spec.id}: ${events.length} event(s) in ${c.frames} frames, ${events.filter((e) => e.seen).length} of them seen`);
      if (byKind.length > 0) console.log(`  ${byKind.map(([kind, n]) => `${kind} ${n}`).join(', ')}`);
      console.log(`full list: ${file}`);
      return 0;
    }

    case 'sfx': {
      const bank = loadBank(str('bank') ?? fail('sfx: give --bank <bank.json>, the bank of sounds'));
      const { bake } = await ensureBake(c, common.cacheDir);
      loaded();
      const track = renderSound(c, bake, bank, { lang: common.lang });
      const file = outFile(`${c.spec.id}_sfx.wav`);
      write(file, track.wav);
      // The report lies next to the track when the track is put somewhere else.
      const reportFile = str('out') ? `${file}.json` : join(common.outDir, 'sfx.json');
      write(reportFile, soundReportJson(track.report));
      console.log(formatSoundReport(track.report));
      console.log(`\ntrack: ${file}`);
      console.log(`full report: ${reportFile}`);
      if (flag('sheet')) {
        if (track.plan.voices.length === 0) console.log('sheet: none (the track is silent)');
        else {
          // The picture modules are loaded only by the commands that draw them.
          const { renderSoundSheet } = await import('../audio/sheet.ts');
          const sheet = await renderSoundSheet(c, bake, track.plan, {
            cols: int('cols', str('cols'), 4, 1, 40),
            tileWidth: int('tile', str('tile'), 480, 64, 3840),
            lang: common.lang,
            gpu: common.gpu,
          });
          const sheetFile = str('out') ? `${file}.sheet.png` : join(common.outDir, 'sfx_sheet.png');
          write(sheetFile, sheet.png);
          const showers = sheet.tiles.filter((t) => t.shower).length;
          console.log(`sheet: ${sheet.tiles.length} tile(s), ${showers} of them shower(s)${sheet.more > 0 ? `; ${sheet.more} more sound(s) do not fit on it` : ''}: ${sheetFile}`);
        }
      }
      return 0;
    }

    // Internal: one worker of `render`.
    case '_chunk': {
      // Fault injection, used by the tests of the parallel renderer only.
      const failAt = process.env['SKINK3_TEST_FAIL_AT_FRAME'];
      const bakePath = str('bake') ?? fail('_chunk: --bake is required');
      const bake = readBake(bakePath);
      if (bake.header.sceneHash !== c.sceneHash) fail('_chunk: the bake does not belong to this scene');
      loaded();
      // A render stops its other workers when one fails. On Windows a worker's encoder dies with the worker; elsewhere
      // it would outlive it, write its chunk after the render removed it and keep its place, so it is stopped first.
      const stopped = new AbortController();
      const stop = (): void => stopped.abort();
      process.once('SIGTERM', stop);
      try {
        await renderChunk(c, bake, {
          from: int('from', str('from'), 0, 0, c.frames - 1),
          to: int('to', str('to'), c.frames, 1, c.frames),
          out: str('out') ?? fail('_chunk: --out is required'),
          lang: common.lang,
          width: common.width,
          gpu: common.gpu,
          lease: lease ?? undefined,
          encoder,
          hashesFile: str('hashes-file') ?? null,
          onFrames: (frames) => {
            process.send?.({ frames });
          },
          ...(failAt === undefined ? {} : { failAtFrame: Number(failAt) }),
          signal: stopped.signal,
        });
      } catch (error) {
        // Stopped by its render, which reports why: exit as a terminated process would, without a message.
        if (stopped.signal.aborted) return 143;
        throw error;
      } finally {
        process.off('SIGTERM', stop);
      }
      return 0;
    }

    default:
      return fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

/** Prints the machine's queue, including estimates that have already been reserved. */
function printQueue(): void {
  if (queueKind() === 'places') {
    printPlaces();
    return;
  }
  const config = queueConfig();
  const state = queueState(config);
  const gib = (bytes: number): string => (bytes / GIB).toFixed(2) + ' GiB';
  console.log(`render queue (${config.dir}), ${GROUP_WORKERS} drawing workers per group`);
  console.log(`RAM: ${gib(state.memory.ram.free)} free, ${gib(config.freeRamGb * GIB)} floor, ${gib(Math.max(0, state.available.ram))} available to reserve`);
  if (state.memory.vram) {
    console.log(`VRAM: ${gib(state.memory.vram.free)} from ${state.memory.vram.source}, ${gib(config.freeVramGb * GIB)} floor, ${gib(Math.max(0, state.available.vram ?? 0))} available to reserve`);
  } else {
    console.log('VRAM: no live reading or configured budget');
  }
  const line = (entry: QueueEntry): void => {
    console.log(`  ${entry.phase}  pid ${entry.pid}  ${gib(entry.memory.ram)} RAM  ${gib(entry.memory.vram)} VRAM  [${entry.group}] ${entry.what}`);
  };
  [...state.active, ...state.waiting].forEach(line);
}

/** Prints the place queue: each lane's holders and waiters, and the memory pressure now. */
function printPlaces(): void {
  const config = placesConfig();
  const state = placesState(config);
  console.log(`render queue (${config.dir}), places: ${config.long} long, ${config.short} short; memory pressure ${pressureName(state.pressure)}`);
  const line = (entry: PlaceEntry): void => {
    console.log(`  ${entry.phase}  pid ${entry.pid}  ${entry.group ? `[${entry.group}] ` : ''}${entry.what}`);
  };
  for (const [name, lane] of [['long', state.long], ['short', state.short]] as const) {
    console.log(`${name}: ${lane.active.length}/${lane.limit} held, ${lane.waiting.length} waiting`);
    [...lane.active, ...lane.waiting].forEach(line);
  }
}
