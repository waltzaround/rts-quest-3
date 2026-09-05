import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { WEAPONS, createCombatScenario, getTurretMuzzleWorldPosition, type ProjectileState } from "@space-rts/game-core";
import { BatchedShipRenderer, createThrusterTrailGeometry } from "../src/batched-renderer";
import { ProjectileVfx } from "../src/combat-visuals";
import { FIGHTER_GUN_HEIGHT, FIGHTER_GUN_Z, fighterMemberCount, inferFighterFiringMember } from "../src/fighter-visuals";
import { getShipHullGeometries, getShipMediumGeometry, getShipSilhouetteGeometry } from "../src/ship-hulls";
import { SHIP_THRUSTERS } from "../src/ship-layout";
import { InterpolatedRenderState, MAX_RENDER_SHIPS, RenderStateBuilder, SHIP_CLASSES, VisualLod } from "../src/render-state";

const scene = new THREE.Scene();
const renderer = new BatchedShipRenderer(scene);
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, 10_000);
camera.position.set(0, 100, 150);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const state = new InterpolatedRenderState();
function prepare(count: number, lod: VisualLod, health = 1): void {
  state.shipCount = count;
  state.shipClass.fill(0);
  state.shipLod.fill(lod);
  state.shipHealth.fill(health);
  state.shipEngine.fill(1);
  state.shipColor.fill(0x55b8ff);
  state.shipYaw.fill(0.9);
  state.shipBank.fill(0.45);
  state.shipPitch.fill(0.2);
  state.shipSpeed.fill(72);
  state.shipEngagement.fill(1);
  for (let i = 0; i < count; i++) {
    state.shipIds[i] = i + 1;
    state.shipPosition.set([i * 50, 18, 20], i * 3);
  }
  renderer.update(state, 1_000, camera, 720, 1, 25.5, false);
}
function batchFor(geometry: THREE.BufferGeometry): THREE.InstancedMesh {
  return renderer.group.children.find(child => child instanceof THREE.InstancedMesh
    && child.geometry === geometry && child.count > 0) as THREE.InstancedMesh;
}

