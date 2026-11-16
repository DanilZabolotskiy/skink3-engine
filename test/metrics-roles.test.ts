// tools/metrics measures any video, so it has to hold for any frame: also one
// in which a role has few pixels or none (a dark shot with a handful of light
// pixels, a shot without an accent, a shot without a dark pixel).
//
// The tools are Python scripts. These tests run them on frames made here, and
// are skipped, with the reason, where Python with numpy and opencv-python is
// not installed (docs/METRICS.md lists what the tools need).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas } from 'skia-canvas';

const TOOLS = fileURLToPath(new URL('../tools/metrics/', import.meta.url));

/** The Python on PATH that has the modules, or null. */
function findPython(modules: string): string | null {
  for (const exe of ['python', 'python3']) {
    if (spawnSync(exe, ['-I', '-c', `import ${modules}`], { encoding: 'utf8' }).status === 0) return exe;
  }
  return null;
}

const python = findPython('numpy, cv2');
const pythonWithPillow = findPython('numpy, cv2, PIL');
const skip = python ? false : 'needs Python with numpy and opencv-python on PATH (docs/METRICS.md)';
const skipPalette = pythonWithPillow ? false : 'needs Python with numpy, opencv-python and Pillow on PATH (docs/METRICS.md)';

// The colours of the frames, each well inside its role as roles.py reads it (CIE L*, and HSV for the accent).
const DEEP = '#0B0820'; // L* 3
const DARK = '#2A2060'; // L* 17
const MID = '#5A6FB0'; // L* 48
const ACCENT = '#FF8000'; // saturation 1, value 1; L* 67, which is no role of lightness
const LIGHT = '#FAF2C8'; // L* 95
const WHITE = '#FFFFFF';

/** roles.py reads a frame at 96 x 54. A frame of ten times that size puts a block of 10 x 10 px on each of its pixels. */
const W = 960;
const H = 540;
const SAMPLES = 96 * 54;

interface Patch {
  /** In pixels of the sample: 96 x 54. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/** A work directory of the tools with one sampled frame of one clip: a ground and patches on it. */
function frame(ground: string, patches: readonly Patch[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'skink3-metrics-'));
  const dir = join(root, 'an', 'clip', 's');
  mkdirSync(dir, { recursive: true });
  const canvas = new Canvas(W, H, { gpu: false });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, W, H);
  for (const p of patches) {
    ctx.fillStyle = p.fill;
    ctx.fillRect(p.x * 10, p.y * 10, p.w * 10, p.h * 10);
  }
  writeFileSync(join(dir, '0001.jpg'), canvas.toBufferSync('jpg', { quality: 1 }));
  return root;
}

const ROLES = ['deep (L<12)', 'dark (12-30)', 'mid (30-60)', 'accent (S>.6,V>.7)', 'light (L>85)'] as const;

interface Measured {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lines: string[];
  /** an/roles.json: per role its share in per cent and its colours, each with its share of the role. */
  readonly roles: Record<string, { share: number; colors: [string, number][] }>;
}

/** Runs roles.py on a work directory, as a shot is measured: no sample is left out. */
function measure(root: string): Measured {
  const r = spawnSync(python!, ['-I', join(TOOLS, 'roles.py'), root.replaceAll('\\', '/'), '0'], { encoding: 'utf8' });
  const stdout = r.stdout.replace(/\r\n/g, '\n');
  let roles: Measured['roles'] = {};
  try {
    roles = JSON.parse(readFileSync(join(root, 'an', 'roles.json'), 'utf8')) as Measured['roles'];
  } catch {
    // The run failed before it wrote its result; the assertions on the status say so.
  }
  return { status: r.status, stdout, stderr: r.stderr, lines: stdout.trimEnd().split('\n'), roles };
}

