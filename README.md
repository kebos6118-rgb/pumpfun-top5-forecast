# pumpfun-top5-forecast

Monte Carlo forecaster for make.fun's "Predict the top 5 new Solana coins by market cap, 24 hours out" bounty.

`main.ts` (Node 22, standard library only) reads the house's 10-minute
market-cap snapshots in `/input` and writes one forecast to
`/output/forecast.json`: per-place probabilities for the top 5 coins,
the top 5 in order, and per-place market-cap size bins.

## Model

See `MODEL.md`. In short: per-coin trajectories in log10 market cap
with venue-aware dynamics (bonding-curve coins decay to a floor,
graduated pool coins rise then decay with an age-dependent crash
hazard, near-graduation curve coins can jump), sampled with a seeded
Monte Carlo (2048 draws) and ranked to produce calibrated place
probabilities and size distributions, with a newcomer component for
coins born after the history ends.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic: two runs on the same history write byte-identical output.
