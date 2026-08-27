import type {
  ShipDefinition,
  ShipEconomyDefinition,
  ShipClass,
  StructureDefinition,
  StructureType,
  WeaponDefinition,
  WeaponTypeId,
} from "./types";

const DEG = Math.PI / 180;

export const WEAPONS: Readonly<Record<WeaponTypeId, WeaponDefinition>> = {
  autocannon: {
    id: "autocannon", delivery: "projectile", range: 230, minimumRange: 0,
    cooldownTicks: 16, burstSize: 4, burstIntervalTicks: 2,
    projectileSpeed: 240, projectileRadius: 2, projectileLifetimeTicks: 35,
    muzzleOffset: 4.6, muzzleSeparation: 0.3,
    damage: 5, traverseRate: 190 * DEG, alignmentTolerance: 10 * DEG,
    targetPreference: {
      fighter: 0, fabricator: 14, bomber: 8, frigate: 20, flakFrigate: 24, torpedoFrigate: 26,
      destroyer: 45, cruiser: 58, carrier: 72, battleship: 82,
    }, color: 0xffc15c,
  },
  torpedo: {
    id: "torpedo", delivery: "projectile", range: 360, minimumRange: 65,
    cooldownTicks: 46, burstSize: 2, burstIntervalTicks: 4,
    projectileSpeed: 108, projectileRadius: 4.2, projectileLifetimeTicks: 78,
    muzzleOffset: 0.35, muzzleSeparation: 0.58,
    damage: 32, traverseRate: 72 * DEG, alignmentTolerance: 5 * DEG,
    targetPreference: {
      fighter: 180, fabricator: 84, bomber: 120, frigate: 48, flakFrigate: 52, torpedoFrigate: 40,
      destroyer: 20, cruiser: 6, carrier: 0, battleship: 2,
    }, color: 0xff766f,
  },
  plasma: {
    id: "plasma", delivery: "projectile", range: 320, minimumRange: 20,
    cooldownTicks: 28, burstSize: 2, burstIntervalTicks: 5,
    projectileSpeed: 135, projectileRadius: 3.5, projectileLifetimeTicks: 55,
    muzzleOffset: 5.1, muzzleSeparation: 0.42,
    damage: 18, traverseRate: 105 * DEG, alignmentTolerance: 7 * DEG,
    targetPreference: {
      fighter: 58, fabricator: 8, bomber: 32, frigate: 0, flakFrigate: 4, torpedoFrigate: 4,
      destroyer: 8, cruiser: 12, carrier: 20, battleship: 18,
    }, color: 0x66ddff,
  },
  heavyRail: {
    id: "heavyRail", delivery: "projectile", range: 430, minimumRange: 55,
    cooldownTicks: 39, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 510, projectileRadius: 2.5, projectileLifetimeTicks: 32,
    muzzleOffset: 8.7, muzzleSeparation: 0.42,
    damage: 42, traverseRate: 65 * DEG, alignmentTolerance: 4 * DEG,
    targetPreference: {
      fighter: 150, fabricator: 54, bomber: 92, frigate: 28, flakFrigate: 30, torpedoFrigate: 24,
      destroyer: 8, cruiser: 3, carrier: 2, battleship: 0,
    }, color: 0xfff2c4,
  },
  pointDefense: {
    id: "pointDefense", delivery: "projectile", range: 185, minimumRange: 0,
    cooldownTicks: 15, burstSize: 6, burstIntervalTicks: 1,
    projectileSpeed: 320, projectileRadius: 1.4, projectileLifetimeTicks: 22,
    muzzleOffset: 3.25, muzzleSeparation: 0.25,
    damage: 4, traverseRate: 270 * DEG, alignmentTolerance: 13 * DEG,
    targetPreference: {
      fighter: 0, fabricator: 42, bomber: 8, frigate: 85, flakFrigate: 92, torpedoFrigate: 90,
      destroyer: 120, cruiser: 135, carrier: 145, battleship: 150,
    }, color: 0x9affbb,
  },
  beam: {
    id: "beam", delivery: "beam", range: 390, minimumRange: 30,
    cooldownTicks: 30, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 0, projectileRadius: 0, projectileLifetimeTicks: 0,
    muzzleOffset: 7.9, muzzleSeparation: 0,
    damage: 36, traverseRate: 82 * DEG, alignmentTolerance: 3 * DEG,
    targetPreference: {
      fighter: 120, fabricator: 38, bomber: 72, frigate: 18, flakFrigate: 20, torpedoFrigate: 16,
      destroyer: 7, cruiser: 2, carrier: 0, battleship: 1,
    }, color: 0xa8f7ff,
  },
};

