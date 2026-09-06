interface SpatialEntity {
  id: number;
  x: number;
  z: number;
}

export class SpatialHash<T extends SpatialEntity> {
  private readonly buckets = new Map<number, T[]>();
  private readonly unusedBuckets: T[][] = [];

  constructor(private readonly cellSize: number) {}

  rebuild(entities: readonly T[]): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
      this.unusedBuckets.push(bucket);
    }
    this.buckets.clear();
    for (const entity of entities) {
      const key = this.key(Math.floor(entity.x / this.cellSize), Math.floor(entity.z / this.cellSize));
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(entity);
      else this.buckets.set(key, this.takeBucket(entity));
    }
  }

  /**
   * Nearby entities in cells overlapping the query circle. Pass `into` to reuse
   * a caller-owned buffer — the default allocates, so nested queries stay safe.
   * Results are only guaranteed unique if an entity occupies one cell.
   */
  query(x: number, z: number, radius: number, into?: T[]): T[] {
    const result = into ?? [];
    result.length = 0;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ += 1) {
        const bucket = this.buckets.get(this.key(cellX, cellZ));
        if (!bucket) continue;
        for (let index = 0; index < bucket.length; index += 1) result.push(bucket[index]!);
      }
    }
    return result;
  }

  /**
   * Packs both cell coordinates into one 32-bit integer key. Unique as long as
   * cell indices stay within ±32768, far beyond any map size divided by the
   * cell width. Numeric keys avoid building a garbage string per lookup.
   */
  private key(x: number, z: number): number {
    return (x & 0xffff) << 16 | z & 0xffff;
  }

  private takeBucket(first: T): T[] {
    const bucket = this.unusedBuckets.pop();
    if (bucket) {
      bucket.push(first);
      return bucket;
    }
    return [first];
  }
}
