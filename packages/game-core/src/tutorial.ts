import { SHIPS, STRUCTURES, WEAPONS } from "./data";
import { createCombatScenario, GameSimulation } from "./simulation";
import type { GameCommand, ShipClass, SimulationEvent, SimulationState, StructureType } from "./types";

export const TUTORIAL_PLAYER_ID = "tutorial-commander";
const OPPONENT_ID = "tutorial-targets";
export const TUTORIAL_BASE = { x: -650, z: 0 };
const RENDEZVOUS = { x: -410, z: 160 };

export interface TutorialLesson {
  id: string;
  chapter: string;
  title: string;
  body: string;
  tip: string;
  goals: readonly { id: string; label: string }[];
  highlight?: string;
}

const goal = (id: string, label: string) => ({ id, label });
export const TUTORIAL_LESSONS: readonly TutorialLesson[] = [
  { id: "welcome", chapter: "Orientation", title: "Welcome, Commander",
    body: "Win a battle by destroying every opposing Command Core while protecting your own. This practice sector has no attacking AI. Learn at your own pace, then fight a small training force.",
    tip: "Complete each checklist, then press Continue. Skip any lesson, use Locate to find its subject, or restart from MENU. Space pauses. Practice supplies are available if you run short.",
    goals: [] },
  { id: "camera", chapter: "Orientation", title: "Read the battlefield",
    body: "Pan with the arrow keys or screen edges. Scroll to zoom between ships and the tactical view. Hold the middle mouse button and drag to rotate. Click the minimap to travel across the map.",
    tip: "Shift + middle-drag also pans; Shift speeds up keyboard panning. Locate returns you to the lesson. Use \\ for fullscreen.",
    goals: [goal("pan", "Pan the camera"), goal("zoom", "Zoom in or out"), goal("rotate", "Rotate with middle-drag"), goal("minimap", "Click the minimap")], highlight: "minimap" },
  { id: "selection", chapter: "Fleet control", title: "Select your fleet",
    body: "Left-click a friendly ship to select it, or drag a box around several ships. Shift-click adds or removes ships. Double-click selects nearby ships of the same class. The command card below changes with your selection.",
    tip: "The selection roster lets you choose individual ships; Ctrl-click a roster entry selects its class. Locate shows your starting frigates.",
    goals: [goal("fleet", "Select at least two friendly ships")], highlight: "fleet-controls" },
  { id: "move", chapter: "Fleet control", title: "Move to the beacon",
    body: "With ships selected, right-click the cyan beacon to move there. You can also press M, then left-click a destination. Your ships keep their formation and steer around solid obstacles.",
    tip: "The objective completes when at least two ships arrive. Ships accelerate into cruise after a quiet period; combat interrupts cruise.",
    goals: [goal("move", "Issue a move order"), goal("arrive", "Bring two ships to the beacon")], highlight: "cmd-move" },
  { id: "formation", chapter: "Fleet control", title: "Shape a formation",
    body: "Hold the right mouse button at a destination, drag a line, then release. The preview shows where each selected ship will go and how the formation will face.",
    tip: "Select several ships first. A broad line spreads your weapons; a compact formation is easier to steer through gaps.",
    goals: [goal("formation", "Right-drag a formation move")], highlight: "cmd-move" },
  { id: "waypoints", chapter: "Fleet control", title: "Queue a route",
    body: "Hold Shift while right-clicking to append a waypoint instead of replacing the current order. Queue two destinations to take a safe route around hazards.",
    tip: "Shift also queues attack-move and patrol orders. A normal order replaces the old route; S clears it.",
    goals: [goal("waypoint1", "Queue a waypoint with Shift"), goal("waypoint2", "Queue a second waypoint")] },
  { id: "orders", chapter: "Fleet control", title: "Patrol, stop, and hold",
    body: "P then click sets a patrol between the current position and a destination. S stops and clears orders. H holds position with weapons free, preventing the fleet from chasing targets.",
    tip: "Try each command on your selected ships. Finish with Hold so they stay nearby while you build.",
    goals: [goal("patrol", "Set a patrol (P, then click)"), goal("stop", "Stop the fleet (S)"), goal("hold", "Hold position (H)")], highlight: "fleet-controls" },
  { id: "groups", chapter: "Fleet control", title: "Remember a control group",
    body: "Select your fleet and press Ctrl + 1–9 to save it as a group. Press that number to recall the ships. Double-tap the number to focus the camera on them.",
    tip: "Factories and other buildings can also use control groups: select them, save a number, and recall it to manage their build cards or production. Keep combat ships, builders, and factories in separate groups.",
    goals: [goal("group-set", "Save a nonempty control group"), goal("group-recall", "Recall that control group")] },
  { id: "core", chapter: "Economy", title: "Your Command Core",
    body: "Locate and select your large Command Core. It supplies a small baseline income, storage, sensors, and a construction area. Completed stationary Fabricators extend the places you can build.",
    tip: "Normal skirmishes start with a Core and no ships. This tutorial supplies a few frigates for control practice. Protect the Core: losing it defeats your commander.",
    goals: [goal("core", "Select your Command Core")], highlight: "construction-controls" },
  { id: "extractor", chapter: "Economy", title: "Gather alloy",
    body: "Select the Command Core, choose T1 → Extractor, then click the glowing alloy deposit at the beacon. Extractors must sit on an unclaimed deposit. Wait for construction to finish; income then flows automatically, without worker trips.",
    tip: "A valid placement preview is cyan. Red means blocked, too far away, or an invalid deposit. Richer deposits yield more alloy. Esc cancels placement.",
    goals: [goal("structure:extractor", "Complete an Extractor on a deposit")], highlight: "build-extractor" },
  { id: "power", chapter: "Economy", title: "Power and reserves",
    body: "Build a Solar Array and Storage on clear ground near your Core. The top bar shows reserves, income, and spending. Construction and ship production spend alloy and energy continuously, rather than charging the whole price at once.",
    tip: "When resources run out, Grid Flow falls and work slows. Add income or cancel excess jobs to recover. Storage raises reserve caps; it does not create income. Supplies are a tutorial-only refill.",
    goals: [goal("structure:solarArray", "Complete a Solar Array"), goal("structure:storage", "Complete Storage")], highlight: "alloy-resource" },
  { id: "shipyard", chapter: "Production", title: "Build your first Shipyard",
    body: "Select your Core and build a T1 Small Yard on clear ground. Wait until it is complete, then select the Shipyard to open its production cards.",
    tip: "Each Shipyard has its own queue and fixed production rate. More Shipyards let you build in parallel, but they also increase resource demand.",
    goals: [goal("structure:shipyard", "Complete a Small Yard")], highlight: "build-shipyard" },
  { id: "production", chapter: "Production", title: "Produce reinforcements",
    body: "Select the Small Yard and click Fighter Wing. Watch the progress bar and wait for deployment. One Fighter order produces five controllable squads, each shown as five small craft; Bombers also deploy in batches. Larger ships and builders are individual units.",
    tip: "With several compatible Shipyards selected, each click adds production to every yard. Shift-click queues five batches in each selected yard. Save your selected factories with Ctrl + 1–9, recall with that number, or double-tap it to focus their location.",
    goals: [goal("produced:fighter", "Produce a Fighter Wing")], highlight: "queue-fighter" },
  { id: "queues", chapter: "Production", title: "Rally and manage queues",
    body: "Select your Shipyard and right-click a clear destination to set its rally point (or Y then click). New ships move there automatically. Queue more ships, enable Infinite Queue to repeat, then use Stop Everything to stop spending.",
    tip: "Click × on an individual queue item to cancel it. Cancel Construction stops a site; Clear Queued Sites leaves active construction running. Spent resources are not refunded.",
    goals: [goal("setRallyPoint", "Set a Shipyard rally point"), goal("repeat", "Enable Infinite Queue"), goal("clearProductionQueue", "Use Stop Everything")], highlight: "production-queue-actions" },
  { id: "mobile", chapter: "Expansion", title: "Deploy a Mobile Fabricator",
    body: "Select your Small Yard and produce a Mobile Fab. This unarmed vessel can travel to remote deposits, start construction beyond your base, and assist nearby sites.",
    tip: "Builders and stationary Fabricators add construction power. Extra power speeds construction only when your economy can supply the extra demand.",
    goals: [goal("produced:fabricator", "Produce a Mobile Fabricator")], highlight: "queue-fabricator" },
  { id: "expansion", chapter: "Expansion", title: "Establish an outpost",
    body: "Select only your Mobile Fabricator. Choose T1 → Fabricator and place it on clear ground near the beacon outside the Core’s construction area. The builder travels there and works on the site.",
    tip: "A completed stationary Fabricator extends construction coverage. Shift queues further sites. Mobile builders automatically assist construction within reach; escort them when expanding into contested space.",
    goals: [goal("outpost", "Complete a remote Fabricator using a Mobile Fabricator")], highlight: "build-fabricator" },
  { id: "sensors", chapter: "Expansion", title: "Scout through the fog",
    body: "Select your Core or a completed Fabricator and build a T1 Radar Array. Ships and completed structures reveal their sensor areas. Enemy contacts disappear outside coverage; discovered resource deposits remain known.",
    tip: "Allies share vision. The shaded minimap shows unexplored space. Radar improves sight, not weapon range. Scout and escort before committing your economy.",
    goals: [goal("structure:radarArray", "Complete a Radar Array")], highlight: "build-radar-array" },
  { id: "technology", chapter: "Technology", title: "Unlock heavier ships",
    body: "Select your Core, open T2, and build a Medium Yard. Once it completes, build a Fusion Reactor for stronger power generation. Hover locked cards to see the exact missing prerequisites.",
    tip: "The current tree is Small Yard → Medium Yard → T3 Large Yard. Medium produces specialist frigates, Destroyers, Cruisers, and medium artillery. Large unlocks Carriers, Battleships, and strategic artillery. T2/T3 income, storage, and radar sustain these fleets.",
    goals: [goal("structure:fleetShipyard", "Complete a Medium Yard"), goal("structure:fusionReactor", "Complete a Fusion Reactor")], highlight: "build-fleet-yard" },
  { id: "defense", chapter: "Combat", title: "Build a defensive line",
    body: "Build a T1 Flak Bastion near your base. Flak and point defense excel against small craft and intercept incoming torpedoes. Torpedo and rail defenses threaten heavier armor; plasma and beam fortresses control larger areas.",
    tip: "Use mixed defenses and ships: fast Fighters screen, Flak Frigates counter small craft, Bombers and Torpedo Frigates threaten heavy targets, and larger warships carry several independent weapon mounts. Watch defensive energy upkeep.",
    goals: [goal("structure:pointDefenseBattery", "Complete a Flak Bastion")], highlight: "build-pd-battery" },
  { id: "attack", chapter: "Combat", title: "Attack-move into contact",
    body: "A hostile practice frigate is now waiting at the beacon. Select your combat ships, press A, and click near it. Attack-move engages enemies along the route. Ordinary Move prioritizes travel; ships can still fire while moving.",
    tip: "Training reinforcements have joined you near the beacon’s approach. Turrets aim independently, have firing arcs and weapon ranges, and can engage different targets. Asteroids block ships and projectiles.",
    goals: [goal("attackMove", "Issue an attack-move"), goal("kill", "Destroy a hostile practice ship")], highlight: "cmd-attack" },
  { id: "focus", chapter: "Combat", title: "Focus fire and break shields",
    body: "A fresh target is at the beacon. Select your fleet, press F, then click the visible enemy ship to focus fire. Shields absorb damage before the hull; different weapon profiles perform differently against light, plated, heavy, and fortified armor.",
    tip: "The selected contact’s bars show shields and hull. Focus fire concentrates damage, but splitting fire can be useful against small targets. Use Move to withdraw damaged ships; shields and hull do not automatically regenerate.",
    goals: [goal("focusFire", "Focus fire on a visible hostile"), goal("damage", "Deal damage to the focus target")], highlight: "focus" },
  { id: "artillery", chapter: "Combat", title: "Deploy artillery",
    body: "A training Artillery Frigate is ready near the beacon’s approach. Select it, stop or hold, then let it fire at the marked hostile storage station. Artillery needs time to deploy while stationary and cannot fire inside its minimum range.",
    tip: "Firing reveals artillery temporarily through fog. Artillery shells hit an area, so use it against formations and structures, keep enemies at range, and defend it with escorts. Locate frames the gun and target.",
    goals: [goal("artillery-hold", "Stop or hold your Artillery Frigate"), goal("artillery", "Let it fire a siege shell")], highlight: "cmd-hold" },
  { id: "victory", chapter: "Final exercise", title: "Destroy the opposing Core",
    body: "The final training Core is now at the beacon, with reduced shields and hull. Rally your fleet, scout into sensor range, then attack it. Destroying every opposing Core wins a normal match too.",
    tip: "Practice reinforcements are available through Supplies if you lose your fleet. Your own Core is protected during training. Combine production, a balanced economy, scouting, and focused attacks in your next skirmish.",
    goals: [goal("victory", "Destroy the opposing Command Core")] },
];

