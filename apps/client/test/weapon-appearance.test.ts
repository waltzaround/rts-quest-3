import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FACTION_IDS, WEAPONS, type FactionId, type ProjectileState, type WeaponTypeId } from "@space-rts/game-core";
import { ProjectileVfx } from "../src/combat-visuals";
import { CombatEffectRenderer } from "../src/batched-renderer";
import { createProjectileGeometry, getWeaponStyle, ProjectileAppearanceRegistry } from "../src/weapon-appearance";

function shot(id = 1, type: WeaponTypeId = "plasma", ownerShipId = 10): ProjectileState {
  return { id, ownerShipId, ownerTeamId: 1, targetEntityId: 20, targetX: 0, targetZ: 150,
    weaponTypeId: type, fixedTrajectory: true, x: 0, z: 20, previousX: 0, previousZ: 10,
    vx: 0, vz: 200, radius: 2, damage: 10, lifetimeTicks: WEAPONS[type].projectileLifetimeTicks - 3 };
}

describe("faction projectile identity", () => {
  it("distinguishes allied ship and building fire, remembers orphaned shots and never guesses a mixed team's hidden source", () => {
    const registry = new ProjectileAppearanceRegistry();
    const players = [{ id: "a", teamId: 1, faction: "brood" }, { id: "b", teamId: 1, faction: "concord" }] as const;
    const ships = [{ id: 10, faction: "brood" }, { id: 11, faction: "concord" }] as const;
    const projectiles = [shot(1), shot(2, "plasma", 11), shot(3, "plasma", 12), shot(4, "plasma", -1)];
    registry.sync(projectiles, ships, [{ id: 12, ownerPlayerId: "b" }], players);
    expect(projectiles.map(p => registry.get(p.id))).toEqual(["brood", "concord", "concord", "industrial"]);
    // Every source disappears, and the network redacts their IDs.
    for (let frame = 0; frame < 4; frame++) {
      registry.sync(projectiles.map(p => ({ ...p, ownerShipId: -1 })), [], [], players);
      expect(registry.get(1)).toBe("brood"); expect(registry.get(2)).toBe("concord");
    }
    registry.sync([], [], [], players);
    expect(registry.get(3)).toBe("concord"); // Impact still has its identity this tick.
    registry.sync([], [], [], players);
    expect(registry.get(3)).toBe("industrial");
    registry.sync([shot(5, "torpedo", -1)], [], [], [players[0]]);
    expect(registry.get(5)).toBe("brood");
    registry.remember(6, "concord"); expect(registry.get(6)).toBe("concord");
    registry.clear(); expect(registry.get(5)).toBe("industrial"); expect(registry.get(6)).toBe("industrial");
  });

  it("uses different head geometry within bounded triangle counts, while retaining weapon altitude", () => {
    for (const type of Object.keys(WEAPONS) as WeaponTypeId[]) {
      const signatures = new Set<string>();
      for (const faction of FACTION_IDS) {
        const geometry = createProjectileGeometry(type, faction);
        const position = geometry.getAttribute("position");
        const triangles = (geometry.index?.count ?? position.count) / 3;
        if (faction !== "industrial") {
          expect(triangles).toBeLessThanOrEqual(80);
          if (type === "autocannon" || type === "pointDefense" || type === "flakCannon") expect(triangles).toBeLessThanOrEqual(12);
        }
        for (const value of position.array) expect(Number.isFinite(value)).toBe(true);
        signatures.add(Array.from(position.array).join(","));
        expect(getWeaponStyle(type, faction).height).toBe(getWeaponStyle(type).height);
        geometry.dispose();
      }
      expect(signatures.size, type).toBe(3);
    }
  });
});

