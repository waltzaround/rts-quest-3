import { describe, expect, it } from "vitest";
import {
  ALL_SHIP_CLASSES,
  DAMAGE_PROFILE_MULTIPLIERS,
  FIGHTER_SQUAD_OFFSETS,
  SHIPS,
  SHIP_ECONOMY,
  STRUCTURES,
  WEAPONS,
  calculateChecksum,
  calculateProfiledDamage,
  createCombatScenario,
  isEntityVisibleToTeam,
  restoreSimulation,
  type ArmorType,
  type DamageProfile,
  type GameSimulation,
  type ProjectileState,
  type ShipState,
  type WeaponTypeId,
} from "../src";

const expectedMultipliers: Readonly<Record<DamageProfile, Readonly<Record<ArmorType | "shields", number>>>> = {
  rapid: { shields: 1, light: 1.3, plated: 0.7, heavy: 0.3, fortified: 0.25 },
  flak: { shields: 0.9, light: 1.6, plated: 0.5, heavy: 0.25, fortified: 0.25 },
  plasma: { shields: 1.3, light: 0.8, plated: 1.25, heavy: 0.8, fortified: 0.6 },
  ordnance: { shields: 0.65, light: 0.45, plated: 0.95, heavy: 1.6, fortified: 1.25 },
  penetrating: { shields: 1, light: 0.4, plated: 0.95, heavy: 1.25, fortified: 1.45 },
  siege: { shields: 0.7, light: 0.3, plated: 0.8, heavy: 1.05, fortified: 1.6 },
};

function cycleDps(weaponTypeId: WeaponTypeId): number {
  const weapon = WEAPONS[weaponTypeId];
  const cycleTicks = weapon.cooldownTicks + (weapon.burstSize - 1) * weapon.burstIntervalTicks;
  return weapon.damage * weapon.burstSize * 20 / cycleTicks;
}

function shipDps(shipClass: keyof typeof SHIPS, armorType: ArmorType): number {
  return SHIPS[shipClass].hardpoints.reduce((total, hardpoint) => {
    const weapon = WEAPONS[hardpoint.weaponTypeId];
    return total + cycleDps(hardpoint.weaponTypeId) * DAMAGE_PROFILE_MULTIPLIERS[weapon.damageProfile][armorType];
  }, 0);
}

function productionDps(shipClass: keyof typeof SHIPS, armorType: ArmorType): number {
  return shipDps(shipClass, armorType) * SHIP_ECONOMY[shipClass].batchSize;
}

function productionCost(shipClass: keyof typeof SHIPS): number {
  const economy = SHIP_ECONOMY[shipClass];
  return economy.alloyCost + economy.energyCost;
}

function refitAsArtillery(simulation: GameSimulation): ShipState {
  const ship = simulation.state.ships.find(
    (candidate) => candidate.teamId === 1 && candidate.class === "destroyer",
  )!;
  const definition = SHIPS.artilleryDestroyer;
  ship.class = "artilleryDestroyer";
  ship.health = definition.maxHealth;
  ship.shields = definition.maxShield;
  ship.lastCombatTick = -1_000;
  ship.artilleryDeploymentTicks = 0;
  ship.revealedUntilTick = 0;
  ship.turrets = definition.hardpoints.map((hardpoint) => ({
    id: simulation.state.nextTurretId++, parentShipId: ship.id,
    weaponTypeId: hardpoint.weaponTypeId,
    localX: hardpoint.localX, localZ: hardpoint.localZ,
    yawCenter: hardpoint.yawCenter, yawHalfArc: hardpoint.yawHalfArc,
    currentYaw: 0, targetEntityId: null, cooldownRemaining: 0, fireSequence: 0,
  }));
  return ship;
}

function prepareArtilleryEngagement(): {
  simulation: GameSimulation;
  artillery: ShipState;
  scout: ShipState;
  target: ShipState;
} {
  const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false, fightersPerTeam: 2 });
  simulation.state.obstacles = [];
  const artillery = refitAsArtillery(simulation);
  const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
  const target = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
  simulation.state.ships = [artillery, scout, target];
  artillery.x = 0; artillery.z = 0; artillery.yaw = 0; artillery.vx = 0; artillery.vz = 0;
  artillery.orders = [{ type: "hold", destination: { x: 0, z: 0 }, facing: 0 }];
  scout.x = 0; scout.z = 350; scout.orders = [];
  target.x = 0; target.z = 400; target.vx = 0; target.vz = 0; target.orders = [];
  for (const structure of simulation.state.structures) {
    structure.x += structure.teamId === 1 ? -8_000 : 8_000;
    structure.z += structure.teamId === 1 ? -8_000 : 8_000;
  }
  return { simulation, artillery, scout, target };
}

