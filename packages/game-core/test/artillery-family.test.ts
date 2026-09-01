import { describe, expect, it } from "vitest";
import {
  SHIPS,
  SHIP_ECONOMY,
  STRUCTURES,
  WEAPONS,
  createCombatScenario,
  isEntityVisibleToTeam,
  type GameSimulation,
  type ShipClass,
  type ShipState,
  type StructureState,
  type StructureType,
  type WeaponTypeId,
} from "../src";

const MOBILE_TIERS = [
  { shipClass: "artilleryFrigate", weapon: "lightArtillery", setup: 40, reveal: 80 },
  { shipClass: "artilleryDestroyer", weapon: "siegeArtillery", setup: 60, reveal: 120 },
  { shipClass: "artilleryCruiser", weapon: "strategicArtillery", setup: 100, reveal: 160 },
] as const satisfies readonly {
  shipClass: ShipClass;
  weapon: WeaponTypeId;
  setup: number;
  reveal: number;
}[];

const STATIC_TIERS = [
  { structureType: "artilleryBattery", weapon: "lightArtillery", reveal: 100 },
  { structureType: "heavyArtilleryBattery", weapon: "siegeArtillery", reveal: 150 },
  { structureType: "strategicArtilleryArray", weapon: "strategicArtillery", reveal: 200 },
] as const satisfies readonly {
  structureType: StructureType;
  weapon: WeaponTypeId;
  reveal: number;
}[];

function refitShip(simulation: GameSimulation, shipClass: ShipClass): ShipState {
  const ship = simulation.state.ships.find((candidate) => candidate.teamId === 1)!;
  const definition = SHIPS[shipClass];
  ship.class = shipClass;
  ship.x = 0;
  ship.z = 0;
  ship.yaw = 0;
  ship.vx = 0;
  ship.vz = 0;
  ship.health = definition.maxHealth;
  ship.shields = definition.maxShield;
  ship.orders = [{ type: "hold", destination: { x: 0, z: 0 }, facing: 0 }];
  ship.focusTargetEntityId = null;
  ship.lastCombatTick = -1_000;
  ship.artilleryDeploymentTicks = 0;
  ship.revealedUntilTick = 0;
  ship.turrets = definition.hardpoints.map((hardpoint) => ({
    id: simulation.state.nextTurretId++,
    parentShipId: ship.id,
    weaponTypeId: hardpoint.weaponTypeId,
    localX: hardpoint.localX,
    localZ: hardpoint.localZ,
    yawCenter: hardpoint.yawCenter,
    yawHalfArc: hardpoint.yawHalfArc,
    currentYaw: 0,
    targetEntityId: null,
    cooldownRemaining: 0,
    fireSequence: 0,
  }));
  return ship;
}

function mobileEngagement(shipClass: ShipClass, weaponTypeId: WeaponTypeId) {
  const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false, fightersPerTeam: 2 });
  simulation.state.obstacles = [];
  const artillery = refitShip(simulation, shipClass);
  const weapon = WEAPONS[weaponTypeId];
  const target = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
  const scout = simulation.state.ships.find((ship) => ship.teamId === 1 && ship.id !== artillery.id)!;
  const range = (weapon.minimumRange + weapon.range) / 2;
  target.x = 0;
  target.z = range;
  target.orders = [{ type: "hold", destination: { x: 0, z: range }, facing: Math.PI }];
  scout.x = 0;
  scout.z = range - 25;
  scout.orders = [{ type: "hold", destination: { x: 0, z: range - 25 }, facing: 0 }];
  simulation.state.ships = [artillery, scout, target];
  for (const structure of simulation.state.structures) {
    structure.x += structure.teamId === 1 ? -9_000 : 9_000;
    structure.z += structure.teamId === 1 ? -9_000 : 9_000;
  }
  return { simulation, artillery, target };
}

