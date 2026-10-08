import { z } from "zod";

/**
 * The public Revien graph export format (version "1.0"). Nodes and edges tolerate unknown extra
 * fields (looseObject) and require only the fields the adapter maps; every other documented field
 * is optional and nullable, because exporters leave them out or null.
 */
const optStr = z.string().nullish();
const optBool = z.boolean().nullish();
const optNum = z.number().nullish();

export const revienNodeSchema = z.looseObject({
  node_id: z.string().min(1),
  node_type: z.string().min(1),
  label: z.string(),
  content: z.string(),
  created_at: z.string(),
  source_id: optStr,
  last_accessed: optStr,
  access_count: optNum,
  metadata: z.record(z.string(), z.unknown()).nullish(),
  source_type: z.enum(["extracted", "inferred", "derived", "corrected"]).nullish(),
  confidence: optNum,
  pinned: optBool,
  confidence_set_at: optStr,
  confidence_set_by: optStr,
  source_context: optStr,
  last_referenced: optStr,
  invalidated_at: optStr,
  source_modality: optStr,
  answerable_by_text: optBool,
  vision_processed: optBool,
  recorded_at: optStr,
  event_time_start: optStr,
  event_time_end: optStr,
  event_time_granularity: optStr,
  event_time_confidence: optNum,
  event_time_text: optStr,
});

export const revienEdgeSchema = z.looseObject({
  edge_id: z.string().min(1),
  edge_type: z.string().min(1),
  source_node_id: z.string().min(1),
  target_node_id: z.string().min(1),
  weight: optNum,
  created_at: optStr,
  metadata: z.record(z.string(), z.unknown()).nullish(),
  confidence: optNum,
  confidence_set_at: optStr,
  confidence_set_by: optStr,
  source_context: optStr,
});

export const revienExportSchema = z.looseObject({
  nodes: z.array(revienNodeSchema),
  edges: z.array(revienEdgeSchema).default([]),
  exported_at: optStr,
  version: optStr,
});

export type RevienNode = z.infer<typeof revienNodeSchema>;
export type RevienEdge = z.infer<typeof revienEdgeSchema>;
export type RevienExport = z.infer<typeof revienExportSchema>;
