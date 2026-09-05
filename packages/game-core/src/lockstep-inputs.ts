import type { GameSimulation } from "./simulation";
import type { GameCommand } from "./types";

export interface LockstepPlayerTransition {
  tick: number;
  playerId: string;
  state: "playing" | "disconnected";
}

/** Network arrival time must never change checksummed simulation state. */
export class LockstepInputs {
  private commands: GameCommand[] = [];
  private transitions: LockstepPlayerTransition[] = [];

  constructor(private readonly simulation: GameSimulation) {}

  queueCommands(commands: readonly GameCommand[]): boolean {
    if (commands.some((command) => command.requestedTick <= this.simulation.state.tick)) return false;
    this.commands.push(...structuredClone(commands));
    this.commands.sort((a, b) => a.requestedTick - b.requestedTick
      || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0) || a.sequence - b.sequence);
    return true;
  }

  queuePlayerState(transition: LockstepPlayerTransition): boolean {
    if (transition.tick < this.simulation.state.tick) return false;
    this.transitions.push({ ...transition });
    this.transitions.sort((a, b) => a.tick - b.tick);
    return true;
  }

  step(): ReturnType<GameSimulation["step"]> {
    // A transition at tick N takes effect after tick N, before simulating N+1.
    // Reconnect history can therefore be queued without synchronous catch-up.
    while (this.transitions[0] && this.transitions[0].tick <= this.simulation.state.tick) {
      const transition = this.transitions.shift()!;
      const player = this.simulation.state.players.find((candidate) => candidate.id === transition.playerId);
      if (player && player.state !== "defeated") player.state = transition.state;
    }
    // Validate on the same tick on every peer, when prerequisite buildings and
    // units actually exist. Recovery journals may contain hours of future input.
    while (this.commands[0] && this.commands[0].requestedTick <= this.simulation.state.tick + 1) {
      this.simulation.submitCommand(this.commands.shift()!);
    }
    return this.simulation.step();
  }
}