const hp = (
  localX: number,
  localZ: number,
  yawCenter: number,
  yawHalfArc: number,
  weaponTypeId: WeaponTypeId,
) => ({ localX, localZ, yawCenter: yawCenter * DEG, yawHalfArc: yawHalfArc * DEG, weaponTypeId });

export const FIGHTER_SQUAD_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-12, -3],
  [12, -3],
  [-7, -14],
  [7, -14],
];

export function getFighterSquadMemberPose(shipId: number, memberIndex: number, tick: number): {
  x: number;
  y: number;
  z: number;
  yaw: number;
  bank: number;
} {
  if (memberIndex <= 0) return { x: 0, y: 0, z: 0, yaw: 0, bank: 0 };
  const base = FIGHTER_SQUAD_OFFSETS[memberIndex] ?? FIGHTER_SQUAD_OFFSETS[0]!;
  const seconds = tick * 0.05;
  const phase = shipId * 0.61803398875 + memberIndex * 1.73;
  const sweep = Math.sin(seconds * 1.65 + phase);
  const jink = Math.sin(seconds * 4.35 + phase * 1.37);
  const drift = Math.sin(seconds * 0.72 + phase * 0.83);
  const side = Math.sign(base[0]) || 1;
  return {
    x: base[0] + sweep * 2.8 + jink * 1.7 + side * drift * 1.2,
    y: Math.sin(seconds * 3.55 + phase) * 0.9 + (memberIndex <= 2 ? 0.35 : -0.35),
    z: base[1] + Math.cos(seconds * 1.28 + phase) * 3.8 + jink * 1.15,
    yaw: sweep * 0.16 + jink * 0.13,
    bank: -jink * 0.52 - sweep * 0.2,
  };
}

