# Model — Monte Carlo forecaster (v3)
Entry: `main.ts` (Node 22, stdlib only, no network, deterministic).
Reads `$MAKEFUN_INPUT_DIR/{task.json,history.ndjson}`, writes
`$MAKEFUN_OUTPUT_DIR/forecast.json`.
## How it works
- Tracks every mint across marks. Features at the last mark: x0 =
  log10(cap in SOL), venue, age, momentum (least-squares slope of x
  over the last 60 min), peak, drawdown, quote reserves (BigInt).
- Candidates: all pool coins + curve coins with x0 > 1.8, momentum >
  0.5/hr, or top-decile quote reserves; capped at 600.
- Per coin per horizon h (from `task.json` reads minus last mark):
  - Curve: decay to floor log10(28), tau 0.6h, sigma 0.25+0.03h;
    graduation-jump mixture (pg <= 0.25) to Normal(3.3, 0.45) when
    momentum > 0.3/hr and reserves in the top quartile.
  - Pool: mu = x0 + g(1-exp(-h/3)) - delta*h (g = min(1.2, 2*momentum);
    delta 0.01-0.04 by age), sigma min(0.5, 0.15+0.03h) (+0.10 if
    age < 2h); crash mixture (pc <= 0.35) to Normal(1.6, 0.3).
  - Mayhem: +0.15 sigma. `migrating` venue treated as pool.
- Monte Carlo: 2048 draws, mulberry32 seed 20261112, Box-Muller
  normals; one branch uniform + one normal per coin shared across
  horizons (coherent trajectories). Place probs and size bins from
  ranking frequencies, averaged over the reads.
- Sizes: every place mixed with a newcomer lognormal Normal(3.6, 0.6)
  (post-cut births), weights 0.25/0.20/0.15/0.10/0.10 by place.
  Then the size histogram is Gaussian-smoothed (sd 0.30 log10 units,
  renormalized to sum 1) — see "What changed in v3".
  Per place at most 12 named coins (p >= 0.005), named sum capped at
  0.65; top5 = per-place argmax, greedy distinct.
## What changed in v3 (and why)
- v2 practice score: log -37.04 (order -19.52, size -17.52), rank
  325/765; top entry -31.7 (order -18.18, size -13.56). The gap is
  almost all size (-3.96); order is only -1.34 behind.
- ONE change, size-only: the final size histogram per place is
  convolved with a Gaussian kernel (sd 0.30 log10 = 6 bins), then
  renormalized to sum 1. Order model, candidates, MC, newcomer mix,
  named cap all unchanged — order scores are bit-identical to v2.
- Why: the truth disperses around the forecast median (effective
  delta ~0.3 at the 0.16-1.16h practice reads, larger at the 7-13h
  final reads — v2's actual practice size -17.52 matches the
  delta~0.3, shift~0 calibration). The raw MC histogram is too
  peaked (mode p 0.08-0.14); the log score punishes the thin
  shoulders/tails far more than it rewards the peak. Smoothing
  raises the shoulders/tails at a small cost to the mode. The top
  entry's title ("wide-smoothed size distribution") points the same
  way. Temperature sharpening was tested and REJECTED (much worse).
