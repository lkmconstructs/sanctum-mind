// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { resolve } from "node:path";
import type { Embedder } from "../verbs/types.js";

interface FlagModel {
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
}

/** L2-normalise; null for a zero (or non-finite) vector, which has no direction and must not be stored. */
export function l2normalise(v: ArrayLike<number>): Float32Array | null {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return null;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/**
 * Local ONNX embedder (fastembed, BAAI/bge-small-en-v1.5). Loaded lazily on the first embed call;
 * any load or inference failure is logged once and the embedder returns nulls from then on.
 */
export function localEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  const cacheDir = resolve(env.EMBED_CACHE_DIR || "./.embed-cache");
  let model: Promise<FlagModel | null> | undefined;
  let warned = false;
  const warn = (e: unknown) => {
    if (warned) return;
    warned = true;
    console.error("sanctum-mind: local embedder unavailable, vectors will be null:", e instanceof Error ? e.message : e);
  };
  const load = async (): Promise<FlagModel | null> => {
    try {
      const fe = await import("fastembed");
      return await fe.FlagEmbedding.init({
        model: fe.EmbeddingModel.BGESmallENV15,
        cacheDir,
        showDownloadProgress: false,
      });
    } catch (e) {
      warn(e);
      return null;
    }
  };
  return {
    name: "local:bge-small-en-v1.5",
    dim: 384,
    async embed(texts) {
      if (texts.length === 0) return [];
      model ??= load();
      const m = await model;
      if (!m) return texts.map(() => null);
      try {
        const out: Array<Float32Array | null> = [];
        for await (const batch of m.embed(texts, 32)) {
          for (const v of batch) out.push(v.length === 384 ? l2normalise(v) : null);
        }
        if (out.length !== texts.length) throw new Error("embedder returned a wrong number of vectors");
        return out;
      } catch (e) {
        warn(e);
        return texts.map(() => null);
      }
    },
  };
}