describe("central damage and armor profiles", () => {
  it("defines every requested shield and armor multiplier", () => {
    expect(DAMAGE_PROFILE_MULTIPLIERS).toEqual(expectedMultipliers);
    expect(new Set(ALL_SHIP_CLASSES.map((shipClass) => SHIPS[shipClass].armorType))).toEqual(
      new Set(["light", "plated", "heavy"]),
    );
    expect(Object.values(STRUCTURES).every((structure) => structure.armorType === "fortified")).toBe(true);
  });

  it("converts shield overflow back to raw damage before applying armor", () => {
    const overflow = calculateProfiledDamage("plasma", 100, 65, "plated");
    expect(overflow).toEqual({ rawDamage: 100, shieldDamage: 65, hullDamage: 62.5 });
    expect(calculateProfiledDamage("torpedo", 100, 1_000, "heavy")).toEqual({
      rawDamage: 100, shieldDamage: 65, hullDamage: 0,
    });
  });

  it("records actual shield and hull damage in deterministic hit events", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    simulation.state.obstacles = [];
    const attacker = simulation.state.ships.find((ship) => ship.teamId === 1)!;
    const target = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    simulation.state.ships = [attacker, target];
    attacker.turrets = [];
    target.turrets = [];
    attacker.x = 0; attacker.z = 0;
    target.x = 0; target.z = 5;
    target.shields = 10;
    const projectile: ProjectileState = {
      id: simulation.state.nextEntityId++, ownerShipId: attacker.id, ownerTeamId: attacker.teamId,
      weaponTypeId: "plasma", targetEntityId: target.id,
      targetX: target.x, targetZ: target.z, fixedTrajectory: false,
      x: target.x, z: target.z, previousX: target.x, previousZ: target.z,
      vx: 0, vz: 0, radius: 3, damage: 100, lifetimeTicks: 2,
    };
    simulation.state.projectiles = [projectile];
    const hit = simulation.step().events.find((event) => event.type === "hit");
    expect(hit).toEqual(expect.objectContaining({
      type: "hit", rawDamage: 100, shieldDamage: 10,
      hullDamage: (100 - 10 / WEAPONS.plasma.shieldMultiplier)
        * DAMAGE_PROFILE_MULTIPLIERS.plasma[SHIPS[target.class].armorType],
    }));
  });
});

describe("fighter wing presentation and first-pass lethality", () => {
  it("preserves five squad entities with five visible and firing members each", () => {
    expect(SHIP_ECONOMY.fighter).toMatchObject({ batchSize: 5, alloyCost: 380, energyCost: 200, buildTicks: 180 });
    expect(FIGHTER_SQUAD_OFFSETS).toHaveLength(5);
    expect(SHIPS.fighter.hardpoints).toHaveLength(5);
    expect(SHIPS.fighter.maxHealth).toBe(700);
  });

  it("reduces per-shot damage while preserving cadence and requested complete-wing DPS", () => {
    expect(WEAPONS.autocannon).toMatchObject({ damage: 1, cooldownTicks: 16, burstSize: 4, burstIntervalTicks: 2 });
    const completeWingRawDps = cycleDps("autocannon") * 25;
    expect(completeWingRawDps).toBeCloseTo(90.91, 1);
    expect(completeWingRawDps * DAMAGE_PROFILE_MULTIPLIERS.rapid.light).toBeCloseTo(118.18, 1);
    expect(completeWingRawDps * DAMAGE_PROFILE_MULTIPLIERS.rapid.plated).toBeCloseTo(63.64, 1);
    expect(completeWingRawDps * DAMAGE_PROFILE_MULTIPLIERS.rapid.heavy).toBeCloseTo(27.27, 1);
    expect(completeWingRawDps * DAMAGE_PROFILE_MULTIPLIERS.rapid.fortified).toBeCloseTo(22.73, 1);
  });

  it("automatically prefers light craft over heavy hulls", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    simulation.state.obstacles = [];
    const fighter = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "fighter")!;
    const light = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
    const heavy = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "destroyer")!;
    heavy.class = "battleship";
    fighter.x = 0; fighter.z = 0; fighter.yaw = 0;
    light.x = -20; light.z = 120;
    heavy.x = 20; heavy.z = 120;
    fighter.orders = [{ type: "hold", destination: { x: 0, z: 0 }, facing: 0 }];
    simulation.state.ships = [fighter, light, heavy];
    simulation.step();
    expect(fighter.turrets.filter((turret) => turret.targetEntityId === light.id).length).toBeGreaterThan(
      fighter.turrets.filter((turret) => turret.targetEntityId === heavy.id).length,
    );
    expect(productionDps("fighter", "light")).toBeGreaterThan(productionDps("fighter", "heavy") * 4);
  });
});

