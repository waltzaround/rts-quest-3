import { QuestBattle, distance3, type CombatClass, type Side } from "./quest-combat";
import { ENCOUNTER_EXTENTS, type BattleVolume, type Point3 } from "./quest-simulation";

export const DEMO_VOLUME: BattleVolume = { x: 8.5, minY: 0.12, maxY: 9, z: 6.5 };
export const DEMO_DEFENSES = [
  { type: "plasmaBattery", offset: { x: 0.7, y: -0.7, z: -0.8 } },
  { type: "railBattery", offset: { x: 1.35, y: 0.8, z: 0.85 } },
  { type: "pointDefenseBattery", offset: { x: 0.9, y: 0.45, z: -1.05 } },
] as const;
const BASE_ENCOUNTERS: ReadonlyArray<{ id: number; name: string; detail: string; center: Point3; roster: readonly CombatClass[] }> = [
  { id: 0, name: "ALPHA", detail: "Lower escort battle", center: { x: -0.55, y: 1.8, z: -4.2 }, roster: ["fighter", "fighter", "bomber", "frigate", "destroyer", "cruiser"] },
  { id: 1, name: "BRAVO", detail: "High capital battle", center: { x: 0.5, y: 5, z: 0 }, roster: ["fighter", "bomber", "bomber", "frigate", "battleship"] },
  { id: 2, name: "CHARLIE", detail: "Deep siege battle", center: { x: -0.15, y: 3.2, z: 4.2 }, roster: ["fighter", "bomber", "destroyer", "cruiser", "artilleryCruiser"] },
];

export const DEMO_ENCOUNTERS = BASE_ENCOUNTERS.map(site => ({ ...site, fortified: true, extents: ENCOUNTER_EXTENTS, roster: [...site.roster, ...site.roster, ...site.roster] }));
/** Small unfortified fights bridge the front and put combat above/below the rear areas. */
export const DEMO_SKIRMISHES = [
  { id: 3, name: "CROSSING ONE", detail: "Between Alpha and Bravo", center: { x: -1.1, y: 3.25, z: -2.1 }, roster: ["fighter", "fighter", "fighter", "frigate"] },
  { id: 4, name: "CROSSING TWO", detail: "Between Bravo and Charlie", center: { x: 1.1, y: 4.15, z: 2.1 }, roster: ["fighter", "fighter", "fighter", "frigate"] },
  { id: 5, name: "FRIENDLY HIGH", detail: "Raid above friendly space", center: { x: -4.6, y: 7.7, z: -0.4 }, roster: ["fighter", "fighter", "fighter", "destroyer"] },
  { id: 6, name: "HOSTILE LOW", detail: "Strike below hostile space", center: { x: 4.6, y: 0.85, z: 0.4 }, roster: ["bomber", "bomber", "bomber", "frigate"] },
].map(site => ({ ...site, roster: site.roster as CombatClass[], fortified: false, extents: { x: 1, y: 0.6, z: 0.8 } }));
export const DEMO_COMBAT_SITES = [...DEMO_ENCOUNTERS, ...DEMO_SKIRMISHES];
export const DEMO_TEAM_CAP = DEMO_COMBAT_SITES.reduce((total, site) => total + site.roster.length, 0);
export const DEMO_BASES: readonly Point3[] = [{ x: -7.3, y: 2.8, z: 0 }, { x: 7.3, y: 2.8, z: 0 }];
export function demoSupplyRoute(encounterId: number, side: Side): Point3[] {
  const center = DEMO_COMBAT_SITES[encounterId]!.center, sign = side === 0 ? -1 : 1;
  return [{ x: sign * 6.5, y: 2.8, z: 0 }, { x: sign * 4.7, y: 2.8, z: 0 },
    { x: sign * 3.1, y: center.y, z: center.z }, { x: center.x + sign * 1.6, y: center.y, z: center.z }];
}

