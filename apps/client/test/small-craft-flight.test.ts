import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createCombatScenario, type ShipState } from "@space-rts/game-core";
import { SmallCraftFlight } from "../src/small-craft-flight";
import { fighterMemberMatrix } from "../src/fighter-visuals";
import { FighterWakes } from "../src/fighter-wakes";

function fighter(id = 1): ShipState {
  const base = createCombatScenario({ enemyCommander: false, startingFleet: true }).state.ships.find(s => s.class === "fighter")!;
  return { ...base, id, x: 0, y: 0, z: 0, vx: 72, vz: 0, yaw: Math.PI / 2 };
}

describe("render-only small-craft flight", () => {
  it("starts a smooth capital pass early, clears the hull, and leaves gameplay positions untouched", () => {
    const ship = fighter();
    const capital = { ...ship, id: 2, class: "battleship" as const, vx: 0 };
    const field = new SmallCraftFlight();
    const sourceBefore = JSON.stringify([ship, capital]);
    let lastAltitude = 0;
    for (let frame = 0; frame <= 360; frame++) {
      const x = -216 + frame * 1.2;
      field.beginFrame([ship, capital]);
      const pose = field.sample(ship, x, 0, 0, 0, frame / 60, frame === 0);
      expect(Math.abs(pose.altitude - lastAltitude)).toBeLessThan(3);
      if (Math.abs(x) < 26) expect(Math.abs(pose.altitude)).toBeGreaterThan(45);
      if (x === -96) expect(Math.abs(pose.altitude)).toBeGreaterThan(15);
      expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(0.34);
      lastAltitude = pose.altitude;
      field.endFrame();
    }
    expect(JSON.stringify([ship, capital])).toBe(sourceBefore);
    expect(Math.abs(lastAltitude)).toBeLessThan(0.1);
  });

  it("freezes while paused and discards interpolation history after a rewind or reveal", () => {
    const ship = fighter(), field = new SmallCraftFlight();
    const capital = { ...ship, id: 2, class: "carrier" as const, vx: 0 };
    field.beginFrame([ship, capital]);
    const start = { ...field.sample(ship, 0, 0, 0, 1, 5, true) };
    const paused = { ...field.sample(ship, 0, 0, 0, 0, 5, false) };
    expect(paused).toEqual(start);
    expect(field.sample(ship, 400, 0, 0, 0, 1, false).altitude).toBe(0);
    expect(field.sample(ship, 0, 0, 0, 0, 1, true).altitude).not.toBe(0);
    field.endFrame();
    field.clear();
    field.beginFrame([ship]);
    expect(field.sample(ship, 0, 0, 0, 0, 2, false).altitude).toBe(0);
  });

  it("bounds proximity work even when thousands of squadrons overlap", () => {
    const base = fighter();
    const ships = Array.from({ length: 4_096 }, (_, i) => ({ ...base, id: i + 1, teamId: i % 2 + 1 }));
    const field = new SmallCraftFlight();
    field.beginFrame(ships);
    for (const ship of ships) field.sample(ship, 0, 0, 0, 0, 0, true);
    expect(field.neighborChecks).toBeLessThanOrEqual(ships.length * 96);
    field.endFrame();
  });

  it("points each craft along its continuous flight path at every phase", () => {
    const current = new THREE.Matrix4(), next = new THREE.Matrix4();
    const nose = new THREE.Vector3(), velocity = new THREE.Vector3();
    const dt = 1 / 1_000;
    for (let member = 0; member < 5; member++) for (let t = 0; t < 12; t += 0.3) {
      fighterMemberMatrix(current, 41, member, t * 20, 0, 0, t * 72, 0, 0, 72, 1);
      fighterMemberMatrix(next, 41, member, (t + dt) * 20, 0, 0, (t + dt) * 72, 0, 0, 72, 1);
      nose.setFromMatrixColumn(current, 2).normalize();
      velocity.setFromMatrixPosition(next).sub(new THREE.Vector3().setFromMatrixPosition(current)).normalize();
      expect(nose.dot(velocity)).toBeGreaterThan(0.999);
    }
  });

  it("caps wake geometry and drops trails on low quality, disappearing contacts, and timeline seeks", () => {
    const wakes = new FighterWakes(), matrix = new THREE.Matrix4(), color = new THREE.Color(0x55ccff);
    for (let frame = 0; frame < 10; frame++) {
      wakes.beginFrame(frame, "medium");
      for (let craft = 0; craft < 2_000; craft++) {
        matrix.makeTranslation(craft, 0, frame * 3);
        wakes.write(craft, 0, matrix, color, false);
      }
      wakes.endFrame();
    }
    expect(wakes.mesh.geometry.drawRange.count).toBe(640 * 6 * 2);
    wakes.beginFrame(9, "medium");
    wakes.endFrame();
    expect(wakes.mesh.visible).toBe(false);
    wakes.beginFrame(1, "high");
    wakes.write(1, 0, matrix, color, false);
    wakes.endFrame();
    expect(wakes.mesh.geometry.drawRange.count).toBe(2);
    wakes.beginFrame(2, "low");
    wakes.write(1, 0, matrix, color, false);
    wakes.endFrame();
    expect(wakes.mesh.geometry.drawRange.count).toBe(0);
  });
});