function addArtilleryStructure(
  simulation: GameSimulation,
  structureType: StructureType,
  buildProgress = 1,
): StructureState {
  const definition = STRUCTURES[structureType];
  const structure: StructureState = {
    id: simulation.state.nextEntityId++,
    ownerPlayerId: "pilot-blue",
    teamId: 1,
    type: structureType,
    x: 0,
    z: 0,
    yaw: 0,
    health: definition.maxHealth,
    shields: definition.maxShield,
    buildProgress,
    resourceNodeId: null,
    productionQueue: [],
    repeatProduction: false,
    rallyPoint: { x: 0, z: 0 },
    revealedUntilTick: 0,
  };
  simulation.state.structures.push(structure);
  return structure;
}

describe("T1–T3 mobile artillery family", () => {
  it("matches the requested chassis, production, and weapon profiles", () => {
    expect(SHIPS.artilleryFrigate).toMatchObject({
      armorType: "plated", radius: 14.5, mass: 135, maxHealth: 900, maxShield: 300,
      speed: 32, sensorRange: 300,
    });
    expect(SHIP_ECONOMY.artilleryFrigate).toEqual({
      alloyCost: 420, energyCost: 280, buildTicks: 230, batchSize: 1,
      yardType: "shipyard", requiredStructures: [],
    });
    expect(SHIPS.artilleryDestroyer.hardpoints.map((hardpoint) => hardpoint.weaponTypeId)).toEqual([
      "siegeArtillery", "siegeArtillery",
    ]);
    expect(SHIPS.artilleryCruiser).toMatchObject({
      armorType: "heavy", radius: 38, mass: 1_250, maxHealth: 7_800, maxShield: 3_000,
      speed: 15, sensorRange: 460,
    });
    expect(SHIP_ECONOMY.artilleryCruiser).toEqual({
      alloyCost: 4_200, energyCost: 3_800, buildTicks: 1_250, batchSize: 1,
      yardType: "capitalShipyard", requiredStructures: [],
    });
    expect(WEAPONS.lightArtillery).toMatchObject({
      range: 500, minimumRange: 140, damage: 70, cooldownTicks: 60,
      projectileSpeed: 200,
      artillery: { setupTicks: 40, mobileRevealTicks: 80, targetReevaluationTicks: 20 },
    });
    expect(WEAPONS.siegeArtillery).toMatchObject({
      range: 680, minimumRange: 220, damage: 180, cooldownTicks: 100,
      projectileSpeed: 180,
      artillery: { setupTicks: 60, mobileRevealTicks: 120, targetReevaluationTicks: 20 },
    });
    expect(WEAPONS.strategicArtillery).toMatchObject({
      range: 900, minimumRange: 320, damage: 420, cooldownTicks: 140,
      projectileSpeed: 160,
      artillery: { setupTicks: 100, mobileRevealTicks: 160, targetReevaluationTicks: 30 },
    });
    for (const tier of MOBILE_TIERS) {
      expect(SHIPS[tier.shipClass].hardpoints.every((hardpoint) => hardpoint.weaponTypeId === tier.weapon)).toBe(true);
      expect(SHIPS[tier.shipClass].hardpoints.some((hardpoint) => hardpoint.weaponTypeId === "pointDefense")).toBe(false);
    }
  });

  for (const tier of MOBILE_TIERS) {
    it(`${tier.shipClass} deploys at its tier timing, fires fixed shots, and reveals for ${tier.reveal} ticks`, () => {
      const { simulation, artillery, target } = mobileEngagement(tier.shipClass, tier.weapon);
      artillery.artilleryDeploymentTicks = tier.setup - 2;
      expect(simulation.step().events.some((event) =>
        event.type === "weaponFired" && event.shipId === artillery.id)).toBe(false);
      artillery.artilleryDeploymentTicks = tier.setup - 1;
      const firedAtTick = simulation.state.tick + 1;
      const debug = simulation.step();
      const fired = debug.events.find((event) =>
        event.type === "weaponFired" && event.shipId === artillery.id && event.weaponTypeId === tier.weapon);
      expect(fired).toBeDefined();
      if (!fired || fired.type !== "weaponFired") throw new Error("Expected artillery fire");
      expect(simulation.state.projectiles.find((projectile) => projectile.id === fired.projectileId)).toMatchObject({
        fixedTrajectory: true,
        targetX: target.x,
        targetZ: target.z,
      });
      expect(artillery.revealedUntilTick).toBe(firedAtTick + tier.reveal);
      expect(isEntityVisibleToTeam(simulation.state, 2, artillery.id)).toBe(true);
    });
  }

  it("enforces every tier's dead zone and team-visibility requirement", () => {
    for (const tier of MOBILE_TIERS) {
      const deadZone = mobileEngagement(tier.shipClass, tier.weapon);
      deadZone.target.z = WEAPONS[tier.weapon].minimumRange - 10;
      deadZone.artillery.artilleryDeploymentTicks = tier.setup - 1;
      expect(deadZone.simulation.step().events.some((event) =>
        event.type === "weaponFired" && event.shipId === deadZone.artillery.id)).toBe(false);

      const blind = mobileEngagement(tier.shipClass, tier.weapon);
      blind.target.z = (SHIPS[tier.shipClass].sensorRange + WEAPONS[tier.weapon].range) / 2;
      blind.simulation.state.ships = blind.simulation.state.ships.filter((ship) =>
        ship.id === blind.artillery.id || ship.id === blind.target.id);
      blind.artillery.artilleryDeploymentTicks = tier.setup - 1;
      blind.artillery.focusTargetEntityId = blind.target.id;
      expect(blind.simulation.step().events.some((event) =>
        event.type === "weaponFired" && event.shipId === blind.artillery.id)).toBe(false);
    }
  });

  it("keeps artillery-only fields out of ordinary live ship state", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false });
    for (const ship of simulation.state.ships) {
      expect(ship.lastCombatTick).toBeTypeOf("number");
      expect(ship.artilleryDeploymentTicks).toBeUndefined();
      expect(ship.revealedUntilTick).toBeUndefined();
      expect("cruising" in ship).toBe(false);
      expect("lastFiredTick" in ship).toBe(false);
      expect("lastDamageTick" in ship).toBe(false);
    }
  });
});

