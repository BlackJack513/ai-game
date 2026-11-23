/** 小型的确定性伪随机数发生器（mulberry32），用于地图生成与 bot 决策。 */

export function hashSeed(input: string | number): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return (Math.floor(input) >>> 0) || 1;
  }
  const s = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0 || 1;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    let a = (this.state += 0x6d2b79f5);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}

/** 把任意字符串转成一个稳定的 32 位无符号整数（用于 bot 每回合的本地随机源）。 */
export function seedFrom(...parts: Array<string | number>): number {
  return hashSeed(parts.join(':'));
}
