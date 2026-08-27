interface SpatialEntity {
  id: number;
  x: number;
  z: number;
}

export class SpatialHash<T extends SpatialEntity> {
  private readonly buckets = new Map<string, T[]>();

  constructor(private readonly cellSize: number) {}

  rebuild(entities: readonly T[]): void {
    this.buckets.clear();
    for (const entity of entities) {
      const key = this.key(Math.floor(entity.x / this.cellSize), Math.floor(entity.z / this.cellSize));
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(entity);
      else this.buckets.set(key, [entity]);
    }
  }

  query(x: number, z: number, radius: number): T[] {
    const result: T[] = [];
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ += 1) {
        const bucket = this.buckets.get(this.key(cellX, cellZ));
        if (bucket) result.push(...bucket);
      }
    }
    return result;
  }

  private key(x: number, z: number): string {
    return `${x}:${z}`;
  }
}
