import type {
  ArmorType,
  DamageProfile,
  ShipDefinition,
  ShipEconomyDefinition,
  ShipClass,
  StructureDefinition,
  StructureType,
  WeaponDefinition,
  WeaponTypeId,
} from "./types";

const DEG = Math.PI / 180;

export const DAMAGE_PROFILE_MULTIPLIERS: Readonly<Record<DamageProfile, Readonly<Record<ArmorType | "shields", number>>>> = {
  rapid: { shields: 1, light: 1.3, plated: 0.7, heavy: 0.3, fortified: 0.25 },
  flak: { shields: 0.9, light: 1.6, plated: 0.5, heavy: 0.25, fortified: 0.25 },
  plasma: { shields: 1.3, light: 0.8, plated: 1.25, heavy: 0.8, fortified: 0.6 },
  ordnance: { shields: 0.65, light: 0.45, plated: 0.95, heavy: 1.6, fortified: 1.25 },
  penetrating: { shields: 1, light: 0.4, plated: 0.95, heavy: 1.25, fortified: 1.45 },
  siege: { shields: 0.7, light: 0.3, plated: 0.8, heavy: 1.05, fortified: 1.6 },
};

export function getWeaponArmorMultiplier(weaponTypeId: WeaponTypeId, armorType: ArmorType): number {
  return DAMAGE_PROFILE_MULTIPLIERS[WEAPONS[weaponTypeId].damageProfile][armorType];
}

export function calculateProfiledDamage(
  weaponTypeId: WeaponTypeId,
  rawDamage: number,
  shields: number,
  armorType: ArmorType,
): { shieldDamage: number; hullDamage: number; rawDamage: number } {
  const weapon = WEAPONS[weaponTypeId];
  const shieldDamage = Math.min(Math.max(0, shields), rawDamage * weapon.shieldMultiplier);
  const rawConsumedByShields = weapon.shieldMultiplier > 0 ? shieldDamage / weapon.shieldMultiplier : 0;
  const remainingRawDamage = Math.max(0, rawDamage - rawConsumedByShields);
  return {
    rawDamage,
    shieldDamage,
    hullDamage: remainingRawDamage * DAMAGE_PROFILE_MULTIPLIERS[weapon.damageProfile][armorType],
  };
}

