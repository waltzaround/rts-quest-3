# Checking Mac/PC desyncs

ARM and x64 do not automatically disagree on floating-point arithmetic. The game nevertheless needs a cross-platform check: its lockstep simulation uses JavaScript `Math.sin`, `Math.cos`, `Math.atan2` and `Math.hypot`, whose approximations can vary between implementations. A small difference can eventually affect a branch, target choice or collision. The shared WebAssembly physics build and rounding of movement to 0.00001 help but do not prove determinism.

The live match compares peer checksums once per simulated second and requests recovery on a mismatch. Replaying the same inputs cannot permanently cure a platform-dependent calculation: the recovered client may diverge again.

## Run the same inputs on both machines

Use identical source files (including uncommitted changes), the lockfile and installed dependency versions. Run `pnpm install --frozen-lockfile` after copying the project. Node 22 or newer is required; initially use the same Node version on both machines.

On the Mac, from the project root:

```sh
pnpm determinism record artifacts/determinism/mac-arm64.json 2000
```

Copy that report to the PC along with the matching project. On the PC:

```sh
pnpm determinism verify artifacts/determinism/mac-arm64.json artifacts/determinism/windows-x64.json
```

The second command runs the Mac report's exact serialized starting states and command streams on the PC, saves a second report, and compares every tick. It covers three seeded scenarios with fighter/capital combat, asteroid navigation and a larger fleet, each with real Box3D WASM and with the fallback physics. The reports include shot/hit counts to confirm that combat occurred. Increase the recording length to `12000` for ten simulated minutes per scenario.

Compare existing reports without rerunning:

```sh
pnpm determinism compare artifacts/determinism/mac-arm64.json artifacts/determinism/windows-x64.json
```

| Result | Meaning | Exit code |
| --- | --- | --- |
| MATCH | Both hashes agree at every recorded tick. | 0 |
| DESYNC | The gameplay checksum differs; the first tick is printed. | 1 |
| INCOMPARABLE | Different builds, inputs, trace lengths or invalid reports. | 2 |
| DRIFT | Exact state differs before the rounded gameplay checksum detects it. | 3 |

A fresh checksum is calculated at **every tick**, bypassing the normal large-battle checksum cache. The second hash includes full serialized simulation state without rounding numbers, preserves negative zero, preserves array order, and rejects non-finite values. The report fingerprints simulation source, installed inline WASM glue and lockfile; it refuses to mix builds or accept files edited during recording. Generated reports stay in the ignored `artifacts/determinism` folder.

## What a pass does and does not establish

This probe tests **Node/V8** on the actual host CPU. Two passing runs on one Mac establish local repeatability, not ARM/x64 compatibility. An x64 run under translation is useful additional evidence but does not replace a Windows PC. Do not label the game cross-platform safe until a real PC verifies the report.

Also test the browsers players actually use: replay the same exported match on Mac Safari, Mac Chrome and Windows Chrome/Edge (and Firefox if supported), then play a mixed-machine match and watch for `lockstep_desync` or repeated resynchronization. Node tests alone do not certify Safari or Firefox. Match timing, network recovery and physics history are separate from this fixed-input CPU/runtime probe.

Passing finite scenarios is evidence, not a proof for every possible match. If a difference occurs, retain both reports and reproduce a short failing run before changing the simulation's math. Presentation-only ship colors, geometry, decals and exhaust do not enter the simulation checksum.

References: [ECMAScript Math semantics](https://tc39.es/ecma262/2026/multipage/numbers-and-dates.html#sec-math.sin), [WebAssembly portability](https://webassembly.org/docs/portability/).
