# Faction AI and scaling — 5 September 2026

Implemented on `feature/brood-concord-factions`, following the original faction design and the [full baseline balance report](balance-report-2026-09-05.md).

**All three factions now expand their production and economy beyond their opening targets. All twelve extended Orbital games finished, compared with four previously. This is an AI improvement, not a finding that the factions are balanced.** The ten-minute suite actually finished fewer games, and Brood still lost every extended Orbital matchup.

No ship statistics, weapons, costs, build times, nest capacities, creep bonuses, warp rules, or shield bonuses changed in this pass. SHA-256 comparisons confirm that `data.ts`, `factions.ts`, and `territory.ts` match the pre-AI-edit copies exactly. Simulation changes outside the new AI strategy and its existing construction helpers are the deterministic version updates.

## How the strategies differ

**Brood grows maintained population by investing in nests.** It starts with a combat nest and a Seeder nest, then diversifies permanent nest specialties across fighters, bombers, frigates and larger vessels. Lost units do not cause the AI to over-specialize new nests in whichever class suffered the latest casualties. Its ordinary-nest target increases with time and income; larger nest targets increase with income. It places nests on creep, advances creep toward scouted enemy buildings, and stages most of a small army inside coverage. Bombers and sufficiently strong armies can push forward. Each nest still hatches only to its existing capacity and replaces losses under the original rules.

**Concord builds a forward warp network and preserves shielded units.** Its mixed force emphasizes fighters, frigates and artillery, followed by destroyers, torpedo frigates and battleships. Foundries set warp points inside the forward owned field and rally there. Small or locally outnumbered forces stage in coverage; larger forces attack ahead of it. Ships below 25% shields withdraw to an owned field chosen by distance and visible threats, resuming after 85% recharge. Those are AI decision thresholds, not changes to shield strength or recharge mechanics. Foundry and builder targets grow with the economy.

**Industrial expands conventional production.** It retains the existing visible-enemy-based roster choices, adds yards as income rises, and scales mobile builders with production capacity. It avoids repeatedly queuing opening builders before the first one completes. Production can continue while infrastructure is under construction instead of every yard waiting for construction to finish.

All three claim more discovered deposits over time, upgrade extraction, and add higher-tier power and alloy infrastructure. They retain previously scouted enemy buildings, prioritize cores, and use bounded individual attack destinations instead of an increasingly wide whole-army grid. Scouts continue looking for the core after finding peripheral buildings. Territory expansion aims toward the objective rather than stopping at the map center. Idle builders leave combat rallies; construction that makes no progress for a minute is cancelled, with a temporary avoidance period for that site.

These are finite-map strategies, not guarantees of unlimited population or growth while under attack. Resources, building space, travel, technology, casualties and normal command validation still apply.

## Same-seed ten-minute comparison

The original 66 cases were rerun: 60 cross-faction games and six mirrors, using the same five profiles, two seeds, both starting assignments and real Box3D WASM physics. The comparison script checks matching scenario options and initial geometry. Only real core-destruction victories count; unresolved games are not scored by fleet size or damage.

The table shows **first faction wins / second faction wins / unresolved**. Each row contains 20 games per version.

| Matchup | Previous AI | Updated AI |
|---|---:|---:|
| Brood / Industrial | 1 / 0 / 19 | 4 / 2 / 14 |
| Concord / Industrial | 1 / 7 / 12 | 1 / 0 / 19 |
| Brood / Concord | 2 / 5 / 13 | 0 / 1 / 19 |
| Cross-faction games completed | 16 / 60 | 8 / 60 |

Unresolved games increased from **44 to 52 of 60**. Six previously unresolved cases became decisive, while fourteen previously decisive cases became unresolved. The new decisive games finished between 6:04 and 9:35, with a median of 8:13. All cross-faction games had combat.

The updated AI produced these per-profile results, again first / second / unresolved, out of four games:

| Profile | Brood / Industrial | Concord / Industrial | Brood / Concord |
|---|---:|---:|---:|
| Orbital; normal balanced | 0 / 0 / 4 | 0 / 0 / 4 | 0 / 1 / 3 |
| Open; normal balanced | 0 / 0 / 4 | 0 / 0 / 4 | 0 / 0 / 4 |
| Tunnel; normal balanced | 0 / 1 / 3 | 0 / 0 / 4 | 0 / 0 / 4 |
| Pressure; small, low/scarce, hard aggressive | 4 / 0 / 0 | 1 / 0 / 3 | 0 / 0 / 4 |
| Macro; high/rich, hard economic | 0 / 1 / 3 | 0 / 0 / 4 | 0 / 0 / 4 |

Brood swept Industrial in Pressure, compared with one win and three unresolved games before. Concord lost none of its 40 appearances within ten minutes, but 38 remained unresolved; that is not a 100% competitive win rate. Its previous four Macro wins over Brood all became unresolved. The slower match endings require longer observations.

Two Industrial mirrors finished, both for slot 2; the other four mirrors timed out. Previously one Concord mirror finished and five timed out. These small controls do not establish side neutrality.

## Mechanic use and continued scaling

| Metric | Industrial: previous → updated | Brood: previous → updated | Concord: previous → updated |
|---|---:|---:|---:|
| Fighting ship-time inside own field | N/A | 24.4% → 49.6% | 10.3% → 35.5% |
| Mean supply efficiency | 54.6% → 51.4% | 91.9% → 92.8% | 57.4% → 63.3% |
| Median first mobile builder | 13.5s → 13.5s | 121.0s → 79.0s | 18.1s → 18.1s |
| Mean completed production buildings at 5:00 | 1.95 → 2.58 | 3.10 → 4.28 | 1.83 → 2.10 |
| Mean combat entities at 5:00 | 24.85 → 15.33 | 11.95 → 19.50 | 12.85 → 18.45 |
| Mean alloy income at 5:00 | 74.5 → 98.6 | 74.3 → 70.4 | 47.8 → 62.8 |

Five-minute checkpoints include all 40 cross-faction appearances for each faction in both versions. Fleet counts exclude mobile builders; classes have different strength, and a fighter entity represents the existing visual swarm. Supply efficiency describes resource fulfillment, not combat effectiveness.

At ten minutes, comparing only identical appearances that still have observations in **both** versions:

| Faction | Paired appearances | Mean completed production buildings | Mean combat entities | Mean alloy income |
|---|---:|---:|---:|---:|
| Industrial | 26 | 3.77 → 6.54 | 43.15 → 64.27 | 193.2 → 224.6 |
| Brood | 26 | 5.65 → 9.38 | 27.69 → 41.54 | 142.7 → 110.8 |
| Concord | 24 | 3.13 → 4.13 | 8.96 → 42.75 | 86.8 → 122.1 |

These are matched surviving samples, not the same population as the five-minute table. In particular, they should not be used as an unbiased estimate of fleet growth for every game. Separate ten-minute economy regression scenarios with a passive, durable opposing core verify that **each** faction increases both completed production buildings and alloy income between minutes five and ten.

Brood expands maintained capacity much faster, but its average income is lower than the old AI in these paired comparisons. Industrial invests in infrastructure and attacks more actively, but has fewer combat entities at five minutes and slightly lower supply efficiency. These are material tradeoffs, not improvements in every metric.

## Same-seed thirty-minute follow-up

All twelve original Orbital cross-faction cases were extended again from the same starting states. Every new extended timeline matches the corresponding new ten-minute timeline exactly through minute ten. They are extended observations of that subset, not twelve additional independent matchups.

| Matchup | Previous: first / second / unresolved | Updated: first / second / unresolved |
|---|---:|---:|
| Brood / Industrial | 0 / 0 / 4 | 0 / 4 / 0 |
| Concord / Industrial | 0 / 3 / 1 | 1 / 3 / 0 |
| Brood / Concord | 0 / 1 / 3 | 0 / 4 / 0 |

**All twelve now finish, compared with four previously.** They end between 9:35 and 19:16, with a median of 15:08. All eight previously unresolved cases become decisive. Previously both cores retained full hull health in every 30-minute unresolved case.

The new extended timelines reach maxima of **13 completed Industrial yards, 16 Brood nests and eight Concord foundries**, counting all production tiers. Those are observed peaks in different games, not equal-time measurements or new caps.