describe("dedicated flak specialization", () => {
  it("materially outperforms ordinary point defence against light craft", () => {
    const normalPd = cycleDps("pointDefense") * DAMAGE_PROFILE_MULTIPLIERS.rapid.light;
    const flak = cycleDps("flakCannon") * DAMAGE_PROFILE_MULTIPLIERS.flak.light;
    expect(flak).toBeGreaterThan(normalPd * 1.5);
    expect(SHIPS.flakFrigate.hardpoints.filter((mount) => mount.weaponTypeId === "flakCannon")).toHaveLength(4);
  });

  it("does not give dedicated flak to capital ships or ordinary escorts", () => {
    for (const shipClass of ["frigate", "destroyer", "cruiser", "carrier", "battleship"] as const) {
      expect(SHIPS[shipClass].hardpoints.some((mount) => mount.weaponTypeId === "flakCannon")).toBe(false);
    }
    expect(DAMAGE_PROFILE_MULTIPLIERS.flak.light).toBeGreaterThan(DAMAGE_PROFILE_MULTIPLIERS.flak.plated * 3);
  });
});

describe("artillery positioning and counterplay", () => {
  it("cannot fire before deployment, while moving or cruising, or inside minimum range", () => {
    const beforeDeployment = prepareArtilleryEngagement();
    beforeDeployment.artillery.artilleryDeploymentTicks = 0;
    expect(beforeDeployment.simulation.step().events.some(
      (event) => event.type === "weaponFired" && event.shipId === beforeDeployment.artillery.id,
    )).toBe(false);

    const moving = prepareArtilleryEngagement();
    moving.artillery.artilleryDeploymentTicks = 60;
    moving.artillery.vz = 5;
    expect(moving.simulation.step().events.some(
      (event) => event.type === "weaponFired" && event.shipId === moving.artillery.id,
    )).toBe(false);
    expect(moving.artillery.artilleryDeploymentTicks).toBe(0);

    const cruising = prepareArtilleryEngagement();
    cruising.artillery.artilleryDeploymentTicks = 60;
    cruising.artillery.orders = [{ type: "move", destination: { x: 0, z: 2_000 }, facing: 0 }];
    expect(cruising.simulation.step().events.some(
      (event) => event.type === "weaponFired" && event.shipId === cruising.artillery.id,
    )).toBe(false);
    expect(Math.hypot(cruising.artillery.vx, cruising.artillery.vz)).toBeGreaterThan(SHIPS.artilleryDestroyer.speed);

    const minimumRange = prepareArtilleryEngagement();
    minimumRange.target.z = 150;
    minimumRange.scout.z = 100;
    minimumRange.artillery.artilleryDeploymentTicks = 59;
    expect(minimumRange.simulation.step().events.some(
      (event) => event.type === "weaponFired" && event.shipId === minimumRange.artillery.id,
    )).toBe(false);
  });

  it("requires allied vision beyond its own sensors", () => {
    const { simulation, artillery, scout } = prepareArtilleryEngagement();
    simulation.state.ships = simulation.state.ships.filter((ship) => ship.id !== scout.id);
    artillery.artilleryDeploymentTicks = 59;
    const debug = simulation.step();
    expect(debug.events.some((event) => event.type === "weaponFired" && event.shipId === artillery.id)).toBe(false);
    expect(artillery.turrets.every((turret) => turret.targetEntityId === null)).toBe(true);
  });

  it("fires fixed non-homing shots and creates a temporary hostile reveal", () => {
    const { simulation, artillery, target } = prepareArtilleryEngagement();
    artillery.artilleryDeploymentTicks = 57;
    simulation.step();
    expect(isEntityVisibleToTeam(simulation.state, 2, artillery.id)).toBe(false);
    artillery.artilleryDeploymentTicks = 59;
    const debug = simulation.step();
    const fired = debug.events.find(
      (event) => event.type === "weaponFired" && event.weaponTypeId === "siegeArtillery",
    );
    expect(fired).toBeDefined();
    if (!fired || fired.type !== "weaponFired") throw new Error("Artillery did not fire");
    const projectile = simulation.state.projectiles.find((candidate) => candidate.id === fired.projectileId)!;
    expect(projectile).toMatchObject({ fixedTrajectory: true, targetX: 0, targetZ: 400 });
    const velocity = { vx: projectile.vx, vz: projectile.vz };
    const launchX = projectile.x;
    target.x = 260;
    simulation.stepMany(8);
    expect(projectile.vx).toBe(velocity.vx);
    expect(projectile.vz).toBe(velocity.vz);
    expect(projectile.x).toBeCloseTo(launchX + velocity.vx * 0.05 * 8, 6);
    expect(artillery.revealedUntilTick).toBeGreaterThan(simulation.state.tick);
    expect(isEntityVisibleToTeam(simulation.state, 2, artillery.id)).toBe(true);
    expect(debug.events).toContainEqual(expect.objectContaining({
      type: "artilleryRevealed", entityId: artillery.id,
    }));
  });
});

