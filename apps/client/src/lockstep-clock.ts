// Catch up after delayed frames without letting a reconnect or a backgrounded
// tab monopolize the UI thread. Every simulation tick still runs in order.
const MAX_TICKS_PER_FRAME = 4;
const CATCH_UP_BUDGET_MS = 8;

export function advanceLockstep(
  state: { tick: number },
  targetTick: number,
  step: () => void,
  now: () => number = () => performance.now(),
): number {
  const startedAt = now();
  let steps = 0;
  while (state.tick < targetTick && steps < MAX_TICKS_PER_FRAME) {
    const previousTick = state.tick;
    step();
    steps += 1;
    if (state.tick === previousTick || now() - startedAt >= CATCH_UP_BUDGET_MS) break;
  }
  return steps;
}
