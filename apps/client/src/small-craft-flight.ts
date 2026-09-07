import { SHIPS, type ShipState } from "@space-rts/game-core";
import { wrapAngle } from "@space-rts/shared";

const CELL_SIZE = 192;
const BUCKET_COUNT = 2_048;
const NEIGHBOR_BUDGET = 48;
const CAPITAL_CLASSES = new Set(["cruiser", "artilleryCruiser", "carrier", "battleship"]);
const CELL_ORDER = [0, 0, -1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => value * value * (3 - 2 * value);
const bucket = (x: number, z: number) => ((Math.imul(x, 73_856_093) ^ Math.imul(z, 19_349_663)) >>> 0) & (BUCKET_COUNT - 1);

interface FlightPose {
  altitude: number;
  bank: number;
  pitch: number;
  engagement: number;
  speed: number;
  formationYaw: number;
  formationTurnVelocity: number;
  time: number;
  frame: number;
}

/** A render-only proximity field. Two reusable spatial grids replace the
 * all-capitals scan; even overlapping swarms have a fixed query budget.
 * Only visible sensor contacts enter the field. No simulation state is written.
 */
export class SmallCraftFlight {
  private readonly capitalHeads = new Int32Array(BUCKET_COUNT);
  private readonly craftHeads = new Int32Array(BUCKET_COUNT);
  private next = new Int32Array(0);
  private ships: readonly ShipState[] = [];
  private readonly history = new Map<number, FlightPose>();
  private frame = 0;
  neighborChecks = 0;

  beginFrame(ships: readonly ShipState[]): void {
    this.ships = ships;
    this.frame++;
    this.neighborChecks = 0;
    this.capitalHeads.fill(-1);
    this.craftHeads.fill(-1);
    if (this.next.length < ships.length) this.next = new Int32Array(Math.max(4_096, ships.length));
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      const heads = CAPITAL_CLASSES.has(ship.class) ? this.capitalHeads
        : ship.class === "fighter" || ship.class === "bomber" ? this.craftHeads : null;
      if (!heads) continue;
      const key = bucket(Math.floor(ship.x / CELL_SIZE), Math.floor(ship.z / CELL_SIZE));
      this.next[i] = heads[key]!;
      heads[key] = i;
    }
  }

  sample(ship: ShipState, x: number, y: number, z: number, turnVelocity: number,
    seconds: number, reset: boolean, yaw = ship.yaw): Readonly<FlightPose> {
    const cellX = Math.floor(x / CELL_SIZE), cellZ = Math.floor(z / CELL_SIZE);
    const bomber = ship.class === "bomber";
    // Keep a squad in the same flight lane as it crosses overlapping hulls.
    const lane = (Math.imul(ship.id, 1_103_515_245) >>> 8) % 2 === 0 ? 1 : -1;
    let altitude = 0, evadeBank = 0, engagement = ship.focusTargetEntityId !== null ? 0.8 : 0;
    for (const turret of ship.turrets) if (turret.targetEntityId !== null) engagement = 1;
    let capitalBudget = NEIGHBOR_BUDGET, craftBudget = NEIGHBOR_BUDGET;
    for (let cell = 0; cell < CELL_ORDER.length; cell += 2) {
      const cx = cellX + CELL_ORDER[cell]!, cz = cellZ + CELL_ORDER[cell + 1]!;
      const key = bucket(cx, cz);
      for (let i = this.capitalHeads[key]!; i !== -1 && capitalBudget > 0; i = this.next[i]!) {
        capitalBudget--; this.neighborChecks++;
        const capital = this.ships[i]!;
        if (Math.floor(capital.x / CELL_SIZE) !== cx || Math.floor(capital.z / CELL_SIZE) !== cz) continue;
        const dx = x - capital.x, dz = z - capital.z;
        const radius = SHIPS[capital.class].radius;
        const envelope = radius * 2.1 + 30;
        // Start climbing before contact and retain clearance until the whole
        // five-craft formation has passed, including the trailing wingmen.
        const aheadX = dx + (ship.vx - capital.vx) * 0.45;
        const aheadZ = dz + (ship.vz - capital.vz) * 0.45;
        const distance = Math.sqrt(Math.min(dx * dx + dz * dz, aheadX * aheadX + aheadZ * aheadZ));
        const influence = smooth(clamp((envelope - distance) / (envelope - radius * 0.7), 0, 1));
        const clearance = Math.max(0, radius * 0.8 + 14 - lane * (y - capital.y));
        const offset = lane * influence * clearance;
        if (Math.abs(offset) > Math.abs(altitude)) {
          altitude = offset;
          evadeBank = lane * influence * 0.24;
        }
        if (capital.teamId !== ship.teamId) engagement = Math.max(engagement, influence);
      }
      for (let i = this.craftHeads[key]!; i !== -1 && craftBudget > 0; i = this.next[i]!) {
        craftBudget--; this.neighborChecks++;
        const other = this.ships[i]!;
        if (other.teamId === ship.teamId || Math.floor(other.x / CELL_SIZE) !== cx || Math.floor(other.z / CELL_SIZE) !== cz) continue;
        const dx = x - other.x, dz = z - other.z;
        engagement = Math.max(engagement, smooth(clamp(1 - (dx * dx + dz * dz) / (180 * 180), 0, 1)));
      }
    }
    const desiredBank = clamp(-turnVelocity * (bomber ? 0.11 : 0.22) + evadeBank, -0.68, 0.68);
    const speed = Math.hypot(ship.vx, ship.vz);
    let pose = this.history.get(ship.id);
    if (!pose) {
      pose = { altitude, bank: desiredBank, pitch: 0, engagement, speed,
        formationYaw: yaw, formationTurnVelocity: 0, time: seconds, frame: this.frame };
      this.history.set(ship.id, pose);
    }
    const dt = seconds - pose.time;
    if (reset || dt < 0 || dt > 0.5) {
      pose.altitude = altitude; pose.bank = desiredBank; pose.pitch = 0; pose.engagement = engagement;
      pose.speed = speed; pose.formationYaw = yaw; pose.formationTurnVelocity = 0;
    } else if (dt > 0) {
      const response = 1 - Math.exp(-dt * 7);
      const climb = (altitude - pose.altitude) * response;
      pose.altitude += climb;
      const desiredPitch = clamp(-Math.atan2(climb / dt, Math.max(35, speed)), -0.34, 0.34);
      pose.pitch += (desiredPitch - pose.pitch) * response;
      pose.bank += (desiredBank - pose.bank) * response;
      pose.engagement += (engagement - pose.engagement) * (1 - Math.exp(-dt * 3));
      pose.speed += (speed - pose.speed) * (1 - Math.exp(-dt * 4));
      // The squad can reverse steering every 50 ms. Its formation must not
      // rotate that fast: an inside wingman would stall or orbit backward.
      // Ease the slot frame separately while noses follow actual travel.
      const maxFormationTurn = 0.4 * Math.min(1, pose.speed / 40);
      const desiredTurn = clamp(wrapAngle(yaw - pose.formationYaw) * 4, -maxFormationTurn, maxFormationTurn);
      pose.formationTurnVelocity += (desiredTurn - pose.formationTurnVelocity) * response;
      pose.formationYaw = wrapAngle(pose.formationYaw + pose.formationTurnVelocity * dt);
    }
    pose.time = seconds; pose.frame = this.frame;
    return pose;
  }

  endFrame(): void {
    for (const [id, pose] of this.history) if (pose.frame !== this.frame) this.history.delete(id);
  }

  clear(): void {
    this.history.clear();
    this.ships = [];
  }
}