describe("deterministic strategic cruise", () => {
  it("activates after 60 quiet ticks and drops to tactical speed on target acquisition", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    simulation.state.obstacles = [];
    const destroyer = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.class === "destroyer")!;
    simulation.state.ships = [destroyer];
    destroyer.x = 0; destroyer.z = 0; destroyer.vx = 0; destroyer.vz = 0;
    destroyer.orders = [{ type: "move", destination: { x: 0, z: 5_000 }, facing: 0 }];
    for (const structure of simulation.state.structures) {
      structure.x += structure.teamId === 1 ? -8_000 : 8_000;
      structure.z += structure.teamId === 1 ? -8_000 : 8_000;
    }
    simulation.stepMany(59);
    expect(Math.hypot(destroyer.vx, destroyer.vz)).toBeLessThanOrEqual(SHIPS.destroyer.speed + 0.001);
    simulation.step();
    expect(Math.hypot(destroyer.vx, destroyer.vz)).toBeGreaterThan(SHIPS.destroyer.speed);
    expect(Math.hypot(destroyer.vx, destroyer.vz)).toBeCloseTo(
      SHIPS.destroyer.speed * SHIPS.destroyer.cruiseMultiplier,
      4,
    );
    destroyer.focusTargetEntityId = simulation.state.structures.find((structure) => structure.teamId === 2)!.id;
    simulation.step();
    expect(Math.hypot(destroyer.vx, destroyer.vz)).toBeLessThanOrEqual(SHIPS.destroyer.speed + 0.001);
  });

  it("ends immediately when damage lands and resets artillery deployment state", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    simulation.state.obstacles = [];
    const artillery = refitAsArtillery(simulation);
    simulation.state.ships = [artillery];
    for (const structure of simulation.state.structures) {
      structure.x += structure.teamId === 1 ? -8_000 : 8_000;
      structure.z += structure.teamId === 1 ? -8_000 : 8_000;
    }
    artillery.x = 0; artillery.z = 0;
    artillery.orders = [{ type: "move", destination: { x: 0, z: 4_000 }, facing: 0 }];
    simulation.step();
    expect(Math.hypot(artillery.vx, artillery.vz)).toBeGreaterThan(SHIPS.artilleryDestroyer.speed);
    artillery.artilleryDeploymentTicks = 60;
    simulation.state.projectiles.push({
      id: simulation.state.nextEntityId++, ownerShipId: 999_999, ownerTeamId: 2,
      weaponTypeId: "torpedo", targetEntityId: artillery.id,
      targetX: artillery.x, targetZ: artillery.z, fixedTrajectory: false,
      x: artillery.x, z: artillery.z, previousX: artillery.x, previousZ: artillery.z,
      vx: 0, vz: 0, radius: 5, damage: 10, lifetimeTicks: 2,
    });
    simulation.step();
    expect(Math.hypot(artillery.vx, artillery.vz)).toBeLessThanOrEqual(SHIPS.artilleryDestroyer.speed + 0.001);
    expect(artillery.artilleryDeploymentTicks).toBe(0);
    expect(artillery.lastCombatTick).toBe(simulation.state.tick);
  });

  it("includes compact combat, deployment, reveal, and derived-cruise inputs in checksums and restores", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    const artillery = refitAsArtillery(simulation);
    const snapshot = simulation.snapshot();
    const baseline = calculateChecksum(snapshot);
    const snapshotArtillery = snapshot.ships.find((ship) => ship.id === artillery.id)!;
    snapshotArtillery.vx = SHIPS.artilleryDestroyer.speed * SHIPS.artilleryDestroyer.cruiseMultiplier;
    snapshotArtillery.lastCombatTick += 1;
    snapshotArtillery.artilleryDeploymentTicks = (snapshotArtillery.artilleryDeploymentTicks ?? 0) + 1;
    snapshotArtillery.revealedUntilTick = (snapshotArtillery.revealedUntilTick ?? 0) + 120;
    expect(calculateChecksum(snapshot)).not.toBe(baseline);
    snapshot.checksum = calculateChecksum(snapshot);
    expect(restoreSimulation(snapshot).snapshot()).toEqual(snapshot);
  });
});

