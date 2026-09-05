import { distanceSquared } from "@space-rts/shared";
import { FACTIONS, getFactionShipDefinition } from "./factions";
import { SHIPS, SHIPYARD_TYPES, RESOURCE_EXTRACTOR_TYPES, STRUCTURES, WEAPONS } from "./data";
import { isInTerritory } from "./territory";
import type { GameSimulation } from "./simulation";
import type { AiCommanderSettings, AiPlanState, GameCommand, PlayerState, ShipClass, ShipState, ShipyardType, StructureState, TerritoryFieldState } from "./types";

type Point = { x: number; z: number };
interface InfrastructureActions {
  countConstruction(): number;
  economy(): void;
  infrastructure(): void;
  defenses(): void;
  industrialRoster(yard: ShipyardType, hasBuilder: boolean): readonly ShipClass[];
}
type UnsequencedCommand = GameCommand extends infer C ? C extends GameCommand
  ? Omit<C, "playerId" | "sequence" | "requestedTick"> : never : never;
const distance = (a: Point, b: Point) => Math.sqrt(distanceSquared(a, b));
const toward = (a: Point, b: Point, amount: number): Point => {
  const length = distance(a, b) || 1;
  return { x: a.x + (b.x - a.x) / length * amount, z: a.z + (b.z - a.z) / length * amount };
};

/** All actions go through the same validation and command queue as a human. */
export function runAiStrategy(
  simulation: GameSimulation, player: PlayerState, settings: AiCommanderSettings,
  thinkTicks: number, actions: InfrastructureActions,
): void {
  new Commander(simulation, player, settings, thinkTicks, actions).think();
}

class Commander {
  private readonly state;
  private readonly ships;
  private readonly structures;
  private readonly yards;
  private readonly builders;
  private readonly fleet;
  private readonly visibleIds;
  private readonly enemies;
  private readonly enemyStructures;
  private readonly fields;
  private readonly core;
  private readonly plan: AiPlanState;

  constructor(
    private readonly simulation: GameSimulation, private readonly player: PlayerState,
    private readonly settings: AiCommanderSettings, private readonly thinkTicks: number,
    private readonly actions: InfrastructureActions,
  ) {
    this.state = simulation.state;
    this.ships = this.state.ships.filter((ship) => ship.ownerPlayerId === player.id);
    this.structures = this.state.structures.filter((structure) => structure.ownerPlayerId === player.id);
    this.yards = this.structures.filter((structure) => structure.buildProgress >= 1
      && SHIPYARD_TYPES.includes(structure.type as ShipyardType));
    this.builders = this.ships.filter((ship) => SHIPS[ship.class].buildPower > 0);
    this.fleet = this.ships.filter((ship) => SHIPS[ship.class].buildPower === 0);
    this.visibleIds = new Set(this.state.visibility.find((view) => view.teamId === player.teamId)?.visibleEntityIds ?? []);
    const allies = new Set([player.teamId, ...(this.state.teams.find((team) => team.id === player.teamId)?.alliedTeamIds ?? [])]);
    this.enemies = this.state.ships.filter((ship) => !allies.has(ship.teamId) && this.visibleIds.has(ship.id));
    this.enemyStructures = this.state.structures.filter((structure) => !allies.has(structure.teamId) && this.visibleIds.has(structure.id));
    this.fields = this.state.territories.filter((field) => field.ownerPlayerId === player.id);
    this.core = this.structures.find((structure) => structure.type === "commandCore");
    this.state.aiPlans ??= {};
    if (!Object.hasOwn(this.state.aiPlans, player.id)) Object.defineProperty(this.state.aiPlans, player.id, {
      value: { knownStructures: [], searchIndex: 0, recoveringShipIds: [] }, enumerable: true, writable: true,
    });
    this.plan = this.state.aiPlans[player.id]!;
  }

  private issue(command: UnsequencedCommand): boolean {
    return this.simulation.submitCommand({ ...command, playerId: this.player.id,
      sequence: this.player.lastCommandSequence + 1, requestedTick: this.state.tick + 1 } as GameCommand).accepted;
  }

  think(): void {
    if (!this.core) return;
    this.rememberIntelligence();
    const target = this.objective();
    this.maintainConstruction();
    for (const builder of this.freeBuilders()) {
      if (distance(builder, this.core) > 300) this.order(builder, this.core, "move");
      else if (builder.orders.length && builder.orders[0]?.type !== "hold") this.issue({ type: "hold", unitIds: [builder.id], queued: false });
    }
    this.production();
    this.construction(target);
    this.deployment(target);
    this.military(target);
  }