describe("faction projectile batches", () => {
  it("keeps the same flight poses and corrected fighter muzzle for every faction without modifying simulation state", () => {
    for (const type of ["autocannon", "torpedo", "plasma", "heavyRail"] as const) {
      const p = Object.freeze(shot(1, type));
      const poses = FACTION_IDS.map(faction => {
        const vfx = new ProjectileVfx(new THREE.Scene());
        if (type === "autocannon") vfx.registerFighterLaunch(p, new THREE.Vector3(3, 17, 4), 6, 0.25);
        vfx.update([p], 0.25, undefined, new Map([[20, { x: 0, z: 150, radius: 20, isShip: true }]]), undefined, () => faction);
        return vfx.getLastVisualPose(p.id);
      });
      expect(poses[1]).toEqual(poses[0]); expect(poses[2]).toEqual(poses[0]);
      if (type === "autocannon") expect(poses[0]).toMatchObject({ x: 3, y: 17, z: 4 });
      expect(p).toEqual(shot(1, type));
    }
  });

  it("handles the full projectile cap with two trail batches and reuses mixed-faction heads", () => {
    const scene = new THREE.Scene(), vfx = new ProjectileVfx(scene);
    const projectiles = Array.from({ length: 8_300 }, (_, i) => shot(i, i % 2 ? "autocannon" : "plasma"));
    const faction = (id: number): FactionId => FACTION_IDS[id % 3]!;
    vfx.update(projectiles, 0.5, 8_192, undefined, undefined, faction);
    const heads = scene.children.filter((m): m is THREE.InstancedMesh => m instanceof THREE.InstancedMesh);
    const trails = scene.children.filter((m): m is THREE.Mesh => m instanceof THREE.Mesh && !(m instanceof THREE.InstancedMesh));
    expect(heads.length).toBe(6);
    expect(heads.reduce((sum, head) => sum + head.count, 0)).toBe(8_192);
    expect(vfx.renderedCount).toBe(8_192); expect(trails.length).toBe(2);
    for (const trail of trails) {
      expect(trail.geometry.drawRange.count).toBe(8_192 * 6);
      const effects = trail.geometry.getAttribute("weaponEffect");
      expect([effects.getX(0), effects.getX(6), effects.getX(12)]).toEqual([0, 1, 2]);
      const p = trail.geometry.getAttribute("position");
      for (const index of [0, 6, 12, 8_192 * 6 - 1]) expect(Number.isFinite(p.getX(index) + p.getY(index) + p.getZ(index))).toBe(true);
      expect(trail.frustumCulled).toBe(false);
    }
    const objectCount = scene.children.length;
    vfx.update(projectiles, 0.75, 500, undefined, undefined, faction);
    expect(scene.children.length).toBe(objectCount);
    expect(heads.reduce((sum, head) => sum + head.count, 0)).toBe(500);
    vfx.update([], 1);
    expect(heads.every(head => head.count === 0)).toBe(true);
    expect(trails.every(trail => trail.geometry.drawRange.count === 0)).toBe(true);
    expect(vfx.getLastVisualPose(1)).toBeUndefined();
  });

  it("bounds faction bursts and beams, and expires every effect", () => {
    const scene = new THREE.Scene(), effects = new CombatEffectRenderer(scene);
    effects.setQuality("high");
    for (let i = 0; i < 1_000; i++) {
      const faction = FACTION_IDS[1 + i % 2]!;
      const color = getWeaponStyle("torpedo", faction).color;
      effects.spawnProjectileDetonation(i, 7, 0, color, 7.2, 100, faction);
      effects.spawnBeam(i, 5, 0, i, 5, 100, color, 0.5, 100, faction);
    }
    effects.update(130, new THREE.PerspectiveCamera());
    expect(effects.beams.activeCount).toBe(384);
    const [active, capacity] = effects.poolUsage.split(" / ").map(Number);
    expect(active).toBeGreaterThan(0); expect(active).toBeLessThanOrEqual(capacity!);
    // Two additional shared meshes at most, regardless of the number of hits.
    expect(scene.children.length).toBe(10);
    const beams = scene.children.filter((m): m is THREE.Mesh => m instanceof THREE.Mesh && m.geometry.hasAttribute("weaponEffect"));
    expect(beams).toHaveLength(2);
    expect(beams.every(beam => beam.geometry.drawRange.count === 384 * 6)).toBe(true);
    effects.update(2_000);
    expect(effects.activeCount).toBe(0);
    expect(beams.every(beam => beam.geometry.drawRange.count === 0)).toBe(true);
  });
});
