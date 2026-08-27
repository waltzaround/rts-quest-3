import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createPlanarCirclePhysicsWorld,
  loadPhysicsRuntime,
  sweptCircleHitFraction,
} from "../dist/index.js";
import { loadPhysicsRuntimeFromModule } from "../dist/worker.js";

test("loads and caches a Worker-safe precompiled WASM module", async () => {
  const bytes = await readFile(new URL("../src/box3d.wasm", import.meta.url));
  const compiledModule = await WebAssembly.compile(bytes);
  const first = await loadPhysicsRuntimeFromModule(compiledModule);
  const second = await loadPhysicsRuntimeFromModule(compiledModule);
  assert.equal(first, second);
  assert.equal(first.backend, "box3d-wasm");
});

test("loads the Worker binding when string code generation is forbidden", () => {
  const script = [
    "import { readFile } from 'node:fs/promises';",
    "import { loadPhysicsRuntimeFromModule } from './dist/worker.js';",
    "const bytes = await readFile('./src/box3d.wasm');",
    "const runtime = await loadPhysicsRuntimeFromModule(await WebAssembly.compile(bytes));",
    "if (runtime.backend !== 'box3d-wasm') process.exit(2);",
  ].join(" ");
  const result = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("returns the first swept-circle time of impact", () => {
  assert.equal(sweptCircleHitFraction({
    fromX: -4, fromZ: 0, toX: 4, toZ: 0, centerX: 0, centerZ: 0, radius: 2,
  }), 0.25);
  assert.equal(sweptCircleHitFraction({
    fromX: -4, fromZ: 3, toX: 4, toZ: 3, centerX: 0, centerZ: 0, radius: 2,
  }), null);
});

test("resolves a dynamic circle against a static obstacle", async () => {
  const runtime = await loadPhysicsRuntime();
  const world = createPlanarCirclePhysicsWorld(runtime);
  try {
    world.syncBodies({
      staticCircles: [{ id: "asteroid", x: 0, z: 0, radius: 1 }],
      dynamicCircles: [{ id: "ship", x: -2, z: 0, radius: 0.5, vx: 4, vz: 0 }],
    });
    world.step(0.25, 8);
    const [ship] = world.step(0.25, 8);
    assert.equal(ship.id, "ship");
    assert.ok(ship.x <= -1.49, `expected collision separation, received x=${ship.x}`);
    assert.ok(ship.vx <= 0.01, `expected collision response, received vx=${ship.vx}`);
    assert.equal(ship.z, 0);
    assert.equal(ship.vz, 0);
  } finally {
    world.dispose();
  }
});

test("allows filtered dynamic circles to pass through one another", async () => {
  const runtime = await loadPhysicsRuntime();
  const world = createPlanarCirclePhysicsWorld(runtime);
  try {
    world.syncBodies({
      staticCircles: [],
      dynamicCircles: [
        {
          id: "small-craft", x: -2, z: 0, radius: 0.5, vx: 4, vz: 0,
          collisionCategory: 0x4, collisionMask: 0x1 | 0x2 | 0x4,
        },
        {
          id: "capital", x: 0, z: 0, radius: 0.75, vx: 0, vz: 0,
          collisionCategory: 0x8, collisionMask: 0x1 | 0x2 | 0x8,
        },
      ],
    });
    const states = world.step(0.75, 12);
    const smallCraft = states.find((body) => body.id === "small-craft");
    const capital = states.find((body) => body.id === "capital");
    assert.ok(smallCraft.x > 0.9, `expected small craft to pass through, received x=${smallCraft.x}`);
    assert.ok(Math.abs(capital.x) < 0.01, `expected capital ship to remain still, received x=${capital.x}`);
  } finally {
    world.dispose();
  }
});

test("uses stable ID order for creation and output", async () => {
  const runtime = await loadPhysicsRuntime();
  const first = createPlanarCirclePhysicsWorld(runtime);
  const second = createPlanarCirclePhysicsWorld(runtime);
  const statics = [
    { id: "rock-b", x: 4, z: 0, radius: 1 },
    { id: "rock-a", x: -4, z: 0, radius: 1 },
  ];
  const dynamics = [
    { id: "ship-b", x: 2, z: 0, radius: 0.75, vx: -2, vz: 0 },
    { id: "ship-a", x: -2, z: 0, radius: 0.75, vx: 2, vz: 0 },
  ];
  try {
    first.syncBodies({ staticCircles: statics, dynamicCircles: dynamics });
    second.syncBodies({
      staticCircles: [...statics].reverse(),
      dynamicCircles: [...dynamics].reverse(),
    });
    assert.deepEqual(first.step(0.25, 8), second.step(0.25, 8));
    assert.deepEqual(first.step(0.25, 8).map(({ id }) => id), ["ship-a", "ship-b"]);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("validates snapshots before mutating the world", async () => {
  const runtime = await loadPhysicsRuntime();
  const world = createPlanarCirclePhysicsWorld(runtime);
  try {
    world.syncBodies({
      staticCircles: [{ id: "rock", x: 0, z: 0, radius: 1 }],
      dynamicCircles: [],
    });
    assert.equal(world.bodyCount, 1);
    assert.throws(
      () => world.syncBodies({
        staticCircles: [{ id: "duplicate", x: 0, z: 0, radius: 1 }],
        dynamicCircles: [{ id: "duplicate", x: 1, z: 0, radius: 1, vx: 0, vz: 0 }],
      }),
      /duplicate circle id/,
    );
    assert.equal(world.bodyCount, 1);
  } finally {
    world.dispose();
  }
  assert.throws(() => world.step(1 / 60), /disposed/);
});
