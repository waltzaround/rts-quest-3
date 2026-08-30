import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import {
  SharedRenderWriter,
  restoreSimulation,
  type GameCommand,
  type GameSimulation,
  type SharedRenderBuffers,
  type SimulationEvent,
  type SimulationState,
} from "@space-rts/game-core";

type WorkerRequest =
  | { type: "initialize"; state: SimulationState; buffers: SharedRenderBuffers }
  | { type: "commands"; commands: GameCommand[] }
  | { type: "advance"; targetTick: number }
  | { type: "player_state"; playerId: string; state: "playing" | "disconnected"; tick: number };

type WorkerResponse =
  | { type: "ready"; tick: number; checksum: number }
  | { type: "advanced"; tick: number; checksum: number; events: SimulationEvent[]; simulationMs: number }
  | { type: "error"; message: string };

let simulation: GameSimulation | null = null;
let writer: SharedRenderWriter | null = null;

function respond(message: WorkerResponse): void {
  self.postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handleMessage(event.data).catch((error: unknown) => {
    respond({ type: "error", message: error instanceof Error ? error.message : "Simulation worker failed" });
  });
});

async function handleMessage(message: WorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    const runtime = await loadPhysicsRuntime();
    simulation = restoreSimulation(message.state, createPlanarCirclePhysicsWorld(runtime));
    writer = new SharedRenderWriter(message.buffers);
    writer.publish(simulation.state);
    respond({ type: "ready", tick: simulation.state.tick, checksum: simulation.state.checksum });
    return;
  }
  if (!simulation || !writer) throw new Error("Simulation worker has not been initialized");
  if (message.type === "commands") {
    for (const command of message.commands) simulation.submitCommand(command);
    return;
  }
  if (message.type === "player_state") {
    while (simulation.state.tick < message.tick) simulation.step();
    const player = simulation.state.players.find((candidate) => candidate.id === message.playerId);
    if (player && player.state !== "defeated") player.state = message.state;
    writer.publish(simulation.state);
    return;
  }
  const startedAt = performance.now();
  const events: SimulationEvent[] = [];
  while (simulation.state.tick < message.targetTick) {
    const debug = simulation.step();
    events.push(...debug.events);
  }
  writer.publish(simulation.state);
  respond({
    type: "advanced",
    tick: simulation.state.tick,
    checksum: simulation.state.checksum,
    events,
    simulationMs: performance.now() - startedAt,
  });
}
