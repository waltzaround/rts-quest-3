# Command Prompt — playable deterministic multiplayer RTS

This repository implements the deterministic foundation, fleet controls, multi-turret combat, continuous-flow economy, sensor-based fog of war, and authoritative 2–8 player multiplayer foundation from the Space RTS brief. It supports local skirmishes plus team or free-for-all matches hosted by a Cloudflare Durable Object.

## Run it

The faction prototype adds **Brood** (capped, automatically replenishing nests and creep bonuses) and **Concord** (pylon warp deployment and shield bonuses). Choose factions on the local skirmish screen or under each commander in a multiplayer lobby. See [faction rules and controls](./docs/factions.md).

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The multiplayer lobby is the default landing screen; choose **Play Local Skirmish** to enter the standalone demo with a ready combat fleet. The bottom command card follows the current selection. Command Cores and completed Fabricator structures place economy and technology buildings; Mobile Fabricator vessels can establish and accelerate remote construction sites. The technology tree progresses through Light, Fleet, and Capital Shipyards, with Advanced Fabrication, Fusion power, storage, and Capital Infrastructure unlocking specialist frigates, Destroyers, Cruisers, Carriers, and Battleships. Locked cards show the exact missing prerequisite.

Select one or more completed Shipyards to queue reinforcements. Fighters and Bombers are produced as five-ship squadrons from one queue item; Mobile Fabricators and larger warships are produced individually. Each production click queues one batch in every selected compatible Shipyard, while Shift-click queues five batches in every selected Shipyard. Right-click the battlefield to assign that rally point to every selected Shipyard; `Y` or **Set Rally** provides the same action as an explicit targeting mode. Each Shipyard keeps its own visible queue, consumes resources continuously, and produces at a fixed per-Shipyard rate, so production capacity scales by building more Shipyards.

Drag-select your fleet, right-click or right-drag to move in formation, press `A` for attack-move, `M` for move, `S` to stop, `H` to hold, and `F` then click an enemy ship or structure to focus fire. Hold Shift to queue waypoints and use Ctrl+1–9 for control groups. Screen edges or arrow keys pan, the wheel zooms, middle-drag rotates the camera, and `\` toggles fullscreen. Destroy every opposing Command Core to win while the other commanders expand and reinforce autonomously.

Asteroids are authoritative Box3D colliders rather than scenery. Fleets steer laterally around them, blocked formation goals move to reachable positions, capital ships cannot penetrate asteroid or station bodies, and asteroids intercept projectiles. The minimap and tactical view retain their silhouettes; enable `COLLIDERS` and `AVOIDANCE` in Sim Telemetry to inspect exact shapes and steering vectors.

Ships and completed structures provide sensor coverage. Allies share live contacts and discovered resource deposits, while hostile ships, structures, projectiles, targeting data, and effects disappear when they leave sensor coverage. The minimap shades unexplored space and shows only permitted contacts.

The host can issue a single-claim **Team View** token from the lobby. A live observer sees exactly that team's fog-limited tactical picture, receives reconnect credentials, and cannot issue orders or change the lobby. Omniscient viewing remains unavailable while a match is active. After victory, choose **Post-match Replay** with the lobby code to download the deterministic archive, verify its manifest and checksummed checkpoints, then review the whole battle with play/pause, single-step, 0.5–4× speed, and timeline seeking.

Battle audio is generated locally and starts after the first interaction. Weapon-specific transient, mechanical, energy, and impact layers are spatially prioritized through a fixed 32-voice pool, while the quieter engine bed is summarized into at most 12 nearby fleet clusters with ship-class-dependent tone. The audio graph therefore stays bounded even in multi-thousand-ship stress scenarios; use the `SND` control in the top bar to mute it.

Combat rendering uses weapon-specific cadence and silhouettes: autocannons and point defence fire deterministic machine-gun bursts, plasma fires paired pulses, railguns and torpedoes remain deliberate single shots, and heavy ships mount instantaneous beam emitters. Thruster exhaust, beam ribbons, explosions, secondary detonations, and drifting wreck chunks all use fixed instanced or pooled budgets. Close and medium LOD keep exhaust on the actual engine nozzles, using four soft-shaded triangles per plume; distant contacts skip exhaust. Healthy fighter squads retain all five craft at every 3D LOD. Large fleets simplify each craft’s geometry instead of dropping members, and fixed guns, muzzle flashes and tracer launches share the same animated craft pose.

## Local multiplayer

Start a LAN-accessible client and the authoritative lobby service together with:

```bash
pnpm dev:lan
```

The command prints this computer's LAN URL. Open that URL on each computer, click **MULTIPLAYER**, then create a lobby or follow the host's copied invite link. The host can choose teams or free-for-all, select an orbital ring, crossfire, or open-expanse layout, set the map capacity to 4, 6, or 8 commanders, and tune starting reserves plus deposit density. Any settings change clears every human pilot's ready state so the final setup must be acknowledged before launch. Up to seven other pilots can join, and the host can fill open slots with AI commanders. All browser traffic goes through port `5173`; the authority remains private behind the host's development proxy. If another computer cannot connect, allow incoming connections to port `5173` in the host firewall and confirm both devices are on the same network.

Clients run the deterministic simulation while the Worker sequences commands and broadcasts a 20 Hz clock. Clients buffer network input outside the simulation and apply it at its scheduled tick, so delivery latency cannot change checksums. Recovery replays the same command journal from the bootstrap state. For separate-terminal development, `pnpm dev:client` runs the client and `pnpm dev:worker` runs the relay.

## Build and deploy

Use the pnpm version declared in `package.json`, then run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm deploy`. The Worker has a development dependency on the client so recursive builds finish the client assets before packaging the Worker, including on a fresh checkout.