function addStructure(state: SimulationState, type: StructureType, x: number, z: number, owner = TUTORIAL_PLAYER_ID) {
  const definition = STRUCTURES[type];
  const structure = {
    id: state.nextEntityId++, ownerPlayerId: owner, teamId: owner === TUTORIAL_PLAYER_ID ? 1 : 2,
    type, x, z, yaw: Math.PI / 2, health: definition.maxHealth, shields: definition.maxShield,
    buildProgress: 1, resourceNodeId: null, productionQueue: [], repeatProduction: false,
    rallyPoint: { x: x + 100, z },
  };
  state.structures.push(structure);
  return structure;
}

function addShip(state: SimulationState, shipClass: ShipClass, x: number, z: number, owner = TUTORIAL_PLAYER_ID) {
  const definition = SHIPS[shipClass];
  const id = state.nextEntityId++;
  const ship = {
    id, ownerPlayerId: owner, teamId: owner === TUTORIAL_PLAYER_ID ? 1 : 2, class: shipClass,
    x, z, y: 8, yaw: owner === TUTORIAL_PLAYER_ID ? Math.PI / 2 : -Math.PI / 2,
    vx: 0, vz: 0, health: definition.maxHealth, shields: definition.maxShield,
    orders: [{ type: "hold" as const, destination: { x, z }, facing: Math.PI / 2 }],
    focusTargetEntityId: null, lastCombatTick: state.tick,
    ...(shipClass === "artilleryFrigate" ? { artilleryDeploymentTicks: 0, revealedUntilTick: 0 } : {}),
    turrets: definition.hardpoints.map((hardpoint) => ({
      ...hardpoint, id: state.nextTurretId++, parentShipId: id, currentYaw: hardpoint.yawCenter,
      targetEntityId: null, cooldownRemaining: 0, fireSequence: 0,
    })),
  };
  state.ships.push(ship);
  return ship;
}