/** The output has its shape: a line per role in their order, then the three lines of tone, every number a number. */
function assertShape(m: Measured): void {
  assert.equal(m.status, 0, `roles.py failed: ${m.stderr.trim().split('\n').slice(-4).join(' | ')}`);
  assert.equal(m.lines.length, 8, m.stdout);
  ROLES.forEach((name, i) => assert.ok(m.lines[i]!.startsWith(`${name} `), `line ${i + 1} is the role ${name}: ${m.lines[i]}`));
  assert.deepEqual(Object.keys(m.roles), [...ROLES]);
  for (const name of ROLES) {
    const role = m.roles[name]!;
    assert.ok(typeof role.share === 'number' && role.share >= 0 && role.share <= 100 && Array.isArray(role.colors), `${name}: ${JSON.stringify(role)}`);
    for (const [hex, share] of role.colors) assert.ok(/^#[0-9A-F]{6}$/.test(hex) && share >= 0 && share <= 100, `${name}: ${hex} ${share}`);
  }
  const hist = /^dark hue hist 30deg: (\[.*\])$/.exec(m.lines[5]!);
  assert.ok(hist, m.lines[5]!);
  const bins = JSON.parse(hist[1]!) as number[];
  assert.ok(bins.length === 12 && bins.every((b) => typeof b === 'number' && b >= 0 && b <= 1), m.lines[5]!);
  assert.match(m.lines[6]!, /^overall: median L -?[\d.]+ {2}S of L<30: [\d.]+ {2}gray\(S<\.12\): [\d.]+$/);
  assert.match(m.lines[7]!, /^L<30 over all pixels: [\d.]+ % {2}\| dark frames \(V<\.3 on more than half of the frame\): \d+ of 1/);
  assert.ok(!/nan/i.test(m.stdout), `a number that is no number: ${m.stdout}`);
  assert.ok(!/Warning|Traceback/.test(m.stderr), m.stderr);
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const sum = (colors: readonly [string, number][]): number => colors.reduce((a, c) => a + c[1], 0);

test('metrics roles: a role that no pixel has is reported with share 0 and no colours', { skip }, () => {
  // A dark frame: every pixel is deep. The four other roles are empty.
  const root = frame(DEEP);
  try {
    const m = measure(root);
    assertShape(m);
    assert.equal(m.roles['deep (L<12)']!.share, 100);
    assert.ok(m.roles['deep (L<12)']!.colors.length === 6 && Math.abs(sum(m.roles['deep (L<12)']!.colors) - 100) <= 3, JSON.stringify(m.roles['deep (L<12)']));
    for (const name of ROLES.slice(1)) {
      assert.deepEqual(m.roles[name], { share: 0, colors: [] }, name);
      assert.equal(m.lines[ROLES.indexOf(name)], `${name} 0.0`, 'its line holds its share and nothing else');
    }
    assert.match(m.lines[7]!, /^L<30 over all pixels: 100\.0 % {2}\| dark frames .*: 1 of 1, L<30 in them: median 100 %/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metrics roles: a role with fewer pixels than clusters gets as many colours as it has pixels', { skip }, () => {
  // A dark frame with five light pixels (the light roles are clustered into 6) and three of an accent (it is clustered into 10).
  const root = frame(DEEP, [
    { x: 40, y: 20, w: 5, h: 1, fill: WHITE },
    { x: 10, y: 40, w: 3, h: 1, fill: ACCENT },
  ]);
  try {
    const m = measure(root);
    assertShape(m);
    const light = m.roles['light (L>85)']!;
    const accent = m.roles['accent (S>.6,V>.7)']!;
    // 5 and 3 of 5184 pixels: both shares round to 0.1 %.
    assert.equal(light.share, Math.round((5 / SAMPLES) * 1000) / 10);
    assert.equal(accent.share, Math.round((3 / SAMPLES) * 1000) / 10);
    assert.equal(light.colors.length, 5);
    assert.equal(accent.colors.length, 3);
    assert.ok(Math.abs(sum(light.colors) - 100) <= 3 && Math.abs(sum(accent.colors) - 100) <= 2, JSON.stringify([light, accent]));
    // The colours are those of the pixels: white, and the accent.
    for (const [hex] of light.colors) assert.ok(rgb(hex).every((v) => v > 235), `light: ${hex}`);
    for (const [hex] of accent.colors) assert.ok(rgb(hex)[0] > 235 && rgb(hex)[2] < 60, `accent: ${hex}`);
    // One pixel is its own cluster.
    const one = frame(DEEP, [{ x: 40, y: 20, w: 1, h: 1, fill: WHITE }]);
    try {
      const single = measure(one);
      assertShape(single);
      assert.deepEqual(single.roles['light (L>85)']!.colors.map((c) => c[1]), [100]);
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metrics roles: a role with pixels enough has all its colours, as it always had', { skip }, () => {
  // Five bands, one per role: 6 colours for each role of lightness, 10 for the accent.
  const band = (i: number, fill: string): Patch => ({ x: 0, y: i * 10, w: 96, h: 10, fill });
  const root = frame(DEEP, [band(1, DARK), band(2, MID), band(3, ACCENT), band(4, LIGHT)]);
  try {
    const m = measure(root);
    assertShape(m);
    for (const name of ROLES) {
      const role = m.roles[name]!;
      assert.equal(role.colors.length, name.startsWith('accent') ? 10 : 6, name);
      // A band of ten rows of the 54, and the deep ground has the fourteen rows that are left.
      assert.ok(Math.abs(role.share - (name.startsWith('deep') ? 1400 / 54 : 1000 / 54)) < 1, `${name}: ${role.share}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metrics roles: frames without a dark pixel have numbers for their darks, not NaN', { skip }, () => {
  // A light frame: the deep and the dark role are empty, and so is the set of dark pixels whose hue and saturation are measured.
  const root = frame(LIGHT);
  try {
    const m = measure(root);
    assertShape(m);
    assert.deepEqual(m.roles['deep (L<12)'], { share: 0, colors: [] });
    assert.deepEqual(m.roles['dark (12-30)'], { share: 0, colors: [] });
    assert.equal(m.roles['light (L>85)']!.share, 100);
    assert.equal(m.lines[5], `dark hue hist 30deg: [${Array(12).fill('0.0').join(', ')}]`);
    assert.match(m.lines[6]!, / {2}S of L<30: 0\.0 {2}/);
    assert.match(m.lines[7]!, /^L<30 over all pixels: 0\.0 % {2}\| dark frames .*: 0 of 1 {2}\| the other frames: median 0 %/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metrics palette: frames without a dark pixel give valid JSON', { skip: skipPalette }, () => {
  const root = frame(LIGHT);
  try {
    const r = spawnSync(pythonWithPillow!, ['-I', join(TOOLS, 'palette.py'), root.replaceAll('\\', '/'), 'clip', '0'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/Warning|Traceback/.test(r.stderr), r.stderr);
    // "<id> {json}" on its first line: what a reader of the output parses.
    const first = r.stdout.replace(/\r\n/g, '\n').split('\n')[0]!;
    assert.ok(first.startsWith('clip {'), first);
    const stats = JSON.parse(first.slice('clip '.length)) as Record<string, unknown>;
    assert.equal(stats['meanS_dark'], 0);
    assert.equal(stats['dark_V_lt_0_3'], 0);
    const saved = JSON.parse(readFileSync(join(root, 'an', 'clip', 'palette.json'), 'utf8')) as { stats: Record<string, unknown>; palette: unknown[] };
    assert.equal(saved.stats['meanS_dark'], 0);
    assert.equal(saved.palette.length, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