- Evidence (size component; order identical everywhere):
  - Real backtest, cut 20:20 (reads h=0.33/0.50h): -23.32 -> -21.44 (+1.88)
  - Real backtest, cut 20:10 (reads h=0.33/0.50/0.66h): -26.33 -> -24.57 (+1.76)
  - Real backtest, cut 20:30 (reads h=0.16/0.33h): -13.25 -> -15.22 (-1.97)
    — at the shortest horizons the truth sits close to the median, so
    narrow wins there; the practice has 5 of 7 reads at h>=0.5h and
    the final is 7-13h, where wide wins.
  - Practice-calibrated expected size (delta growing with horizon,
    validated: v2 model -17.87 vs actual -17.52): -17.87 -> -16.78 (+1.09)
  - Long-horizon proxy (the final's regime): delta 0.4/0.5/0.6 ->
    +1.90/+2.32/+2.51 vs v2.
  - Smoothing level 0.30 chosen over 0.25: tied on the practice
    models, better at h>=0.33 backtests (+0.37 at cut 20:20) and at
    long horizons; worse only at the shortest-horizon cut.
- Rejected: newcomer rework (per-place mu 3.7/3.6/3.5/3.45/3.4,
  sigma 0.4, higher weights) — gains only +0.06-0.08 on the
  expected-size model, inside the +/-0.3 noise and inside the
  truth-model uncertainty; not shipped. Temperature sharpening
  (1.25/1.5/2.0) — much worse on every model (-1 to -4.4).
- Bug found and fixed during v3: the smoothing kernel mass falling
  outside bins 0..81 leaked at the edges — at early cuts places 4-5
  mass sits near the low floor and rows lost up to 42% of their sum.
  Fixed by renormalizing each smoothed row to sum 1. The first
  (unfixed) run made the cut 20:10/20:20 backtests look flat/negative
  and hid the +1.8 gain; all numbers above are post-fix.
## Backtest (local; cut 20:30, reads 20:40/20:50, mean over 2 reads)
- v1: order -16.12, size -13.24, log -29.36, agreement 22.
- v2: order -16.10, size -13.25, log -29.35, agreement 22.
- v3: order -16.10, size -15.22, log -31.32, agreement 22.
- Caveat: horizons here are 0.16-0.33h, far shorter than the final's
  7-13h, so this tests mechanics and short-h size calibration only.
  v3 deliberately trades this short-h cut (-1.97) for the longer
  horizons, where it gains +1.76/+1.88 on real ground truth
  (cuts 20:10/20:20). 22:00 order check (known top 5): v3 -21.78,
  identical to v2.
## Sanity check (kit rehearsal, 2026-11-11 20:00-20:50)
- Runtime ~0.45s; two runs byte-identical; output matches the
  backtest exp2 s030 run byte-for-byte.
- Candidates 35; top5 all pool (same as v2). Named sums 0.65, size
  sums 1.0, all places.
- Edge input (empty mark, ok:false, missing fields, bad cap string):
  runs, no crash (same as v1).
## What changed in v2 (and why)
- v1 practice score: log -38.17 (order -19.59, size -18.58); top entry
  -31.7 (order -18.18, size -13.56). Size is the gap (-5.02).
- Pool sigma capped: v1's 0.18+0.06h reached 0.60-0.96 at h=7-13h, so
  its long-horizon size distributions were IQR 0.40-0.80 log with the
  place-1 mode degenerate in bin 81 (>=1M SOL, p=0.043). v2 uses
  min(0.50, 0.15+0.03h): IQR 0.30-0.70, mode p 0.045-0.086.
- Pool growth raised: surviving top pool coins grew +0.14 to +0.40
  log/hour in the rehearsal, but v1's net long-h growth was ~0 to
  +0.5 over 7-13h. v2: gain cap 1.2 (was 0.8), mult 2.0 (was 1.5),
  tau 3h (was 1.5h), delta 0.01-0.04 (was 0.03-0.08). Place medians
  at h=7-13 rise to [4.78, 4.53, 4.38, 4.18, 4.03] (v1: 4.83, 4.43,
  4.13, 3.93, 3.73) — higher at places 2-5, where growth was missing.
- Newcomer size mix extended to all places: in the practice 3 of 9
  top-5 holders were post-cut births, including places 3-5 (CHAT,
  NIHAONOON, HAMSTER), which v1 left at 0%. v2 weights 25/20/15/10/10%.
- Unchanged: crash mixture, graduation jump, seed/draws, named cap
  0.65, candidate pruning. The short-horizon backtest could not
  distinguish the variants (all within +-0.3 log), so these changes
  rest on the long-horizon calibration + measured growth, not on it.
## Backtest (local; cut 20:30, reads 20:40/20:50, mean over 2 reads)
- v1: order -16.12, size -13.24, log -29.36, agreement 22.
- v2: order -16.10, size -13.25, log -29.35, agreement 22.
- Caveat: horizons here are 0.16-0.33h, far shorter than the final's
  7-13h, so this tests mechanics and short-h size calibration only.
  Expected size score at 7-13h (truth = forecast median + N(0,d)):
  v2 beats v1 at d=0.2 (-15.20 vs -15.59), ties at d=0.3, loses at
  d>=0.4 — the v2 bet is that long-h truth dispersion is ~0.2-0.3,
  not 0.4+. 22:00 order check (known top 5): v1 -21.83, v2 ~-21.8.
## Sanity check (kit rehearsal, 2026-11-11 20:00-20:50)
- Runtime ~0.1s; two runs byte-identical; output 18,850 B.
- Candidates 35; top5 all pool: AIB, MIHAO VI, GTA 6 Coin, DeepSeek,
  Claude. Named sums 0.65, size sums 1.0, all places.
- Edge input (empty mark, ok:false, missing fields, bad cap string):
  runs, no crash (same as v1).
## Deviations from the brief
- Bins are 0..81 (82 bins) per RULES.txt; the brief's "0..82" is a
  typo (edges has 81 entries, 2.00-6.00 step 0.05).
- Candidates come from the last mark's rows only (features are
  defined "at last mark"); the 600 cap cannot bind (<=200 rows/mark).
