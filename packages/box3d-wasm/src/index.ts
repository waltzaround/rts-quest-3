import type { b3BodyId, b3WorldId, Box3DModule } from "box3d.js";

export interface PhysicsRuntime {
  readonly backend: "box3d-wasm";
  readonly module: Box3DModule;
}

let runtimePromise: Promise<PhysicsRuntime> | undefined;

/** Loads the same Erin Catto Box3D WebAssembly build in browsers and Workers. */
export function loadPhysicsRuntime(): Promise<PhysicsRuntime> {
  runtimePromise ??= import("box3d.js/inline").then(async ({ default: createBox3D }) => ({
    backend: "box3d-wasm" as const,
    module: await createBox3D(),
  }));
  return runtimePromise;
}

/** Instantiates and advances a real 3D world so startup can verify the WASM backend. */
export function runPhysicsProbe(runtime: PhysicsRuntime): { x: number; y: number; z: number } {
  const b3 = runtime.module;
  const worldDefinition = b3.b3DefaultWorldDef();
  worldDefinition.gravity = [0, 0, 0];
  worldDefinition.enableContinuous = true;
  const world = b3.b3CreateWorld(worldDefinition);
  const bodyDefinition = b3.b3DefaultBodyDef();
  bodyDefinition.type = b3.b3BodyType.b3_dynamicBody;
  bodyDefinition.position = [0, 0, 0];
  bodyDefinition.linearVelocity = [1, 0, 0];
  const body = b3.b3CreateBody(world, bodyDefinition);
  const shapeDefinition = b3.b3DefaultShapeDef();
  shapeDefinition.density = 1;
  b3.b3CreateSphereShape(body, shapeDefinition, { center: [0, 0, 0], radius: 0.5 });
  b3.b3World_Step(world, 1 / 60, 4);
  const position = b3.b3Body_GetPosition([0, 0, 0], body);
  b3.b3DestroyBody(body);
  b3.b3DestroyWorld(world);
  return { x: position[0], y: position[1], z: position[2] };
}

export interface CircleSweep {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  centerX: number;
  centerZ: number;
  radius: number;
}

/** Deterministic narrow phase used by game-core until rigid bodies are introduced. */
export function sweptCircleIntersects(sweep: CircleSweep): boolean {
  return sweptCircleHitFraction(sweep) !== null;
}

/** Returns the first normalized time of impact for a planar circle sweep. */
export function sweptCircleHitFraction(sweep: CircleSweep): number | null {
  const dx = sweep.toX - sweep.fromX;
  const dz = sweep.toZ - sweep.fromZ;
  const fromCenterX = sweep.fromX - sweep.centerX;
  const fromCenterZ = sweep.fromZ - sweep.centerZ;
  const c = fromCenterX * fromCenterX + fromCenterZ * fromCenterZ - sweep.radius * sweep.radius;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a <= Number.EPSILON) return null;
  const b = 2 * (fromCenterX * dx + fromCenterZ * dz);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
  return fraction >= 0 && fraction <= 1 ? fraction : null;
}