  private rememberIntelligence(): void {
    // Forget a vanished contact only after our sensors revisit its last position.
    // Never query hidden enemy health, orders, economy, or live coordinates.
    const sensors = [
      ...this.ships.map((ship) => ({ ...ship, range: SHIPS[ship.class].sensorRange })),
      ...this.structures.filter((structure) => structure.buildProgress >= 1)
        .map((structure) => ({ ...structure, range: STRUCTURES[structure.type].sensorRange })),
    ];
    this.plan.knownStructures = this.plan.knownStructures.filter((known) =>
      this.enemyStructures.some((structure) => structure.id === known.id)
      || !sensors.some((sensor) => distance(sensor, known) < sensor.range - 60));
    for (const structure of this.enemyStructures) {
      const known = this.plan.knownStructures.find((entry) => entry.id === structure.id);
      if (known) { known.x = structure.x; known.z = structure.z; }
      else this.plan.knownStructures.push({ id: structure.id, type: structure.type, x: structure.x, z: structure.z });
    }
    this.plan.knownStructures.sort((a, b) => a.id - b.id);
    this.plan.recoveringShipIds = this.plan.recoveringShipIds.filter((id) => this.ships.some((ship) => ship.id === id));
  }

  private objective(): Point & { id?: number; type?: string } {
    const priority = (type: string) => type === "commandCore" ? 0 : type.includes("Shipyard") || type === "shipyard" ? 1 : 2;
    const known = [...this.plan.knownStructures].sort((a, b) => priority(a.type) - priority(b.type)
      || distanceSquared(this.core!, a) - distanceSquared(this.core!, b) || a.id - b.id)[0];
    return known ?? this.searchDestination();
  }

  private searchDestination(): Point {
    const guesses = [0, -0.3, 0.3, -0.6, 0.6, -1.1, 1.1];
    const guess = (): Point => {
      const angle = Math.atan2(this.core!.x, this.core!.z) + Math.PI + guesses[this.plan.searchIndex % guesses.length]!;
      const radius = Math.hypot(this.core!.x, this.core!.z);
      return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
    };
    let destination = guess();
    if (this.fleet.some((ship) => distance(ship, destination) < 150)) {
      this.plan.searchIndex++;
      destination = guess();
    }
    return destination;
  }

  private production(): void {
    const counts = (shipClass: ShipClass) => this.ships.filter((ship) => ship.class === shipClass).length
      + this.yards.reduce((sum, yard) => sum + yard.productionQueue.filter((item) => item.shipClass === shipClass).length, 0);
    const builderTarget = 1 + Math.floor(this.yards.length / 3);
    for (const yard of this.yards) {
      if (yard.broodClass !== undefined) continue;
      const reserve = this.actions.countConstruction() > 0 && this.builders.length > 0 && this.fleet.length > 3;
      const depth = reserve ? 1 : this.settings.difficulty === "easy" ? 1 : this.settings.difficulty === "hard" ? 4 : 3;
      if (yard.productionQueue.length >= depth) continue;
      let roster: readonly ShipClass[];
      if (this.player.faction === "brood") {
        const nests = this.yards.filter((candidate) => candidate.type === yard.type && candidate.broodClass !== undefined);
        if (yard.type === "shipyard" && !nests.some((nest) => nest.broodClass !== "fabricator")) roster = ["fighter"];
        else if (yard.type === "shipyard" && !nests.some((nest) => nest.broodClass === "fabricator")) roster = ["fabricator"];
        else roster = yard.type === "shipyard" ? ["bomber", "frigate", "fighter", "fighter"]
          : yard.type === "fleetShipyard" ? ["flakFrigate", "destroyer", "destroyer"] : ["battleship"];
        // A nest is a permanent production investment, so balance specialties
        // across existing nests rather than reacting to temporary casualty counts.
        const weights = new Map(roster.map((type) => [type, roster.filter((value) => value === type).length]));
        roster = [...weights.keys()].sort((a, b) =>
          nests.filter((nest) => nest.broodClass === a).length / weights.get(a)!
          - nests.filter((nest) => nest.broodClass === b).length / weights.get(b)!);
      } else if (yard.type === "shipyard" && counts("fabricator") < builderTarget) roster = ["fabricator"];
      else if (this.player.faction === "concord") {
        roster = yard.type === "shipyard" ? ["fighter", "fighter", "frigate", "frigate", "artilleryFrigate"]
          : yard.type === "fleetShipyard" ? ["destroyer", "destroyer", "torpedoFrigate"] : ["battleship"];
        if (yard.type === "shipyard" && this.fleet.length < 4) roster = ["fighter", "frigate"];
        const weights = new Map(roster.map((type) => [type, roster.filter((value) => value === type).length]));
        roster = [...weights.keys()].sort((a, b) => counts(a) / weights.get(a)! - counts(b) / weights.get(b)!);
      } else {
        const choices = this.actions.industrialRoster(yard.type as ShipyardType, counts("fabricator") > 0);
        const offset = (this.ships.length + yard.id + this.state.tick / this.thinkTicks) % choices.length | 0;
        roster = [...choices.slice(offset), ...choices.slice(0, offset)];
      }
      const shipClass = roster.find((type) => FACTIONS[this.player.faction].ships.includes(type)
        && this.simulation.canStructureProduceShipClass(this.player.id, yard.id, type));
      if (shipClass) this.issue({ type: "queueUnit", structureId: yard.id, shipClass, count: 1 });
    }
  }