describe("T1–T3 artillery structures", () => {
  it("matches requested costs, durability, upkeep, sensors, prerequisites, and barrels", () => {
    expect(STRUCTURES.artilleryBattery).toMatchObject({
      armorType: "fortified", alloyCost: 650, energyCost: 450, buildTicks: 330,
      maxHealth: 1_600, maxShield: 400, radius: 20, sensorRange: 300, energyUpkeep: 12,
      requiredStructures: ["commandCore"],
    });
    expect(STRUCTURES.heavyArtilleryBattery).toMatchObject({
      armorType: "fortified", alloyCost: 1_800, energyCost: 1_350, buildTicks: 680,
      maxHealth: 4_200, maxShield: 1_200, radius: 28, sensorRange: 420, energyUpkeep: 42,
      requiredStructures: ["fleetShipyard", "fusionReactor"],
    });
    expect(STRUCTURES.strategicArtilleryArray).toMatchObject({
      armorType: "fortified", alloyCost: 5_500, energyCost: 5_200, buildTicks: 1_500,
      maxHealth: 9_000, maxShield: 3_000, radius: 40, sensorRange: 540, energyUpkeep: 120,
      requiredStructures: ["capitalShipyard", "antimatterReactor"],
    });
    expect(STRUCTURES.artilleryBattery.hardpoints).toHaveLength(1);
    expect(STRUCTURES.heavyArtilleryBattery.hardpoints).toHaveLength(2);
    expect(STRUCTURES.strategicArtilleryArray.hardpoints).toHaveLength(2);
  });

  for (const tier of STATIC_TIERS) {
    it(`${tier.structureType} fires without setup, uses fixed trajectories, and counter-battery reveals`, () => {
      const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false, fightersPerTeam: 2 });
      simulation.state.obstacles = [];
      const battery = addArtilleryStructure(simulation, tier.structureType);
      const weapon = WEAPONS[tier.weapon];
      const target = simulation.state.ships.find((ship) => ship.teamId === 2 && ship.class === "fighter")!;
      const scout = simulation.state.ships.find((ship) => ship.teamId === 1)!;
      const range = (weapon.minimumRange + weapon.range) / 2;
      target.x = 0;
      target.z = range;
      scout.x = 0;
      scout.z = range - 20;
      simulation.state.ships = [scout, target];
      const maximumWait = weapon.cooldownTicks + 2;
      let fired: Extract<ReturnType<GameSimulation["step"]>["events"][number], { type: "weaponFired" }> | undefined;
      for (let tick = 0; tick < maximumWait && !fired; tick += 1) {
        fired = simulation.step().events.find((event) =>
          event.type === "weaponFired" && event.shipId === battery.id && event.weaponTypeId === tier.weapon) as typeof fired;
      }
      expect(fired).toBeDefined();
      expect(simulation.state.projectiles.find((projectile) => projectile.id === fired?.projectileId)?.fixedTrajectory).toBe(true);
      expect((battery.revealedUntilTick ?? 0) - simulation.state.tick).toBeGreaterThanOrEqual(tier.reveal - 1);
      expect(isEntityVisibleToTeam(simulation.state, 2, battery.id)).toBe(true);
    });
  }

  it("never fires an incomplete artillery structure", () => {
    const simulation = createCombatScenario({ startingFleet: true, enemyCommander: false, fightersPerTeam: 2 });
    simulation.state.obstacles = [];
    const batteries = STATIC_TIERS.map((tier, index) => {
      const battery = addArtilleryStructure(simulation, tier.structureType, 0);
      battery.x = index * 35;
      return battery;
    });
    const target = simulation.state.ships.find((ship) => ship.teamId === 2)!;
    const scout = simulation.state.ships.find((ship) => ship.teamId === 1)!;
    target.x = 0; target.z = 450;
    scout.x = 0; scout.z = 425;
    simulation.state.ships = [scout, target];
    const batteryIds = new Set(batteries.map((battery) => battery.id));
    let fired = false;
    for (let tick = 0; tick < 150; tick += 1) {
      if (simulation.step().events.some((event) =>
        event.type === "weaponFired" && batteryIds.has(event.shipId))) fired = true;
    }
    expect(fired).toBe(false);
  });
});

