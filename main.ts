// pumpfun-top5-forecast-01 entry: Monte Carlo forecaster (Node 22, standard library only).
//
// Reads the house's 10-minute market-cap snapshots from $MAKEFUN_INPUT_DIR (or /input)
// and writes one forecast to $MAKEFUN_OUTPUT_DIR/forecast.json (or /output/).
// Model: per-coin predictive distributions of log10(market cap in SOL) at each answer
// read, sampled with a fixed-seed PRNG (mulberry32); place probabilities and size bins
// come from Monte Carlo ranking frequencies, averaged over the reads. Deterministic:
// two runs on the same history write the same file byte for byte.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MICRO = 1_000_000;
const SEED = 20261112;
const N_DRAWS = 2048;
const MAX_CANDIDATES = 600;
const MAX_NAMED_PER_PLACE = 12;
const MIN_NAMED_P = 0.005;
const MAX_NAMED_SUM = 0.65;
/** log10 of the floor a bonding-curve coin decays to (~28 SOL). */
const CURVE_FLOOR = Math.log10(28);

interface Row {
  rank: number;
  mint: string;
  market_cap_lamports: string | number;
  venue?: string;
  created_at?: string;
  complete?: boolean;
  mayhem?: boolean;
  quote_reserves_lamports?: string | number;
}

interface Mark {
  at: string;
  ok: boolean;
  rows: Row[] | null;
}

interface Task {
  places: number;
  output: string;
  reads: string[];
  size: { edges: number[] };
}

/** log10 of a cap in SOL, as the scorer takes it: log10(lamports) - 9. */
function sizeOf(lamports: string | number): number | null {
  try {
    const v = BigInt(lamports);
    if (v <= 0n) return null;
    return Math.log10(Number(v)) - 9;
  } catch {
    return null;
  }
}