export interface PlanarStaticCircle {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

export interface PlanarDynamicCircle extends PlanarStaticCircle {
  readonly vx: number;
  readonly vz: number;
  /** Shape density controls relative collision mass. Defaults to 1. */
  readonly density?: number;
}

export interface PlanarCircleBodies {
  readonly staticCircles: readonly PlanarStaticCircle[];
  readonly dynamicCircles: readonly PlanarDynamicCircle[];
}

export interface PlanarDynamicCircleState {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

export interface PlanarCirclePhysicsWorld {
  readonly bodyCount: number;
  /**
   * Makes the Box3D world match an authoritative simulation snapshot.
   * Input order is ignored; new bodies are always created in stable ID order.
   */
  syncBodies(bodies: PlanarCircleBodies): void;
  /** Advances Box3D and returns dynamic bodies in stable ID order. */
  step(timeStep: number, subStepCount?: number): readonly PlanarDynamicCircleState[];
  dispose(): void;
}

type BodyKind = "static" | "dynamic";

interface BodyRecord {
  readonly id: string;
  readonly kind: BodyKind;
  readonly radius: number;
  readonly density: number;
  readonly bodyId: b3BodyId;
}

const IDENTITY_ROTATION: [number, number, number, number] = [0, 0, 0, 1];
const DEFAULT_DENSITY = 1;
const DEFAULT_SUB_STEP_COUNT = 4;

/**
 * Creates a thin deterministic X/Z-plane facade over the shared Box3D WASM
 * runtime. It is synchronous after runtime loading, so game-core can own the
 * fixed-timestep loop in browsers, Node, and Workers.
 */
export function createPlanarCirclePhysicsWorld(runtime: PhysicsRuntime): PlanarCirclePhysicsWorld {
  return new WasmPlanarCirclePhysicsWorld(runtime.module);
}

class WasmPlanarCirclePhysicsWorld implements PlanarCirclePhysicsWorld {
  readonly #module: Box3DModule;
  readonly #worldId: b3WorldId;
  readonly #bodies = new Map<string, BodyRecord>();
  #disposed = false;

  constructor(module: Box3DModule) {
    this.#module = module;
    const worldDefinition = module.b3DefaultWorldDef();
    worldDefinition.gravity = [0, 0, 0];
    worldDefinition.enableContinuous = true;
    worldDefinition.enableSleep = false;
    // A single Box3D worker avoids scheduler-dependent solver ordering.
    worldDefinition.workerCount = 1;
    this.#worldId = module.b3CreateWorld(worldDefinition);
    // Authoritative snapshots overwrite body transforms and velocities before
    // every step, so cached impulses would only add hidden history and work.
    module.b3World_EnableWarmStarting(this.#worldId, false);
  }

  get bodyCount(): number {
    this.#assertActive();
    return this.#bodies.size;
  }

  syncBodies(bodies: PlanarCircleBodies): void {
    this.#assertActive();
    const statics = [...bodies.staticCircles].sort(compareIds);
    const dynamics = [...bodies.dynamicCircles].sort(compareIds);
    validateBodies(statics, dynamics);

    const nextIds = new Set<string>([
      ...statics.map((body) => body.id),
      ...dynamics.map((body) => body.id),
    ]);
    const removedIds = [...this.#bodies.keys()]
      .filter((id) => !nextIds.has(id))
      .sort(compareStrings);
    for (const id of removedIds) {
      this.#destroyBody(id);
    }

    for (const circle of statics) {
      this.#syncStaticCircle(circle);
    }
    for (const circle of dynamics) {
      this.#syncDynamicCircle(circle);
    }
  }

  step(timeStep: number, subStepCount = DEFAULT_SUB_STEP_COUNT): readonly PlanarDynamicCircleState[] {
    this.#assertActive();
    assertPositiveFinite(timeStep, "timeStep");
    if (!Number.isSafeInteger(subStepCount) || subStepCount < 1) {
      throw new RangeError("subStepCount must be a positive safe integer");
    }

    this.#module.b3World_Step(this.#worldId, timeStep, subStepCount);
    return [...this.#bodies.values()]
      .filter((record) => record.kind === "dynamic")
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((record) => {
        const position = this.#module.b3Body_GetPosition([0, 0, 0], record.bodyId);
        const velocity = this.#module.b3Body_GetLinearVelocity([0, 0, 0], record.bodyId);
        return {
          id: record.id,
          x: position[0],
          z: position[2],
          vx: velocity[0],
          vz: velocity[2],
        };
      });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    for (const id of [...this.#bodies.keys()].sort(compareStrings)) {
      this.#destroyBody(id);
    }
    this.#module.b3DestroyWorld(this.#worldId);
    this.#disposed = true;
  }

  #syncStaticCircle(circle: PlanarStaticCircle): void {
    const record = this.#getCompatibleBody(circle.id, "static", circle.radius, 0);
    const body = record ?? this.#createBody(circle.id, "static", circle.radius, 0, circle.x, circle.z, 0, 0);
    this.#module.b3Body_SetTransform(body.bodyId, [circle.x, 0, circle.z], IDENTITY_ROTATION);
  }

  #syncDynamicCircle(circle: PlanarDynamicCircle): void {
    const density = circle.density ?? DEFAULT_DENSITY;
    const record = this.#getCompatibleBody(circle.id, "dynamic", circle.radius, density);
    const body = record ?? this.#createBody(
      circle.id,
      "dynamic",
      circle.radius,
      density,
      circle.x,
      circle.z,
      circle.vx,
      circle.vz,
    );
    this.#module.b3Body_SetTransform(body.bodyId, [circle.x, 0, circle.z], IDENTITY_ROTATION);
    this.#module.b3Body_SetLinearVelocity(body.bodyId, [circle.vx, 0, circle.vz]);
    this.#module.b3Body_SetAngularVelocity(body.bodyId, [0, 0, 0]);
  }

  #getCompatibleBody(id: string, kind: BodyKind, radius: number, density: number): BodyRecord | undefined {
    const record = this.#bodies.get(id);
    if (record === undefined) {
      return undefined;
    }
    if (record.kind === kind && record.radius === radius && record.density === density) {
      return record;
    }
    this.#destroyBody(id);
    return undefined;
  }