/** One front, three main sectors and four smaller depth skirmishes, with replacements physically delivered from rear bases. */
export class QuestDemo {
  round = 1;
  private nextWave = 0;
  private nextDefenses = 0;
  private launches: [number, number] = [0, 0];
  create(): QuestBattle {
    const battle = new QuestBattle(DEMO_VOLUME);
    battle.aiEnabled = false;
    battle.entities = battle.entities.filter(e => e.structureType === "commandCore");
    for (const side of [0, 1] as const) {
      const core = battle.core(side)!;
      core.position = { ...DEMO_BASES[side]! };
      core.previousPosition = { ...core.position }; core.target = { ...core.position }; core.mounts = [];
      const sign = side === 0 ? -1 : 1;
      battle.spawnStructure(side, "capitalShipyard", { x: sign * 6.85, y: 2.45, z: 0.65 });
      battle.spawnStructure(side, "fusionReactor", { x: sign * 7.65, y: 3.2, z: -0.65 });
    }
    battle.deposits = [];
    battle.togglePause(); this.nextWave = this.nextDefenses = 0; this.launches = [0, 0];
    return this.update(battle);
  }
  update(battle: QuestBattle): QuestBattle {
    if (battle.terminal) { this.round++; return this.create(); }
    if (battle.status !== "running") return battle;
    let delivered = false;
    for (const ship of battle.entities) {
      const transit = ship.supplyTransit;
      if (!transit || ship.health <= 0) continue;
      if (distance3(ship.position, transit.route[transit.waypoint]!) > 0.1) continue;
      transit.waypoint++;
      if (transit.waypoint < transit.route.length) ship.target = { ...transit.route[transit.waypoint]! };
      else {
        ship.speed = transit.combatSpeed; delete ship.supplyTransit;
        ship.encounterCenter = DEMO_COMBAT_SITES[ship.encounterId!]!.center;
        ship.encounterExtents = DEMO_COMBAT_SITES[ship.encounterId!]!.extents;
        ship.order = "hold"; delivered = true;
      }
    }
    if (battle.tick < this.nextWave) { if (delivered) this.orderFleets(battle); return battle; }
    this.nextWave = battle.tick + 60;
    for (const encounter of DEMO_COMBAT_SITES) {
      for (const side of [0, 1] as const) {
        if (encounter.fortified && battle.tick >= this.nextDefenses) for (const defense of DEMO_DEFENSES) {
          if (battle.entities.some(e => e.health > 0 && e.side === side && e.encounterId === encounter.id && e.structureType === defense.type)) continue;
          const sign = side === 0 ? -1 : 1;
          const installation = battle.spawnStructure(side, defense.type, {
            x: encounter.center.x + sign * defense.offset.x,
            y: encounter.center.y + defense.offset.y,
            z: encounter.center.z + sign * defense.offset.z,
          });
          installation.encounterId = encounter.id; installation.encounterCenter = encounter.center;
        }
        const missing = [...encounter.roster];
        const fleet = battle.fleet(side).filter(e => e.encounterId === encounter.id);
        for (const ship of fleet) { const i = missing.indexOf(ship.shipClass as CombatClass); if (i >= 0) missing.splice(i, 1); }
        for (const type of missing) {
          if (battle.fleet(side).length >= DEMO_TEAM_CAP) break;
          const n = battle.fleet(side).filter(e => e.encounterId === encounter.id).length;
          const destination = encounter.fortified ? {
            x: encounter.center.x + (side === 0 ? -1 : 1) * (type === "artilleryCruiser" ? 1.8 : 0.9 + Math.floor(n / 6) * 0.35),
            y: encounter.center.y + (Math.floor(n / 3) % 3 - 1) * 0.7,
            z: encounter.center.z + (n % 3 - 1) * 0.95,
          } : {
            x: encounter.center.x + (side === 0 ? -0.55 : 0.55),
            y: encounter.center.y + (n % 2 ? 0.22 : -0.22),
            z: encounter.center.z + (Math.floor(n / 2) - 0.5) * 0.55,
          };
          const launch = battle.tick > 0 || (encounter.fortified && n >= encounter.roster.length - 3);
          const slot = this.launches[side]++ % 48, sign = side === 0 ? -1 : 1;
          const ship = battle.spawnShip(side, type, launch ? {
            x: sign * (6.1 + Math.floor(slot / 16) * 0.55),
            y: 2.8 + (Math.floor(slot / 4) % 4 - 1.5) * 0.4,
            z: (slot % 4 - 1.5) * 0.5,
          } : destination);
          ship.encounterId = encounter.id;
          if (launch) {
            const route = [...demoSupplyRoute(encounter.id, side).slice(1), destination];
            ship.supplyTransit = { route, waypoint: 0, combatSpeed: ship.speed };
            ship.speed = Math.max(0.65, ship.speed * 5); ship.order = "move"; ship.target = { ...route[0]! };
          } else { ship.encounterCenter = encounter.center; ship.encounterExtents = encounter.extents; }
        }
      }
    }
    this.orderFleets(battle);
    if (battle.tick >= this.nextDefenses) this.nextDefenses = battle.tick + 240;
    return battle;
  }
  private orderFleets(battle: QuestBattle): void {
    for (const encounter of DEMO_COMBAT_SITES) for (const side of [0, 1] as const) {
        const enemies = battle.fleet(side === 0 ? 1 : 0).filter(e => e.encounterId === encounter.id && !e.supplyTransit);
        const defenses = battle.entities.filter(e => e.health > 0 && e.side !== side && e.encounterId === encounter.id && e.structureType);
        battle.fleet(side).filter(e => e.encounterId === encounter.id && !e.supplyTransit && !e.playerControlled).forEach((ship, i) => {
          const targets = defenses.length && (ship.shipClass === "artilleryCruiser" || ship.shipClass === "battleship" || i % 4 === 0) ? defenses : enemies;
          const target = targets[i % targets.length];
          if (target) battle.issue(side, [ship.id], "focus", undefined, target.id);
        });
    }
  }
}