describe("strategic artillery map safety", () => {
  const presets = [
    "orbital-ring", "crossfire", "open-expanse", "asteroid-belt", "spiral-arms",
    "shattered-core", "amazon-tunnel", "core-rush", "star-fortress",
  ] as const;
  const sizes = ["small", "medium", "large", "huge", "colossal"] as const;

  it("cannot bombard an opposing spawn from its own spawn on any map preset or size", () => {
    for (const mapPreset of presets) {
      for (const mapSize of sizes) {
        const simulation = createCombatScenario({
          mapPreset,
          mapSize,
          enemyCommander: false,
          players: [
            { id: "blue", name: "Blue", teamId: 1 },
            { id: "red", name: "Red", teamId: 2 },
          ],
        });
        const cores = simulation.state.structures.filter((structure) => structure.type === "commandCore");
        for (let left = 0; left < cores.length; left += 1) {
          for (let right = left + 1; right < cores.length; right += 1) {
            if (cores[left]!.teamId === cores[right]!.teamId) continue;
            expect(Math.hypot(cores[left]!.x - cores[right]!.x, cores[left]!.z - cores[right]!.z),
              `${mapPreset}/${mapSize}`).toBeGreaterThan(WEAPONS.strategicArtillery.range);
          }
        }
      }
    }
  });
});