describe("fighter squad rendering", () => {
  it("keeps every living craft at every 3D LOD and at capacity, simplifying geometry in large fleets", () => {
    for (const lod of [VisualLod.Close, VisualLod.Medium, VisualLod.Far]) {
      for (const count of [1, 500, 2_000, MAX_RENDER_SHIPS]) {
        prepare(count, lod);
        const geometry = lod === VisualLod.Far || (count > 768 && lod <= VisualLod.Medium)
          ? getShipSilhouetteGeometry("fighter") : lod === VisualLod.Close
            ? getShipHullGeometries("fighter").hull : getShipMediumGeometry("fighter", "hull");
        expect(batchFor(geometry).count, `${count} squads, LOD ${lod}`).toBe(count * 5);
        if (lod <= VisualLod.Medium) expect(renderer.metrics.thrusterInstances).toBe(count * 5 * SHIP_THRUSTERS.fighter.offsets.length);
      }
    }
    prepare(1, VisualLod.Medium, 0.4);
    expect(batchFor(getShipMediumGeometry("fighter", "hull")).count).toBe(2);
    expect(fighterMemberCount(Math.fround(0.2))).toBe(1);
    expect(fighterMemberCount(0)).toBe(0);
  });

  it("places each muzzle on its rendered banked craft, including independently moving wingmen", () => {
    prepare(1, VisualLod.Close);
    const hull = batchFor(getShipHullGeometries("fighter").hull);
    const matrix = new THREE.Matrix4();
    const muzzle = new THREE.Vector3();
    for (let member = 0; member < 5; member++) {
      expect(renderer.getFighterMuzzle(1, member, member, muzzle)).toBe(true);
      hull.getMatrixAt(member, matrix);
      muzzle.applyMatrix4(matrix.invert());
      expect(muzzle.z).toBeCloseTo(FIGHTER_GUN_Z, 4);
      expect(muzzle.y).toBeCloseTo(FIGHTER_GUN_HEIGHT, 4);
      expect(Math.abs(muzzle.x)).toBeLessThan(0.1);
    }
    prepare(1, VisualLod.Tactical);
    expect(renderer.getFighterMuzzle(1, 0, 0, muzzle)).toBe(false);
  });

  it("does not append separate squad turrets at unanimated formation offsets", () => {
    const sim = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const fighter = sim.state.ships.find(ship => ship.class === "fighter")!;
    fighter.x = 0; fighter.z = 0;
    const render = new RenderStateBuilder().update({ players: sim.state.players, ships: [fighter] },
      new Map(), 1, camera, 720, camera.position.length(), new Set(), "high", 1_000);
    expect(render.shipCount).toBe(1);
    expect(render.turretCount).toBe(0);
  });

  it("launches a tracer exactly from the visible gun and releases the correction on its flight path", () => {
    prepare(1, VisualLod.Close);
    const muzzle = new THREE.Vector3();
    renderer.getFighterMuzzle(1, 4, 0, muzzle);
    const effects = new ProjectileVfx(new THREE.Scene());
    const p: ProjectileState = { id: 40, ownerShipId: 1, ownerTeamId: 1, targetEntityId: 2,
      weaponTypeId: "autocannon", targetX: 0, targetZ: 180, fixedTrajectory: true,
      x: 0, z: 12, previousX: 0, previousZ: 0, vx: 0, vz: 240, radius: 2, damage: 1,
      lifetimeTicks: WEAPONS.autocannon.projectileLifetimeTicks - 1 };
    effects.registerFighterLaunch(p, muzzle, 8, 0.25);
    effects.update([p], 0.25);
    const launch = effects.getLastVisualPose(p.id)!;
    expect(launch.x).toBeCloseTo(muzzle.x);
    expect(launch.y).toBeCloseTo(muzzle.y);
    expect(launch.z).toBeCloseTo(muzzle.z);
    p.lifetimeTicks -= 16; p.previousZ += 192; p.z += 192;
    effects.update([p], 0.25);
    const end = effects.getLastVisualPose(p.id)!;
    expect(end.x).toBe(0);
    expect(end.y).toBe(8);
    effects.clearHistory();
    expect(effects.getLastVisualPose(p.id)).toBeUndefined();
  });

  it("recovers the craft for snapshot burst rounds without a turret ID", () => {
    const sim = createCombatScenario({ enemyCommander: false, startingFleet: true });
    const fighter = sim.state.ships.find(ship => ship.class === "fighter")!;
    fighter.x = 100; fighter.z = 30; fighter.vx = 10; fighter.vz = 20;
    const age = 3, seconds = age * 0.05, tick = 100;
    for (let member = 0; member < fighter.turrets.length; member++) {
      const origin = getTurretMuzzleWorldPosition({ ...fighter,
        x: fighter.x - fighter.vx * seconds, z: fighter.z - fighter.vz * seconds }, fighter.turrets[member]!, 0, tick - age);
      const projectile = { x: origin.x + 180 * seconds, z: origin.z + 160 * seconds,
        vx: 180, vz: 160, weaponTypeId: "autocannon", lifetimeTicks: WEAPONS.autocannon.projectileLifetimeTicks - age } as ProjectileState;
      expect(inferFighterFiringMember(fighter, projectile, tick)).toBe(member);
    }
  });

  it("keeps low-detail exhaust on all six carrier nozzles, with none in the open center", () => {
    prepare(1, VisualLod.Medium);
    state.shipClass[0] = SHIP_CLASSES.indexOf("carrier");
    state.shipPosition.fill(0); state.shipBank.fill(0); state.shipYaw.fill(0); state.shipPitch.fill(0);
    renderer.setQuality("low");
    renderer.update(state, 1_000, camera, 720, 1, 25.5, false);
    const exhaust = renderer.group.children.find(child => child instanceof THREE.InstancedMesh
      && (child.material as THREE.Material).customProgramCacheKey() === "soft-nozzle-plume-v2") as THREE.InstancedMesh;
    expect(exhaust.count).toBe(6);
    const matrix = new THREE.Matrix4();
    SHIP_THRUSTERS.carrier.offsets.forEach((offset, i) => {
      exhaust.getMatrixAt(i, matrix);
      expect(matrix.elements[12]).toBe(offset);
      expect(matrix.elements[13]).toBe(SHIP_THRUSTERS.carrier.y);
    });
    renderer.setQuality("medium");
  });

  it("uses four softly shaded triangles per exhaust nozzle", () => {
    const geometry = createThrusterTrailGeometry();
    expect(geometry.getIndex()!.count / 3).toBe(4);
    geometry.dispose();
  });
});
