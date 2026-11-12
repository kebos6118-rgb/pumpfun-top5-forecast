# Model — Monte Carlo forecaster (v1)
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
  - Curve: decay to floor log10(28), tau 0.6h, sigma 0.25+0.05h;
    graduation-jump mixture (pg <= 0.25) to Normal(3.3, 0.45) when
    momentum > 0.3/hr and reserves in the top quartile.
  - Pool: mu = x0 + g(1-exp(-h/1.5)) - delta*h (g from momentum,
    capped 0.8; delta 0.03-0.08 by age), sigma 0.18+0.06h (+0.10 if
    age < 2h); crash mixture (pc <= 0.35) to Normal(1.6, 0.3).
  - Mayhem: +0.15 sigma. `migrating` venue treated as pool.
- Monte Carlo: 2048 draws, mulberry32 seed 20261112, Box-Muller
  normals; one branch uniform + one normal per coin shared across
  horizons (coherent trajectories). Place probs and size bins from
  ranking frequencies, averaged over the 7 reads.
- Sizes: places 1-2 mixed with 12%/8% of Normal(3.7, 0.5) (post-cut
  births). Per place at most 12 named coins (p >= 0.005), named sum
  capped at 0.65; top5 = per-place argmax, greedy distinct.
## Sanity check (kit rehearsal, 2026-11-11 20:00-20:50)
- Runtime ~0.1s; two runs byte-identical; output 12,572 B.
- Candidates 35; top5 all pool: AIB, MIHAO VI, GTA 6 Coin, DeepSeek,
  Claude. Named sums 0.65, size sums ~1.0, all places.
- Largest place-1 size bin 40 (8,913-10,000 SOL), p 0.077.
- Last-read order score vs known practice answer top 5: -21.83 vs
  house baseline -23.20 (place 2: MIHAO VI named at 0.092).
- Final-like synthetic (66 marks, horizons 7.2-13.2h): 0.3s, identical
  outputs, top5 still all pool. Edge input (empty mark, ok:false,
  missing fields, bad cap string): runs, no crash.
## Deviations from the brief
- Bins are 0..81 (82 bins) per RULES.txt; the brief's "0..82" is a
  typo (edges has 81 entries, 2.00-6.00 step 0.05).
- Candidates come from the last mark's rows only (features are
  defined "at last mark"); the 600 cap cannot bind (<=200 rows/mark).
