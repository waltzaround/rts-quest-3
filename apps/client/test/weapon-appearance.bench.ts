import * as THREE from "three";
import { bench, describe } from "vitest";
import { FACTION_IDS, WEAPONS, type FactionId, type ProjectileState, type WeaponTypeId } from "@space-rts/game-core";
import { ProjectileVfx } from "../src/combat-visuals";

// Measures CPU preparation/upload marking, not GPU or whole-game frame time.
const mix: WeaponTypeId[] = ["autocannon", "autocannon", "pointDefense", "flakCannon", "plasma", "torpedo", "heavyRail", "siegeArtillery"];
describe("projectile preparation at the render cap", () => {
  for (const faction of [...FACTION_IDS, "mixed"] as const) {
    const projectiles: ProjectileState[] = Array.from({ length: 8_192 }, (_, id) => {
      const type = mix[id % mix.length]!;
      return { id, ownerShipId: 1, ownerTeamId: 1, targetEntityId: 2, weaponTypeId: type,
        targetX: 0, targetZ: 240, fixedTrajectory: true, x: id % 80, z: 60, previousX: id % 80, previousZ: 50,
        vx: 0, vz: 200, radius: 2, damage: 10, lifetimeTicks: WEAPONS[type].projectileLifetimeTicks - 12 };
    });
    const vfx = new ProjectileVfx(new THREE.Scene());
    const resolve = (id: number): FactionId => faction === "mixed" ? FACTION_IDS[id % 3]! : faction;
    vfx.update(projectiles, 0.5, 8_192, undefined, undefined, resolve);
    bench(faction, () => vfx.update(projectiles, 0.5, 8_192, undefined, undefined, resolve), { time: 300, warmupTime: 100 });
  }
});