function toBigInt(v: string | number | undefined): bigint {
  if (v === undefined) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** erfc(x), Numerical Recipes' erfcc (fractional error under 1.2e-7 everywhere). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** P(X >= x) for X normal with mean `mean` and sd `sd`. */
const above = (x: number, mean: number, sd: number): number =>
  x === -Infinity ? 1 : x === Infinity ? 0 : 0.5 * erfc((x - mean) / (sd * Math.SQRT2));

/** mulberry32: small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sampler on a fixed PRNG stream (spare cached; call order fixed). */
function makeRandn(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

const floor6 = (p: number): number => Math.floor(p * MICRO) / MICRO;

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as Task;
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l !== '');
const marks = lines
  .map((l) => JSON.parse(l) as Mark)
  .filter((m) => m.ok === true && Array.isArray(m.rows));
if (marks.length === 0) throw new Error('the history holds no ok mark');
const marksWithRows = marks.filter((m) => (m.rows as Row[]).length > 0);
if (marksWithRows.length === 0) throw new Error('the history holds no mark with rows');
const lastMark = marksWithRows[marksWithRows.length - 1]!;
const lastTime = Date.parse(lastMark.at);
const horizons = task.reads.map((r) => Math.max(0, (Date.parse(r) - lastTime) / 3600000));
const H = horizons.length;
const PLACES = task.places;
const edges = task.size.edges;
const NBINS = edges.length + 1; // 82 bins: 0 below edges[0], NBINS-1 at/above edges[last]

/** Bin index of a log10(cap in SOL) value. */
function binOf(x: number): number {
  if (x < edges[0]!) return 0;
  if (x >= edges[edges.length - 1]!) return NBINS - 1;
  let lo = 0;
  let hi = edges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---- Track every coin across marks -------------------------------------------
interface CoinTrack {
  mint: string;
  points: Array<{ t: number; x: number }>; // t in hours relative to lastTime
  lastX: number;
  venue: string;
  mayhem: boolean;
  createdAtMs: number;
  quoteReserves: bigint;
}

const tracks = new Map<string, CoinTrack>();
for (const m of marks) {
  const t = (Date.parse(m.at) - lastTime) / 3600000;
  for (const row of m.rows as Row[]) {
    const x = sizeOf(row.market_cap_lamports);
    if (x === null) continue;
    let tr = tracks.get(row.mint);
    if (tr === undefined) {
      tr = {
        mint: row.mint,
        points: [],
        lastX: x,
        venue: row.venue ?? 'curve',
        mayhem: row.mayhem ?? false,
        createdAtMs: row.created_at !== undefined ? Date.parse(row.created_at) : lastTime,
        quoteReserves: toBigInt(row.quote_reserves_lamports),
      };
      tracks.set(row.mint, tr);
    }
    tr.points.push({ t, x });
  }
}
// Refresh last-mark fields from the last mark's rows.
for (const row of lastMark.rows as Row[]) {
  const tr = tracks.get(row.mint);
  if (tr === undefined) continue;
  const x = sizeOf(row.market_cap_lamports);
  if (x !== null) tr.lastX = x;
  tr.venue = row.venue ?? 'curve';
  tr.mayhem = row.mayhem ?? false;
  if (row.created_at !== undefined) tr.createdAtMs = Date.parse(row.created_at);
  tr.quoteReserves = toBigInt(row.quote_reserves_lamports);
}

// ---- Features at the last mark ------------------------------------------------
interface Cand {
  mint: string;
  isCurve: boolean;
  x0: number;
  ageHours: number;
  momentum: number;
  drawdown: number;
  mayhem: boolean;
  pg: number; // graduation-jump probability (curve only)
  pc: number; // crash probability (pool only)
  mixMu: number;
  mixSigma: number;
  mu: number[]; // per horizon
  sigma: number[]; // per horizon
}

const lastRows = lastMark.rows as Row[];
const curveCands: Cand[] = [];
const poolCands: Cand[] = [];
for (const row of lastRows) {
  const tr = tracks.get(row.mint);
  if (tr === undefined) continue;
  const x0 = tr.lastX;
  const ageHours = Math.max(0, (lastTime - tr.createdAtMs) / 3600000);
  // Momentum: least-squares slope of x over the last 60 minutes.
  const recent = tr.points.filter((p) => p.t >= -1.0);
  let momentum = 0;
  if (recent.length >= 2) {
    let st = 0;
    let sx = 0;
    for (const p of recent) {
      st += p.t;
      sx += p.x;
    }
    const mt = st / recent.length;
    const mx = sx / recent.length;
    let num = 0;
    let den = 0;
    for (const p of recent) {
      num += (p.t - mt) * (p.x - mx);
      den += (p.t - mt) * (p.t - mt);
    }
    momentum = den > 0 ? num / den : 0;
  }
  let peak = -Infinity;
  for (const p of tr.points) if (p.x > peak) peak = p.x;
  const drawdown = Math.max(0, peak - x0);
  const venue = tr.venue === 'migrating' ? 'pool' : tr.venue;
  const isCurve = venue !== 'pool';
  const cand: Cand = {
    mint: row.mint,
    isCurve,
    x0,
    ageHours,
    momentum,
    drawdown,
    mayhem: tr.mayhem,
    pg: 0,
    pc: 0,
    mixMu: 0,
    mixSigma: 0,
    mu: new Array<number>(H),
    sigma: new Array<number>(H),
  };
  (isCurve ? curveCands : poolCands).push(cand);
}

// Quote-reserves quartiles / deciles among curve coins (BigInt compare, mint tie-break).
const curveByReserves = [...curveCands].sort((a, b) => {
  const ra = tracks.get(a.mint)!.quoteReserves;
  const rb = tracks.get(b.mint)!.quoteReserves;
  if (ra !== rb) return ra > rb ? -1 : 1;
  return a.mint < b.mint ? -1 : 1;
});
const topQuartile = new Set(curveByReserves.slice(0, Math.ceil(curveByReserves.length / 4)).map((c) => c.mint));
const topDecile = new Set(curveByReserves.slice(0, Math.ceil(curveByReserves.length / 10)).map((c) => c.mint));

// Candidate pruning: all pool coins; curve coins with a realistic shot.
let candidates: Cand[] = [];
for (const c of poolCands) candidates.push(c);
for (const c of curveCands) {
  if (c.x0 > 1.8 || c.momentum > 0.5 || topDecile.has(c.mint)) candidates.push(c);
}
candidates.sort((a, b) => {
  if (a.x0 !== b.x0) return b.x0 - a.x0;
  if (a.momentum !== b.momentum) return b.momentum - a.momentum;
  return a.mint < b.mint ? -1 : 1;
});
if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES);
const C = candidates.length;
if (C < PLACES) throw new Error(`only ${C} candidate coins, fewer than ${PLACES} places`);

// Per-coin, per-horizon predictive parameters (mixture components).
for (const c of candidates) {
  if (c.isCurve) {
    const gradJump = c.momentum > 0.3 && topQuartile.has(c.mint);
    c.pg = gradJump ? 0.25 * Math.min(1, c.momentum) : 0;
    c.mixMu = 3.3;
    c.mixSigma = 0.45;
    for (let h = 0; h < H; h++) {
      const hh = horizons[h]!;
      c.mu[h] = CURVE_FLOOR + (c.x0 - CURVE_FLOOR) * Math.exp(-hh / 0.6);
      c.sigma[h] = 0.25 + 0.03 * hh + (c.mayhem ? 0.15 : 0);
    }
  } else {
    const g = c.momentum > 0 ? Math.min(1.2, c.momentum * 2.0) : 0;
    const delta = Math.min(0.04, 0.01 + (0.02 * Math.max(0, c.ageHours - 6)) / 12);
    c.pc = Math.min(0.35, 0.02 + (0.03 * c.ageHours) / 6 + 0.1 * Math.max(0, c.drawdown - 0.3));
    c.mixMu = 1.6;
    c.mixSigma = 0.3;
    for (let h = 0; h < H; h++) {
      const hh = horizons[h]!;
      c.mu[h] = c.x0 + g * (1 - Math.exp(-hh / 3)) - delta * hh;
      c.sigma[h] = Math.min(0.5, 0.15 + 0.03 * hh) + (c.ageHours < 2 ? 0.1 : 0) + (c.mayhem ? 0.15 : 0);
    }
  }
}

// ---- Monte Carlo ---------------------------------------------------------------
const startNs = process.hrtime.bigint();
const rng = mulberry32(SEED);
const randn = makeRandn(rng);
const placeCounts = new Float64Array(PLACES * C);
const sizeCounts = new Float64Array(PLACES * NBINS);
const us = new Float64Array(C);
const zs = new Float64Array(C);
// Top-5 working arrays, reused per (draw, horizon): entries sorted desc by (x, mint asc).
const topX = new Float64Array(PLACES);
const topI = new Int32Array(PLACES);

for (let d = 0; d < N_DRAWS; d++) {
  // One branch uniform + one normal per coin, shared across horizons (coherent
  // trajectories, common random numbers across the reads).
  for (let i = 0; i < C; i++) {
    us[i] = rng();
    zs[i] = randn();
  }
  for (let h = 0; h < H; h++) {
    let nTop = 0;
    for (let i = 0; i < C; i++) {
      const c = candidates[i]!;
      const u = us[i]!;
      const z = zs[i]!;
      const x = c.isCurve
        ? u < c.pg
          ? c.mixMu + c.mixSigma * z
          : c.mu[h]! + c.sigma[h]! * z
        : u < c.pc
          ? c.mixMu + c.mixSigma * z
          : c.mu[h]! + c.sigma[h]! * z;
      // Insert into the top-5 (desc by x; ties to the smaller mint first).
      let pos = nTop;
      while (pos > 0) {
        const px = topX[pos - 1]!;
        const pi = topI[pos - 1]!;
        if (x > px || (x === px && c.mint < candidates[pi]!.mint)) pos--;
        else break;
      }
      if (pos < PLACES) {
        const lim = Math.min(nTop + 1, PLACES);
        for (let s = lim - 1; s > pos; s--) {
          topX[s] = topX[s - 1]!;
          topI[s] = topI[s - 1]!;
        }
        topX[pos] = x;
        topI[pos] = i;
        if (nTop < PLACES) nTop++;
      }
    }
    for (let k = 0; k < nTop; k++) {
      placeCounts[k * C + topI[k]!]! += 1;
      sizeCounts[k * NBINS + binOf(topX[k]!)]! += 1;
    }
  }
}

const denom = N_DRAWS * H;
// Average place probabilities over the horizons.
const placeProb: number[][] = [];
for (let k = 0; k < PLACES; k++) {
  const row: number[] = new Array<number>(C);
  for (let i = 0; i < C; i++) row[i] = placeCounts[k * C + i]! / denom;
  placeProb.push(row);
}
// Average size-bin probabilities over the horizons.
const sizeProb: number[][] = [];
for (let k = 0; k < PLACES; k++) {
  const row: number[] = new Array<number>(NBINS);
  for (let b = 0; b < NBINS; b++) row[b] = sizeCounts[k * NBINS + b]! / denom;
  sizeProb.push(row);
}
// Newcomer right-tail adjustment for all places: mix in a broad lognormal
// Normal(3.6, 0.6) — post-cut births rocketing to the top. Weights fall with
// place: newcomers take ~1/3 of top-5 slots in the practice (3 of 9 holders),
// including places 3-5 (CHAT, NIHAONOON, HAMSTER), which v1 left at 0%.
const newcomerW = [0.25, 0.2, 0.15, 0.1, 0.1];
for (let k = 0; k < 5; k++) {
  const w = newcomerW[k]!;
  if (w === 0) continue;
  for (let b = 0; b < NBINS; b++) {
    const lo = b === 0 ? -Infinity : edges[b - 1]!;
    const hi = b === NBINS - 1 ? Infinity : edges[b]!;
    const pLn = above(lo, 3.6, 0.6) - above(hi, 3.6, 0.6);
    sizeProb[k]![b] = (1 - w) * sizeProb[k]![b]! + w * pLn;
  }
}

// ---- Assemble the forecast ------------------------------------------------------
interface ProbRow {
  mint: string;
  place: number;
  p: number;
}
interface SizeRow {
  place: number;
  bin: number;
  p: number;
}

const probabilities: ProbRow[] = [];
const namedSums: number[] = [];
for (let k = 0; k < PLACES; k++) {
  const order = candidates
    .map((c, i) => ({ mint: c.mint, p: placeProb[k]![i]! }))
    .sort((a, b) => (a.p !== b.p ? b.p - a.p : a.mint < b.mint ? -1 : 1))
    .slice(0, MAX_NAMED_PER_PLACE)
    .map((e) => ({ mint: e.mint, p: floor6(e.p) }))
    .filter((e) => e.p >= MIN_NAMED_P);
  let sum = 0;
  for (const e of order) sum += e.p;
  let named = order;
  if (sum > MAX_NAMED_SUM) {
    const f = MAX_NAMED_SUM / sum;
    named = order
      .map((e) => ({ mint: e.mint, p: floor6(e.p * f) }))
      .filter((e) => e.p > 0);
    sum = 0;
    for (const e of named) sum += e.p;
  }
  namedSums.push(sum);
  for (const e of named) probabilities.push({ mint: e.mint, place: k + 1, p: e.p });
}
probabilities.sort((a, b) =>
  a.place !== b.place ? a.place - b.place : a.p !== b.p ? b.p - a.p : a.mint < b.mint ? -1 : 1,
);

// top5: argmax coin per place, greedy distinct in place order.
const top5: string[] = [];
const used = new Set<string>();
for (let k = 0; k < PLACES; k++) {
  let best = -1;
  let bestP = -1;
  for (let i = 0; i < C; i++) {
    const c = candidates[i]!;
    if (used.has(c.mint)) continue;
    const p = placeProb[k]![i]!;
    if (p > bestP || (p === bestP && best >= 0 && c.mint < candidates[best]!.mint)) {
      best = i;
      bestP = p;
    }
  }
  if (best >= 0) {
    top5.push(candidates[best]!.mint);
    used.add(candidates[best]!.mint);
  }
}
if (top5.length < PLACES) throw new Error(`top5 has only ${top5.length} coins`);

const sizes: SizeRow[] = [];
for (let k = 0; k < PLACES; k++) {
  for (let b = 0; b < NBINS; b++) {
    const p = floor6(sizeProb[k]![b]!);
    if (p > 0) sizes.push({ place: k + 1, bin: b, p });
  }
}
sizes.sort((a, b) => (a.place !== b.place ? a.place - b.place : a.bin - b.bin));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);

