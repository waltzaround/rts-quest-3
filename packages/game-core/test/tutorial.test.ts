import { describe, expect, it } from "vitest";
import {
  createTutorialScenario, TutorialSession, TUTORIAL_PLAYER_ID, TUTORIAL_LESSONS,
  type GameCommand, type StructureType,
} from "../src";

function practice() {
  const simulation = createTutorialScenario();
  const session = new TutorialSession(simulation);
  let sequence = 0;
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      session.beforeTick();
      session.observe(simulation.step().events);
    }
  };
  const send = (details: object) => {
    const command = { playerId: TUTORIAL_PLAYER_ID, sequence: ++sequence,
      requestedTick: simulation.state.tick + 1, ...details } as GameCommand;
    expect(simulation.submitCommand(command), JSON.stringify(details)).toMatchObject({ accepted: true });
    session.recordCommand(command);
    tick();
  };
  const untilReady = (limit = 5000) => {
    for (let i = 0; i < limit && !session.ready; i++) {
      if (i % 100 === 0) session.resupply();
      tick();
    }
    expect([...session.achieved], session.lesson?.id).toEqual(expect.arrayContaining(session.lesson!.goals.map((g) => g.id)));
    expect(session.ready, session.lesson?.id).toBe(true);
  };
  const skipTo = (id: string) => {
    while (session.lesson?.id !== id && !session.finished) session.advance(true);
    expect(session.lesson?.id).toBe(id);
    tick(2);
  };
  const build = (type: Exclude<StructureType, "commandCore">) => {
    const position = Array.from({ length: 100 }, (_, i) => ({
      x: -950 + (i % 10) * 66, z: -310 + Math.floor(i / 10) * 66,
    })).find((point) => simulation.canPlaceStructure(TUTORIAL_PLAYER_ID, type, point));
    expect(position, type).toBeDefined();
    send({ type: "buildStructure", structureType: type, position, queued: false });
  };
  const fleet = () => simulation.state.ships.filter((s) => s.ownerPlayerId === TUTORIAL_PLAYER_ID && s.class !== "fabricator").map((s) => s.id);
  return { simulation, session, tick, send, untilReady, skipTo, build, fleet };
}