Brood loses all eight of its extended Orbital appearances despite its larger maintained population. Concord beats Brood in all four and wins one of four against Industrial. This is stronger evidence that the old attack deadlock has been reduced in Orbital; it also leaves a clear Brood matchup concern. Results do not distinguish unit balance from remaining composition, economy and tactical shortcomings.

The other four profiles were not extended to thirty minutes in this pass. The twelve Orbital outcomes must not be generalized to all 52 unresolved ten-minute games.

## Validation and scope

- 208 game-core tests passed, including ten new AI strategy/scaling tests; 14 client tests, seven physics tests, the protocol validation script and four determinism-comparison script tests passed. Ordinary runs skip the opt-in balance benchmark.
- Workspace TypeScript checks and the production client/Worker builds passed. Multiplayer checks passed faction ownership, ready resets, match locking, command broadcast, bootstrap/journal recovery and reconnect transport against the local authority.
- AI scouting memory, shield-recovery membership, construction progress watches and blocked sites are serialized and checksummed. Projected views omit them; replay and protocol parsers reject malformed plans. Simulation version is **11**, lockstep version **5**; multiplayer peers must use matching versions.
- A 300-ship regression verifies bounded attack destinations. Other regressions cover remembered versus hidden contacts, permanent nest diversification, shield retreat/re-entry, stalled construction, pylons advancing past the center, and continuing economy growth for all factions.
- Real-WASM replay and per-tick checksums match when instances start from the same restored snapshot. A separate live-versus-restored continuation check exposed a physics limitation: restoring at tick 800 first diverged in ship positions/velocities at tick 1449. Box3D retains solver/allocation history outside the serialized simulation. The AI plans were equal at that first divergence. This pass does not change that physics behavior; passing reconnect transport checks does not prove uninterrupted mid-battle physics continuity.
- Both final balance runs verified unchanged simulation/dependency source fingerprint `8404b789d9e81c7cf4490826641064fae13c108d15110be6899bd85f7808ca76`. The old fingerprint was `cd1e840ee186b0f82e0ebf481696e8f2fc6836f381943116419fdf32e3ff98c6`. The new runs cover 639.1 and 177.2 simulated minutes respectively. Experimental pilot runs are excluded from the comparison.

Changes remain on the faction branch. No publication or unit-stat rebalance was performed for this AI pass.

## Reports and reproduction

- [Original report](balance-report-2026-09-05.md) and [benchmark methodology](balance-testing.md)
- [New ten-minute raw report](../artifacts/balance/2026-09-05/ai-scaling-suite/report.json), [summary](../artifacts/balance/2026-09-05/ai-scaling-suite/summary.json), [paired comparison](../artifacts/balance/2026-09-05/ai-scaling-suite/comparison.json)
- [New extended raw report](../artifacts/balance/2026-09-05/ai-scaling-long-orbital/report.json), [summary](../artifacts/balance/2026-09-05/ai-scaling-long-orbital/summary.json), [paired comparison](../artifacts/balance/2026-09-05/ai-scaling-long-orbital/comparison.json)
- Per-match files include timelines, terminal entities, AI plans and pending build orders.

Run from the repository root with a new absolute output directory:

```sh
RTS_BALANCE_OUTPUT=/absolute/path/to/new-suite pnpm --filter @space-rts/game-core exec vitest run test/synthetic-balance.test.ts
RTS_BALANCE_OUTPUT=/absolute/path/to/new-extended RTS_BALANCE_PROFILES=orbital RTS_BALANCE_MIRRORS=0 RTS_BALANCE_TICKS=36000 pnpm --filter @space-rts/game-core exec vitest run test/synthetic-balance.test.ts
python3 scripts/summarize-balance.py /absolute/path/to/new-suite/report.json
python3 scripts/compare-balance.py artifacts/balance/2026-09-05/suite/report.json /absolute/path/to/new-suite/report.json /absolute/path/to/new-suite/comparison.json
```

Use the original `long-orbital/report.json` when comparing extended runs. The comparison script rejects incomplete runs, changed source during a run, different cases, different time limits, different scenario options or different initial geometry.