  private construction(target: Point): void {
    if (this.state.tick % (this.thinkTicks * 3) !== 0 || this.actions.countConstruction() > 0) return;
    const extractors = this.structures.filter((structure) => RESOURCE_EXTRACTOR_TYPES.includes(structure.type as typeof RESOURCE_EXTRACTOR_TYPES[number]));
    const cycle = Math.floor(this.state.tick / (this.thinkTicks * 3));
    if (extractors.length < 3) this.actions.economy();
    else if (this.player.economy.energy < this.player.economy.energyStorage * 0.12
      && this.player.economy.efficiency < 0.9) this.actions.economy();
    else if (this.player.faction === "brood" && !this.yards.some((yard) => yard.broodClass === "fabricator")) this.actions.infrastructure();
    else if (this.builders.length > 0 && this.settings.personality !== "economic"
      && !this.structures.some((structure) => structure.type === "pointDefenseBattery")) this.actions.defenses();
    else if (this.player.faction !== "industrial" && cycle % 3 === 0) this.extendTerritory(target);
    else if (cycle % 2 === 0) this.actions.economy();
    else this.actions.infrastructure();
    if (this.actions.countConstruction() === 0) this.actions.infrastructure();
    if (this.actions.countConstruction() === 0) this.actions.economy();
    if (this.actions.countConstruction() === 0 && this.player.faction !== "industrial") this.extendTerritory(target);
  }

  private maintainConstruction(): void {
    this.plan.blockedSites = (this.plan.blockedSites ?? []).filter((site) => site.untilTick > this.state.tick);
    const pending = this.state.commandQueue.find((command) => command.playerId === this.player.id && command.type === "buildStructure");
    const site = this.structures.find((structure) => structure.buildProgress < 1);
    if ((!pending || pending.type !== "buildStructure") && !site) { delete this.plan.constructionWatch; return; }
    const position = pending?.type === "buildStructure" ? pending.position : site!;
    const assigned = pending?.type === "buildStructure" ? this.builders.filter((builder) => pending.builderUnitIds?.includes(builder.id)) : [];
    const key = pending ? `order:${pending.sequence}` : `site:${site!.id}`;
    const progress = pending ? -Math.min(100_000, ...assigned.map((builder) => distance(builder, position))) : site!.buildProgress * 10_000;
    const watch = this.plan.constructionWatch;
    if (!watch || watch.key !== key || progress > watch.progress + 10) {
      this.plan.constructionWatch = { key, progress, lastProgressTick: this.state.tick };
      return;
    }
    if (this.state.tick - watch.lastProgressTick < 1_200) return;
    if (pending) this.issue({ type: "cancelBuildOrder", buildSequence: pending.sequence });
    else this.issue({ type: "cancelConstruction", structureId: site!.id });
    this.plan.blockedSites.push({ x: position.x, z: position.z, untilTick: this.state.tick + 2_400 });
    delete this.plan.constructionWatch;
  }

  private freeBuilders(): ShipState[] {
    const reserved = new Set(this.state.commandQueue.flatMap((command) => command.type === "buildStructure" ? command.builderUnitIds ?? [] : []));
    return this.builders.filter((ship) => !reserved.has(ship.id)
      && !ship.orders.some((order) => order.constructionId !== undefined));
  }

