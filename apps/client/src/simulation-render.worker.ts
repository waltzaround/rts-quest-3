import { createPlanarCirclePhysicsWorld, loadPhysicsRuntime } from "@space-rts/box3d-wasm";
import {
  SharedRenderWriter,
  LockstepInputs,
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
let inputs: LockstepInputs | null = null;
let writer: SharedRenderWriter | null = null;
let messageChain = Promise.resolve();

function respond(message: WorkerResponse): void {
  self.postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  messageChain = messageChain.then(() => handleMessage(event.data)).catch((error: unknown) => {
    respond({ type: "error", message: error instanceof Error ? error.message : "Simulation worker failed" });
  });
});

async function handleMessage(message: WorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    const runtime = await loadPhysicsRuntime();
    simulation = restoreSimulation(message.state, createPlanarCirclePhysicsWorld(runtime));
    inputs = new LockstepInputs(simulation);
    writer = new SharedRenderWriter(message.buffers);
    writer.publish(simulation.state);
    respond({ type: "ready", tick: simulation.state.tick, checksum: simulation.state.checksum });
    return;
  }
  if (!simulation || !inputs || !writer) throw new Error("Simulation worker has not been initialized");
  if (message.type === "commands") {
    if (!inputs.queueCommands(message.commands)) throw new Error("Simulation worker received late commands");
    return;
  }
  if (message.type === "player_state") {
    if (!inputs.queuePlayerState(message)) throw new Error("Simulation worker received a late player transition");
    return;
  }
  const startedAt = performance.now();
  const events: SimulationEvent[] = [];
  while (simulation.state.tick < message.targetTick) {
    const previousTick = simulation.state.tick;
    const debug = inputs.step();
    events.push(...debug.events);
    if (simulation.state.tick === previousTick) break;
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