  #createBody(
    id: string,
    kind: BodyKind,
    radius: number,
    density: number,
    x: number,
    z: number,
    vx: number,
    vz: number,
  ): BodyRecord {
    const bodyDefinition = this.#module.b3DefaultBodyDef();
    bodyDefinition.type = kind === "dynamic"
      ? this.#module.b3BodyType.b3_dynamicBody
      : this.#module.b3BodyType.b3_staticBody;
    bodyDefinition.position = [x, 0, z];
    bodyDefinition.linearVelocity = [vx, 0, vz];
    bodyDefinition.enableSleep = false;
    bodyDefinition.isBullet = kind === "dynamic";
    bodyDefinition.motionLocks = {
      linearX: false,
      linearY: true,
      linearZ: false,
      angularX: true,
      angularY: true,
      angularZ: true,
    };
    const bodyId = this.#module.b3CreateBody(this.#worldId, bodyDefinition);
    const shapeDefinition = this.#module.b3DefaultShapeDef();
    shapeDefinition.density = density;
    shapeDefinition.baseMaterial.friction = 0;
    shapeDefinition.baseMaterial.restitution = 0;
    this.#module.b3CreateSphereShape(bodyId, shapeDefinition, {
      center: [0, 0, 0],
      radius,
    });
    const record: BodyRecord = { id, kind, radius, density, bodyId };
    this.#bodies.set(id, record);
    return record;
  }

  #destroyBody(id: string): void {
    const record = this.#bodies.get(id);
    if (record === undefined) {
      return;
    }
    this.#module.b3DestroyBody(record.bodyId);
    this.#bodies.delete(id);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("PlanarCirclePhysicsWorld has been disposed");
    }
  }
}

function validateBodies(
  staticCircles: readonly PlanarStaticCircle[],
  dynamicCircles: readonly PlanarDynamicCircle[],
): void {
  const ids = new Set<string>();
  for (const circle of staticCircles) {
    validateCircle(circle, ids);
  }
  for (const circle of dynamicCircles) {
    validateCircle(circle, ids);
    assertPositiveFinite(circle.density ?? DEFAULT_DENSITY, `density for ${circle.id}`);
    assertFinite(circle.vx, `vx for ${circle.id}`);
    assertFinite(circle.vz, `vz for ${circle.id}`);
  }
}

function validateCircle(circle: PlanarStaticCircle, ids: Set<string>): void {
  if (circle.id.length === 0) {
    throw new TypeError("circle id must not be empty");
  }
  if (ids.has(circle.id)) {
    throw new TypeError(`duplicate circle id: ${circle.id}`);
  }
  ids.add(circle.id);
  assertFinite(circle.x, `x for ${circle.id}`);
  assertFinite(circle.z, `z for ${circle.id}`);
  assertPositiveFinite(circle.radius, `radius for ${circle.id}`);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
