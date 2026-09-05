# Synthetic AI faction balance tests

The opt-in harness at `packages/game-core/test/synthetic-balance.test.ts` runs complete AI-versus-AI games without injecting commands, changing entity state, granting resources, or modifying gameplay rules. It uses the production Box3D WASM physics backend at 20 simulation ticks per second. It runs one game at a time and disposes its physics world afterward.

## Run

From the repository root:

```sh
RTS_BALANCE_OUTPUT="$PWD/artifacts/balance/my-run" \
  pnpm --filter @space-rts/game-core exec vitest run test/synthetic-balance.test.ts
```

Use a fresh output directory for each run. The harness overwrites its manifest/progress files there.

The default suite contains 60 cross-faction games and six mirror controls. All three cross-faction pairs run on seeds 1729 and 7384 under each of the five profiles below, with two legs that swap factions between fixed player IDs and starting positions. The mirror controls run each faction against itself on both seeds in the Orbital profile.

| Profile | Map | Size | Resources / deposits | AI on both sides |
|---|---|---|---|---|
| orbital | Orbital Ring | Medium | Standard / standard | Normal, balanced |
| open | Open Expanse | Medium | Standard / standard | Normal, balanced |
| tunnel | Amazon Tunnel | Medium | Standard / standard | Normal, balanced |
| pressure | Core Rush | Small | Low / scarce | Hard, aggressive |
| macro | Open Expanse | Medium | High / rich | Hard, economic |

Every game uses the ordinary full starting base, zero starting ships, seeded starting-position variation, and a ten-minute simulation limit. Pressure and Macro intentionally combine several stress conditions; differences between them cannot isolate the effect of one setting.

Optional environment variables:

- `RTS_BALANCE_PROFILES=orbital,open` selects profiles.
- `RTS_BALANCE_SEEDS=1729,7384` selects map seeds.
- `RTS_BALANCE_PAIRS=industrial:brood,brood:concord` selects pairs; both side assignments still run.
- `RTS_BALANCE_TICKS=36000` changes the limit to 30 simulated minutes.
- `RTS_BALANCE_MIRRORS=0` omits same-faction controls.

The test is skipped by default during ordinary `pnpm test` runs. Its assertions check the harness and state integrity, not whether a faction wins a prescribed percentage.

## Outputs and interpretation

- `report.json`: settings, runtime and source fingerprints, all completed match summaries, and a final source-unchanged check.
- `progress.jsonl`: one durable progress row per completed game, useful while Vitest buffers terminal output.
- `matches/*.json`: per-tick production/loss and damage totals, 30-second timelines, and terminal ship/structure diagnostics.

After completion, run `python3 scripts/summarize-balance.py artifacts/balance/my-run/report.json` to generate `summary.json` and `matchups.csv`. The summarizer rejects incomplete reports and runs whose source fingerprint changed. It excludes same-faction mirrors from cross-faction win and production statistics.

A win requires the existing game victory condition: only one team retains a command core. Time-limit results remain unresolved. Army size, damage, resources, and nominal army cost do not award wins. Simultaneous loss of both cores is recorded separately from victory.

Every cross-faction matchup's two legs must have identical initial map geometry and structure placement. Production and loss events must reconcile with the surviving ship count. The source fingerprint includes uncommitted simulation/shared/physics sources, installed physics glue, and the dependency lockfile; a changing fingerprint fails the run. The runner's own hash is also recorded.

Production, losses, combat events, and economy flow are counted each tick. Fleet size, supply efficiency, nest coverage/capacity, ready-but-blocked warp queues, and fighting-unit field coverage are sampled each second. Field coverage measures ships that fired or took damage during the preceding second; it is a time-sampled usage measure, not the exact fraction of damage receiving a bonus. Integrated income is nominal generated income before storage overflow; it is not all spendable income. Ship counts refer to controllable entities, with each fighter entity drawn as a five-craft swarm.

These are measurements of the current faction rules **and the current AI's ability to use them together**. AI opening choices, scouting, construction priorities, army composition, and field use can drive results. Side-swapped games share a map seed and are paired observations; mirrors do not add independent cross-faction evidence. Small seeded samples and unfinished games should not be treated as proof of human competitive balance.
