# AI balance report — 5 September 2026

No gameplay or AI rules were changed for these experiments. This report measures the current implementation on `feature/brood-concord-factions`.

The strongest overall finding is that the AI often fails to turn large military advantages into a destroyed command core. Concord struggles against Industrial in the tested configurations, and Brood's results vary with the scenario. The high unresolved-game rate prevents a confident competitive-balance verdict.

## Ten-minute suite

60 cross-faction games plus six same-faction mirror controls ran with real Box3D WASM physics. Each cross-faction pairing used two seeds, five map/AI/economy profiles, and both faction-to-starting-position assignments. Games started with ordinary full bases, no ships, and no injected resources or commands.

**44 of 60 cross-faction games (73.3%) were unresolved at ten minutes.** All 60 had combat. The 16 decisive games ended between 6:14 and 9:52, with a median of 8:46. Median first contact was 0:59. An unresolved game was never scored from army size, damage, or income.

| Matchup | First faction wins | Second faction wins | Unresolved |
|---|---:|---:|---:|
| Brood vs Industrial | 1 | 0 | 19 |
| Concord vs Industrial | 1 | 7 | 12 |
| Brood vs Concord | 2 | 5 | 13 |

Each row contains 20 games. These are counts at the time limit, not win percentages calculated only from the minority of games that finished.

## Sensitivity to scenario

Each cell shows first-faction wins / second-faction wins / unresolved, out of four games. Pressure and Macro change multiple settings together, so their results cannot attribute the difference to resources, difficulty, or personality individually.

| Profile | Brood / Industrial / unresolved | Concord / Industrial / unresolved | Brood / Concord / unresolved |
|---|---:|---:|---:|
| Orbital Ring; normal balanced AI | 0 / 0 / 4 | 0 / 2 / 2 | 0 / 1 / 3 |
| Open Expanse; normal balanced AI | 0 / 0 / 4 | 1 / 1 / 2 | 0 / 0 / 4 |
| Amazon Tunnel; normal balanced AI | 0 / 0 / 4 | 0 / 1 / 3 | 0 / 0 / 4 |
| Small Core Rush; low/scarce; hard aggressive AI | 1 / 0 / 3 | 0 / 2 / 2 | 2 / 0 / 2 |
| Open Expanse; high/rich; hard economic AI | 0 / 0 / 4 | 0 / 1 / 3 | 0 / 4 / 0 |

- Industrial beat Concord 7–1 overall, with 12 unfinished games. That is a concern for Concord under the current AI, rather than a general ranking of the factions.
- All three Brood victories occurred in the Pressure profile. The standard profiles produced no Brood wins within ten minutes.
- Concord beat Brood in all four Macro games: both seeds and both starting assignments. Its matchup against Brood changes substantially with the combined scenario/AI profile.
- Brood versus Industrial is mostly unmeasured by victories: 19 of their 20 games remained unresolved.

## Opening, economy, and faction mechanic use

| Metric | Industrial | Brood | Concord |
|---|---:|---:|---:|
| Median first combat-unit completion | 27.8s | 5.6s | 22.6s |
| Median first mobile builder | 13.5s | 121.0s | 18.1s |
| Mean combat entities alive at 1:00 | 4.4 | 12.0 | 3.7 |
| Mean combat entities alive at 5:00 | 24.9 | 12.0 | 12.9 |
| Average supply efficiency | 54.6% | 91.9% | 57.4% |
| Fighting ship-time inside owned faction field | N/A | 24.4% | 10.3% |

Opening/checkpoint figures include all 40 cross-faction appearances for each faction; no game ended before five minutes. Combat entity counts exclude mobile builders. Each fighter entity is the current five-craft visual swarm, and different unit compositions have different strength.

Brood has a large early numerical lead, but its mean fleet count falls behind Industrial by five minutes. Its AI specializes the first nest in combat units and the next in Seeders; the other factions produce a mobile builder first. These timings therefore include AI opening choices, not only unit build times.

Brood’s free replacement production gives it much higher resource-supply efficiency. This metric is the fraction of requested economic work the economy can supply, not a measure of efficiency in combat. Brood hatching itself does not depend on that fraction.

Concord fought outside its own coverage for roughly 90% of sampled fighting ship-time; Brood fought off creep for roughly 76%. The results therefore expose limited AI use of field bonuses. They do not demonstrate that the bonuses are ineffective when used deliberately.