export const SHIPS: Readonly<Record<ShipClass, ShipDefinition>> = {
  fighter: {
    class: "fighter", radius: 12, mass: 40, maxHealth: 700, maxShield: 200, speed: 58,
    turnRate: 150 * DEG, sensorRange: 270, buildPower: 0, buildRange: 0,
    hardpoints: FIGHTER_SQUAD_OFFSETS.map(([localX, localZ]) => hp(localX, localZ + 2.1, 0, 75, "autocannon")),
  },
  fabricator: {
    class: "fabricator", radius: 9.5, mass: 58, maxHealth: 620, maxShield: 240, speed: 28,
    turnRate: 82 * DEG, sensorRange: 340, buildPower: 1.35, buildRange: 150,
    hardpoints: [hp(0, -3, 180, 150, "pointDefense")],
  },
  bomber: {
    class: "bomber", radius: 6.6, mass: 30, maxHealth: 280, maxShield: 90, speed: 45,
    turnRate: 105 * DEG, sensorRange: 290, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-2.8, 4.2, 0, 48, "torpedo"), hp(2.8, 4.2, 0, 48, "torpedo"),
    ],
  },
  frigate: {
    class: "frigate", radius: 13, mass: 95, maxHealth: 900, maxShield: 350, speed: 22,
    turnRate: 68 * DEG, sensorRange: 370, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5, 8, 0, 120, "plasma"), hp(5, 8, 0, 120, "plasma"),
      hp(-7, -1, -90, 115, "pointDefense"), hp(7, -1, 90, 115, "pointDefense"),
    ],
  },
  flakFrigate: {
    class: "flakFrigate", radius: 14, mass: 112, maxHealth: 1_050, maxShield: 420, speed: 21,
    turnRate: 64 * DEG, sensorRange: 410, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(0, 8, 0, 150, "plasma"),
      hp(-7, 5, -55, 145, "pointDefense"), hp(7, 5, 55, 145, "pointDefense"),
      hp(-8, -2, -105, 150, "pointDefense"), hp(8, -2, 105, 150, "pointDefense"),
      hp(-4, -8, -155, 140, "pointDefense"), hp(4, -8, 155, 140, "pointDefense"),
    ],
  },
  torpedoFrigate: {
    class: "torpedoFrigate", radius: 14.5, mass: 125, maxHealth: 980, maxShield: 360, speed: 19,
    turnRate: 58 * DEG, sensorRange: 420, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5.5, 9, -18, 75, "torpedo"), hp(5.5, 9, 18, 75, "torpedo"),
      hp(-6.5, 2, -55, 90, "torpedo"), hp(6.5, 2, 55, 90, "torpedo"),
      hp(-7, -5, -120, 125, "pointDefense"), hp(7, -5, 120, 125, "pointDefense"),
    ],
  },
  destroyer: {
    class: "destroyer", radius: 23, mass: 420, maxHealth: 3000, maxShield: 1200, speed: 14,
    turnRate: 38 * DEG, sensorRange: 500, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-7, 13, 0, 105, "heavyRail"), hp(7, 13, 0, 105, "heavyRail"),
      hp(-11, 3, -90, 100, "plasma"), hp(11, 3, 90, 100, "plasma"),
      hp(-10, -5, -135, 125, "pointDefense"), hp(10, -5, 135, 125, "pointDefense"),
      hp(-7, 8, -50, 130, "pointDefense"), hp(7, 8, 50, 130, "pointDefense"),
    ],
  },
  cruiser: {
    class: "cruiser", radius: 34, mass: 980, maxHealth: 6_800, maxShield: 3_200, speed: 10.5,
    turnRate: 24 * DEG, sensorRange: 610, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-10, 20, -12, 105, "heavyRail"), hp(10, 20, 12, 105, "heavyRail"),
      hp(-15, 10, -65, 115, "plasma"), hp(15, 10, 65, 115, "plasma"),
      hp(-16, 0, -90, 120, "beam"), hp(16, 0, 90, 120, "beam"),
      hp(-12, -12, -130, 120, "torpedo"), hp(12, -12, 130, 120, "torpedo"),
      hp(-17, 5, -85, 145, "pointDefense"), hp(17, 5, 85, 145, "pointDefense"),
      hp(-10, -18, -150, 140, "pointDefense"), hp(10, -18, 150, 140, "pointDefense"),
    ],
  },
  carrier: {
    class: "carrier", radius: 46, mass: 2_100, maxHealth: 11_500, maxShield: 5_800, speed: 7.5,
    turnRate: 15 * DEG, sensorRange: 760, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-18, 24, -35, 115, "beam"), hp(18, 24, 35, 115, "beam"),
      hp(-22, 8, -80, 120, "plasma"), hp(22, 8, 80, 120, "plasma"),
      hp(-16, -20, -140, 120, "torpedo"), hp(16, -20, 140, 120, "torpedo"),
      hp(-25, 18, -60, 150, "pointDefense"), hp(25, 18, 60, 150, "pointDefense"),
      hp(-27, 6, -90, 155, "pointDefense"), hp(27, 6, 90, 155, "pointDefense"),
      hp(-26, -8, -110, 155, "pointDefense"), hp(26, -8, 110, 155, "pointDefense"),
      hp(-20, -24, -150, 150, "pointDefense"), hp(20, -24, 150, 150, "pointDefense"),
    ],
  },
  battleship: {
    class: "battleship", radius: 52, mass: 3_600, maxHealth: 17_000, maxShield: 7_500, speed: 6.2,
    turnRate: 11 * DEG, sensorRange: 700, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-13, 34, -18, 90, "heavyRail"), hp(13, 34, 18, 90, "heavyRail"),
      hp(-17, 22, -35, 100, "heavyRail"), hp(17, 22, 35, 100, "heavyRail"),
      hp(-19, 8, -70, 110, "heavyRail"), hp(19, 8, 70, 110, "heavyRail"),
      hp(-18, -10, -110, 115, "plasma"), hp(18, -10, 110, 115, "plasma"),
      hp(-14, -28, -150, 120, "beam"), hp(14, -28, 150, 120, "beam"),
      hp(-25, 15, -75, 150, "pointDefense"), hp(25, 15, 75, 150, "pointDefense"),
      hp(-26, -2, -95, 155, "pointDefense"), hp(26, -2, 95, 155, "pointDefense"),
      hp(-22, -22, -140, 150, "pointDefense"), hp(22, -22, 140, 150, "pointDefense"),
    ],
  },
};

/** Shared hardpoint scale keeps projectile origins aligned with the instanced turret meshes. */
export const SHIP_TURRET_SCALES: Readonly<Record<ShipClass, number>> = {
  fighter: 0.24,
  fabricator: 0.5,
  frigate: 0.58,
  bomber: 0.4,
  flakFrigate: 0.6,
  torpedoFrigate: 0.62,
  destroyer: 0.7,
  cruiser: 0.76,
  carrier: 0.78,
  battleship: 0.82,
};

