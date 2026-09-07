import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FACTION_IDS, createCombatScenario, type ShipState } from "@space-rts/game-core";
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

  it("points every faction's craft along its own path through straight flight and tight turns", () => {
    const current = new THREE.Matrix4(), next = new THREE.Matrix4();
    const nose = new THREE.Vector3(), velocity = new THREE.Vector3(), origin = new THREE.Vector3();
    const dt = 1 / 1_000;
    for (const faction of FACTION_IDS) for (const turn of [0, -1.4, 2.6]) {
      const sample = (matrix: THREE.Matrix4, member: number, t: number) => fighterMemberMatrix(matrix,
        41, member, t * 20, turn ? 72 / turn * (1 - Math.cos(t * turn)) : 0, 0,
        turn ? 72 / turn * Math.sin(t * turn) : t * 72, t * turn, -turn * 0.22, 72, 1, 0, faction, turn);
      for (let member = 0; member < 5; member++) for (let t = 0; t < 12; t += 0.3) {
        sample(current, member, t);
        sample(next, member, t + dt);
        nose.setFromMatrixColumn(current, 2).normalize();
        velocity.setFromMatrixPosition(next).sub(origin.setFromMatrixPosition(current)).normalize();
        expect(nose.dot(velocity), `${faction}, craft ${member}, turn ${turn}, time ${t}`).toBeGreaterThan(0.999);
      }
    }
  });

  it("breaks up shared turn axes with climbing and diving wingmen and distinct faction movement", () => {
    const matrix = new THREE.Matrix4(), attitude = new THREE.Euler(0, 0, 0, "YXZ");
    const motion = new Map<string, { pitch: number; roll: number }>();
    for (const faction of FACTION_IDS) {
      let variedFrames = 0, pitch = 0, roll = 0;
      for (let frame = 0; frame < 180; frame++) {
        let climbing = false, diving = false;
        for (let member = 0; member < 5; member++) {
          fighterMemberMatrix(matrix, 41, member, frame / 3, 0, 0, 0, 0, -0.3, 72, 1, 0, faction, 1.4);
          attitude.setFromRotationMatrix(matrix, "YXZ");
          climbing ||= attitude.x < -0.03;
          diving ||= attitude.x > 0.03;
          pitch += Math.abs(attitude.x);
          roll += Math.abs(attitude.z);
          expect(Math.abs(matrix.elements[13]!)).toBeLessThan(38);
        }
        if (climbing && diving) variedFrames++;
      }
      expect(variedFrames, faction).toBeGreaterThan(120);
      motion.set(faction, { pitch, roll });
    }
    expect(motion.get("brood")!.pitch).toBeGreaterThan(motion.get("industrial")!.pitch * 1.3);
    expect(motion.get("industrial")!.roll).toBeGreaterThan(motion.get("concord")!.roll * 1.3);
  });

  it("keeps stopped formations still and samples the same pose after pause or seek", () => {
    const first = new THREE.Matrix4(), later = new THREE.Matrix4();
    for (const faction of FACTION_IDS) for (let member = 0; member < 5; member++) {
      fighterMemberMatrix(first, 41, member, 20, 0, 0, 0, 0, 0, 0, 1, 0, faction);
      fighterMemberMatrix(later, 41, member, 200, 0, 0, 0, 0, 0, 0, 1, 0, faction);
      expect(later.elements).toEqual(first.elements);
      fighterMemberMatrix(first, 41, member, 20, 0, 0, 0, 0, -0.3, 72, 1, 0, faction, 1.4);
      fighterMemberMatrix(later, 41, member, 200, 0, 0, 0, 0, -0.3, 72, 1, 0, faction, 1.4);
      fighterMemberMatrix(later, 41, member, 20, 0, 0, 0, 0, -0.3, 72, 1, 0, faction, 1.4);
      expect(later.elements).toEqual(first.elements);
    }
  });

  it("lets wingmen leave their assigned side in combat while retaining cruising formation", () => {
    const matrix = new THREE.Matrix4();
    for (const faction of FACTION_IDS) {
      let crossedCenter = false;
      for (let frame = 0; frame < 720; frame++) {
        fighterMemberMatrix(matrix, 41, 1, frame / 3, 0, 0, 0, 0, 0, 72, 0, 0, faction);
        expect(matrix.elements[12]!, `${faction} cruising wingman`).toBeLessThan(0);
        fighterMemberMatrix(matrix, 41, 1, frame / 3, 0, 0, 0, 0, 0, 72, 1, 0, faction);
        crossedCenter ||= matrix.elements[12]! > 6;
      }
      expect(crossedCenter, `${faction} combat wingman`).toBe(true);
    }
  });

  it("flies smoothly through combat steering reversals and brief braking without snapping into formation", () => {
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion();
    for (const faction of FACTION_IDS) {
      const ship = fighter(41), field = new SmallCraftFlight();
      ship.faction = faction;
      ship.focusTargetEntityId = 99;
      const positions = Array.from({ length: 5 }, () => new THREE.Vector3());
      const rotations = Array.from({ length: 5 }, () => new THREE.Quaternion());
      for (let frame = 0; frame < 360; frame++) {
        const turn = (Math.floor(frame / 30) % 2 ? -1 : 1) * 2.6;
        const braking = frame >= 180 && frame < 186;
        ship.yaw += turn / 60;
        ship.vx = Math.sin(ship.yaw) * (braking ? 0 : 72);
        ship.vz = Math.cos(ship.yaw) * (braking ? 0 : 72);
        ship.x += ship.vx / 60; ship.z += ship.vz / 60;
        field.beginFrame([ship]);
        const pose = field.sample(ship, ship.x, 0, ship.z, turn, frame / 60, frame === 0);
        for (let member = 0; member < 5; member++) {
          fighterMemberMatrix(matrix, ship.id, member, frame / 3, ship.x, 0, ship.z, ship.yaw,
            pose.bank, pose.speed, pose.engagement, pose.pitch, faction, pose.formationTurnVelocity, pose.formationYaw);
          position.setFromMatrixPosition(matrix); rotation.setFromRotationMatrix(matrix);
          if (frame > 0) {
            expect(position.distanceTo(positions[member]!), `${faction} craft ${member} frame ${frame} position`).toBeLessThan(3);
            expect(rotation.angleTo(rotations[member]!), `${faction} craft ${member} frame ${frame} attitude`).toBeLessThan(0.22);
            if (frame < 180) expect(position.distanceTo(positions[member]!)).toBeGreaterThan(0.25);
          }
          positions[member]!.copy(position); rotations[member]!.copy(rotation);
        }
        field.endFrame();
      }
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