// ---- Sanity print (stdout only, never into the file) ----------------------------
const elapsedS = Number(process.hrtime.bigint() - startNs) / 1e9;
const sizeSums: number[] = [];
for (let k = 0; k < PLACES; k++) {
  let s = 0;
  for (const r of sizes) if (r.place === k + 1) s += r.p;
  sizeSums.push(s);
}
let top1Bin = -1;
let top1BinP = -1;
for (const r of sizes) {
  if (r.place === 1 && r.p > top1BinP) {
    top1BinP = r.p;
    top1Bin = r.bin;
  }
}
const top5Venues = top5.map((m) => {
  const c = candidates.find((cc) => cc.mint === m);
  return c !== undefined ? (c.isCurve ? 'curve' : 'pool') : '?';
});
console.log(`candidates=${C} draws=${N_DRAWS} horizons=${H} (${horizons.map((h) => h.toFixed(2)).join(',')}h) runtime=${elapsedS.toFixed(1)}s`);
console.log(`top5=${JSON.stringify(top5)}`);
console.log(`top5 venues=${JSON.stringify(top5Venues)}`);
console.log(`named sums per place=${JSON.stringify(namedSums.map((s) => +s.toFixed(4)))}`);
console.log(`size sums per place=${JSON.stringify(sizeSums.map((s) => +s.toFixed(4)))}`);
console.log(`largest place-1 size bin=${top1Bin} p=${top1BinP} (bin ${top1Bin} = ${top1Bin === 0 ? '<100' : top1Bin === NBINS - 1 ? '>=1M' : `${Math.pow(10, edges[top1Bin - 1]!).toFixed(0)}-${Math.pow(10, edges[top1Bin]!).toFixed(0)}`} SOL)`);
