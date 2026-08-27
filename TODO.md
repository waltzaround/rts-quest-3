# Space RTS development log

## Completed

- Monorepo and TypeScript foundation.
- Phase 0 package boundaries for client, Worker, protocol, shared code, Box3D WASM, and game-core.
- Declarative 2–8 player combat scenarios with stable player, team, ship, turret, and projectile IDs.
- Fixed-step deterministic simulation with seeded randomness and explicit system ordering.
- Independent turret acquisition, firing arcs, traverse, target preferences, cooldown staggering, projectiles, shields, damage, and ship movement while firing.
- Browser battle renderer with low-poly ships, independently rotating visible turrets, projectile effects, tactical camera, and debug visualization.
- Persistent Match Durable Object with lobby slots, host transfer, teams/FFA, ready state, AI slots, and canonical 20 Hz simulation.
- Cross-runtime determinism and critical turret behavior tests.
- Cloudflare runtime verification for the precompiled Box3D module, Durable Object, and WebSocket snapshot path.
- Drag and click selection, Shift-add/remove selection, double-click type selection, and Ctrl+1–9 control groups.
- Fixed-tick move, attack-move, stop, hold, and focus-fire commands with waypoint queues.
- Deterministic formation assignment, right-drag formation facing, arrival steering, and local separation.
- Selection markers, order paths, formation previews, contextual HUD, command feedback, and victory/restart flow.
- Command ownership, duplicate-sequence, fixed-tick ingestion, formation-spacing, queueing, and replay tests.
- Deterministic Alloy/Energy economy with income, spend, storage, and proportional low-resource efficiency.
- Resource deposits, Command Cores, Asteroid Extractors, Solar Arrays, and Shipyards with placement validation.
- Continuous construction progress, ship production queues, cancellation, rally deployment, and fleet reinforcement.
- Low-poly structure/resource rendering, valid/invalid placement ghosts, live economy HUD, and production feedback.
- Deterministic enemy commander that claims expansion deposits, queues reinforcements, and launches attack waves.
- Command Core destruction as the synchronized team victory condition.
- Economy, construction, queue, stall, AI replay, and core-victory tests.
- Storage Arrays, Fabricators, Fusion Reactors, prerequisite-driven progression, and Fusion-gated Destroyer production.
- Command Core/Fabricator construction anchors with deterministic nearby Fabricator assistance that scales build speed and resource draw together.
- Progression-aware command cards, locked-prerequisite feedback, distinct structure models, and live Fabricator build-power status.
- Light, Fleet, and Capital Shipyard tiers with Advanced Fabrication, Capital Infrastructure, specialist frigates, Cruisers, Carriers, and Battleships.
- Mobile Fabricator vessels with remote placement authority, construction assistance, protocol validation, distinct rendering/audio, and dedicated production controls.
- Runtime-validated lobby, batched command, checksum, snapshot, and reconnect protocol.
- Optimistic client command routing with authority rejection handling and snapshot correction.
- Reconnect tokens, disconnected player state, persisted match snapshots, and live rejoin flow.
- Immediate Durable Object persistence after accepted command batches and protocol validation for every advanced structure.
- Eight-player FFA and team scenario tests plus a real two-client WebSocket verification script.
- Batched/instanced ship and turret rendering, distance LOD, pooled combat effects, bounded projectile visuals, GPU/CPU telemetry, and 100–2,000 ship visual stress modes.
- Authoritative, rotationally fair asteroid fields with shared browser/Worker Box3D static and dynamic bodies.
- Mass-aware ship collision, station collision, obstacle avoidance, reachable-goal projection, and asteroid-blocked projectile CCD.
- Neutral low-poly obstacle rendering, tactical/minimap persistence, exact collider overlays, avoidance vectors, and live physics telemetry.
- Worker-safe static Embind closures with a no-code-generation regression test, browser/Worker replay parity, restore equivalence, and live workerd reconnect verification.
- Deterministic ship/structure sensors, current hostile contacts, persistent resource discovery, and shared allied vision.
- Visibility-aware focus fire, turret acquisition, effects, audio, selection, tactical rendering, placement, HUD telemetry, and minimap fog.
- Explicit server-projected player views with private seeds, hidden orders/economies/queues/targets removed, per-view checksums, and no opponent command/event broadcasts.
- Projected-view interpolation, reconnect-safe discovery, protocol leak guards, and multiplayer hidden-target indistinguishability verification.
- Host-issued, single-claim team spectator access with the same fog-limited view as the authorized team, read-only enforcement, and reconnect credentials.
- Deterministic replay archives with accepted commands, authority transitions, checksummed checkpoints, persistence/resume, tamper detection, and exact Box3D playback.
- Post-match omniscient replay download with a verified manifest, bounded chunk transfer, play/pause, stepping, speed control, and timeline seeking.
- Starting combat fleets in both local and multiplayer matches, verified through the live browser and authority flow.
- Active-match timer recovery after a Worker hot reload when hibernatable WebSockets remain connected.

## Current

- Playable Phase 1 fleet control and Box3D obstacles, core Phase 2 combat, Phase 3 economy/technology progression, sensor fog of war, permissioned spectators, deterministic post-match replays, and a privacy-safe authoritative 2–8 player multiplayer foundation.

## Next

- Last-known contact memory, radar-style uncertain contacts, stealth/counter-sensor rules, and attack alerts.
- Production matchmaking, invite links, regional routing, and lobby discovery.
- Network input-delay tuning, long-duration soak tests, and adversarial protocol fuzzing.

## Technical debt

- The client uses simple geometry and DOM labels as intentional prototype art.
- Projectile CCD uses deterministic swept-circle time-of-impact queries from the physics facade, while rigid asteroid/station/ship contacts use Box3D.
- Physics bodies are intentionally rebuilt from canonical state every tick to make persistence and reconnect replay independent of Box3D warm-start caches; this favors correctness over maximum body throughput.
- Match IDs create isolated development matches directly; production matchmaking and abuse controls are not included yet.
- Multiplayer clients interpolate authoritative 10 Hz player views and do not yet predict locally owned movement between frames.
- In-progress replay archives are persisted with the match record; very long competitive matches should move action logs into segmented Durable Object storage before production rollout.
- Battle audio is implemented; cinematic post-processing and final mix polish remain.

## Bugs

- None known in the verified prototype.

## Performance risks

- Targeting uses a spatial hash, but candidate list pressure still needs 1,000+ ship benchmarks.
- Simulation and networking still need representative 8-player soak tests; the current 2,000-ship stress mode exercises rendering rather than full combat AI.
- Per-player view projection and 10 Hz fan-out need profiling in a full eight-human match with large visible fleets.
- Stateless per-tick Box3D body rebuilding needs profiling before scaling authoritative collision to hundreds of rigid ships; the visual stress harness does not exercise this path.
