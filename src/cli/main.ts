// Command-line entry point: bake, still, strip, sheet, render, check.
// Output goes to ./out and the bake cache to ./cache of the caller's working
// directory, wherever the scene module and the engine live.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport, runChecks } from '../checks/index.ts';
import { FPS } from '../core/time.ts';
import { ensureBake } from '../physics/bake.ts';
import { bakeHash, readBake } from '../physics/cache.ts';
import { ffmpegAvailable, type Encoder } from '../render/encode.ts';
import { frameRaw, heightFor, rendererInfo } from '../render/frame.ts';
import { renderChunk, renderParallel } from '../render/parallel.ts';
import { rawToPng, renderSheet, type SheetTile } from '../render/sheet.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { languagesOf } from '../text/strings.ts';
import { engineVersion, physicsVersion } from '../version.ts';
import { loadShot } from './load.ts';

const HELP = `skink3 <command> <scene module> [options]

Commands
  check   palette laws, string tables and text fit in every language
  bake    simulate physics, springs and particles; write the cache
  still   one or more frames as PNG
  strip   a motion strip: consecutive frames side by side
  sheet   a contact sheet of the whole shot (or of chosen frames, per language)
  render  the shot as an mp4 (parallel chunk workers, joined by ffmpeg)

Common options
  --lang <tag>        language of the string tables (default: the first table)
  --width <px>        output width, 16:9 (default 1920)
  --cpu               draw on the CPU instead of the GPU
  --out <file>        output file (default under ./out/<shot>/)
  --cache <dir>       bake cache directory (default ./cache)

still   --frame <n[,n...]> | --time <s[,s...]>   [--hash]
strip   --from <frame> [--count 12] [--step 2] [--cols 6] [--tile 480] [--crop x,y,w,h]
sheet   [--cols 6] [--rows 5] [--frames n,n,...] [--lang a,b] [--tile 480] [--crop x,y,w,h]
render  [--workers <n>] [--from <frame>] [--to <frame>] [--encoder x264|nvenc] [--hashes] [--force]
bake    [--force]
check   (no options; --lang limits the text checks to some languages)

--crop is in stage units (1920 x 1080, origin top-left). --hash and --hashes
print or write the SHA-256 of each frame's raw RGBA pixels.`;

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
    },
  });
  const str = (name: string): string | undefined => {
    const v = (values as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : undefined;
  };
  const flag = (name: string): boolean => (values as Record<string, unknown>)[name] === true;

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
  const wantedLangs = langArg ? langArg.split(',') : null;
  for (const l of wantedLangs ?? []) {
    if (!langs.includes(l)) fail(`--lang ${l}: no such string table (available: ${langs.join(', ')})`);
  }
  const outFile = (fallback: string): string => {
    const o = str('out');
    return o ? resolve(process.cwd(), o) : join(common.outDir, fallback);
  };
  const c = compiled;

  switch (command) {
    case 'check': {
      const { bake } = await ensureBake(c, common.cacheDir);
      const report = runChecks(c, bake, wantedLangs ?? undefined);
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
      }
      const from = int('from', str('from'), 0, 0, c.frames - 1);
      const to = int('to', str('to'), c.frames, from + 1, c.frames);
      const workers = int('workers', str('workers'), Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))), 1, 64);
      const info = rendererInfo(common.gpu);
      console.log(`render ${c.spec.id} [${common.lang}]: frames ${from}..${to - 1} at ${common.width}x${heightFor(common.width)}, ${FPS} fps, ${workers} worker(s), ${info.renderer}${info.renderer === 'GPU' && info.api ? ` ${info.api}` : ''}, ${encoder}`);
      console.log(`  bake ${baked.baked ? 'baked' : 'cache hit'} in ${baked.seconds.toFixed(2)} s`);
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
        hashes: flag('hashes'),
      });
      console.log(`  ${result.frames} frames in ${result.seconds.toFixed(2)} s = ${result.fps.toFixed(1)} frames/s`);
      console.log(`  ${result.out}`);
      if (result.hashesFile) console.log(`  ${result.hashesFile}`);
      return 0;
    }

    // Internal: one worker of `render`.
    case '_chunk': {
      const bakePath = str('bake') ?? fail('_chunk: --bake is required');
      const bake = readBake(bakePath);
      if (bake.header.sceneHash !== c.sceneHash) fail('_chunk: the bake does not belong to this scene');
      await renderChunk(c, bake, {
        from: int('from', str('from'), 0, 0, c.frames - 1),
        to: int('to', str('to'), c.frames, 1, c.frames),
        out: str('out') ?? fail('_chunk: --out is required'),
        lang: common.lang,
        width: common.width,
        gpu: common.gpu,
        encoder: (str('encoder') ?? 'x264') as Encoder,
        hashesFile: str('hashes-file') ?? null,
      });
      return 0;
    }

    default:
      return fail(`unknown command "${command}"\n\n${HELP}`);
  }
}
