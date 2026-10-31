# Contributing to the experiment

This is a small WebXR passthrough / VR interaction prototype. Useful changes make spatial selection, manipulation or information scale easier to understand and test.

## Setup

Use Node.js 22.12+ and pnpm 10.26.1, then run:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The Quest entry point is http://localhost:5174/quest.html. For desktop-only live editing, use `pnpm dev:client` and its reported local port instead. See the [setup and controls guide](docs/quest-guide.md) for USB and HTTPS headset access.

Leave an active immersive session before refreshing. Keep automatic reloads disabled for the default Quest server.

## Before sending a change

- Explain the interaction or bug, the observed behavior, and the resulting behavior.
- Keep simulation changes separate from presentation-only layout changes where practical.
- Exercise both desktop picking and direct hand/controller contact when changing hit targets.
- Add behavioral regression coverage for simulation, lifecycle or input changes.
- Run `pnpm test`, `pnpm typecheck` and `pnpm build`.
- Say which checks ran on desktop and which ran on an actual headset. Do not mark unchecked headset acceptance items as complete.

The [architecture map](docs/architecture.md) identifies the main modules. Preserve audio provenance and third-party license notices when changing bundled assets. No project-wide source-code license has been selected; the README records the current licensing state.
