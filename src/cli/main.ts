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
import { chunkFrames, planOf, renderChunk, renderParallel } from '../render/parallel.ts';
import { envPriority, holdSlotForGpu, parsePriority, queueConfig, queueState, renderPriority, waitingLine, type Priority, type Waiting } from '../render/queue.ts';
import { rawToPng, renderSheet, type SheetTile } from '../render/sheet.ts';
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
  queue   the render slots of this machine: who draws on the GPU, who waits (takes no scene module)

Common options
  --lang <tag>        language of the string tables (default: the first table)
  --width <px>        output width, 16:9 (default 1920)
  --cpu               draw on the CPU instead of the GPU
  --out <file>        output file (default under ./out/<shot>/)
  --cache <dir>       bake cache directory (default ./cache)
  --priority high|low the turn in the render queue (default high; low for a render wider than 1920)

still   --frame <n[,n...]> | --time <s[,s...]>   [--hash]
strip   --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  [--workers <n>] [--chunk <frames>] [--from <frame>] [--to <frame>] [--encoder x264|nvenc] [--hashes] [--force]
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
print or write the SHA-256 of each frame's raw RGBA pixels. --pictures writes
pictures of the worst few subjects of the report: a trail and a graph for
motion; a close-up, a trail or a graph, by the kind of finding, for physics.
--sheet (of sfx) writes the sound sheet of the track: a tile for every sound,
with the frame it is placed on, the node it comes from ringed, an arrow along
the way of a move, and the sound, the kind of event and the time written on
it. A shower, the run of a sound that the bank sets apart, is one tile, with
its count and its length.

