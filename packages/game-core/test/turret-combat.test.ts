import { describe, expect, it } from "vitest";
import {
  SHIPS, WEAPONS, createCombatScenario as createScenario, getTurretMuzzleWorldPosition,
  getTurretWorldPosition, isPointInTurretArc, type ScenarioOptions,
} from "../src";

const createCombatScenario = (options: ScenarioOptions = {}) => createScenario({ ...options, startingFleet: true });

describe("moving multi-turret combat", () => {
  it("defines clearly different single-shot, pulse, and burst cadences", () => {
    expect(WEAPONS.autocannon).toMatchObject({ delivery: "projectile", burstSize: 4, burstIntervalTicks: 2 });
    expect(WEAPONS.pointDefense).toMatchObject({ delivery: "projectile", burstSize: 6, burstIntervalTicks: 1 });
    expect(WEAPONS.plasma).toMatchObject({ delivery: "projectile", burstSize: 2, burstIntervalTicks: 5 });
    expect(WEAPONS.torpedo).toMatchObject({ delivery: "projectile", burstSize: 2, burstIntervalTicks: 4 });
    expect(WEAPONS.heavyRail.burstSize).toBe(1);
    expect(WEAPONS.beam.delivery).toBe("beam");
  });

  it("fires autocannons in deterministic four-round bursts", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const fighter = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter")!;
    const target = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    simulation.state.obstacles = [];
    simulation.state.ships = [fighter];
    fighter.x = target.x;
    fighter.z = target.z - 170;
    fighter.yaw = 0;
    fighter.orders = [{ type: "hold", destination: { x: fighter.x, z: fighter.z }, facing: 0 }];
    fighter.focusTargetEntityId = target.id;
    fighter.turrets[0]!.cooldownRemaining = 0;
    const fireTicks: number[] = [];
    for (let tick = 0; tick < 70; tick += 1) {
      const snapshot = simulation.step();
      for (const event of snapshot.events) {
        if (event.type === "weaponFired" && event.turretId === fighter.turrets[0]!.id) fireTicks.push(event.tick);
      }
    }
    const intervals = fireTicks.slice(1).map((tick, index) => tick - fireTicks[index]!);
    expect(intervals.slice(0, 4)).toEqual([2, 2, 2, 16]);
  });

  it("resolves beam weapons immediately without creating projectile entities", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const ship = simulation.state.ships.find((candidate) => candidate.ownerPlayerId === "pilot-blue" && candidate.class === "destroyer")!;
    const target = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    const turret = ship.turrets[0]!;
    simulation.state.obstacles = [];
    simulation.state.ships = [ship];
    ship.x = target.x;
    ship.z = target.z - 220;
    ship.yaw = 0;
    ship.orders = [{ type: "hold", destination: { x: ship.x, z: ship.z }, facing: 0 }];
    ship.focusTargetEntityId = target.id;
    ship.turrets = [turret];
    turret.weaponTypeId = "beam";
    turret.currentYaw = 0;
    turret.yawCenter = 0;
    turret.yawHalfArc = Math.PI;
    turret.cooldownRemaining = 0;
    const shieldBefore = target.shields;
    const snapshot = simulation.step();
    const fired = snapshot.events.find((event) => event.type === "weaponFired" && event.turretId === turret.id);
    expect(fired?.type).toBe("weaponFired");
    if (!fired || fired.type !== "weaponFired") throw new Error("Beam did not fire");
    expect(snapshot.events).toContainEqual({
      type: "hit", tick: snapshot.tick, projectileId: fired.projectileId, targetId: target.id, damage: WEAPONS.beam.damage,
    });
    expect(simulation.state.projectiles.some((projectile) => projectile.id === fired.projectileId)).toBe(false);
    expect(target.shields).toBe(shieldBefore - WEAPONS.beam.damage);
  });

  it("keeps fighter squadrons faster than bombers", () => {
    expect(SHIPS.fighter.radius).toBeGreaterThan(SHIPS.bomber.radius);
    expect(SHIPS.bomber.radius).toBe(6);
    expect(SHIPS.fighter.speed).toBeGreaterThan(SHIPS.bomber.speed);
    expect(SHIPS.fighter.speed).toBeGreaterThanOrEqual(50);
  });

  it("spawns projectiles at alternating barrel muzzles instead of the hardpoint origin", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const fighter = simulation.state.ships.find((ship) => ship.ownerPlayerId === "pilot-blue" && ship.class === "fighter")!;
    const target = simulation.state.structures.find(
      (structure) => structure.ownerPlayerId === "pilot-red" && structure.type === "commandCore",
    )!;
    simulation.state.obstacles = [];
    simulation.state.ships = [fighter];
    fighter.x = target.x;
    fighter.z = target.z - 170;
    fighter.yaw = 0;
    fighter.orders = [{ type: "hold", destination: { x: fighter.x, z: fighter.z }, facing: 0 }];
    fighter.focusTargetEntityId = target.id;
    const turret = fighter.turrets[1]!;
    turret.cooldownRemaining = 0;
    const hardpoint = getTurretWorldPosition(fighter, turret);
    const firingTick = simulation.state.tick + 1;
    const expectedMuzzle = getTurretMuzzleWorldPosition(fighter, turret, 0, firingTick);
    const alternateMuzzle = getTurretMuzzleWorldPosition(fighter, turret, 1, firingTick);
    expect(alternateMuzzle.x).not.toBeCloseTo(expectedMuzzle.x, 6);
    const snapshot = simulation.step();
    const fired = snapshot.events.find((event) => event.type === "weaponFired" && event.turretId === turret.id);
    expect(fired?.type).toBe("weaponFired");
    if (!fired || fired.type !== "weaponFired") throw new Error("Autocannon did not fire");
    const projectile = simulation.state.projectiles.find((candidate) => candidate.id === fired.projectileId)!;
    expect(projectile.previousX).toBeCloseTo(expectedMuzzle.x, 6);
    expect(projectile.previousZ).toBeCloseTo(expectedMuzzle.z, 6);
    expect(Math.hypot(projectile.previousX - hardpoint.x, projectile.previousZ - hardpoint.z)).toBeGreaterThan(2);
  });

  it("lets bombers launch torpedoes during a live engagement", () => {
    const simulation = createCombatScenario({ enemyCommander: false });
    const bomberIds = new Set(simulation.state.ships.filter(
      (ship) => ship.teamId === 1 && ship.class === "bomber",
    ).map((ship) => ship.id));
    let torpedoShots = 0;
    let firstLaunchDistance: number | null = null;
    for (let tick = 0; tick < 180; tick += 1) {
      const snapshot = simulation.step();
      torpedoShots += snapshot.events.filter((event) => {
        if (event.type !== "weaponFired" || !bomberIds.has(event.shipId)) return false;
        const projectile = simulation.state.projectiles.find(
          (projectile) => projectile.id === event.projectileId && projectile.weaponTypeId === "torpedo",
        );
        if (projectile && firstLaunchDistance === null) {
          firstLaunchDistance = Math.hypot(projectile.x - projectile.previousX, projectile.z - projectile.previousZ);
        }
        return Boolean(projectile);
      }).length;
    }
    expect(torpedoShots).toBeGreaterThan(0);
    expect(firstLaunchDistance).not.toBeNull();
    expect(firstLaunchDistance!).toBeLessThan(WEAPONS.torpedo.projectileSpeed * 0.05 * 0.2);
  });

  it("keeps capital ships moving while their weapons fire", () => {
    const simulation = createCombatScenario();
    const destroyer = simulation.state.ships.find((ship) => ship.class === "destroyer")!;
    const startingZ = destroyer.z;
    let destroyerShots = 0;
    for (let tick = 0; tick < 220; tick += 1) {
      const snapshot = simulation.step();
      destroyerShots += snapshot.events.filter(
        (event) => event.type === "weaponFired" && event.shipId === destroyer.id,
      ).length;
    }
    const liveDestroyer = simulation.state.ships.find((ship) => ship.id === destroyer.id);
    expect(liveDestroyer).toBeDefined();
    expect(Math.abs(liveDestroyer!.z - startingZ)).toBeGreaterThan(50);
    expect(Math.hypot(liveDestroyer!.vx, liveDestroyer!.vz)).toBeGreaterThan(0);
    expect(destroyerShots).toBeGreaterThan(2);
  });

  it("allows turrets on one ship to independently track multiple enemies", () => {
    const simulation = createCombatScenario({ fightersPerTeam: 8 });
    let maximumDistinctTargets = 0;
    for (let tick = 0; tick < 260; tick += 1) {
      simulation.step();
      for (const ship of simulation.state.ships.filter((candidate) => candidate.class === "destroyer")) {
        const targets = new Set(ship.turrets.map((turret) => turret.targetEntityId).filter((id) => id !== null));
        maximumDistinctTargets = Math.max(maximumDistinctTargets, targets.size);
      }
    }
    expect(maximumDistinctTargets).toBeGreaterThanOrEqual(3);
  });

  it("makes point defence prefer fighters over larger ships", () => {
    const simulation = createCombatScenario({ fightersPerTeam: 8 });
    let pointDefenseTargets = 0;
    let fighterTargets = 0;
    for (let tick = 0; tick < 140; tick += 1) {
      simulation.step();
      const byId = new Map(simulation.state.ships.map((ship) => [ship.id, ship]));
      for (const ship of simulation.state.ships) {
        for (const turret of ship.turrets.filter((candidate) => candidate.weaponTypeId === "pointDefense")) {
          if (turret.targetEntityId === null) continue;
          pointDefenseTargets += 1;
          if (byId.get(turret.targetEntityId)?.class === "fighter") fighterTargets += 1;
        }
      }
    }
    expect(pointDefenseTargets).toBeGreaterThan(0);
    expect(fighterTargets / pointDefenseTargets).toBeGreaterThan(0.9);
  });

  it("respects local firing arcs as the hull rotates in world space", () => {
    const simulation = createCombatScenario();
    const destroyer = simulation.state.ships.find((ship) => ship.class === "destroyer")!;
    const rightPlasma = destroyer.turrets.find((turret) => turret.yawCenter > 1 && turret.weaponTypeId === "plasma")!;
    expect(isPointInTurretArc(destroyer, rightPlasma, destroyer.x + 100, destroyer.z)).toBe(true);
    expect(isPointInTurretArc(destroyer, rightPlasma, destroyer.x - 100, destroyer.z)).toBe(false);
    destroyer.yaw = Math.PI;
    expect(isPointInTurretArc(destroyer, rightPlasma, destroyer.x - 100, destroyer.z)).toBe(true);
  });

  it("staggers deterministic turret fire sequences", () => {
    const simulation = createCombatScenario();
    const firstFireTickByTurret = new Map<number, number>();
    for (let tick = 0; tick < 180; tick += 1) {
      const snapshot = simulation.step();
      for (const event of snapshot.events) {
        if (event.type === "weaponFired" && !firstFireTickByTurret.has(event.turretId)) {
          firstFireTickByTurret.set(event.turretId, event.tick);
        }
      }
    }
    expect(new Set(firstFireTickByTurret.values()).size).toBeGreaterThan(4);
  });
});