export const WEAPONS: Readonly<Record<WeaponTypeId, WeaponDefinition>> = {
  autocannon: {
    id: "autocannon", delivery: "projectile", range: 230, minimumRange: 0,
    cooldownTicks: 16, burstSize: 4, burstIntervalTicks: 2,
    projectileSpeed: 240, projectileRadius: 2, projectileLifetimeTicks: 35,
    muzzleOffset: 4.6, muzzleSeparation: 0.3,
    damage: 1, damageProfile: "rapid", shieldMultiplier: 1,
    traverseRate: 190 * DEG, alignmentTolerance: 10 * DEG,
    targetPreference: {
      fighter: 0, fabricator: 14, bomber: 8, frigate: 20, flakFrigate: 24, torpedoFrigate: 26,
      artilleryFrigate: 5, destroyer: 4, artilleryDestroyer: 5, cruiser: 6, artilleryCruiser: 7, carrier: 7, battleship: 8,
    }, color: 0xffc15c,
  },
  torpedo: {
    id: "torpedo", delivery: "projectile", range: 360, minimumRange: 65,
    cooldownTicks: 46, burstSize: 2, burstIntervalTicks: 4,
    projectileSpeed: 108, projectileRadius: 4.2, projectileLifetimeTicks: 78,
    muzzleOffset: 0.35, muzzleSeparation: 0.58,
    damage: 32, damageProfile: "ordnance", shieldMultiplier: 0.65,
    traverseRate: 72 * DEG, alignmentTolerance: 5 * DEG,
    targetPreference: {
      fighter: 180, fabricator: 84, bomber: 120, frigate: 48, flakFrigate: 52, torpedoFrigate: 40,
      artilleryFrigate: 5, destroyer: 3, artilleryDestroyer: 4, cruiser: 1, artilleryCruiser: 1, carrier: 0, battleship: 0,
    }, color: 0xff766f,
  },
  plasma: {
    id: "plasma", delivery: "projectile", range: 320, minimumRange: 20,
    cooldownTicks: 28, burstSize: 2, burstIntervalTicks: 5,
    projectileSpeed: 135, projectileRadius: 3.5, projectileLifetimeTicks: 55,
    muzzleOffset: 5.1, muzzleSeparation: 0.42,
    damage: 18, damageProfile: "plasma", shieldMultiplier: 1.3,
    traverseRate: 105 * DEG, alignmentTolerance: 7 * DEG,
    targetPreference: {
      fighter: 58, fabricator: 8, bomber: 32, frigate: 0, flakFrigate: 4, torpedoFrigate: 4,
      artilleryFrigate: 1, destroyer: 1, artilleryDestroyer: 1, cruiser: 3, artilleryCruiser: 3, carrier: 4, battleship: 4,
    }, color: 0x66ddff,
  },
  heavyRail: {
    id: "heavyRail", delivery: "projectile", range: 430, minimumRange: 55,
    cooldownTicks: 39, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 510, projectileRadius: 2.5, projectileLifetimeTicks: 32,
    muzzleOffset: 8.7, muzzleSeparation: 0.42,
    damage: 48, damageProfile: "penetrating", shieldMultiplier: 0.85,
    traverseRate: 65 * DEG, alignmentTolerance: 4 * DEG,
    targetPreference: {
      fighter: 150, fabricator: 54, bomber: 92, frigate: 28, flakFrigate: 30, torpedoFrigate: 24,
      artilleryFrigate: 4, destroyer: 3, artilleryDestroyer: 2, cruiser: 1, artilleryCruiser: 1, carrier: 1, battleship: 0,
    }, color: 0xfff2c4,
  },
  pointDefense: {
    id: "pointDefense", delivery: "projectile", range: 185, minimumRange: 0,
    cooldownTicks: 15, burstSize: 6, burstIntervalTicks: 1,
    projectileSpeed: 320, projectileRadius: 1.4, projectileLifetimeTicks: 22,
    muzzleOffset: 3.25, muzzleSeparation: 0.25,
    damage: 4, damageProfile: "rapid", shieldMultiplier: 1,
    traverseRate: 270 * DEG, alignmentTolerance: 13 * DEG,
    targetPreference: {
      fighter: 0, fabricator: 42, bomber: 8, frigate: 85, flakFrigate: 92, torpedoFrigate: 90,
      artilleryFrigate: 7, destroyer: 6, artilleryDestroyer: 7, cruiser: 8, artilleryCruiser: 9, carrier: 9, battleship: 10,
    }, color: 0x9affbb,
  },
  flakCannon: {
    id: "flakCannon", delivery: "projectile", range: 205, minimumRange: 0,
    cooldownTicks: 15, burstSize: 6, burstIntervalTicks: 1,
    projectileSpeed: 330, projectileRadius: 1.7, projectileLifetimeTicks: 24,
    muzzleOffset: 3.5, muzzleSeparation: 0.3,
    damage: 5, damageProfile: "flak", shieldMultiplier: 0.9,
    traverseRate: 285 * DEG, alignmentTolerance: 14 * DEG,
    targetPreference: {
      fighter: 0, fabricator: 2, bomber: 0, frigate: 5, flakFrigate: 6, torpedoFrigate: 6,
      artilleryFrigate: 7, destroyer: 8, artilleryDestroyer: 8, cruiser: 9, artilleryCruiser: 9, carrier: 10, battleship: 10,
    }, color: 0xb7ff9a,
  },
  beam: {
    id: "beam", delivery: "beam", range: 390, minimumRange: 30,
    cooldownTicks: 30, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 0, projectileRadius: 0, projectileLifetimeTicks: 0,
    muzzleOffset: 7.9, muzzleSeparation: 0,
    damage: 36, damageProfile: "penetrating", shieldMultiplier: 1.35,
    traverseRate: 82 * DEG, alignmentTolerance: 3 * DEG,
    targetPreference: {
      fighter: 120, fabricator: 38, bomber: 72, frigate: 18, flakFrigate: 20, torpedoFrigate: 16,
      artilleryFrigate: 4, destroyer: 3, artilleryDestroyer: 2, cruiser: 1, artilleryCruiser: 1, carrier: 0, battleship: 1,
    }, color: 0xa8f7ff,
  },
  lightArtillery: {
    id: "lightArtillery", delivery: "projectile", range: 500, minimumRange: 140,
    cooldownTicks: 60, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 200, projectileRadius: 4, projectileLifetimeTicks: 62,
    muzzleOffset: 7.5, muzzleSeparation: 0,
    damage: 70, damageProfile: "siege", shieldMultiplier: 0.7,
    traverseRate: 24 * DEG, alignmentTolerance: 3 * DEG,
    targetPreference: {
      fighter: 10, fabricator: 6, bomber: 10, frigate: 7, flakFrigate: 7, torpedoFrigate: 7,
      artilleryFrigate: 3, destroyer: 5, artilleryDestroyer: 3, cruiser: 3, artilleryCruiser: 2, carrier: 2, battleship: 1,
    }, color: 0xffdf9b,
    artillery: { setupTicks: 40, mobileRevealTicks: 80, structureRevealTicks: 100, targetReevaluationTicks: 20 },
  },
  siegeArtillery: {
    id: "siegeArtillery", delivery: "projectile", range: 680, minimumRange: 220,
    cooldownTicks: 100, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 180, projectileRadius: 5.2, projectileLifetimeTicks: 80,
    muzzleOffset: 10.5, muzzleSeparation: 0,
    damage: 180, damageProfile: "siege", shieldMultiplier: 0.7,
    traverseRate: 18 * DEG, alignmentTolerance: 2.5 * DEG,
    targetPreference: {
      fighter: 10, fabricator: 6, bomber: 10, frigate: 7, flakFrigate: 7, torpedoFrigate: 7,
      artilleryFrigate: 3, destroyer: 5, artilleryDestroyer: 3, cruiser: 3, artilleryCruiser: 2, carrier: 2, battleship: 1,
    }, color: 0xffd37a,
    artillery: { setupTicks: 60, mobileRevealTicks: 120, structureRevealTicks: 150, targetReevaluationTicks: 20 },
  },
  strategicArtillery: {
    id: "strategicArtillery", delivery: "projectile", range: 900, minimumRange: 320,
    cooldownTicks: 140, burstSize: 1, burstIntervalTicks: 1,
    projectileSpeed: 160, projectileRadius: 7, projectileLifetimeTicks: 125,
    muzzleOffset: 15, muzzleSeparation: 0,
    damage: 420, damageProfile: "siege", shieldMultiplier: 0.7,
    traverseRate: 12 * DEG, alignmentTolerance: 2 * DEG,
    targetPreference: {
      fighter: 12, fabricator: 6, bomber: 12, frigate: 8, flakFrigate: 8, torpedoFrigate: 8,
      artilleryFrigate: 4, destroyer: 5, artilleryDestroyer: 3, cruiser: 3, artilleryCruiser: 2, carrier: 1, battleship: 0,
    }, color: 0xffbd6b,
    artillery: { setupTicks: 100, mobileRevealTicks: 160, structureRevealTicks: 200, targetReevaluationTicks: 30 },
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
    class: "fighter", armorType: "light", radius: 12, mass: 40, maxHealth: 700, maxShield: 200, speed: 72.5,
    turnRate: 150 * DEG, sensorRange: 270, cruiseMultiplier: 1, buildPower: 0, buildRange: 0,
    hardpoints: FIGHTER_SQUAD_OFFSETS.map(([localX, localZ]) => hp(localX, localZ + 2.1, 0, 75, "autocannon")),
  },
  fabricator: {
    class: "fabricator", armorType: "light", radius: 9.5, mass: 58, maxHealth: 620, maxShield: 240, speed: 35,
    turnRate: 82 * DEG, sensorRange: 340, cruiseMultiplier: 1, buildPower: 1.35, buildRange: 150,
    hardpoints: [hp(0, -3, 180, 150, "pointDefense")],
  },
  bomber: {
    class: "bomber", armorType: "light", radius: 6, mass: 30, maxHealth: 280, maxShield: 90, speed: 56.25,
    turnRate: 105 * DEG, sensorRange: 290, cruiseMultiplier: 1, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-2.8, 4.2, 0, 48, "torpedo"), hp(2.8, 4.2, 0, 48, "torpedo"),
    ],
  },
  frigate: {
    class: "frigate", armorType: "plated", radius: 13, mass: 95, maxHealth: 1_035, maxShield: 405, speed: 37.8,
    turnRate: 58 * DEG, sensorRange: 370, cruiseMultiplier: 1.3, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5, 8, 0, 120, "plasma"), hp(5, 8, 0, 120, "plasma"),
      hp(-7, -1, -90, 115, "pointDefense"), hp(7, -1, 90, 115, "pointDefense"),
    ],
  },
  flakFrigate: {
    class: "flakFrigate", armorType: "plated", radius: 14, mass: 112, maxHealth: 1_210, maxShield: 485, speed: 36,
    turnRate: 54 * DEG, sensorRange: 410, cruiseMultiplier: 1.3, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(0, 8, 0, 150, "plasma"),
      hp(-7, 5, -55, 145, "flakCannon"), hp(7, 5, 55, 145, "flakCannon"),
      hp(-8, -2, -105, 150, "flakCannon"), hp(8, -2, 105, 150, "flakCannon"),
    ],
  },
  torpedoFrigate: {
    class: "torpedoFrigate", armorType: "plated", radius: 14.5, mass: 125, maxHealth: 1_130, maxShield: 415, speed: 33,
    turnRate: 49 * DEG, sensorRange: 420, cruiseMultiplier: 1.3, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5.5, 9, -18, 75, "torpedo"), hp(5.5, 9, 18, 75, "torpedo"),
      hp(-6.5, 2, -55, 90, "torpedo"), hp(6.5, 2, 55, 90, "torpedo"),
      hp(-7, -5, -120, 125, "pointDefense"), hp(7, -5, 120, 125, "pointDefense"),
    ],
  },
  artilleryFrigate: {
    class: "artilleryFrigate", armorType: "plated", radius: 14.5, mass: 135,
    maxHealth: 900, maxShield: 300, speed: 32,
    turnRate: 45 * DEG, sensorRange: 300, cruiseMultiplier: 1.3, buildPower: 0, buildRange: 0,
    hardpoints: [hp(0, 8.5, 0, 28, "lightArtillery")],
  },
  destroyer: {
    class: "destroyer", armorType: "plated", radius: 23, mass: 420, maxHealth: 3_450, maxShield: 1_380, speed: 24,
    turnRate: 32 * DEG, sensorRange: 500, cruiseMultiplier: 1.5, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-7, 13, 0, 105, "heavyRail"), hp(7, 13, 0, 105, "heavyRail"),
      hp(-11, 3, -90, 100, "plasma"), hp(11, 3, 90, 100, "plasma"),
      hp(-10, -5, -135, 125, "pointDefense"), hp(10, -5, 135, 125, "pointDefense"),
      hp(-7, 8, -50, 130, "pointDefense"), hp(7, 8, 50, 130, "pointDefense"),
    ],
  },
  artilleryDestroyer: {
    class: "artilleryDestroyer", armorType: "plated", radius: 22, mass: 340,
    maxHealth: 2_400, maxShield: 900, speed: 25,
    turnRate: 28 * DEG, sensorRange: 370, cruiseMultiplier: 1.5, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5.5, 13, -8, 22, "siegeArtillery"), hp(5.5, 13, 8, 22, "siegeArtillery"),
    ],
  },
  cruiser: {
    class: "cruiser", armorType: "heavy", radius: 34, mass: 980, maxHealth: 7_820, maxShield: 3_680, speed: 18,
    turnRate: 20 * DEG, sensorRange: 610, cruiseMultiplier: 1.75, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-10, 20, -12, 105, "heavyRail"), hp(10, 20, 12, 105, "heavyRail"),
      hp(-15, 10, -65, 115, "plasma"), hp(15, 10, 65, 115, "plasma"),
      hp(-16, 0, -90, 120, "beam"), hp(16, 0, 90, 120, "beam"),
      hp(-7, -12, -130, 120, "torpedo"), hp(7, -12, 130, 120, "torpedo"),
      hp(-17, 5, -85, 145, "pointDefense"), hp(17, 5, 85, 145, "pointDefense"),
      hp(-7, -18, -150, 140, "pointDefense"), hp(7, -18, 150, 140, "pointDefense"),
    ],
  },
  artilleryCruiser: {
    class: "artilleryCruiser", armorType: "heavy", radius: 38, mass: 1_250,
    maxHealth: 7_800, maxShield: 3_000, speed: 15,
    turnRate: 14 * DEG, sensorRange: 460, cruiseMultiplier: 1.75, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-9, 21, -7, 18, "strategicArtillery"), hp(9, 21, 7, 18, "strategicArtillery"),
    ],
  },
  carrier: {
    class: "carrier", armorType: "heavy", radius: 46, mass: 2_100, maxHealth: 13_225, maxShield: 6_670, speed: 13.2,
    turnRate: 12.75 * DEG, sensorRange: 760, cruiseMultiplier: 2, buildPower: 0, buildRange: 0,
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
    class: "battleship", armorType: "heavy", radius: 52, mass: 3_600, maxHealth: 19_550, maxShield: 8_625, speed: 10.8,
    turnRate: 9.35 * DEG, sensorRange: 700, cruiseMultiplier: 2, buildPower: 0, buildRange: 0,
    hardpoints: [
      hp(-5, 34, -18, 90, "heavyRail"), hp(5, 34, 18, 90, "heavyRail"),
      hp(-8, 22, -35, 100, "heavyRail"), hp(8, 22, 35, 100, "heavyRail"),
      hp(-12, 8, -70, 110, "heavyRail"), hp(12, 8, 70, 110, "heavyRail"),
      hp(-15, -10, -110, 115, "plasma"), hp(15, -10, 110, 115, "plasma"),
      hp(-14, -28, -150, 120, "beam"), hp(14, -28, 150, 120, "beam"),
      hp(-9, 15, -75, 150, "pointDefense"), hp(9, 15, 75, 150, "pointDefense"),
      hp(-14, -2, -95, 155, "pointDefense"), hp(14, -2, 95, 155, "pointDefense"),
      hp(-19, -22, -140, 150, "pointDefense"), hp(19, -22, 140, 150, "pointDefense"),
    ],
  },
};

