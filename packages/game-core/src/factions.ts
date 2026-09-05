import { ALL_SHIP_CLASSES, SHIPS, SHIP_ECONOMY, SHIPYARD_TYPES, STRUCTURES } from "./data";
import type { FactionId, ShipClass, ShipDefinition, ShipEconomyDefinition, ShipyardType, StructureDefinition, StructureType } from "./types";

export const FACTION_IDS = ["industrial", "brood", "concord"] as const;
export const FACTIONS: Readonly<Record<FactionId, {
  name: string; description: string; color: number; ships: readonly ShipClass[];
}>> = {
  industrial: {
    name: "Industrial", color: 0xa9c4db,
    description: "Flexible fleets. Pay for each batch; expand shipyards to increase production.",
    ships: ALL_SHIP_CLASSES,
  },
  brood: {
    name: "Brood", color: 0xbb75e8,
    description: "Specialized nests maintain a capped army for free. Creep grants +20% speed and +10% damage.",
    ships: ["fighter", "fabricator", "frigate", "bomber", "flakFrigate", "destroyer", "battleship"],
  },
  concord: {
    name: "Concord", color: 0x63ebdc,
    description: "Elite shielded fleets warp from factories into pylon fields, gaining shield resistance and recharge.",
    ships: ["fighter", "fabricator", "frigate", "torpedoFrigate", "artilleryFrigate", "destroyer", "battleship"],
  },
};

export const BROOD_CAPACITY: Readonly<Record<ShipClass, number>> = {
  fighter: 12, fabricator: 2, frigate: 4, bomber: 6, flakFrigate: 4,
  torpedoFrigate: 4, artilleryFrigate: 3, destroyer: 3, artilleryDestroyer: 2,
  cruiser: 2, artilleryCruiser: 1, carrier: 1, battleship: 1,
};

const SHIP_NAMES: Partial<Record<FactionId, Partial<Record<ShipClass, string>>>> = {
  brood: { fighter: "Drone Swarm", fabricator: "Seeder", frigate: "Spitter", bomber: "Ravager",
    flakFrigate: "Spore Guardian", destroyer: "Behemoth", battleship: "Leviathan" },
  concord: { fighter: "Shard Wing", fabricator: "Architect", frigate: "Sentinel",
    torpedoFrigate: "Lancer", artilleryFrigate: "Oracle", destroyer: "Arbiter", battleship: "Sovereign" },
};

export function factionShipName(shipClass: ShipClass, faction: FactionId = "industrial"): string | undefined {
  return SHIP_NAMES[faction]?.[shipClass];
}

export const ECONOMY_STRUCTURE_TYPES = [
  "extractor", "deepCoreExtractor", "singularityHarvester", "alloyRefinery", "matterForge",
  "solarArray", "fusionReactor", "antimatterReactor", "storage", "quantumStorage",
  "fabricator", "advancedFabrication", "capitalInfrastructure",
] as const satisfies readonly StructureType[];
export type EconomyStructureType = typeof ECONOMY_STRUCTURE_TYPES[number];

const ECONOMY_PRESENTATION: Record<"brood" | "concord", Record<EconomyStructureType, readonly [name: string, description: string]>> = {
  brood: {
    extractor: ["Mineral Maw", "A rooted feeding maw draws alloy from a mineral deposit."],
    deepCoreExtractor: ["Deep Siphon", "Deep tendrils feed mineral-rich fluid into paired digestion glands."],
    singularityHarvester: ["World Feeder", "Three linked maws consume a deposit at an industrial scale."],
    alloyRefinery: ["Digestor", "Paired digestive sacs convert energy into alloy without a deposit."],
    matterForge: ["Crucible Organ", "A towering metabolic crucible produces alloy without a deposit."],
    solarArray: ["Sunleaf Colony", "Broad photosynthetic fronds harvest starlight for energy."],
    fusionReactor: ["Bio Dynamo", "Twin living hearts generate energy inside a ribbed carapace."],
    antimatterReactor: ["Starheart", "A massive caged heart powers the late-game hive."],
    storage: ["Nutrient Sacs", "A cluster of armored sacs stores alloy and energy."],
    quantumStorage: ["Brood Reservoir", "A mature reservoir holds expanded alloy and energy reserves."],
    fabricator: ["Growth Organ", "Branching growth limbs construct and assist nearby buildings."],
    advancedFabrication: ["Evolution Chamber", "A protected neural organ unlocks advanced hive infrastructure."],
    capitalInfrastructure: ["Leviathan Cortex", "An elevated cortical nexus supports capital-scale hive infrastructure."],
  },
  concord: {
    extractor: ["Prism Tap", "A suspended prism focuses extraction into a mineral deposit."],
    deepCoreExtractor: ["Resonance Well", "Nested lenses draw alloy through a resonant mineral well."],
    singularityHarvester: ["Singularity Lens", "Orbital lenses concentrate extraction from a mineral deposit."],
    alloyRefinery: ["Matter Distillery", "Aligned prisms convert energy into alloy without a deposit."],
    matterForge: ["Transmutation Spire", "A vertical transmutation lattice produces alloy without a deposit."],
    solarArray: ["Heliostat", "Three reflective sails focus starlight into energy."],
    fusionReactor: ["Flux Resonator", "Interlocking resonance rings generate a steady energy supply."],
    antimatterReactor: ["Zero-Point Nexus", "A contained singularity supplies late-game energy."],
    storage: ["Phase Vault", "Sealed prism vaults store alloy and energy."],
    quantumStorage: ["Tesseract Vault", "Nested containment frames hold expanded alloy and energy reserves."],
    fabricator: ["Assembly Loom", "Three field arms construct and assist nearby buildings."],
    advancedFabrication: ["Genesis Loom", "A paired assembly lattice unlocks advanced Concord infrastructure."],
    capitalInfrastructure: ["Ascension Matrix", "A towering crystal matrix supports capital-scale Concord infrastructure."],
  },
};