The render queue: a process that draws on the GPU first takes one of the
machine's render slots, which every checkout shares (SKINK3_RENDER_SLOTS,
default 4, 0 for no limit; in the directory SKINK3_SLOT_DIR), and waits when
they are all taken: quick work first, then a render wider than 1920 or one
given --priority low (or SKINK3_RENDER_PRIORITY=low), which is served in the
end however much quick work comes. A render keeps at most as many workers
alive as there are slots, and splits its frames into chunks of at most
--chunk frames (900 at 1920 wide, as many pixels at other widths; 0: one
chunk per worker), each worker giving its slot back after its chunk.`;

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

/** The render slot this process holds for the frames it draws on the GPU, if it holds one; given back when `main` returns. */
let held: { release(): void } | null = null;

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv);
  } finally {
    held?.release();
    held = null;
  }
}

async function run(argv: readonly string[]): Promise<number> {
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
      priority: { type: 'string' },
      chunk: { type: 'string' },
    },
  });
  const str = (name: string): string | undefined => {
    const v = (values as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : undefined;
  };
  const flag = (name: string): boolean => (values as Record<string, unknown>)[name] === true;

  // The one command without a scene: the render queue of the machine.
  if (command === 'queue') {
    printQueue();
    return 0;
  }
  const scene = positionals[0];
  if (!scene) fail(`${command}: give the path of a scene module\n\n${HELP}`);
  const { compiled, file: sceneFile } = await loadShot(scene);
  const langs = languagesOf(compiled.spec.strings);
  const langArg = str('lang');
  const common: Common = {
    compiled,
    sceneFile,
    lang: langArg?.split(',')[0] ?? langs[0]!,
    width: int('width', str('width'), 1920, 64, 7680),
    gpu: !flag('cpu'),
    cacheDir: resolve(process.cwd(), str('cache') ?? 'cache'),
    outDir: resolve(process.cwd(), 'out', compiled.spec.id),
  };
  const flagPriority = parsePriority(str('priority'), '--priority');
  /** The turn of this process in the render queue: --priority, SKINK3_RENDER_PRIORITY, or by what it draws. */
  const priority = (): Priority => flagPriority ?? envPriority() ?? (command === 'render' ? renderPriority(common.width) : 'high');
  const wantedLangs = langArg ? langArg.split(',') : null;
  for (const l of wantedLangs ?? []) {
    if (!langs.includes(l)) fail(`--lang ${l}: no such string table (available: ${langs.join(', ')})`);
  }
  const outFile = (fallback: string): string => {
    const o = str('out');
    return o ? resolve(process.cwd(), o) : join(common.outDir, fallback);
  };
  const c = compiled;
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

  // A command that draws frames on the GPU takes a render slot of the machine before its first frame and holds it to
  // its end; one that turns out to draw nothing never waits. A worker of a render tells its parent that it waits.
  const worker = command === '_chunk' && typeof process.send === 'function';
  if (common.gpu && DRAWS.has(command)) {
    held = holdSlotForGpu(queueConfig(), {
      priority: priority(),
      what: `${command} ${basename(sceneFile)} ${common.width}x${heightFor(common.width)}${command === '_chunk' ? ` frames ${str('from') ?? 0}..${Number(str('to') ?? c.frames) - 1}` : ''}`,
      onWait: worker ? (w: Waiting) => process.send?.({ waiting: w }) : (w: Waiting) => console.log(waitingLine(w)),
    });
  }
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
      const frames = str('frame')
        ? intList('frame', str('frame')!)
        : str('time')
          ? numList('time', str('time')!).map((s) => Math.round(s * FPS))
          : fail('still: give --frame <n[,n...]> or --time <s[,s...]>');
      const { bake } = await ensureBake(c, common.cacheDir);
      const height = heightFor(common.width);
      if (frames.length > 1 && str('out')) fail('still: --out works with a single frame');
      for (const f of frames) {
        checkFrame(c, f);
        const raw = await frameRaw(c, bake, f, { width: common.width, lang: common.lang, gpu: common.gpu });
        const file = outFile(`still_${String(f).padStart(5, '0')}_${common.lang}.png`);
        write(file, await rawToPng(raw, common.width, height));
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
      const png = await renderSheet(c, bake, tiles, {
        cols: int('cols', str('cols'), 6, 1, 40),
        tileWidth: int('tile', str('tile'), 480, 64, 3840),
        crop: crop(str('crop')),
        gpu: common.gpu,
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
      const png = await renderSheet(c, bake, tiles, {
        cols,
        tileWidth: int('tile', str('tile'), 480, 64, 3840),
        crop: crop(str('crop')),
        gpu: common.gpu,
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
      const encoder = (str('encoder') ?? 'x264') as Encoder;
      if (encoder !== 'x264' && encoder !== 'nvenc') fail('--encoder must be x264 or nvenc');
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
      const workers = int('workers', str('workers'), Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))), 1, 64);
      const chunk = int('chunk', str('chunk'), chunkFrames(common.width), 0, 1e9);
      const plan = planOf({ from, to, workers, width: common.width, gpu: common.gpu, chunk });
      const queue = common.gpu ? queueConfig() : null;
      const turn = priority();
      const info = rendererInfo(common.gpu);
      const atOnce = `${plan.atOnce} worker(s)${plan.atOnce < plan.workers ? ` at once (${plan.workers} asked, ${queue?.slots} render slots)` : ''}`;
      const queued = queue && queue.slots > 0 ? `, priority ${turn}` : ', no render queue';
      console.log(`render ${c.spec.id} [${common.lang}]: frames ${from}..${to - 1} at ${common.width}x${heightFor(common.width)}, ${FPS} fps, ${atOnce}, ${plan.chunks.length} chunk(s), ${info.renderer}${info.renderer === 'GPU' && info.api ? ` ${info.api}` : ''}, ${encoder}${common.gpu ? queued : ''}`);
      console.log(`  bake ${baked.baked ? 'baked' : 'cache hit'} in ${baked.seconds.toFixed(2)} s`);
      // Progress: rewritten in place on a terminal, one line every few seconds otherwise.
      const tty = process.stdout.isTTY === true;
      let lastShown = -Infinity;
      let shown = false;
      const result = await renderParallel({
        scene: sceneFile,
        bakeFile: baked.file,
        from,
        to,
        out: outFile(`${c.spec.id}_${common.lang}.mp4`),
        lang: common.lang,
        width: common.width,
        gpu: common.gpu,
        encoder,
        workers,
        chunk,
        priority: turn,
        hashes: flag('hashes'),
        onWait: (w) => {
          if (tty && shown) process.stdout.write('\n');
          shown = false;
          console.log(`  ${waitingLine(w)}`);
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
      // A worker whose render is gone (its parent was ended) stops, and its slot is given back as it exits.
      const orphaned = (): void => process.exit(1);
      if (worker) process.on('disconnect', orphaned);
      try {
        await renderChunk(c, bake, {
          from: int('from', str('from'), 0, 0, c.frames - 1),
          to: int('to', str('to'), c.frames, 1, c.frames),
          out: str('out') ?? fail('_chunk: --out is required'),
          lang: common.lang,
          width: common.width,
          gpu: common.gpu,
          encoder: (str('encoder') ?? 'x264') as Encoder,
          hashesFile: str('hashes-file') ?? null,
          onFrames: (frames) => {
            process.send?.({ frames });
          },
          ...(failAt === undefined ? {} : { failAtFrame: Number(failAt) }),
        });
      } finally {
        process.off('disconnect', orphaned);
      }
      return 0;
    }

    default:
      return fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

/** The commands that may draw frames on the GPU, and so take a render slot before they do. */
const DRAWS = new Set(['still', 'strip', 'sheet', 'trail', 'motion', 'physics', 'sfx', '_chunk']);

/** `skink3 queue`: the render slots of the machine, who holds them and who waits. */
function printQueue(): void {
  const queue = queueConfig();
  if (queue.slots === 0) {
    console.log('render queue: off (SKINK3_RENDER_SLOTS=0): no limit on the processes that draw on the GPU');
    return;
  }
  const state = queueState(queue);
  const ago = (seconds: number): string => `${Math.round(seconds)} s`;
  console.log(`render queue: ${queue.slots} slot(s), ${state.held.filter((h) => h !== null).length} busy, ${state.waiting.length} waiting (${queue.dir})`);
  state.held.forEach((h, i) => {
    console.log(h ? `  slot ${i + 1}  pid ${h.pid}  ${h.priority.padEnd(4)}  ${ago(h.seconds).padStart(6)}  ${h.what}` : `  slot ${i + 1}  free`);
  });
  state.waiting.forEach((w, i) => {
    console.log(`  wait ${i + 1}  pid ${w.pid}  ${w.priority.padEnd(4)}  ${ago(w.seconds).padStart(6)}  ${w.what}`);
  });
}