describe("Command Academy", () => {
  it("starts deterministically with a safe fleet, a buildable deposit, and no AI", () => {
    const a = createTutorialScenario();
    const b = createTutorialScenario();
    expect(a.state).toEqual(b.state);
    expect(a.state.aiPlayerIds).toEqual([]);
    expect(a.state.ships).toHaveLength(3);
    const node = a.state.resourceNodes[0]!;
    expect(a.canPlaceStructure(TUTORIAL_PLAYER_ID, "extractor", node, node.id)).toBe(true);
    a.stepMany(1200);
    expect(a.state.status).toBe("playing");
    expect(a.state.ships).toHaveLength(3);
    expect(a.state.players[0]!.economy.alloyIncome).toBe(3);
  });

  it("requires actual camera actions, selection, and movement before advancing", () => {
    const { session, simulation, send, fleet, untilReady } = practice();
    expect(session.advance()).toBe(true);
    expect(session.advance()).toBe(false);
    for (const input of ["pan", "zoom", "rotate", "minimap"] as const) session.recordInput(input);
    expect(session.advance()).toBe(true);
    session.observe([], new Set([fleet()[0]!]));
    expect(session.ready).toBe(false);
    session.observe([], new Set(fleet()));
    expect(session.advance()).toBe(true);
    send({ type: "move", unitIds: fleet(), queued: false, destination: session.location });
    expect(session.ready).toBe(false);
    untilReady();
    expect(simulation.state.ships.some((s) => s.x > -500)).toBe(true);
  });

  it("completes the full course using simulation commands, construction, and combat", () => {
    const p = practice();
    const { session, simulation, send, tick, untilReady, fleet, build } = p;
    for (const lesson of TUTORIAL_LESSONS) {
      expect(session.lesson?.id).toBe(lesson.id);
      switch (lesson.id) {
        case "camera":
          for (const input of ["pan", "zoom", "rotate", "minimap"] as const) session.recordInput(input);
          break;
        case "selection": session.observe([], new Set(fleet())); break;
        case "move": send({ type: "move", unitIds: fleet(), queued: false, destination: session.location }); break;
        case "formation": send({ type: "move", unitIds: fleet(), queued: false,
          destination: { x: -410, z: 160 }, formationEnd: { x: -300, z: 160 } }); break;
        case "waypoints":
          for (const x of [-350, -400]) send({ type: "move", unitIds: fleet(), queued: true, destination: { x, z: 180 } });
          break;
        case "orders":
          send({ type: "patrol", unitIds: fleet(), queued: false, destination: { x: -450, z: 180 } });
          for (const type of ["stop", "hold"]) send({ type, unitIds: fleet(), queued: false });
          break;
        case "groups": session.recordInput("group-set"); session.recordInput("group-recall"); break;
        case "core": session.observe([], new Set([simulation.state.structures[0]!.id])); break;
        case "extractor": {
          const node = simulation.state.resourceNodes[0]!;
          send({ type: "buildStructure", structureType: "extractor", position: node, resourceNodeId: node.id, queued: false });
          break;
        }
        case "power": build("solarArray"); build("storage"); break;
        case "shipyard": build("shipyard"); break;
        case "production":
        case "mobile": {
          const yard = simulation.state.structures.find((s) => s.type === "shipyard")!;
          send({ type: "queueUnit", structureId: yard.id, shipClass: lesson.id === "mobile" ? "fabricator" : "fighter", count: 1 });
          break;
        }
        case "queues": {
          const yard = simulation.state.structures.find((s) => s.type === "shipyard")!;
          send({ type: "setRallyPoint", structureId: yard.id, position: { x: -400, z: 150 } });
          send({ type: "queueUnit", structureId: yard.id, shipClass: "frigate", count: 2 });
          send({ type: "setProductionRepeat", structureId: yard.id, enabled: true });
          send({ type: "clearProductionQueue", structureId: yard.id });
          break;
        }
        case "expansion": {
          const builder = simulation.state.ships.find((s) => s.class === "fabricator")!;
          send({ type: "buildStructure", structureType: "fabricator", position: session.location, builderUnitIds: [builder.id], queued: false });
          break;
        }
        case "sensors": build("radarArray"); break;
        case "technology":
          build("fleetShipyard");
          while (!simulation.state.structures.some((s) => s.type === "fleetShipyard" && s.buildProgress === 1)) { session.resupply(); tick(100); }
          build("fusionReactor");
          break;
        case "defense": build("pointDefenseBattery"); break;
        case "attack": send({ type: "attackMove", unitIds: fleet(), destination: session.location, queued: false }); break;
        case "focus": {
          const target = simulation.state.ships.find((s) => s.ownerPlayerId !== TUTORIAL_PLAYER_ID)!;
          tick(3);
          send({ type: "focusFire", unitIds: fleet(), targetEntityId: target.id, queued: false });
          break;
        }
        case "artillery":
          send({ type: "hold", unitIds: simulation.state.ships.filter((s) => s.class === "artilleryFrigate").map((s) => s.id), queued: false });
          break;
        case "victory": send({ type: "attackMove", unitIds: fleet(), destination: session.location, queued: false }); break;
      }
      untilReady();
      expect(session.advance(), lesson.id).toBe(true);
    }
    expect(session.finished).toBe(true);
    expect(session.skipped.size).toBe(0);
    expect(simulation.state.winnerTeamId).toBe(1);
    expect(session.advance()).toBe(false);
  }, 30_000);

  it("supports skipping, supplies missing prerequisites, and starts a clean new session", () => {
    const { session, simulation, skipTo, tick } = practice();
    skipTo("production");
    expect(simulation.state.structures.some((s) => s.type === "shipyard" && s.buildProgress === 1)).toBe(true);
    expect(session.ready).toBe(false);
    skipTo("expansion");
    expect(simulation.state.ships.some((s) => s.class === "fabricator")).toBe(true);
    simulation.state.ships = [];
    simulation.state.players[0]!.economy.alloy = 0;
    session.resupply();
    tick();
    expect(simulation.state.ships).toHaveLength(4);
    expect(simulation.state.players[0]!.economy.alloy).toBeGreaterThan(0);
    while (!session.finished) session.advance(true);
    expect(session.skipped.size).toBeGreaterThan(0);
    const fresh = new TutorialSession(createTutorialScenario());
    expect(fresh.index).toBe(0);
    expect(fresh.skipped.size).toBe(0);
    expect(fresh.simulation.state.tick).toBe(0);
  });

  it("does not credit rejected, foreign, or previous-lesson commands", () => {
    const { session, simulation, skipTo, fleet, send } = practice();
    skipTo("formation");
    const command: GameCommand = { type: "move", playerId: "tutorial-targets", sequence: 1,
      requestedTick: simulation.state.tick + 1, unitIds: fleet(), destination: session.location, queued: false,
      formationEnd: { x: -100, z: 100 } };
    expect(simulation.submitCommand(command).accepted).toBe(false);
    session.recordCommand(command);
    session.observe([{ type: "commandAccepted", playerId: "tutorial-targets", sequence: 1, tick: 2, unitIds: fleet(), commandType: "move" }]);
    expect(session.ready).toBe(false);
    send({ type: "move", unitIds: fleet(), queued: false, destination: session.location });
    expect(session.ready).toBe(false);
    session.advance(true);
    expect(session.achieved.size).toBe(0);
  });

  it("replaces prematurely destroyed targets and lost artillery so practice stays possible", () => {
    const { simulation, session, skipTo, tick } = practice();
    skipTo("focus");
    const target = simulation.state.ships.find((s) => s.ownerPlayerId !== TUTORIAL_PLAYER_ID && s.class === "cruiser")!;
    simulation.state.ships = simulation.state.ships.filter((s) => s.id !== target.id);
    tick();
    expect(simulation.state.ships.some((s) => s.class === "cruiser" && s.id !== target.id)).toBe(true);
    expect(session.ready).toBe(false);
    skipTo("artillery");
    simulation.state.ships = simulation.state.ships.filter((s) => s.class !== "artilleryFrigate");
    session.resupply();
    expect(simulation.state.ships.some((s) => s.class === "artilleryFrigate")).toBe(true);
  });
});