export function factionStructureDescription(type: StructureType, faction: FactionId = "industrial"): string | undefined {
  return faction === "industrial" ? undefined : ECONOMY_PRESENTATION[faction][type as EconomyStructureType]?.[1];
}

export function factionStructureName(type: StructureType, faction: FactionId = "industrial"): string | undefined {
  if (faction !== "industrial") {
    const economy = ECONOMY_PRESENTATION[faction][type as EconomyStructureType];
    if (economy) return economy[0];
  }
  if (faction === "brood") return ({ commandCore: "Hive Core", shipyard: "Brood Nest", fleetShipyard: "Greater Nest", capitalShipyard: "Leviathan Nest" } as Partial<Record<StructureType, string>>)[type];
  if (faction === "concord") return ({ commandCore: "Nexus Core", shipyard: "Warp Foundry", fleetShipyard: "Fleet Foundry", capitalShipyard: "Sovereign Foundry" } as Partial<Record<StructureType, string>>)[type];
  return undefined;
}

export function factionAllowsStructure(faction: FactionId, type: StructureType): boolean {
  return type === "creepNode" ? faction === "brood" : type === "pylon" ? faction === "concord" : true;
}

const shipDefinitions = Object.fromEntries(FACTION_IDS.map((faction) => [faction,
  Object.fromEntries(ALL_SHIP_CLASSES.map((shipClass) => {
    const base = SHIPS[shipClass];
    const definition = faction === "brood" ? {
      ...base, maxHealth: Math.round(base.maxHealth * 0.9), maxShield: 0, speed: base.speed * 1.1,
    } : faction === "concord" ? {
      ...base, maxHealth: Math.round(base.maxHealth * 0.85), maxShield: Math.round(base.maxShield * 2), speed: base.speed * 0.9,
    } : base;
    return [shipClass, definition];
  })),
])) as Record<FactionId, Record<ShipClass, ShipDefinition>>;

const economies = Object.fromEntries(FACTION_IDS.map((faction) => [faction,
  Object.fromEntries(ALL_SHIP_CLASSES.map((shipClass) => {
    const base = SHIP_ECONOMY[shipClass];
    return [shipClass, faction === "industrial" ? base : {
      ...base, batchSize: 1,
      alloyCost: faction === "brood" ? 0 : Math.ceil(base.alloyCost / base.batchSize * 1.4),
      energyCost: faction === "brood" ? 0 : Math.ceil(base.energyCost / base.batchSize * 1.4),
      buildTicks: Math.ceil(base.buildTicks / base.batchSize * (faction === "brood" ? 2 : 1.4)),
    }];
  })),
])) as Record<FactionId, Record<ShipClass, ShipEconomyDefinition>>;

// Specialization makes every new role a separate investment. Keep the opening
// nest affordable; advanced nests retain a larger premium for free replacements.
const BROOD_NEST_COST_MULTIPLIERS: Record<ShipyardType, number> = {
  shipyard: 1.5, fleetShipyard: 2, capitalShipyard: 2,
};
const broodStructures = Object.fromEntries(Object.entries(STRUCTURES).map(([type, definition]) => [type,
  (SHIPYARD_TYPES as readonly string[]).includes(type) ? {
    ...definition,
    alloyCost: Math.ceil(definition.alloyCost * BROOD_NEST_COST_MULTIPLIERS[type as ShipyardType]),
    energyCost: Math.ceil(definition.energyCost * BROOD_NEST_COST_MULTIPLIERS[type as ShipyardType]),
    buildTicks: definition.buildTicks * 2,
  } : definition,
])) as Record<StructureType, StructureDefinition>;

export function getFactionShipDefinition(shipClass: ShipClass, faction: FactionId = "industrial"): ShipDefinition {
  return shipDefinitions[faction][shipClass];
}

export function getFactionShipEconomy(shipClass: ShipClass, faction: FactionId = "industrial"): ShipEconomyDefinition {
  return economies[faction][shipClass];
}

export function getFactionStructureDefinition(type: StructureType, faction: FactionId = "industrial"): StructureDefinition {
  return faction === "brood" ? broodStructures[type] : STRUCTURES[type];
}