/** Shared hardpoint scale keeps projectile origins aligned with the instanced turret meshes. */
export const SHIP_TURRET_SCALES: Readonly<Record<ShipClass, number>> = {
  fighter: 0.24,
  fabricator: 0.5,
  frigate: 0.58,
  bomber: 0.3,
  flakFrigate: 0.6,
  torpedoFrigate: 0.62,
  artilleryFrigate: 0.64,
  destroyer: 0.7,
  artilleryDestroyer: 0.72,
  cruiser: 0.76,
  artilleryCruiser: 0.78,
  carrier: 0.78,
  battleship: 0.82,
};

export const SHIP_ECONOMY: Readonly<Record<ShipClass, ShipEconomyDefinition>> = {
  fighter: { alloyCost: 380, energyCost: 200, buildTicks: 180, batchSize: 5, yardType: "shipyard", requiredStructures: [] },
  fabricator: { alloyCost: 320, energyCost: 210, buildTicks: 230, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  frigate: { alloyCost: 260, energyCost: 150, buildTicks: 190, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  bomber: { alloyCost: 1_500, energyCost: 1_050, buildTicks: 380, batchSize: 5, yardType: "shipyard", requiredStructures: [] },
  flakFrigate: { alloyCost: 500, energyCost: 340, buildTicks: 250, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  torpedoFrigate: { alloyCost: 600, energyCost: 420, buildTicks: 275, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  artilleryFrigate: { alloyCost: 420, energyCost: 280, buildTicks: 230, batchSize: 1, yardType: "shipyard", requiredStructures: [] },
  destroyer: { alloyCost: 760, energyCost: 520, buildTicks: 360, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  artilleryDestroyer: { alloyCost: 1_200, energyCost: 900, buildTicks: 520, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  cruiser: { alloyCost: 1_750, energyCost: 1_300, buildTicks: 620, batchSize: 1, yardType: "fleetShipyard", requiredStructures: [] },
  artilleryCruiser: { alloyCost: 4_200, energyCost: 3_800, buildTicks: 1_250, batchSize: 1, yardType: "capitalShipyard", requiredStructures: [] },
  carrier: { alloyCost: 3_600, energyCost: 3_100, buildTicks: 1_050, batchSize: 1, yardType: "capitalShipyard", requiredStructures: [] },
  battleship: { alloyCost: 4_800, energyCost: 4_200, buildTicks: 1_300, batchSize: 1, yardType: "capitalShipyard", requiredStructures: [] },
};

const STRUCTURE_BASE: Readonly<Record<StructureType, Omit<StructureDefinition, "armorType">>> = {
  commandCore: {
    type: "commandCore", radius: 38, maxHealth: 5_500, maxShield: 1_600,
    alloyCost: 0, energyCost: 0, buildTicks: 1,
    alloyIncome: 3, energyIncome: 12, energyUpkeep: 0, alloyStorage: 1_500, energyStorage: 1_500,
    requiredStructures: [], buildPower: 0, assistRange: 0, sensorRange: 520,
    weaponTypeId: "pointDefense",
    hardpoints: [
      hp(-23, -18, -130, 150, "pointDefense"),
      hp(23, -18, 130, 150, "pointDefense"),
      hp(-23, 18, -50, 150, "pointDefense"),
      hp(23, 18, 50, 150, "pointDefense"),
    ],
  },
  extractor: {
    type: "extractor", radius: 17, maxHealth: 1_050, maxShield: 180,
    alloyCost: 275, energyCost: 80, buildTicks: 180,
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
  alloyRefinery: {
    type: "alloyRefinery", radius: 24, maxHealth: 2_250, maxShield: 620,
    alloyCost: 850, energyCost: 780, buildTicks: 390,
    alloyIncome: 18, energyIncome: 0, energyUpkeep: 28, alloyStorage: 500, energyStorage: 0,
    requiredStructures: ["fleetShipyard", "fusionReactor"], buildPower: 0, assistRange: 0, sensorRange: 340,
  },
  matterForge: {
    type: "matterForge", radius: 33, maxHealth: 4_600, maxShield: 1_850,
    alloyCost: 2_300, energyCost: 2_650, buildTicks: 760,
    alloyIncome: 45, energyIncome: 0, energyUpkeep: 82, alloyStorage: 1_500, energyStorage: 0,
    requiredStructures: ["capitalShipyard", "antimatterReactor"], buildPower: 0, assistRange: 0, sensorRange: 520,
  },
  solarArray: {
    type: "solarArray", radius: 20, maxHealth: 850, maxShield: 120,
    alloyCost: 210, energyCost: 20, buildTicks: 160,
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
    alloyCost: 1_100, energyCost: 750, buildTicks: 520,
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
    alloyCost: 1_100, energyCost: 800, buildTicks: 600,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 16, alloyStorage: 500, energyStorage: 500,
    requiredStructures: ["commandCore", "shipyard"], buildPower: 0, assistRange: 0, sensorRange: 520,
  },
  capitalInfrastructure: {
    type: "capitalInfrastructure", radius: 36, maxHealth: 6_200, maxShield: 2_600,
    alloyCost: 2_100, energyCost: 1_750, buildTicks: 900,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 30, alloyStorage: 900, energyStorage: 1_100,
    requiredStructures: ["advancedFabrication", "fleetShipyard", "fusionReactor", "storage"], buildPower: 0, assistRange: 0, sensorRange: 620,
  },
  capitalShipyard: {
    type: "capitalShipyard", radius: 58, maxHealth: 9_500, maxShield: 4_400,
    alloyCost: 2_800, energyCost: 2_400, buildTicks: 1_100,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 38, alloyStorage: 1_200, energyStorage: 1_400,
    requiredStructures: ["commandCore", "fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 720,
  },
  radarArray: {
    type: "radarArray", radius: 19, maxHealth: 1_250, maxShield: 420,
    alloyCost: 420, energyCost: 360, buildTicks: 240,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 0, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "shipyard"], buildPower: 0, assistRange: 0, sensorRange: 1_050,
  },
  phasedRadarArray: {
    type: "phasedRadarArray", radius: 25, maxHealth: 2_500, maxShield: 900,
    alloyCost: 1_250, energyCost: 1_050, buildTicks: 540,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 0, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["fleetShipyard", "fusionReactor", "radarArray"], buildPower: 0, assistRange: 0, sensorRange: 1_750,
  },
  deepSpaceRadarArray: {
    type: "deepSpaceRadarArray", radius: 34, maxHealth: 4_800, maxShield: 2_100,
    alloyCost: 3_200, energyCost: 2_900, buildTicks: 980,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 0, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["capitalShipyard", "antimatterReactor", "phasedRadarArray"], buildPower: 0, assistRange: 0, sensorRange: 2_800,
  },
  pointDefenseBattery: {
    type: "pointDefenseBattery", radius: 23, maxHealth: 2_600, maxShield: 620,
    alloyCost: 620, energyCost: 430, buildTicks: 320,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 10, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 350,
    weaponTypeId: "pointDefense",
    hardpoints: [
      { localX: -10, localZ: -7, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 10, localZ: -7, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: -10, localZ: 7, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 10, localZ: 7, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: -5, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "autocannon" },
      { localX: 5, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "autocannon" },
    ],
  },
  missileBattery: {
    type: "missileBattery", radius: 28, maxHealth: 3_400, maxShield: 900,
    alloyCost: 1_050, energyCost: 860, buildTicks: 480,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 18, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "shipyard"], buildPower: 0, assistRange: 0, sensorRange: 480,
    weaponTypeId: "torpedo",
    hardpoints: [
      { localX: -11, localZ: -4, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "torpedo" },
      { localX: 0, localZ: 8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "torpedo" },
      { localX: 11, localZ: -4, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "torpedo" },
      { localX: -14, localZ: 9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 14, localZ: 9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
    ],
  },
  railBattery: {
    type: "railBattery", radius: 32, maxHealth: 4_900, maxShield: 1_400,
    alloyCost: 1_750, energyCost: 1_350, buildTicks: 650,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 27, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 590,
    weaponTypeId: "heavyRail",
    hardpoints: [
      { localX: -10, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "heavyRail" },
      { localX: 10, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "heavyRail" },
      { localX: -18, localZ: -8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 18, localZ: -8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
    ],
  },
  plasmaBattery: {
    type: "plasmaBattery", radius: 35, maxHealth: 5_600, maxShield: 2_050,
    alloyCost: 2_150, energyCost: 1_900, buildTicks: 760,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 36, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "fleetShipyard"], buildPower: 0, assistRange: 0, sensorRange: 690,
    weaponTypeId: "plasma",
    hardpoints: [
      { localX: -13, localZ: -9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: 13, localZ: -9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: -13, localZ: 9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: 13, localZ: 9, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: -21, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 21, localZ: 0, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
    ],
  },
  beamBattery: {
    type: "beamBattery", radius: 45, maxHealth: 10_500, maxShield: 5_200,
    alloyCost: 5_200, energyCost: 4_800, buildTicks: 1_450,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 88, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore", "capitalShipyard"], buildPower: 0, assistRange: 0, sensorRange: 950,
    weaponTypeId: "beam",
    hardpoints: [
      { localX: -16, localZ: -8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "beam" },
      { localX: 0, localZ: 13, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "beam" },
      { localX: 16, localZ: -8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "beam" },
      { localX: -23, localZ: 8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: 23, localZ: 8, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "plasma" },
      { localX: -28, localZ: -15, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 28, localZ: -15, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: -28, localZ: 15, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
      { localX: 28, localZ: 15, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "pointDefense" },
    ],
  },
  artilleryBattery: {
    type: "artilleryBattery", radius: 20, maxHealth: 1_600, maxShield: 400,
    alloyCost: 650, energyCost: 450, buildTicks: 330,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 12, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["commandCore"], buildPower: 0, assistRange: 0, sensorRange: 300,
    weaponTypeId: "lightArtillery",
    hardpoints: [
      { localX: 0, localZ: 3, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "lightArtillery" },
    ],
  },
  heavyArtilleryBattery: {
    type: "heavyArtilleryBattery", radius: 28, maxHealth: 4_200, maxShield: 1_200,
    alloyCost: 1_800, energyCost: 1_350, buildTicks: 680,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 42, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["fleetShipyard", "fusionReactor"], buildPower: 0, assistRange: 0, sensorRange: 420,
    weaponTypeId: "siegeArtillery",
    hardpoints: [
      { localX: -8, localZ: 4, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "siegeArtillery" },
      { localX: 8, localZ: 4, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "siegeArtillery" },
    ],
  },
  strategicArtilleryArray: {
    type: "strategicArtilleryArray", radius: 40, maxHealth: 9_000, maxShield: 3_000,
    alloyCost: 5_500, energyCost: 5_200, buildTicks: 1_500,
    alloyIncome: 0, energyIncome: 0, energyUpkeep: 120, alloyStorage: 0, energyStorage: 0,
    requiredStructures: ["capitalShipyard", "antimatterReactor"], buildPower: 0, assistRange: 0, sensorRange: 540,
    weaponTypeId: "strategicArtillery",
    hardpoints: [
      { localX: -12, localZ: 6, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "strategicArtillery" },
      { localX: 12, localZ: 6, yawCenter: 0, yawHalfArc: Math.PI, weaponTypeId: "strategicArtillery" },
    ],
  },
};

export const STRUCTURES: Readonly<Record<StructureType, StructureDefinition>> = Object.fromEntries(
  Object.entries(STRUCTURE_BASE).map(([type, definition]) => [type, { ...definition, armorType: "fortified" as const }]),
) as unknown as Readonly<Record<StructureType, StructureDefinition>>;

export const ALL_SHIP_CLASSES: readonly ShipClass[] = [
  "fighter", "fabricator", "frigate", "bomber", "flakFrigate", "torpedoFrigate",
  "artilleryFrigate", "destroyer", "artilleryDestroyer", "cruiser", "artilleryCruiser", "carrier", "battleship",
];

export const SHIPYARD_TYPES = ["shipyard", "fleetShipyard", "capitalShipyard"] as const;

export const DEFENSIVE_STRUCTURE_TYPES = [
  "pointDefenseBattery", "missileBattery", "railBattery", "plasmaBattery", "beamBattery",
  "artilleryBattery", "heavyArtilleryBattery", "strategicArtilleryArray",
] as const;

export const RESOURCE_EXTRACTOR_TYPES = ["extractor", "deepCoreExtractor", "singularityHarvester"] as const;

export const BUILDABLE_STRUCTURE_TYPES = [
  "extractor", "solarArray", "storage", "fabricator", "shipyard",
  "fleetShipyard", "capitalShipyard",
  "fusionReactor", "deepCoreExtractor",
  "alloyRefinery",
  "antimatterReactor", "singularityHarvester", "matterForge", "quantumStorage",
  "radarArray",
  "phasedRadarArray", "deepSpaceRadarArray",
  ...DEFENSIVE_STRUCTURE_TYPES,
] as const satisfies readonly Exclude<StructureType, "commandCore">[];
