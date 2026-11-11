// Server copy of FloraRules (Assets/Cubinexo/Scripts/World/Biosphere.cs).
// The server runs this around the clock so the shared world keeps evolving even when nobody is online.
'use strict';
const N = require('./noise');

const TICK_SECONDS = 3;
const GROW = [60, 25, 12, 1];
const LIFE = [600, 220, 80, 1000000000];
const SEED_CHANCE = [0.012, 0.03, 0.07, 0];
const SPREAD_M = [9, 6, 3.5, 0];

const allows = (p, k) => Array.isArray(p.kinds) && k < p.kinds.length && p.kinds[k] !== 0;
const wrap01 = (x) => { x %= 1; return x < 0 ? x + 1 : x; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function suitable(p, dir, k) {
  if (!allows(p, k)) return false;
  if (N.inBuildZone(p, dir, 2)) return false;
  const h = N.rawHeight(p, dir);
  if (N.hasSea(p) && h < p.sea + 0.012) return false;
  const polar = Math.abs(dir[1]);
  switch (k) {
    case 0: return h < 0.38 && polar < 0.8;
    case 1: return h < 0.5 && polar < 0.88;
    case 2: return h < 0.3 && polar < 0.8;
    default: return h > 0.12 || !N.hasSea(p);
  }
}

function randomDir() {
  for (let i = 0; i < 30; i++) {
    const v = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const m = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (m > 0.01 && m <= 1) { const s = Math.sqrt(m); return [v[0] / s, v[1] / s, v[2] / s]; }
  }
  return [0, 1, 0];
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

/** Rotate `dir` by `angle` radians in a random direction along the sphere. */
function jitter(dir, angle) {
  let axis = cross(dir, randomDir());
  if (Math.hypot(...axis) < 1e-6) axis = cross(dir, [1, 0, 0]);
  axis = N.normalize(axis);
  // Rodrigues rotation
  const c = Math.cos(angle), s = Math.sin(angle), k = axis, v = dir;
  const kv = cross(k, v), kd = N.dot(k, v);
  return N.normalize([
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ]);
}

function randomPlantKind(p, fallback) {
  for (let i = 0; i < 6; i++) { const k = Math.floor(Math.random() * 3); if (allows(p, k)) return k; }
  return fallback;
}

const r3 = (d) => d.map((x) => Math.round(x * 100000) / 100000);

function randomFlora(world, p, idx, kind, randomAge, at) {
  const k = kind >= 0 ? kind : randomPlantKind(p, -1);
  if (k < 0) return null;
  for (let t = 0; t < 25; t++) {
    const d = at || randomDir();
    if (!suitable(p, d, k)) { if (at) return null; continue; }
    const L = Math.round(LIFE[k] * (0.7 + Math.random() * 0.6));
    return {
      id: world.nextFloraId++, pl: idx, d: r3(d), k,
      h: wrap01(p.hue + (Math.random() - 0.5) * 0.15),
      m: k === 3 ? 0.6 + Math.random() * 0.9 : 0.7 + Math.random() * 0.8,
      a: randomAge && k !== 3 ? Math.floor(Math.random() * Math.max(1, L / 2)) : 0,
      g: 0, L,
    };
  }
  return null;
}

/** Fill an empty world with starting life. */
function seedWorld(world, planets) {
  planets.forEach((p, idx) => {
    for (let i = 0; i < Math.floor(p.maxFlora / 3); i++) { const f = randomFlora(world, p, idx, -1, true); if (f) world.flora.push(f); }
    for (let i = 0; i < Math.floor(p.maxCrystals / 2); i++) { const f = randomFlora(world, p, idx, 3, false); if (f) world.flora.push(f); }
  });
}

/** One evolution step for every planet. Returns { add, rem } for broadcasting. */
function tick(world, planets) {
  world.tick++;
  const add = [], rem = [];
  planets.forEach((p, idx) => {
    let plants = 0, crystals = 0;
    for (const f of world.flora) if (f.pl === idx) { if (f.k === 3) crystals++; else plants++; }
    const n = world.flora.length;
    for (let i = 0; i < n; i++) {
      const f = world.flora[i];
      if (f.pl !== idx) continue;
      f.a++;
      if (f.k !== 3 && f.a > f.L) { rem.push(f.id); plants--; continue; }
      if (f.k !== 3 && f.a >= GROW[f.k] && plants < p.maxFlora && Math.random() < SEED_CHANCE[f.k]) {
        let k = f.k;
        if (Math.random() < 0.05) k = randomPlantKind(p, f.k);
        const cd = jitter(f.d, SPREAD_M[k] / p.radius * (0.5 + Math.random()));
        if (!suitable(p, cd, k)) continue;
        add.push({
          id: world.nextFloraId++, pl: idx, d: r3(cd), k,
          h: wrap01(f.h + (Math.random() - 0.5) * 0.06),
          m: clamp(f.m * (0.9 + Math.random() * 0.22), 0.4, 3.2),
          L: clamp(Math.round(f.L * (0.9 + Math.random() * 0.22)), 30, 3000),
          g: f.g + 1, a: 0,
        });
        plants++;
      }
    }
    if (plants < 6 && (allows(p, 0) || allows(p, 1) || allows(p, 2)) && Math.random() < 0.25) {
      const f = randomFlora(world, p, idx, -1, false); if (f) add.push(f);
    }
    if (crystals < p.maxCrystals && allows(p, 3) && Math.random() < 0.35) {
      const f = randomFlora(world, p, idx, 3, false); if (f) add.push(f);
    }
  });
  if (rem.length) { const set = new Set(rem); world.flora = world.flora.filter((f) => !set.has(f.id)); }
  for (const f of add) world.flora.push(f);
  return { add, rem };
}

const crystalValue = (f) => Math.max(2, Math.round(f.m * 5));

module.exports = { TICK_SECONDS, suitable, randomFlora, seedWorld, tick, crystalValue, randomDir };
