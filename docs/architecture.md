# Architecture

Orbital Command separates a local spatial RTS simulation from its WebXR and desktop presentation. The Quest entry point is `apps/client/quest.html`; it runs without the multiplayer worker.

## Frame and input flow

1. `quest.ts` creates the Three.js scene and handles WebXR sessions, desktop controls, fingertip/controller contact and wrist menus.
2. Input produces selection, move, attack-move, focus, build or production commands in battle coordinates. Moving or scaling the world transforms the presentation, not the simulation's coordinates.
3. `QuestBattle` advances the local simulation at 20 Hz. Movement, aiming, collision and projectile paths use XYZ coordinates.
4. The renderer interpolates positions and chooses ship models, individual flags or force summaries according to distance. Presentation easing is independent of simulation pause.
5. Audio, effects, territory and supply overlays follow the same battle state; input uses hit targets for the dominant visible representation.

## Main files

| Area | Files in `apps/client/src/` |
| --- | --- |
| App and XR lifecycle | `quest.ts`, `quest.css` |
| Simulation, AI and economy | `quest-combat.ts`, `quest-simulation.ts` |
| Selection and 3D orders | `quest-controls.ts`, `quest-spatial-controls.ts`, `quest-direct-input.ts` |
| Wrist interaction | `quest-wrist-input.ts` |
| Ship models and strategic symbols | `quest-battle-view.ts`, `quest-nato-icons.ts`, `quest-icon-layout.ts`, `quest-icon-presentation.ts` |
| Zoom transitions | `quest-view-transition.ts`, `quest-instance-fade.ts` |
| Composition banners and pressure | `quest-encounters-view.ts`, `quest-force-summary.ts`, `quest-force-status.ts` |
| Endless battles and supply | `quest-demo.ts`, `quest-supply-view.ts` |
| Fronts and territorial influence | `quest-territory.ts` |
| Visual effects and spatial audio | `quest-weapon-effects.ts`, `quest-effect-visibility.ts`, `quest-audio.ts` |

## Passthrough and VR

The client requests an immersive AR or immersive VR session using a local-floor reference space and optional hand tracking. Passthrough removes the scene background so the headset compositor can show the real environment. The experiment does not request room geometry or anchors.

The user's tracked camera stays under the headset's control. Grabs transform the battlefield group instead. Menus attach to the raised wrist, and the battlefield turns horizontally without tilting or rolling with the hands.

## Simulation and presentation boundaries

The `packages/game-core` definitions supply ship statistics, weapons, resource costs and hardpoint data. Quest mode has its own spatial simulation and match lifecycle; it does not use the earlier planar Box3D solver or lockstep multiplayer protocol. The original browser RTS and Cloudflare Durable Object worker remain available separately.

The demonstration launches replacements at rear bases and moves them along actual XYZ routes. Arrival restores normal combat speed and assigns each ship to its encounter. Recent pressure tracks net arrivals and losses per battle over 20 simulation seconds, so pause stops the window and a new battle clears it.

Hull and turret instances share geometry. Tactical symbols use bounded offsets, and only top zoom aggregates nearby units. Force banners suppress the units they summarize. Fine weapon effects fade through the local detail range and clear in overview. No shadows or postprocessing are used.

## Validation

Unit and integration tests cover command ownership, spatial movement and aiming, swept projectile impacts, economy, production, lifecycle, supply arrival, symbol grouping, picking, zoom transitions and force summaries. Run `pnpm test`, `pnpm typecheck` and `pnpm build` from the root.

On-device tracking, comfort, stereo depth and rendering budgets require a real headset. Follow [quest-validation.md](quest-validation.md); do not use a desktop screenshot or test count as proof of physical-headset acceptance.
