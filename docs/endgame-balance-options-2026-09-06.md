# Endgame formations and balance options — 6 September 2026

The formation fix is implemented. The balance values below are proposed experiments, not changes applied to the game.

## Formation change

A point attack-move now gives nearby, similarly sized ships independent, compact detachments. Each assigned destination stays within 180 world units of the objective, regardless of selection size. Additional detachments share that attack area, using the existing local separation and collision rules. They no longer receive permanent rear ranks thousands of units from the fight. This bounds destinations; it does not promise that thousands of physical hulls can occupy the same small area simultaneously.

The previous algorithm used the largest hull's spacing across the entire selection. With 1,000 ships and a battleship selected, it produced a grid approximately 4,766 units wide and 2,933 deep. Adding a battleship no longer expands the fighters' destinations. Fleets approaching from different areas have independent headings instead of a shared map-wide centroid.

Dragged attack orders use the nearest section of the requested line and cap rear-rank depth. Short drags now respect their actual frontage for ordinary move and patrol formations too. The client preview and authoritative command handler use the same assignments. Assignment work is bounded to at most 24 ships per detachment rather than comparing every ship against the entire fleet's remaining slots; the preview's ship lookup is also linear.

## What the evidence supports

The [5 September report](balance-report-2026-09-05.md) recorded 44 of 60 cross-faction games unresolved at ten minutes. Eight of twelve extended games were still unresolved at thirty minutes with both command cores at full hull health. That is evidence of poor match closure in that earlier build, not a measurement of today's code or proof that every faction needs damage buffs. AI movement, territorial deployment and Brood nest expansion have changed since that report. Fresh games are needed before using its faction win counts to set prices.

Current code still shows several possible causes:

- Mobile artillery must stop and deploy before it can acquire targets and fire. Ordinary attack-move navigation has no artillery-specific stop-at-range behavior, so a clicked base can leave siege ships inside their minimum range. Formation compression does not solve this separate combat-posture issue.
- Static artillery has a growing range advantage over mobile siege:

  | Tier | Mobile range | Static range | Static advantage |
  | --- | ---: | ---: | ---: |
  | T1 | 500 | 600 | 20% |
  | T2 | 680 | 918 | 35% |
  | T3 | 900 | 1,350 | 50% |

- Refineries and matter forges generate alloy without holding deposits, so a fortified home economy can keep reinforcing after losing much of the map.
- Industrial and Concord can accumulate units without a global population limit; Brood pays for nests and replaces casualties for free within each nest's capacity. These are different ways of sustaining an attrition fight.
- Concord pays a 40% per-unit price and build-time premium, but some of its value depends on fighting or recovering in pylon coverage. Its old off-field AI results should not be treated as human competitive balance.

Sources: [unit, economy and artillery values](../packages/game-core/src/data.ts), [faction prices and replacements](../packages/game-core/src/factions.ts), [field bonuses](../packages/game-core/src/territory.ts), [navigation and deployment](../packages/game-core/src/simulation.ts), and [current AI](../packages/game-core/src/ai-strategy.ts).

## Recommended order of experiments

1. **Make siege reliably execute an attack.** Have mobile artillery stop inside its firing band, deploy, face a visible target, and resume advancing when that target dies or leaves range. A direct move must still override this. Keep spotting and setup requirements. This reduces the manual work needed to finish a won fight and should be measured before changing stats.

2. **Give entrenched artillery a deliberate counter.** My preferred experiment preserves the long static ranges: add a deployed, structure-only bombardment range of roughly 675 / 1,050 / 1,500 for mobile siege, retaining the current ranges against ships. Require allied spotting and reveal the gun when it fires, so defenders can raid it. Start by changing range alone. If breaches are still too slow, separately test +20–25% siege damage against buildings. Brood currently has no mobile artillery; it would need an equivalent breach option, such as an exposed siege role or a building-focused Ravager attack, before this becomes a faction-wide balance patch. The simpler alternative is to reduce static range advantages, but that reverses the earlier preference for long-range static artillery.

3. **Make map control shorten wars.** Start with a 20% increase in refinery/forge energy upkeep and measure whether losing contested deposits now constrains replacements. Check power-starved cases and Brood separately, because free hatching does not consume the normal production supply. If needed, test deposit income +10–15% as a separate experiment. The intended outcome is that losing territory hurts; players should still be able to recover from a raid.

4. **Add a match-ending objective if siege remains tedious.** For a more substantial design change, unlock three neutral relays around minute 12. Holding two starts a visible three-minute victory countdown; losing the majority resets it. Tune the times to the intended match length. This creates an alternative to dismantling every layer of a base, but needs map placement and AI support and should initially be an optional mode.

5. **Tune faction prices only after the mechanics rerun.** If Concord still loses when it uses forward pylons and recovery correctly, test a premium reduction from 40% to 30% before a global damage buff. If Brood still produces endless stalemates, test a 20% longer replacement interval after a nest reaches its initial capacity, preserving its opening and free-replacement identity. Do not apply both together when measuring their effects.

I would start with siege behavior, then the structure-only counter-siege option. A global health reduction, general damage boost or hard unit cap would change every matchup without first establishing why armies fail to finish. A supply or upkeep system remains an option if excessive army accumulation persists, but it would need to price Brood's maintained capacity consistently with the other factions.

As a design precedent rather than evidence about this game, the [FAF Equilibrium changelog](https://faforever.github.io/equilibrium/Changelog/#support-units-without-weapons) describes giving support units an attack-move stopping behavior that keeps them behind the frontline.

## How to judge success

Provisional target for a standard medium-map 1v1: a 15–25 minute match, with a decisive advantage converting into core pressure within two or three minutes. This is a proposed design target, not a measured result.

Run a fresh unchanged-code baseline, then one experiment at a time across the same seeds with swapped starting sides. Record completion rate at 15, 20 and 30 minutes; time from first combat to first core damage; resource-cost-weighted army advantage; siege firing uptime; time spent stalled outside weapon range; and faction-field use. Report unresolved games separately rather than treating the larger surviving army as the winner. Use the existing [balance harness](balance-testing.md), plus a human test of selecting a dispersed late-game fleet and attack-moving it through a defended approach. Include open maps and chokepoints.

The formation regression suite covers 128, 1,000 and 12,000-unit assignment bounds, selection-order determinism, mixed hull sizes, independent approach directions, dragged frontage, queued orders and snapshot restore. It also exercises a 256-unit advance using the production collision backend. These checks validate movement behavior, not competitive faction balance.