describe("cost-aware combined-arms guardrails", () => {
  it("keeps fighter wings efficient against light craft but poor against heavy hulls and fortifications", () => {
    const lightEfficiency = productionDps("fighter", "light") / productionCost("fighter");
    const heavyEfficiency = productionDps("fighter", "heavy") / productionCost("fighter");
    const fortifiedEfficiency = productionDps("fighter", "fortified") / productionCost("fighter");
    expect(lightEfficiency).toBeGreaterThan(heavyEfficiency * 4);
    expect(lightEfficiency).toBeGreaterThan(fortifiedEfficiency * 5);
  });

  it("makes flak screens resist strike-craft spam without becoming general damage ships", () => {
    const flakVsLight = productionDps("flakFrigate", "light") / productionCost("flakFrigate");
    const flakVsHeavy = productionDps("flakFrigate", "heavy") / productionCost("flakFrigate");
    expect(flakVsLight).toBeGreaterThan(flakVsHeavy * 4);
    expect(productionDps("flakFrigate", "light")).toBeGreaterThan(productionDps("frigate", "light"));
  });

  it("gives heavy ships exploitable ordnance counters and useful screening", () => {
    const torpedoVsHeavy = productionDps("torpedoFrigate", "heavy") / productionCost("torpedoFrigate");
    const fighterVsHeavy = productionDps("fighter", "heavy") / productionCost("fighter");
    expect(torpedoVsHeavy).toBeGreaterThan(fighterVsHeavy * 3);
    const plasmaBomberStrike = productionDps("frigate", "heavy") + productionDps("bomber", "heavy");
    expect(plasmaBomberStrike).toBeGreaterThan(productionDps("fighter", "heavy") * 8);
    const screenedAntiLight = productionDps("battleship", "light") + productionDps("flakFrigate", "light");
    expect(screenedAntiLight).toBeGreaterThan(productionDps("battleship", "light") * 1.5);
  });

  it("lets protected artillery break fortifications while fast raiders punish unsupported guns", () => {
    const artilleryFortified = productionDps("artilleryDestroyer", "fortified") / productionCost("artilleryDestroyer");
    const artilleryLight = productionDps("artilleryDestroyer", "light") / productionCost("artilleryDestroyer");
    expect(artilleryFortified).toBeGreaterThan(artilleryLight * 5);
    expect(productionDps("fighter", "plated")).toBeGreaterThan(productionDps("artilleryDestroyer", "light") * 2.5);
  });

  it("rewards mixed fleets with broad damage coverage over same-cost mono-role fleets", () => {
    const mixed = ["fighter", "flakFrigate", "torpedoFrigate", "artilleryDestroyer"] as const;
    const armors: readonly ArmorType[] = ["light", "plated", "heavy", "fortified"];
    const mixedCost = mixed.reduce((sum, shipClass) => sum + productionCost(shipClass), 0);
    const mixedWorstCase = Math.min(...armors.map((armor) =>
      mixed.reduce((sum, shipClass) => sum + productionDps(shipClass, armor), 0) / mixedCost));
    for (const mono of ["fighter", "flakFrigate", "artilleryDestroyer"] as const) {
      const monoWorstCase = Math.min(...armors.map((armor) => productionDps(mono, armor) / productionCost(mono)));
      expect(mixedWorstCase).toBeGreaterThan(monoWorstCase * 1.2);
    }
  });
});