/** A small offline practice map, using the ordinary economy, combat, fog, and command rules. */
export function createTutorialScenario(): GameSimulation {
  const state = createCombatScenario({ seed: 0x747574, startingBase: "command-core", players: [
    { id: TUTORIAL_PLAYER_ID, name: "Cadet Commander", teamId: 1, color: 0x59a7ff },
    { id: OPPONENT_ID, name: "Training Targets", teamId: 2, color: 0xff5576 },
  ] }).state;
  state.structures = [];
  state.resourceNodes = [];
  state.obstacles = [{ id: 1, type: "asteroid", x: 250, z: -320, radius: 65, visualSeed: 42 }];
  state.visibility = [];
  addStructure(state, "commandCore", TUTORIAL_BASE.x, TUTORIAL_BASE.z);
  addStructure(state, "commandCore", 2200, 0, OPPONENT_ID);
  for (const [x, z] of [[-510, -110], [-390, -220], [-170, 320], [300, 270]]) {
    state.resourceNodes.push({ id: state.nextEntityId++, type: "alloy", x: x!, z: z!, richness: 1,
      claimedByStructureId: null });
  }
  for (let i = 0; i < 3; i++) addShip(state, "frigate", -570 + i * 50, 100);
  return new GameSimulation(state);
}

export type TutorialInput = "pan" | "zoom" | "rotate" | "minimap" | "group-set" | "group-recall";

