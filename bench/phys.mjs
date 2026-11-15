import RAPIER from '@dimforge/rapier2d-deterministic-compat';
await RAPIER.init();
// 1) rigid pile: 2000 capsules/boxes falling into a bowl, dt 1/240 (4 substeps per 60 fps frame)
const world = new RAPIER.World({x: 0, y: -9.81});
world.timestep = 1 / 240;
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.polyline(new Float32Array([-40, 30, -30, 0, 30, 0, 40, 30])), ground);
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const bodies = [];
for (let i = 0; i < 2000; i++) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-25 + rnd() * 50, 5 + i * 0.12).setRotation(rnd() * 6));
  world.createCollider(i % 2 ? RAPIER.ColliderDesc.capsule(0.35, 0.15).setRestitution(0.2) : RAPIER.ColliderDesc.cuboid(0.3, 0.2).setFriction(0.7), b);
  bodies.push(b);
}
const frames = 600; let t0 = performance.now(), worst = 0;
const rec = new Float32Array(frames * bodies.length * 3);
for (let f = 0; f < frames; f++) {
  const a = performance.now();
  for (let k = 0; k < 4; k++) world.step();
  worst = Math.max(worst, performance.now() - a);
  let o = f * bodies.length * 3; for (const b of bodies) { const t = b.translation(); rec[o++] = t.x; rec[o++] = t.y; rec[o++] = b.rotation(); }
}
const ms = (performance.now() - t0) / frames;
// determinism: hash of final state, run twice in separate processes and compare
let h = 0; for (let i = rec.length - bodies.length * 3; i < rec.length; i++) h = (h * 31 + Math.round(rec[i] * 1e5)) | 0;
console.log(`Rapier 2000 bodies: ${ms.toFixed(2)} ms per 60fps frame (4 substeps), worst ${worst.toFixed(1)} ms; 10 s of sim = ${(ms * 600 / 1000).toFixed(1)} s; state hash ${h}`);
// 2) XPBD soft stuff in plain JS: 300 pressure blobs x 24 pts + 100 ropes x 40 pts = 11.2k points, 8 iterations
const nB = 300, nP = 24, nR = 100, nL = 40, N = nB * nP + nR * nL;
const x = new Float32Array(N * 2), p = new Float32Array(N * 2), v = new Float32Array(N * 2);
const cons = []; // [i, j, rest]
for (let b = 0; b < nB; b++) { const cx = rnd() * 100, cy = rnd() * 60, r = 1 + rnd(); for (let i = 0; i < nP; i++) { const a = i / nP * 6.283; const k = b * nP + i; x[2 * k] = cx + Math.cos(a) * r; x[2 * k + 1] = cy + Math.sin(a) * r; cons.push([k, b * nP + (i + 1) % nP, 2 * r * Math.sin(Math.PI / nP)]); cons.push([k, b * nP + (i + nP / 2) % nP, 2 * r]); } }
for (let r = 0; r < nR; r++) { const base = nB * nP + r * nL, cx = rnd() * 100; for (let i = 0; i < nL; i++) { x[2 * (base + i)] = cx; x[2 * (base + i) + 1] = 60 - i * 0.5; if (i) cons.push([base + i - 1, base + i, 0.5]); } }
const C = new Float64Array(cons.flat());
t0 = performance.now(); const dt = 1 / 240;
for (let f = 0; f < 600; f++) for (let s = 0; s < 4; s++) {
  for (let i = 0; i < N; i++) { v[2 * i + 1] -= 9.81 * dt; p[2 * i] = x[2 * i] + v[2 * i] * dt; p[2 * i + 1] = x[2 * i + 1] + v[2 * i + 1] * dt; if (p[2 * i + 1] < 0) p[2 * i + 1] = 0; }
  for (let it = 0; it < 8; it++) for (let c = 0; c < C.length; c += 3) {
    const i = C[c], j = C[c + 1], rest = C[c + 2]; const dx = p[2 * j] - p[2 * i], dy = p[2 * j + 1] - p[2 * i + 1]; const d = Math.hypot(dx, dy) || 1e-9; const k = 0.5 * (d - rest) / d;
    p[2 * i] += dx * k; p[2 * i + 1] += dy * k; p[2 * j] -= dx * k; p[2 * j + 1] -= dy * k; }
  for (let i = 0; i < 2 * N; i++) { v[i] = (p[i] - x[i]) / dt; x[i] = p[i]; }
}
console.log(`XPBD JS ${N} points, ${cons.length} constraints, 8 iters: ${((performance.now() - t0) / 600).toFixed(2)} ms per frame`);
// 3) 100k particles with drag + curl-ish field
const M = 100000, q = new Float32Array(M * 4); for (let i = 0; i < M * 4; i++) q[i] = rnd() * 100;
t0 = performance.now();
for (let f = 0; f < 600; f++) for (let i = 0; i < M; i++) { const o = i * 4; const fx = Math.sin(q[o + 1] * 0.1 + f * 0.01), fy = Math.cos(q[o] * 0.1); q[o + 2] = q[o + 2] * 0.98 + fx * 0.02; q[o + 3] = q[o + 3] * 0.98 + fy * 0.02 - 0.01; q[o] += q[o + 2]; q[o + 1] += q[o + 3]; }
console.log(`particles JS 100k: ${((performance.now() - t0) / 600).toFixed(2)} ms per frame`);