  private extendTerritory(target: Point): void {
    const kind = this.player.faction === "brood" ? "creep" : "pylon";
    const type = kind === "creep" ? "creepNode" : "pylon";
    const fields = this.fields.filter((field) => field.kind === kind);
    const uncovered = kind === "creep" ? this.yards.find((yard) => !isInTerritory(fields, this.player.id, kind, yard)) : undefined;
    const goal = uncovered ?? target;
    const anchor = [...fields].sort((a, b) => distanceSquared(a, goal) - distanceSquared(b, goal) || a.id - b.id)[0];
    if (!anchor || (!uncovered && distance(anchor, goal) < (kind === "pylon" ? 330 : 180))) return;
    const range = Math.min(distance(anchor, goal), kind === "creep" ? Math.min(anchor.radius - 25, 235) : 250);
    if (range < 120) return;
    const angle = Math.atan2(goal.x - anchor.x, goal.z - anchor.z);
    for (const offset of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
      const position = { x: anchor.x + Math.sin(angle + offset) * range, z: anchor.z + Math.cos(angle + offset) * range };
      if (this.plan.blockedSites?.some((site) => distance(site, position) < 125)) continue;
      if (this.structures.some((structure) => structure.type === type && distance(structure, position) < 125)) continue;
      const builder = this.freeBuilders().sort((a, b) => distanceSquared(a, position) - distanceSquared(b, position) || a.id - b.id)[0];
      const builderUnitIds = builder ? [builder.id] : [];
      if (!this.simulation.canPlaceStructure(this.player.id, type, position, undefined, builderUnitIds)) continue;
      // Advance a defended supply line; do not send an isolated builder into a visible army.
      const enemies = this.enemies.filter((ship) => distance(ship, position) < 450);
      if (enemies.length > this.fleet.filter((ship) => distance(ship, position) < 600).length + 1) continue;
      if (this.issue({ type: "buildStructure", structureType: type, position, builderUnitIds, queued: false })) return;
    }
  }

  private forwardField(target: Point): TerritoryFieldState | undefined {
    return [...this.fields].sort((a, b) => distanceSquared(a, target) - distanceSquared(b, target) || a.id - b.id)[0];
  }

  private deployment(target: Point): void {
    const field = this.forwardField(target);
    for (const yard of this.yards) {
      const point = field ? toward(field, target, Math.min(110, field.radius * 0.45))
        : this.route(yard, target);
      if (this.player.faction === "concord" && field
        && (!yard.warpPoint || distance(yard.warpPoint, point) > 40)) {
        this.issue({ type: "setWarpPoint", structureId: yard.id, position: point });
      }
      if (distance(yard.rallyPoint, point) > 60) this.issue({ type: "setRallyPoint", structureId: yard.id, position: point });
    }
  }

  private route(ship: Point, goal: Point): Point {
    if (this.state.mapPreset !== "amazon-tunnel") return goal;
    const radius = Math.max(...this.state.obstacles.map((obstacle) => Math.abs(obstacle.x))) / 1.08;
    // Enter the crossing from this unit's side only when crossing sides. A unit
    // already in the enemy half must not be redirected back to the middle.
    return Math.sign(ship.x) !== Math.sign(goal.x) && Math.abs(ship.z) > radius * 0.12
      ? { x: Math.sign(ship.x) * radius * 0.82, z: 0 } : goal;
  }

  private order(ship: ShipState, goal: Point, type: "move" | "attackMove" | "patrol" = "attackMove"): void {
    const destination = this.route(ship, goal);
    const order = ship.orders[0];
    if (order?.type === type && distance(order.destination, destination) < 45) return;
    if (!order && distance(ship, destination) < 18) return;
    // Individual destinations retain a bounded formation even for hundreds of
    // ships; the old whole-fleet grid could spread units thousands of units wide.
    this.issue({ type, unitIds: [ship.id], destination, queued: false });
  }

