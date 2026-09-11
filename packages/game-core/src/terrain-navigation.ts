import type { ObstacleState } from "./types";

interface Point { x: number; z: number }
interface Edge { node: number; distance: number }
interface NavigationGraph {
  points: Point[];
  edges: Edge[][];
  goals: Map<string, Float64Array>;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

function crossesCircle(from: Point, to: Point, center: Point, radius: number): boolean {
  const dx = to.x - from.x, dz = to.z - from.z;
  const ox = from.x - center.x, oz = from.z - center.z;
  const dot = ox * dx + oz * dz;
  // A collision solver may leave a ship just inside the routing clearance.
  // Allow it to move out, but never to cut further into the obstacle.
  if (dot >= 0) return ox * ox + oz * oz < radius * radius && distance(to, center) < radius;
  const t = Math.min(1, -dot / Math.max(1e-12, dx * dx + dz * dz));
  return (ox + dx * t) ** 2 + (oz + dz * t) ** 2 < radius * radius - 1e-6;
}

function crossesBox(from: Point, to: Point, center: Point, halfX: number, halfZ: number): boolean {
  let enter = 0, exit = 1;
  for (const [origin, delta, half] of [
    [from.x - center.x, to.x - from.x, halfX],
    [from.z - center.z, to.z - from.z, halfZ],
  ]) {
    if (Math.abs(delta!) < 1e-9) {
      if (Math.abs(origin!) >= half! - 1e-6) return false;
    } else {
      const a = (-half! - origin!) / delta!, b = (half! - origin!) / delta!;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter >= exit - 1e-9) return false;
    }
  }
  return enter < exit;
}

function clearSegment(from: Point, to: Point, obstacles: readonly ObstacleState[], padding: number): boolean {
  for (const obstacle of obstacles) {
    if (obstacle.type === "barrier" && obstacle.width && obstacle.depth) {
      const halfX = obstacle.width / 2, halfZ = obstacle.depth / 2;
      const fromClearance = Math.hypot(Math.max(0, Math.abs(from.x - obstacle.x) - halfX),
        Math.max(0, Math.abs(from.z - obstacle.z) - halfZ));
      if (fromClearance < padding) {
        const closest = { x: Math.max(obstacle.x - halfX, Math.min(obstacle.x + halfX, from.x)),
          z: Math.max(obstacle.z - halfZ, Math.min(obstacle.z + halfZ, from.z)) };
        if ((from.x - closest.x) * (to.x - from.x) + (from.z - closest.z) * (to.z - from.z) > 0) continue;
      }
      if (crossesBox(from, to, obstacle, halfX + padding, halfZ)
        || crossesBox(from, to, obstacle, halfX, halfZ + padding)) return false;
      for (const x of [-halfX, halfX]) for (const z of [-halfZ, halfZ]) {
        if (crossesCircle(from, to, { x: obstacle.x + x, z: obstacle.z + z }, padding)) return false;
      }
    } else if (crossesCircle(from, to, obstacle, obstacle.radius + padding)) return false;
  }
  return true;
}

/** A visibility graph shared by ships of the same size. Caches contain only
 * derived terrain/goal data, so restoring a snapshot never changes the route.
 */
export class TerrainNavigator {
  private signature = "";
  private obstacles: readonly ObstacleState[] = [];
  private readonly graphs = new Map<number, NavigationGraph>();

  setObstacles(obstacles: readonly ObstacleState[]): void {
    const signature = obstacles.map(o => `${o.id}:${o.type}:${o.x}:${o.z}:${o.radius}:${o.width}:${o.depth}`).join(";");
    if (signature === this.signature) return;
    this.signature = signature;
    this.obstacles = [...obstacles].sort((a, b) => a.id - b.id);
    this.graphs.clear();
  }

  waypoint(from: Point, goal: Point, radius: number): Point | null {
    const padding = radius + 2;
    if (clearSegment(from, goal, this.obstacles, padding)) return goal;
    let graph = this.graphs.get(padding);
    if (!graph) {
      graph = this.buildGraph(padding);
      this.graphs.set(padding, graph);
    }
    const key = `${goal.x}:${goal.z}`;
    let costs = graph.goals.get(key);
    if (!costs) {
      costs = this.goalCosts(graph, goal, padding);
      if (graph.goals.size >= 128) graph.goals.delete(graph.goals.keys().next().value!);
      graph.goals.set(key, costs);
    }
    let best: Point | null = null, bestCost = Infinity;
    for (let index = 0; index < graph.points.length; index++) {
      const point = graph.points[index]!;
      const cost = distance(from, point) + costs[index]!;
      if (cost >= bestCost || !clearSegment(from, point, this.obstacles, padding)) continue;
      best = point; bestCost = cost;
    }
    return best;
  }

  private buildGraph(padding: number): NavigationGraph {
    const points: Point[] = [];
    for (const obstacle of this.obstacles) {
      if (obstacle.type === "barrier" && obstacle.width && obstacle.depth) {
        for (const x of [-1, 1]) for (const z of [-1, 1]) points.push({
          x: obstacle.x + x * (obstacle.width / 2 + padding + 8),
          z: obstacle.z + z * (obstacle.depth / 2 + padding + 8),
        });
      } else {
        // Adjacent vertices connect outside the padded circle, not through it.
        const radius = (obstacle.radius + padding + 8) / Math.cos(Math.PI / 8);
        for (let index = 0; index < 8; index++) {
          const angle = index * Math.PI / 4;
          points.push({ x: obstacle.x + Math.cos(angle) * radius, z: obstacle.z + Math.sin(angle) * radius });
        }
      }
    }
    const clearPoints = points.filter(point => clearSegment(point, point, this.obstacles, padding));
    const edges: Edge[][] = clearPoints.map(() => []);
    for (let a = 0; a < clearPoints.length; a++) for (let b = a + 1; b < clearPoints.length; b++) {
      if (!clearSegment(clearPoints[a]!, clearPoints[b]!, this.obstacles, padding)) continue;
      const length = distance(clearPoints[a]!, clearPoints[b]!);
      edges[a]!.push({ node: b, distance: length });
      edges[b]!.push({ node: a, distance: length });
    }
    return { points: clearPoints, edges, goals: new Map() };
  }

  private goalCosts(graph: NavigationGraph, goal: Point, padding: number): Float64Array {
    const costs = new Float64Array(graph.points.length).fill(Infinity);
    const visited = new Uint8Array(graph.points.length);
    for (let index = 0; index < graph.points.length; index++) {
      if (clearSegment(graph.points[index]!, goal, this.obstacles, padding)) costs[index] = distance(graph.points[index]!, goal);
    }
    for (let step = 0; step < graph.points.length; step++) {
      let nearest = -1, cost = Infinity;
      for (let index = 0; index < costs.length; index++) {
        if (!visited[index] && costs[index]! < cost) { nearest = index; cost = costs[index]!; }
      }
      if (nearest < 0) break;
      visited[nearest] = 1;
      for (const edge of graph.edges[nearest]!) {
        costs[edge.node] = Math.min(costs[edge.node]!, cost + edge.distance);
      }
    }
    return costs;
  }
}
