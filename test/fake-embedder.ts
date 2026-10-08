import { createHash } from "node:crypto";
import type { Embedder } from "../src/verbs/types.js";

function bucket(word: string): number {
  return createHash("sha256").update(word).digest().readUInt32BE(0) % 384;
}

/** Deterministic bag-of-words hashing embedder: texts sharing words land closer together. */
export const FAKE_EMBEDDER: Embedder = {
  name: "fake",
  dim: 384,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(384);
      for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[bucket(w)]! += 1;
      let sum = 0;
      for (const x of v) sum += x * x;
      if (sum === 0) v[0] = 1;
      else {
        const n = Math.sqrt(sum);
        for (let i = 0; i < v.length; i++) v[i]! /= n;
      }
      return v;
    });
  },
};