  private military(target: Point & { id?: number; type?: string }): void {
    const scoutLimit = this.settings.difficulty === "easy" ? 1 : this.settings.difficulty === "hard" ? 3 : 2;
    const scouts = target.type !== "commandCore" ? [...this.fleet].filter((ship) => ["fighter", "frigate", "bomber"].includes(ship.class))
      .sort((a, b) => Number(a.class !== "fighter") - Number(b.class !== "fighter") || a.id - b.id).slice(0, scoutLimit) : [];
    const scoutTarget = scouts.length ? this.searchDestination() : target;
    const field = this.forwardField(target);
    const threshold = this.settings.personality === "aggressive" ? 3 : this.settings.personality === "turtle" ? 10 : 5;
    const visibleCoreThreats = this.enemies.filter((enemy) => distance(enemy, this.core!) < 600);
    const defenseTarget = visibleCoreThreats.sort((a, b) => distanceSquared(a, this.core!) - distanceSquared(b, this.core!) || a.id - b.id)[0];
    const canPush = this.fleet.length >= Math.max(this.player.faction === "brood" ? 18 : 12, this.enemies.length * 1.6 + 6);
    const defendingIds = new Set(defenseTarget ? [...this.fleet].sort((a, b) => distanceSquared(a, this.core!) - distanceSquared(b, this.core!) || a.id - b.id)
      .slice(0, Math.min(8, Math.ceil(this.fleet.length * 0.35))).map((ship) => ship.id) : []);
    for (const ship of this.fleet) {
      if (this.player.faction === "concord" && this.recover(ship, target)) continue;
      if (scouts.includes(ship)) {
        this.order(ship, { x: scoutTarget.x + (scouts.indexOf(ship) - 0.5) * 120, z: scoutTarget.z }, "patrol");
        continue;
      }
      if (defenseTarget && defendingIds.has(ship.id)) { this.order(ship, defenseTarget); continue; }
      const offsetAngle = (ship.id % 12) * Math.PI / 6;
      let goal = { x: target.x + Math.cos(offsetAngle) * 45, z: target.z + Math.sin(offsetAngle) * 45 };
      let mode: "move" | "attackMove" = "attackMove";
      if (this.fleet.length < threshold && distance(ship, this.core!) < 500) {
        goal = field ? toward(field, target, field.radius * 0.35) : toward(this.core!, target, 350);
        mode = "move";
      }
      else if (this.player.faction === "brood" && field && distance(field, target) > 550 && !canPush
        && ship.class !== "bomber" && !scouts.includes(ship)) {
        goal = toward(field, target, Math.min(165, field.radius * 0.65));
        goal = { x: goal.x + Math.cos(offsetAngle) * 30, z: goal.z + Math.sin(offsetAngle) * 30 };
        mode = "move";
      }
      else if (this.player.faction === "concord" && field && distance(field, target) > 550 && !canPush) {
        goal = toward(field, target, Math.min(145, field.radius * 0.55));
        goal = { x: goal.x + Math.cos(offsetAngle) * 35, z: goal.z + Math.sin(offsetAngle) * 35 };
        mode = "move"; // Shard Wings must not dogfight outside the protected staging field.
      } else if (target.id !== undefined) {
        const artillery = SHIPS[ship.class].hardpoints.map((hp) => WEAPONS[hp.weaponTypeId]).find((weapon) => weapon.artillery);
        if (artillery) goal = toward(target, this.core!, artillery.range * 0.8);
        else if (ship.class !== "fighter" && ship.class !== "bomber") goal = toward(target, this.core!, 140 + ship.id % 4 * 20);
      }
      this.order(ship, goal, mode);
      if (target.id !== undefined && this.visibleIds.has(target.id) && distance(ship, target) < 750
        && ship.focusTargetEntityId !== target.id && (ship.class !== "fighter" || this.enemies.length < 3)) {
        this.issue({ type: "focusFire", unitIds: [ship.id], targetEntityId: target.id, queued: false });
      }
    }
  }

  private recover(ship: ShipState, target: Point): boolean {
    const definition = getFactionShipDefinition(ship.class, "concord");
    const wasRecovering = this.plan.recoveringShipIds.includes(ship.id);
    if (!wasRecovering && ship.shields >= definition.maxShield * 0.25) return false;
    if (wasRecovering && ship.shields >= definition.maxShield * 0.85) {
      this.plan.recoveringShipIds = this.plan.recoveringShipIds.filter((id) => id !== ship.id);
      return false;
    }
    const field = [...this.fields].sort((a, b) => {
      const score = (candidate: Point) => distance(ship, candidate)
        + this.enemies.filter((enemy) => distance(enemy, candidate) < 450).length * 250;
      return score(a) - score(b) || a.id - b.id;
    })[0];
    if (!field) return false;
    if (!wasRecovering) { this.plan.recoveringShipIds.push(ship.id); this.plan.recoveringShipIds.sort((a, b) => a - b); }
    const point = toward(field, target, -Math.min(100, field.radius * 0.4));
    this.order(ship, point, "move");
    if (distance(ship, point) < 35 && ship.orders[0]?.type !== "hold") this.issue({ type: "hold", unitIds: [ship.id], queued: false });
    return true;
  }
}
