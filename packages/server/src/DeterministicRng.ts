export interface DeterministicRngState {
  algorithm: "mulberry32-v1";
  state: number;
}

/** Serializable pseudo-random source owned by one authoritative world. */
export class DeterministicRng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new Error("Deterministic RNG seed must be an integer.");
    }
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("Deterministic RNG maxExclusive must be a positive safe integer.");
    }
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  createCheckpoint(): DeterministicRngState {
    return { algorithm: "mulberry32-v1", state: this.state };
  }

  restoreCheckpoint(checkpoint: DeterministicRngState): void {
    if (
      checkpoint.algorithm !== "mulberry32-v1"
      || !Number.isInteger(checkpoint.state)
      || checkpoint.state < 0
      || checkpoint.state > 0xffff_ffff
    ) {
      throw new Error("Invalid deterministic RNG checkpoint.");
    }
    this.state = checkpoint.state >>> 0;
  }
}
