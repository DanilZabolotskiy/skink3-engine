// Benchmark frame: gradient background, 3 depth layers with blur, boolean-op light crescents on 532 shapes, glow, 5k particles, text.
// Usage: node bench/render.mjs <width> <gpu|cpu> <frames>   (env NOSAVE=1 skips writing frame_<w>_<engine>.png)
import {Canvas, Path2D, DOMMatrix} from 'skia-canvas';
const W = +process.argv[2] || 3840, H = Math.round(W * 9 / 16), GPU = process.argv[3] !== 'cpu', N = +process.argv[4] || 20;
const s = W / 3840;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function blob(cx, cy, r, k = 9) { const p = new Path2D(); for (let i = 0; i <= k; i++) { const a = i / k * Math.PI * 2, rr = r * (0.85 + 0.15 * Math.sin(i * 2.3)); i ? p.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : p.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } p.closePath(); return p.round(r * 0.35); }
function lit(ctx, path, base, dark, light, r, f) {   // auto light: crescent = shape minus shifted shape
  const t = new DOMMatrix().translate(-r * 0.18, -r * 0.18), t2 = new DOMMatrix().translate(r * 0.08, r * 0.08);
  ctx.fillStyle = base; ctx.fill(path);
  ctx.fillStyle = dark; ctx.fill(path.difference(path.transform(t)));
  ctx.fillStyle = light; ctx.fill(path.difference(path.transform(t2)));
}
const scene = [];
for (let i = 0; i < 400; i++) scene.push({L: 0, x: rnd() * 3840, y: rnd() * 2160, r: 20 + rnd() * 60});
for (let i = 0; i < 120; i++) scene.push({L: 1, x: rnd() * 3840, y: rnd() * 2160, r: 60 + rnd() * 140});
for (let i = 0; i < 12; i++) scene.push({L: 2, x: rnd() * 3840, y: rnd() * 2160, r: 250 + rnd() * 250});
const parts = Array.from({length: 5000}, () => [rnd() * 3840, rnd() * 2160, 2 + rnd() * 6, (rnd() * 6) | 0]);
const PAL = ['#3BE5DF', '#F0D22F', '#E68C28', '#CE237B', '#68DB45', '#9E41DE'];
function layerCanvas() { const c = new Canvas(W, H); c.gpu = GPU; return c; }
function frame(f) {
  const out = new Canvas(W, H); out.gpu = GPU; const ctx = out.getContext('2d');
  const g = ctx.createRadialGradient(W * .5, H * .4, 0, W * .5, H * .5, W * .7); g.addColorStop(0, '#2A0E6E'); g.addColorStop(1, '#070420');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const dx = f * 0.6 * s;
  for (const L of [0, 1, 2]) {
    const lc = layerCanvas(), lx = lc.getContext('2d'); lx.scale(s, s); lx.translate(-dx * (L + 1), 0);
    for (const o of scene) if (o.L === L) lit(lx, blob(o.x, o.y, o.r), ['#2B1A78', '#5525AD', '#B32871'][L], ['#170A4A', '#310E6C', '#641437'][L], ['#4A3AB0', '#9C64CF', '#F28AB8'][L], o.r);
    ctx.save(); ctx.filter = L === 0 ? 'blur(' + 6 * s + 'px)' : L === 2 ? 'blur(' + 40 * s + 'px)' : 'none'; ctx.drawCanvas(lc, 0, 0); ctx.restore();
  }
  // particles (instanced-ish: one path per colour)
  const ps = PAL.map(() => new Path2D());
  for (const [x, y, r, c] of parts) { const X = ((x - dx * 1.5) % 3840 + 3840) % 3840 * s; ps[c].moveTo(X + r * s, y * s); ps[c].arc(X, y * s, r * s, 0, Math.PI * 2); }
  ps.forEach((p, i) => { ctx.fillStyle = PAL[i]; ctx.fill(p); });
  // glow: neon ring + bloom copy
  const gl = layerCanvas(), gx = gl.getContext('2d'); gx.strokeStyle = '#7CF7FF'; gx.lineWidth = 14 * s; gx.lineCap = 'round';
  gx.beginPath(); gx.arc(W * .5, H * .5, 500 * s, f * .02, f * .02 + 4.2); gx.stroke();
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.filter = 'blur(' + 30 * s + 'px)'; ctx.drawCanvas(gl, 0, 0); ctx.filter = 'none'; ctx.drawCanvas(gl, 0, 0); ctx.restore();
  ctx.font = `700 ${64 * s}px Arial`; ctx.fillStyle = '#F4EF9E'; ctx.fillText('Glucose · C6H12O6 · 180 g/mol', 200 * s, 1900 * s);
  return out;
}
let t0 = performance.now(), tr = 0;
for (let f = 0; f < N; f++) {
  const c = frame(f); const a = performance.now();
  const buf = await c.toBuffer('raw'); tr += performance.now() - a;
  if (f === 0 && !process.env.NOSAVE) { await c.toFile(`frame_${W}_${GPU ? 'gpu' : 'cpu'}.png`); if (buf.length !== W * H * 4) console.log('raw len', buf.length); }
}
const dt = (performance.now() - t0) / N;
console.log(`${W}x${H} ${GPU ? 'GPU' : 'CPU'}: ${dt.toFixed(1)} ms/frame (raster+readback ${ (tr / N).toFixed(1)} ms)  -> ${(1000 / dt).toFixed(1)} fps single process`);
