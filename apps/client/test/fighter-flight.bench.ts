import * as THREE from "three";
import { bench, describe } from "vitest";
import { SmallCraftFlight } from "../src/small-craft-flight";
import { fighterMemberMatrix } from "../src/fighter-visuals";
import { FighterWakes } from "../src/fighter-wakes";
import { createCombatScenario } from "@space-rts/game-core";

const base = createCombatScenario({ enemyCommander: false, startingFleet: true }).state.ships.find(s => s.class === "fighter")!;
const matrix = new THREE.Matrix4();
const color = new THREE.Color(0x55ccff);

describe("fighter flight CPU work (no simulation or GPU)", () => {
  for (const count of [400, 2_000, 4_096]) {
    const ships = Array.from({ length: count }, (_, i) => ({ ...base, id: i + 1,
      class: i % 20 === 0 ? "battleship" as const : "fighter" as const,
      teamId: i % 2 + 1, x: (i % 40) * 20, y: 0, z: Math.floor(i / 40) * 20, vx: 60, vz: 10 }));
    const field = new SmallCraftFlight(), wakes = new FighterWakes();
    let tick = 0;
    bench(`${count} ships: proximity + five flight poses + capped wakes`, () => {
      tick += 1 / 3;
      field.beginFrame(ships);
      wakes.beginFrame(tick, "medium");
      for (const ship of ships) {
        if (ship.class !== "fighter") continue;
        const pose = field.sample(ship, ship.x, 0, ship.z, 0.3, tick * 0.05, false);
        for (let member = 0; member < 5; member++) {
          fighterMemberMatrix(matrix, ship.id, member, tick, ship.x, pose.altitude, ship.z,
            ship.yaw, pose.bank, 60, pose.engagement, pose.pitch);
          wakes.write(ship.id, member, matrix, color, false);
        }
      }
      wakes.endFrame(); field.endFrame();
    }, { time: 500, warmupTime: 300 });
  }
});
