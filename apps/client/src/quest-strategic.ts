/** Distance is in unscaled battle metres, so desktop zoom and XR scaling agree. */
export const SHIP_DETAIL_DISTANCE = 8;
export function strategicIcon(distance: number, wasIcon = false): boolean {
  return distance > (wasIcon ? 6.5 : SHIP_DETAIL_DISTANCE);
}
export function strategicIconRadius(distance: number): number {
  return Math.max(0.035, Math.min(0.22, distance * 0.013));
}

/** Counts are reserved for the furthest zoom, with a wide individual-flag middle layer. */
export const STRATEGIC_COUNT_DISTANCE = 32;
export const STRATEGIC_COUNT_RETURN_DISTANCE = 27;
export function strategicOverview(distance: number, wasOverview = false): boolean {
  return distance > (wasOverview ? STRATEGIC_COUNT_RETURN_DISTANCE : STRATEGIC_COUNT_DISTANCE);
}
