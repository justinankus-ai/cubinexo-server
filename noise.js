// Mirror of Assets/Cubinexo/Scripts/Core/Noise.cs and Planet.RawHeight().
// Keep these identical so the server agrees with players about where land and mountains are.
'use strict';

function hash(x, y, z, seed) {
  let h = Math.imul(seed >>> 0, 0x9E3779B1) >>> 0;
  h = (h ^ Math.imul(x | 0, 0x85EBCA77)) >>> 0;
  h = (h ^ Math.imul(y | 0, 0xC2B2AE3D)) >>> 0;
  h = (h ^ Math.imul(z | 0, 0x27D4EB2F)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x2C1B3C6D) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0; h = Math.imul(h, 0x297A2D39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

const lattice = (x, y, z, s) => (hash(x, y, z, s) & 0xFFFFFF) / 8388607.5 - 1;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function value(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c000 = lattice(xi, yi, zi, seed), c100 = lattice(xi + 1, yi, zi, seed);
  const c010 = lattice(xi, yi + 1, zi, seed), c110 = lattice(xi + 1, yi + 1, zi, seed);
  const c001 = lattice(xi, yi, zi + 1, seed), c101 = lattice(xi + 1, yi, zi + 1, seed);
  const c011 = lattice(xi, yi + 1, zi + 1, seed), c111 = lattice(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm(px, py, pz, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * value(px * f, py * f, pz * f, (seed + i * 1013) >>> 0);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const inverseLerp = (a, b, v) => (a === b ? 0 : clamp01((v - a) / (b - a)));
const smoothStep01 = (t) => { t = clamp01(t); return -2 * t * t * t + 3 * t * t; };

function normalize(d) {
  const m = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / m, d[1] / m, d[2] / m];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Normalized terrain height of planet `p` (from planets.json) along unit direction `dir`. */
function rawHeight(p, dir) {
  if (p.gas) return 0;
  const seed = p.seed >>> 0;
  const px = dir[0] * p.freq, py = dir[1] * p.freq, pz = dir[2] * p.freq;
  let h = fbm(px, py, pz, Math.max(1, p.oct), seed);
  if (p.ridge > 0) {
    const r = 1 - Math.abs(fbm(px * 2.1, py * 2.1, pz * 2.1, 3, (seed + 77) >>> 0));
    h += p.ridge * (r * r - 0.35);
  }
  if (p.flatten && p.flatten.length >= 4) {
    const fd = normalize(p.flatten);
    const fc = Math.cos(p.flatten[3] * Math.PI / 180);
    const d = dot(dir, fd);
    if (d > fc - 0.04) {
      const t = smoothStep01(inverseLerp(fc - 0.04, fc + 0.01, d));
      h = h + (p.flattenH - h) * t;
    }
  }
  return h;
}

function hasSea(p) { return p.sea > -5; }

function surfaceRadius(p, dir) {
  let h = rawHeight(p, dir);
  if (hasSea(p) && h < p.sea) h = p.sea;
  return p.radius * (1 + p.amp * h);
}

function inBuildZone(p, dir, extraDeg) {
  if (!p.flatten || p.flatten.length < 4) return false;
  return dot(dir, normalize(p.flatten)) > Math.cos((p.flatten[3] + extraDeg) * Math.PI / 180);
}

module.exports = { hash, value, fbm, rawHeight, surfaceRadius, inBuildZone, hasSea, normalize, dot };