Concord recorded only four sampled yard-seconds with a completed unit blocked from arriving, about 0.01% of completed foundry time. Brood recorded no sampled uncovered specialized nests. In this suite, failed warp arrivals or nests left without creep were not the main production bottlenecks.

## Thirty-minute follow-up

All 12 Orbital Ring cross-faction cases were rerun from the same seeds with a thirty-minute limit. These are extended reruns of an existing subset, not 12 additional independent matchups. Their first ten-minute timelines matched the original runs exactly.

| Matchup | First faction wins | Second faction wins | Still unresolved at 30:00 |
|---|---:|---:|---:|
| Brood vs Industrial | 0 | 0 | 4 |
| Concord vs Industrial | 0 | 3 | 1 |
| Brood vs Concord | 0 | 1 | 3 |

Only one previously unresolved game finished: an Industrial victory over Concord at 13:26. **Eight of the twelve cases were still unresolved at thirty minutes, and both command cores retained full hull health in every one of those eight.** These games continued to exchange fire.

In all four Industrial–Brood cases, Industrial ended with 208–437 combat entities while Brood had 23–43. The entities have different roles, so counts alone do not quantify combat strength; nevertheless, the AI was not converting a very large numerical advantage into core damage.

One representative game, `orbital-1729-industrial-vs-brood-1`, ended with 349 Industrial combat entities versus 43 Brood. Of those Industrial entities, 270 had no queued movement order, and none were within 600 units of the opposing core. Entities with no movement orders can still fire; this is a terminal-state observation rather than proof they were inactive throughout the game. Together with the undefeated cores, it points to AI attack/formation behavior as a major confound for interpreting faction balance.

The current Brood AI also stops adding ordinary nests at a small target count, while opponents can keep accumulating units from existing yards. That AI policy can amplify the late-game population difference; it is not a faction-wide building cap. These results do not justify changing unit stats on their own.

## Controls and limitations

Five of the six same-faction mirrors also timed out. One Concord mirror ended in a slot-1 victory. Cross-faction decisive games split 9 wins for slot 1 and 7 for slot 2. The small number of decisive mirrors is insufficient to establish side neutrality, but every cross-faction case was run in both assignments and identical initial geometry was checked.

The six pilot games were repeated exactly in the full suite: final checksums, recorded metrics, and final player summaries all matched. Pilot duplicates are excluded from the counts above.

This measures faction rules together with the current AI. The AI’s target of four ordinary Brood nests (five with the aggressive personality) can constrain its late-game maintained population; it is not a faction-wide building cap. The current scripts also choose production compositions, scouting and formation destinations. Human micro, deliberate defensive field use, alternative build orders, and other maps could change the outcomes. Only two map seeds were used per profile, and paired legs are related observations.

## Reproduce and inspect

- [Harness and methodology](balance-testing.md)
- [Raw ten-minute report](../artifacts/balance/2026-09-05/suite/report.json)
- [Aggregated statistics](../artifacts/balance/2026-09-05/suite/summary.json)
- [Per-profile matchup CSV](../artifacts/balance/2026-09-05/suite/matchups.csv)
- [Raw thirty-minute follow-up](../artifacts/balance/2026-09-05/long-orbital/report.json)
- [Thirty-minute aggregated statistics](../artifacts/balance/2026-09-05/long-orbital/summary.json)
- [Representative thirty-minute stalemate](../artifacts/balance/2026-09-05/long-orbital/matches/orbital-1729-industrial-vs-brood-1.json)
- Per-match timelines and terminal entity diagnostics are in `artifacts/balance/2026-09-05/suite/matches/`.

Both completed runs verify the same unchanged simulation/dependency source fingerprint `cd1e840ee186b0f82e0ebf481696e8f2fc6836f381943116419fdf32e3ff98c6`. The main suite covered 634.8 simulated minutes in 7.7 minutes of measured match execution time; the extension covered 276.5 simulated minutes in 8.7 minutes. Their execution overlapped. All production/loss accounting and initial-map equality assertions passed, as did TypeScript checking. The benchmark was also checked to remain skipped in ordinary test runs.

Only the opt-in test harness, report summarizer, documentation, and generated reports were added. No gameplay values, AI logic, rendering, or multiplayer behavior were edited for this experiment.
