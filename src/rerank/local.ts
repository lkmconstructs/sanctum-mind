// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { resolve } from "node:path";
import { sigmoid, type Reranker } from "./types.js";

/** The cross-encoder: a small ONNX MS MARCO model (about 23 MB quantised) that scores (query, document) pairs. */
export const LOCAL_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** The slice of @huggingface/transformers this file uses; the package is optional and loaded dynamically. */
export interface TransformersModule {
  env: { cacheDir: string; allowLocalModels?: boolean };
  AutoTokenizer: { from_pretrained(model: string): Promise<(texts: string[], opts: Record<string, unknown>) => unknown> };
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, opts?: Record<string, unknown>): Promise<(inputs: unknown) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>>;
  };
}

/** Loads the package. Overridable so tests can stand a fake in; the default imports it by a non-literal name, so the build does not need it. */
export type TransformersLoader = () => Promise<TransformersModule>;

const defaultLoader: TransformersLoader = async () => {
  const name = "@huggingface/transformers";
  return (await import(name)) as TransformersModule;
};

const BATCH = 16;
const MAX_LENGTH = 512;

/**
 * Local ONNX cross-encoder reranker (@huggingface/transformers, Xenova/ms-marco-MiniLM-L-6-v2, CPU).
 *
 * The package is an OPTIONAL dependency, not listed in package.json: `npm ci` works without it. Install it where you want
 * the local reranker (`npm install --no-save @huggingface/transformers`). The model files download into RERANK_CACHE_DIR
 * (default ./.rerank-cache, gitignored) on first use. Everything is lazy: nothing loads until the first rerank call.
 * If the package or the model cannot be loaded, or inference fails, one warning is logged and every score is null from then on
 * (the extractor then runs on cosine and its other features, and says so).
 *
 * Scores: the model's raw logit per pair, squashed with the sigmoid, so every score is 0..1 and comparable within a batch.
 */
export function localReranker(
  env: Record<string, string | undefined> = process.env,
  load: TransformersLoader = defaultLoader,
): Reranker {
  const cacheDir = resolve(env.RERANK_CACHE_DIR || "./.rerank-cache");
  let model: Promise<{ tokenizer: (texts: string[], opts: Record<string, unknown>) => unknown; net: (i: unknown) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }> } | null> | undefined;
  let warned = false;
  const warn = (e: unknown) => {
    if (warned) return;
    warned = true;
    console.error("sanctum-mind: local reranker unavailable, scores will be null:", e instanceof Error ? e.message : e);
  };
  const init = async () => {
    try {
      const tf = await load();
      tf.env.cacheDir = cacheDir;
      const tokenizer = await tf.AutoTokenizer.from_pretrained(LOCAL_RERANK_MODEL);
      const net = await tf.AutoModelForSequenceClassification.from_pretrained(LOCAL_RERANK_MODEL, { dtype: "q8" });
      return { tokenizer, net };
    } catch (e) {
      warn(e);
      return null;
    }
  };
  return {
    name: "local:ms-marco-MiniLM-L-6-v2",
    async rerank(query, documents) {
      if (documents.length === 0) return [];
      model ??= init();
      const m = await model;
      if (!m) return documents.map(() => null);
      try {
        const out: Array<number | null> = [];
        for (let i = 0; i < documents.length; i += BATCH) {
          const docs = documents.slice(i, i + BATCH);
          const inputs = m.tokenizer(docs.map(() => query), { text_pair: docs, padding: true, truncation: true, max_length: MAX_LENGTH });
          const { logits } = await m.net(inputs);
          // one logit per pair for this model; for a two-class head the last column is "relevant"
          const width = logits.dims[1] ?? 1;
          for (let j = 0; j < docs.length; j++) {
            const raw = Number(logits.data[j * width + (width - 1)]);
            if (!Number.isFinite(raw)) throw new Error("reranker returned a non-finite score");
            out.push(sigmoid(raw));
          }
        }
        return out;
      } catch (e) {
        warn(e);
        return documents.map(() => null);
      }
    },
  };
}