/** Session progress is local-only; it is never serialized into a multiplayer match. */
export class TutorialSession {
  index = 0;
  readonly achieved = new Set<string>();
  readonly skipped = new Set<string>();
  private readonly pendingCommands = new Map<number, GameCommand>();
  private readonly produced = new Set<ShipClass>();
  private waypointCount = 0;
  private mobileSiteId: number | null = null;
  private focusTargetId: number | null = null;
  private practiceTargetId: number | null = null;

  constructor(readonly simulation: GameSimulation) {}
  get lesson(): TutorialLesson | undefined { return TUTORIAL_LESSONS[this.index]; }
  get finished(): boolean { return !this.lesson; }
  get ready(): boolean { return this.lesson?.goals.every((item) => this.achieved.has(item.id)) ?? true; }

  recordInput(input: TutorialInput): void {
    if (input === "group-recall" && !this.achieved.has("group-set")) return;
    this.mark(input);
  }

  recordCommand(command: GameCommand): void {
    if (command.playerId === TUTORIAL_PLAYER_ID) this.pendingCommands.set(command.sequence, command);
  }

  private mark(id: string): void {
    if (this.lesson?.goals.some((item) => item.id === id)) this.achieved.add(id);
  }

  observe(events: readonly SimulationEvent[] = [], selectedIds: ReadonlySet<number> = new Set()): void {
    const state = this.simulation.state;
    const ownShips = state.ships.filter((ship) => ship.ownerPlayerId === TUTORIAL_PLAYER_ID);
    if (ownShips.filter((ship) => selectedIds.has(ship.id)).length >= 2) this.mark("fleet");
    for (const structure of state.structures) {
      if (structure.ownerPlayerId !== TUTORIAL_PLAYER_ID || structure.buildProgress < 1) continue;
      this.mark(`structure:${structure.type}`);
      if (structure.type === "commandCore" && selectedIds.has(structure.id)) this.mark("core");
      if (structure.type === "fabricator" && structure.id === this.mobileSiteId) this.mark("outpost");
    }
    if (this.achieved.has("move") && ownShips.filter((ship) => Math.hypot(ship.x - RENDEZVOUS.x, ship.z - RENDEZVOUS.z) < 100).length >= 2) this.mark("arrive");
    for (const event of events) {
      if (event.type === "unitProduced" && event.playerId === TUTORIAL_PLAYER_ID) this.produced.add(event.shipClass);
      if (event.type === "commandAccepted" && event.playerId === TUTORIAL_PLAYER_ID) {
        const command = this.pendingCommands.get(event.sequence);
        this.pendingCommands.delete(event.sequence);
        if (!command) continue;
        this.mark(command.type);
        if ((command.type === "stop" || command.type === "hold")
          && ownShips.some((ship) => ship.class === "artilleryFrigate" && command.unitIds.includes(ship.id))) this.mark("artillery-hold");
        if (command.type === "move") {
          if (command.formationEnd) this.mark("formation");
          if (command.queued) this.mark(`waypoint${++this.waypointCount}`);
        }
        if (command.type === "setProductionRepeat" && command.enabled) this.mark("repeat");
        if (command.type === "focusFire") this.focusTargetId = command.targetEntityId;
        if (command.type === "buildStructure" && command.structureType === "fabricator"
          && command.builderUnitIds?.length && Math.hypot(command.position.x - TUTORIAL_BASE.x, command.position.z - TUTORIAL_BASE.z) > 400) {
          this.mobileSiteId = state.structures.find((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.constructionSequence === command.sequence)?.id ?? null;
        }
      }
      if (event.type === "destroyed" && event.entityId === this.practiceTargetId) this.mark("kill");
      if (event.type === "hit" && event.targetId === this.focusTargetId && this.achieved.has("focusFire")) this.mark("damage");
      if (event.type === "weaponFired" && WEAPONS[event.weaponTypeId].artillery
        && ownShips.some((ship) => ship.id === event.shipId)) this.mark("artillery");
    }
    for (const shipClass of this.produced) this.mark(`produced:${shipClass}`);
    if (state.status === "finished" && state.winnerTeamId === 1) this.mark("victory");
  }

  advance(skip = false): boolean {
    if (this.finished || (!skip && !this.ready)) return false;
    if (skip && !this.ready) this.skipped.add(this.lesson!.id);
    this.index++;
    this.achieved.clear();
    this.pendingCommands.clear();
    this.waypointCount = 0;
    this.mobileSiteId = null;
    this.focusTargetId = null;
    this.prepareLesson();
    this.observe();
    return true;
  }

  /** Protect the learning session from accidental early victory/defeat. Supplies remain opt-in. */
  beforeTick(): void {
    const state = this.simulation.state;
    // A player may explore or fight ahead. Keep a target available until its exercise is done.
    if (!this.ready && this.practiceTargetId !== null
      && !state.ships.some((s) => s.id === this.practiceTargetId)
      && !state.structures.some((s) => s.id === this.practiceTargetId)) {
      if (this.lesson?.id === "focus") {
        this.practiceTargetId = addShip(state, "cruiser", 800, 0, OPPONENT_ID).id;
        this.focusTargetId = null;
        this.achieved.delete("focusFire");
      } else if (this.lesson?.id === "artillery") {
        this.practiceTargetId = addStructure(state, "storage", 1420, 180, OPPONENT_ID).id;
      }
    }
    for (const core of this.simulation.state.structures.filter((s) => s.type === "commandCore")) {
      if (core.ownerPlayerId === TUTORIAL_PLAYER_ID || this.lesson?.id !== "victory") {
        core.health = STRUCTURES.commandCore.maxHealth;
        core.shields = STRUCTURES.commandCore.maxShield;
      }
    }
  }

  resupply(): void {
    const state = this.simulation.state;
    const player = state.players.find((candidate) => candidate.id === TUTORIAL_PLAYER_ID)!;
    player.economy.alloy = player.economy.alloyStorage;
    player.economy.energy = player.economy.energyStorage;
    if (state.ships.filter((ship) => ship.ownerPlayerId === TUTORIAL_PLAYER_ID && ship.class !== "fabricator").length < 3) {
      for (let i = 0; i < 3; i++) addShip(state, "frigate", -540 + i * 55, 120);
    }
    if (this.lesson?.id === "expansion" && !state.ships.some((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.class === "fabricator")) {
      addShip(state, "fabricator", -470, 200);
    }
    if (this.lesson?.id === "artillery" && !state.ships.some((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.class === "artilleryFrigate")) {
      addShip(state, "artilleryFrigate", 1140, 180);
    }
    this.simulation.refreshChecksum();
  }

  get location(): { x: number; z: number } {
    const state = this.simulation.state;
    const id = this.lesson?.id;
    if (id === "move" || id === "formation" || id === "waypoints" || id === "orders" || id === "groups") return RENDEZVOUS;
    if (id === "selection") return state.ships.find((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID) ?? TUTORIAL_BASE;
    if (id === "extractor") return state.resourceNodes[0]!;
    if (id === "expansion") return { x: -130, z: 170 };
    if (id === "attack" || id === "focus" || id === "artillery") {
      return state.ships.find((s) => s.id === this.practiceTargetId)
        ?? state.structures.find((s) => s.id === this.practiceTargetId) ?? { x: 400, z: 0 };
    }
    if (id === "victory") return state.structures.find((s) => s.ownerPlayerId === OPPONENT_ID && s.type === "commandCore") ?? { x: 1100, z: 0 };
    return TUTORIAL_BASE;
  }

  private ensureStructure(type: StructureType, x: number, z: number): void {
    const state = this.simulation.state;
    if (state.structures.some((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.type === type && s.buildProgress >= 1)) return;
    // Only used to supply prerequisites after a skipped lesson. Find clear ground.
    for (let ring = 0; ring < 12; ring++) {
      const point = { x: x + (ring % 4) * 80, z: z - Math.floor(ring / 4) * 80 };
      if (this.simulation.canPlaceStructure(TUTORIAL_PLAYER_ID, type as Exclude<StructureType, "commandCore">, point)) {
        addStructure(state, type, point.x, point.z);
        return;
      }
    }
  }

  private prepareLesson(): void {
    const state = this.simulation.state;
    const id = this.lesson?.id;
    if (["production", "queues", "mobile", "sensors", "technology"].includes(id ?? "")) this.ensureStructure("shipyard", -780, -100);
    if (id === "expansion" && !state.ships.some((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.class === "fabricator")) addShip(state, "fabricator", -470, 200);
    if (id === "attack" || id === "focus") {
      const x = id === "attack" ? 420 : 800;
      this.practiceTargetId = addShip(state, id === "attack" ? "frigate" : "cruiser", x, 0, OPPONENT_ID).id;
      for (let i = 0; i < 4; i++) addShip(state, "frigate", x - 350, -80 + i * 50);
    }
    if (id === "artillery") {
      this.practiceTargetId = addStructure(state, "storage", 1420, 180, OPPONENT_ID).id;
      addShip(state, "artilleryFrigate", 1140, 180);
    }
    if (id === "victory") {
      const core = state.structures.find((s) => s.type === "commandCore" && s.ownerPlayerId === OPPONENT_ID)!;
      core.x = 1750; core.z = -200; core.health = 1500; core.shields = 400;
      for (let i = 0; i < 3; i++) addShip(state, "torpedoFrigate", 1250, -280 + i * 65);
      this.resupply();
    }
    this.simulation.refreshChecksum();
  }
}
