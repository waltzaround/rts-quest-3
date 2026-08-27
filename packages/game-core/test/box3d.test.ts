import { describe, expect, it } from "vitest";
import { loadPhysicsRuntime, runPhysicsProbe } from "@space-rts/box3d-wasm";

describe("Box3D WebAssembly boundary", () => {
  it("loads Erin Catto's 3D engine and advances a real world", async () => {
    const runtime = await loadPhysicsRuntime();
    const position = runPhysicsProbe(runtime);
    expect(runtime.backend).toBe("box3d-wasm");
    expect(position.x).toBeGreaterThan(0);
    expect(position.y).toBeCloseTo(0, 5);
    expect(position.z).toBeCloseTo(0, 5);
  });
});