The input scheduling fix uses lockstep protocol 6. After deploying it, reload every player's page and start a new match so all peers use the same rules.

## Verify it

```bash
pnpm test
pnpm typecheck
pnpm build
```

With the Worker running, exercise the full two-client WebSocket flow with:

```bash
pnpm --filter @space-rts/worker verify:multiplayer
```

To verify two real WASM simulations over local WebSockets, including a 15 FPS client, delayed delivery, construction, production and full recovery:

```bash
VOIDFRONT_INTEGRATION_AUTHORITY=ws://127.0.0.1:8787 pnpm --filter @space-rts/worker test
```

The tests cover deterministic replay/checksums, replay seek/resume and tamper rejection, 2–8 player scenario generation, team victory, continuous economy and stalls, the complete three-tier technology tree, static and mobile Fabricator construction assistance, placement validation, construction, squadron and capital-ship production, fixed-rate multi-Shipyard production, rally points, production cancellation, enemy commander behavior, command ingestion, queued orders, stable formations, moving fire, independent multi-target turrets, firing arcs, point-defence priorities, staggered fire, sensor boundaries, allied vision, hidden-target rejection, secure player/team/omniscient projections, persistent discovery, real Box3D obstacle resolution, browser/Worker binding parity, restore equivalence, projectile interception, and Worker loading with runtime code generation forbidden. The multiplayer verifier additionally covers lobby launch with starting fleets, per-player views, hidden-data redaction, indistinguishable hidden target rejection, spoofed-owner correction, obstacle steering, view checksums, team-spectator authorization/read-only behavior/reconnect, live omniscient rejection, and player reconnect snapshots.

## Architecture

- `apps/client`: Three.js renderer (fleet silhouettes and architecture in `src/fleet-designs.ts`, geometry primitives and turrets in `src/ship-hulls.ts`, structures in `src/structure-models.ts`, shared deck/thruster layout in `src/ship-layout.ts`; open `/viewer.html` on the dev server to compare ships at their actual scale, switch detail tiers, adjust hull health and preview impact/destruction effects, or `/viewer.html?structures=1` for structures), multiplayer lobby, projected-view interpolation, fog/minimap filtering, command routing, resources and structures, placement and production UI, RTS controls, batched ship/turret rendering with LOD, pooled effects, tactical camera, bounded spatial audio, and debug/stress visualization.

Ship surface markings share the existing material passes. Model detail follows camera zoom, with one shared tier and transition history per ship class across all factions; moving across the view, orbiting, or emerging from fog does not lower a ship's detail. Class size, render quality and viewport resolution still determine the zoom thresholds. Medium detail retains the major armor masses, while wide views use flat silhouettes that preserve openings and class profiles. Off-screen culling, large-fleet budgets and strategic icons remain active. Damage sites are sampled from actual hull surfaces once per class; scorch patches and transient combat effects use fixed instance pools. Client tests guard the pre-redesign aggregate geometry budgets at all three detail tiers, physical footprints, damage attachment and effect pool limits. The hull palette uses satin grey plating, restrained markings and neutral lighting. Open `/viewer.html?class=fighter&lod=medium&firing=1` to inspect the five-member squad and its gun origins; fighter tests also cover maximum instance capacity, damage thresholds, snapshot burst ownership and nozzle placement.
- `apps/worker`: Cloudflare gateway and persistent Match Durable Object with slots, teams/FFA, ready/host controls, AI players, validated command batches, a 20 Hz canonical simulation, private persistence, per-player/team 10 Hz tactical views and checksums, team-spectator grants, replay capture/transfer, and reconnect handling.
- `packages/game-core`: renderer-free deterministic economy, technology progression, assisted construction, production, enemy commander, RTS steering, Box3D body synchronization, sensors, visibility-safe player/team/omniscient projection, replay recording/playback, ships, turrets, spatial targeting, projectiles, damage, victory, and checksums.
- `packages/box3d-wasm`: the shared Erin Catto Box3D boundary. Browsers use the inline build; Workers import the exact same binary as a precompiled module through Worker-safe static Embind closures.
- `packages/protocol`: Typed and runtime-validated lobby, command, projected-view, view-checksum, snapshot, and reconnect message contracts that reject legacy full-state gameplay frames.
- `packages/shared`: fixed-step and math primitives.

Cloudflare forbids runtime WASM compilation and dynamic JavaScript generation. The Worker therefore bundles the Box3D binary as a precompiled module and applies a checked-in patch that replaces the upstream Embind code generators with static closures. Browser and Worker simulations use the same planar circle world; bodies are rebuilt from canonical state each tick so persistence and reconnects never depend on hidden solver caches.

See [TODO.md](./TODO.md) for current scope, next steps, and performance risks.

Cross-platform determinism checks: see [Mac/PC verification](docs/determinism.md) for recording the same combat scenarios, rerunning them on a second machine, and locating the first exact-state or gameplay-checksum mismatch.