export const SHIP_ECONOMY: Readonly<Record<ShipClass, ShipEconomyDefinition>> = {
  fighter: { alloyCost: 450, energyCost: 225, buildTicks: 180, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  fabricator: { alloyCost: 320, energyCost: 210, buildTicks: 230, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  frigate: { alloyCost: 260, energyCost: 150, buildTicks: 190, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  bomber: { alloyCost: 1_800, energyCost: 1_300, buildTicks: 440, batchSize: 5, yardType: "shipyard", requiredStructures: [] },
  flakFrigate: { alloyCost: 440, energyCost: 300, buildTicks: 250, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  torpedoFrigate: { alloyCost: 520, energyCost: 360, buildTicks: 275, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  destroyer: { alloyCost: 760, energyCost: 520, buildTicks: 360, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  cruiser: { alloyCost: 1_550, energyCost: 1_150, buildTicks: 620, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  carrier: { alloyCost: 3_600, energyCost: 3_100, buildTicks: 1_050, batchSize: 1, yardType: "capitalShipyard", requiredStructures: [] },
  battleship: { alloyCost: 4_800, energyCost: 4_200, buildTicks: 1_300, batchSize: 1, yardType: "capitalShipyard", requiredStructures: [] },
};

export const STRUCTURES: Readonly<Record<StructureType, StructureDefinition>> = {
  commandCore: {
    type: "commandCore", radius: 38, maxHealth: 5_500, maxShield: 1_600,
    alloyCost: 0, energyCost: 0, buildTicks: 1,
    alloyIncome: 3, energyIncome: 12, energyUpkeep: 0, alloyStorage: 1_500, energyStorage: 1_500,
    requiredStructures: [], buildPower: 0, assistRange: 0, sensorRange: 520,
  },
  extractor: {
    type: "extractor", radius: 17, maxHealth: 1_050, maxShield: 180,
    alloyCost: 220, energyCost: 80, buildTicks: 150,
    alloyIncome: 11, energyIncome: 0, energyUpkeep: 1, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 220,
  },
  deepCoreExtractor: {
    type: "deepCoreExtractor", radius: 22, maxHealth: 1_900, maxShield: 480,
    alloyCost: 900, energyCost: 650, buildTicks: 420,
    alloyIncome: 30, energyIncome: 0, energyUpkeep: 18, alloyStorage: 350, energyStorage: 0,
    requiredStructures: ["fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 360,
  },
  singularityHarvester: {
    type: "singularityHarvester", radius: 28, maxHealth: 3_800, maxShield: 1_450,
    alloyCost: 2_600, energyCost: 2_300, buildTicks: 820,
    alloyIncome: 70, energyIncome: 0, energyUpkeep: 55, alloyStorage: 1_000, energyStorage: 0,
    requiredStructures: ["capitalShipyard"], buildPower: 0, assistRange: 0, sensorRange: 560,
  },
  solarArray: {
    type: "solarArray", radius: 20, maxHealth: 850, maxShield: 120,
    alloyCost: 170, energyCost: 20, buildTicks: 125,
    alloyIncome: 0, energyIncome: 22, energyUpkeep: 0, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 190,
  },
  storage: {
    type: "storage", radius: 18, maxHealth: 950, maxShield: 180,
    alloyCost: 180, energyCost: 60, buildTicks: 130,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 1, alloyStorage: 1_200, energyStorage: 1_200,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 190,
  },
  quantumStorage: {
    type: "quantumStorage", radius: 27, maxHealth: 3_200, maxShield: 1_100,
    alloyCost: 1_400, energyCost: 1_100, buildTicks: 520,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 18, alloyStorage: 6_000, energyStorage: 8_000,
    requiredStructures: ["capitalShipyard"], buildPower: 0, assistRange: 0, sensorRange: 400,
  },
  fabricator: {
    type: "fabricator", radius: 22, maxHealth: 1_200, maxShield: 250,
    alloyCost: 340, energyCost: 180, buildTicks: 190,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 4, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 1, assistRange: 260, sensorRange: 280,
  },
  advancedFabrication: {
    type: "advancedFabrication", radius: 28, maxHealth: 2_400, maxShield: 750,
    alloyCost: 1_320, energyCost: 820, buildTicks: 520,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 12, alloyStorage: 350, energyStorage: 350,
    requiredStructures: ["commandCore", "fabricator", "solarArray"], buildPower: 0, assistRange: 0, sensorRange: 420,
  },
  fusionReactor: {
    type: "fusionReactor", radius: 26, maxHealth: 1_650, maxShield: 400,
    alloyCost: 650, energyCost: 480, buildTicks: 320,
    alloyIncome: 0, energyIncome: 110, energyUpkeep: 6, alloyStorage: 250, energyStorage: 650,
    requiredStructures: ["fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 300,
  },
  antimatterReactor: {
    type: "antimatterReactor", radius: 34, maxHealth: 4_200, maxShield: 1_700,
    alloyCost: 1_800, energyCost: 2_000, buildTicks: 700,
    alloyIncome: 0, energyIncome: 320, energyUpkeep: 28, alloyStorage: 600, energyStorage: 2_500,
    requiredStructures: ["capitalShipyard"], buildPower: 0, assistRange: 0, sensorRange: 480,
  },
  shipyard: {
    type: "shipyard", radius: 31, maxHealth: 2_200, maxShield: 500,
    alloyCost: 480, energyCost: 320, buildTicks: 260,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 3, alloyStorage: 250, energyStorage: 250,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 360,
  },
  fleetShipyard: {
    type: "fleetShipyard", radius: 42, maxHealth: 4_800, maxShield: 1_600,
    alloyCost: 1_250, energyCost: 900, buildTicks: 600,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 16, alloyStorage: 500, energyStorage: 500,
    requiredStructures: ["commandCore", "shipyard"], buildPower: 0, assistRange: 0, sensorRange: 520,
  },
  capitalInfrastructure: {
    type: "capitalInfrastructure", radius: 36, maxHealth: 6_200, maxShield: 2_600,
    alloyCost: 2_650, energyCost: 2_100, buildTicks: 900,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 30, alloyStorage: 900, energyStorage: 1_100,
    requiredStructures: ["advancedFabrication", "fleetShipyard", "fusionReactor", "storage"], buildPower: 0, assistRange: 0, sensorRange: 620,
  },
  capitalShipyard: {
    type: "capitalShipyard", radius: 58, maxHealth: 9_500, maxShield: 4_400,
    alloyCost: 3_200, energyCost: 2_700, buildTicks: 1_100,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 38, alloyStorage: 1_200, energyStorage: 1_400,
    requiredStructures: ["commandCore", "fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 720,
  },
  pointDefenseBattery: {
    type: "pointDefenseBattery", radius: 16, maxHealth: 1_350, maxShield: 280,
    alloyCost: 260, energyCost: 190, buildTicks: 170,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 4, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 310,
    weaponTypeId: "pointDefense",
  },
  missileBattery: {
    type: "missileBattery", radius: 20, maxHealth: 1_900, maxShield: 450,
    alloyCost: 520, energyCost: 420, buildTicks: 280,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 8, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "shipyard"], buildPower: 0, assistRange: 0, sensorRange: 440,
    weaponTypeId: "torpedo",
  },
  railBattery: {
    type: "railBattery", radius: 23, maxHealth: 2_650, maxShield: 720,
    alloyCost: 820, energyCost: 650, buildTicks: 380,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 12, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 540,
    weaponTypeId: "heavyRail",
  },
};

export const ALL_SHIP_CLASSES: readonly ShipClass[] = [
  "fighter", "fabricator", "frigate", "bomber", "flakFrigate", "torpedoFrigate",
  "destroyer", "cruiser", "carrier", "battleship",
];

export const SHIPYARD_TYPES = ["shipyard", "fleetShipyard", "capitalShipyard"] as const;

export const DEFENSIVE_STRUCTURE_TYPES = ["pointDefenseBattery", "missileBattery", "railBattery"] as const;

export const RESOURCE_EXTRACTOR_TYPES = ["extractor", "deepCoreExtractor", "singularityHarvester"] as const;

export const BUILDABLE_STRUCTURE_TYPES = [
  "extractor", "solarArray", "storage", "fabricator", "shipyard",
  "fleetShipyard", "capitalShipyard",
  "fusionReactor", "deepCoreExtractor",
  "antimatterReactor", "singularityHarvester", "quantumStorage",
  ...DEFENSIVE_STRUCTURE_TYPES,
] as const satisfies readonly Exclude<StructureType, "commandCore">[];
