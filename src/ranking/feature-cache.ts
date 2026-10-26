import type { Chunk } from "../types.ts";

/** FIFO limits bound metadata for live indexes; weak keys release discarded chunks. */
export class ChunkFeatureCache<Value> {
  private values = new WeakMap<Chunk, { value: Value; ref: WeakRef<Chunk> }>();
  private readonly order = new Map<WeakRef<Chunk>, { tokens: number; characters: number }>();
  private tokens = 0;
  private characters = 0;

  constructor(private readonly limits = { chunks: 512, tokens: 100_000, characters: 2_000_000 }) {}

  get(chunk: Chunk): Value | undefined {
    return this.values.get(chunk)?.value;
  }

  set(chunk: Chunk, value: Value, tokens = 0): void {
    this.delete(chunk);
    const characters = chunk.content.length;
    if (tokens > this.limits.tokens || characters > this.limits.characters) return;
    const ref = new WeakRef(chunk);
    this.values.set(chunk, { value, ref });
    this.order.set(ref, { tokens, characters });
    this.tokens += tokens;
    this.characters += characters;
    while (
      this.order.size > this.limits.chunks ||
      this.tokens > this.limits.tokens ||
      this.characters > this.limits.characters
    ) {
      const oldest = this.order.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  delete(chunk: Chunk): void {
    const entry = this.values.get(chunk);
    if (entry) this.remove(entry.ref);
  }

  private remove(ref: WeakRef<Chunk>): void {
    const weight = this.order.get(ref);
    if (!weight) return;
    this.tokens -= weight.tokens;
    this.characters -= weight.characters;
    this.order.delete(ref);
    const chunk = ref.deref();
    if (chunk) this.values.delete(chunk);
  }

  clear(): void {
    this.values = new WeakMap();
    this.order.clear();
    this.tokens = 0;
    this.characters = 0;
  }

  get size(): number {
    return this.order.size;
  }
}
