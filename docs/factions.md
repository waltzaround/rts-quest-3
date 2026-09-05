# Brood and Concord: first playable version

Choose your faction and the AI faction above **Local Skirmish**, or use the faction selector under each commander in a multiplayer lobby. Humans control their own faction; the host also controls AI factions. Changing a faction clears human ready states. Factions lock at launch.

The lobby battle randomly chooses a faction for each side when it loads or restarts. Its dedicated arena director keeps both fleets fighting near the center, with faction-correct reinforcements capped at 28 units per player. It uses `stepMenuBattle()` instead of normal commander staging, recovery and base-search orders; local skirmishes and multiplayer retain their regular AI behavior.

Each faction now has its own unit and building geometry. Brood uses segmented rose-colored chitin, hooked limbs, spore organs and rooted nests; Concord uses pale detached blades, suspended crystals and open warp gates. Role envelopes, weapon anchors and physics retain the existing definitions. Competitive balance remains prototype work.

The fleet archive at `viewer.html?faction=brood` or `viewer.html?faction=concord` shows the playable rosters. Choose **Buildings** to inspect the faction's structures, or choose an individual unit/building. The archive supports touch orbit/zoom, LOD inspection and hull damage previews, and is included in production builds.

Models are cached by faction and role. The renderer creates instance batches only for combinations present in a match; Close and Medium geometry totals for each playable roster remain within the original Industrial budgets. Far silhouettes retain the faction outlines. Damage sites are sampled from each faction's actual hull, and all fighter squad members use the same fixed gun anchors across factions. This art change adds no simulation rules or random state.

Brood weapons fire bone needles, pulsing acid sacs and seed-like artillery, with wavering membrane trails and spore bursts. Concord weapons use crystal darts, split lances, segmented energy trails and diamond interference waves. Missile launches, beams and impacts follow the firing faction. The two existing trail batches and projectile cap are retained; head batches are allocated only for active faction/weapon combinations, and bursts use bounded shared pools. Fighter muzzle corrections and authoritative projectile paths are unchanged.

Projectile appearance remembers observed ownership when a shooter dies or disappears. For a previously unseen shooter on a mixed-faction team, it uses a neutral tracer until ownership becomes visible; it does not expose hidden entity information. All of this remains client-side, with no simulation or network-format changes. `pnpm --filter @space-rts/client exec vitest bench --run test/weapon-appearance.bench.ts` compares CPU projectile preparation at the 8,192-shot cap; it does not measure GPU or whole-game FPS.

## Economy buildings

Economy structures have dedicated role and tier silhouettes, with names shared by build cards, prerequisites, tooltips, selection panels and the fleet archive. Choose **Economy** in the archive to compare them. Their costs, income, build power, technology requirements and footprints remain unchanged.

| Economy role | Brood | Concord |
|---|---|---|
| Extractor | Mineral Maw | Prism Tap |
| Deep Core Extractor | Deep Siphon | Resonance Well |
| Singularity Harvester | World Feeder | Singularity Lens |
| Alloy Refinery | Digestor | Matter Distillery |
| Matter Forge | Crucible Organ | Transmutation Spire |
| Solar Array | Sunleaf Colony | Heliostat |
| Fusion Reactor | Bio Dynamo | Flux Resonator |
| Antimatter Reactor | Starheart | Zero-Point Nexus |
| Storage | Nutrient Sacs | Phase Vault |
| Quantum Storage | Brood Reservoir | Tesseract Vault |
| Fabricator | Growth Organ | Assembly Loom |
| Advanced Fabrication | Evolution Chamber | Genesis Loom |
| Capital Infrastructure | Leviathan Cortex | Ascension Matrix |

## Brood

Brood ships have 90% of the corresponding Industrial hull health, no shields, and 110% base speed. On owned creep they gain another 20% movement speed and 10% weapon damage. Overlapping fields never stack; allied players cannot borrow the bonus.

The Hive Core begins with a 360-unit creep radius. Creep Nodes must be placed inside existing owned creep, using the usual core/fabricator construction range or a Seeder. Their fields grow from 25 to 300 units over roughly 15 seconds. A destroyed source's remaining creep recedes over at most 10 seconds. Surviving nodes maintain their own patches without requiring a connection to the core.

Each nest is permanently specialized by choosing a unit card once. It gradually hatches its initial population, stops at capacity, and replaces destroyed units for free. There is no banked production at capacity. A nest outside creep pauses its hatch timer. Free hatching is independent of resource efficiency; buildings still consume their normal idle energy upkeep.

