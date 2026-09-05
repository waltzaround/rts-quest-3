# Production multiplayer desync check

Tested https://space.walt.online on 5 September 2026, starting at 07:14 UTC, in dedicated QA match `2812`.

## Result

No spontaneous desync was observed during the 135-second four-player run. The three instrumented simulations made 10,576 matching checksum comparisons, including comparisons against their earlier states during recovery. No protocol or browser-console errors were observed.

The fourth player used the actual production browser client. Its downloaded JavaScript bundle matched the local build byte-for-byte (SHA-256 `1ce2299f6952dd3c636f886974a6103dc7a8d4a9a550ef33a8616a6d9fa3ab23`).

## Coverage

| Player | Client | Faction | Added delivery delay |
| --- | --- | --- | --- |
| Browser host | Production browser UI | Industrial | None |
| QA 1 | WASM simulation at 60 FPS | Industrial | None |
| QA 2 | WASM simulation at 30 FPS | Brood | 80 ms |
| QA 3 | WASM simulation at 15 FPS | Concord | 160 ms |

Each simulated player constructed a shipyard, produced fighters, and issued attack-move commands. The browser player queued a fighter squadron and a frigate, then built storage through the normal UI. The run reached 36 total simulation ship entities. A requested resync of QA 3 replayed matching historical checksums and retained its completed shipyard. The browser was separately reloaded and rejoined; its army and new storage (entity 70, full health) were visibly present afterward and remained present at nearly five minutes of game time.

## Limits and performance finding

The recorded run is a bounded test, not proof against all desync scenarios. All clients ran on this computer using the live production server. Different operating systems and browser engines were not compared.

QA 3's intentional recovery began around 100 seconds. At the final 135-second sample it had replayed through tick 2100 correctly while the latest received relay tick was 2368: it was still 268 ticks behind. The test verifies correct reconstruction through its pre-recovery state and the following 100 ticks; it does not establish that this low-FPS peer had fully caught up. Slow recovery remains a performance limitation.

The three simulated players and the browser disconnected after testing. No production code or configuration was deployed or changed.

Raw measurements: [JSON report](./2026-09-05-four-player-desync.json).