| Nest tier | Specialization | Capacity |
|---|---|---:|
| Brood Nest | Drone Swarm | 12 |
| Brood Nest | Seeder | 2 |
| Brood Nest | Spitter | 4 |
| Brood Nest | Ravager | 6 |
| Greater Nest | Spore Guardian | 4 |
| Greater Nest | Behemoth | 3 |
| Leviathan Nest | Leviathan | 1 |

Capacity counts controllable simulation units. Each Drone Swarm uses the existing five-craft fighter presentation, so twelve swarms show sixty craft. Production is one simulation unit per hatch, with a timer twice the Industrial per-unit production time. A Drone Swarm takes 3.6 seconds.

Basic nests cost 1.5 times the corresponding shipyard's Alloy/Energy; advanced nests cost twice as much. This lowers the investment required to add a second specialization or Seeder nest, while retaining a larger premium for advanced units' free replacements. All nests still take twice the shipyard's base construction time. Resources stream into construction normally.

| Nest | Alloy | Energy | Base construction time |
|---|---:|---:|---:|
| Brood Nest | 720 | 480 | 26 seconds |
| Greater Nest | 2,200 | 1,600 | 60 seconds |
| Leviathan Nest | 5,600 | 4,800 | 110 seconds |

These are unassisted construction times at full resource efficiency; hatch times and population caps are unchanged. Destroying a nest leaves its surviving units alive. New nests adopt unbound survivors of their specialization before hatching, preventing repeated nest replacement from accumulating an uncapped reserve.

## Concord

Concord ships have 85% of the corresponding Industrial hull health, twice its shields, and 90% base speed. Each unit costs 140% of the Industrial per-unit cost and takes 140% of its per-unit production time, rounded up. Production emits individual units instead of five-unit batches.

The initial Nexus Core supplies a 360-unit home field. Pylons supply a 280-unit field immediately when construction finishes. Architects can establish isolated forward pylons; no connection to the core is required. Fields vanish when their source dies, while overlap preserves coverage from other surviving sources. A field supplies no additional vision beyond its structure's ordinary sensors.

Select foundries and use **Set Warp** to choose an arrival point in owned coverage. **Set Rally** or right-click sets the units' movement orders separately. Selected foundries display both destinations. A unit appears in the field on its completion tick, without a second warp timer.

Deployment checks coverage and placement again at completion, including the whole unit footprint, asteroids, barriers, structures, and other ships. If the selected point is occupied, it searches a bounded, deterministic set of nearby points within coverage. If no point is available, or the selected field is lost, the completed unit stays ready at the front of the queue and blocks further production. It consumes no further production resources while waiting. Retargeting or clearing the arrival area releases it. Destroying the factory loses its queued/held units.

Concord's initial roster is Shard Wing, Architect, Sentinel, Oracle, Lancer, Arbiter, and Sovereign, using the corresponding fighter, fabricator, frigate, artillery frigate, torpedo frigate, destroyer, and battleship roles.

Inside owned pylon space, ship shields take 20% less damage. Hull damage is unaffected; shield break-through converts the remaining raw damage through normal hull armor. Shields recharge at 2% of maximum per second after five seconds without taking damage, while inside a field. Firing does not reset that recovery delay. Entering coverage never grants a fresh shield pool.

## Implementation and verification

- `factions.ts` holds rosters, capacities, names, and cached faction definitions. Geometry, hardpoints, and physical radii retain the existing role definitions.
- `territory.ts` maintains serialized source circles and receding creep. Growth and all bonuses use fixed simulation ticks. Damage bonuses are captured when weapons fire; shield resistance is checked on impact.
- Faction, brood ownership/progress, warp destinations, damage timers, and field radii participate in checksums and restoration. Enemy nest links, hatch progress, and warp destinations remain private in projected views. Hostile field sources appear only when their source is visible.
- Simulation snapshots now use version 11 and the lockstep handshake uses version 5. Legacy snapshots default to Industrial when restored. Replays from older simulation versions are rejected rather than replayed under changed rules; all multiplayer peers need the updated client.
- AI commanders specialize nests, produce faction rosters, extend territory, and retarget foundries to forward pylons. Brood adds nest capacity over time, Concord stages and recharges in pylon fields, and Industrial expands factories with income. All three retain scouted building objectives and recover from stalled construction. AI plans participate in snapshots and checksums; projected views omit them.

`pnpm test` covers capacity, survivor adoption, resource stalls, warp loss/blocking/retargeting, combat modifiers, recharge, visibility, AI, and replay restoration. `pnpm --filter @space-rts/worker verify:multiplayer` checks faction selection/ownership, ready resets, launch locking, and reconnects against a running local authority. Use `VOIDFRONT_AUTHORITY=ws://127.0.0.1:PORT` to target a different local port.
