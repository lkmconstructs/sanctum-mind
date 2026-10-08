// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Registry, Verb } from "./types.js";
import { mind_health } from "./mind_health.js";
import { mind_state } from "./mind_state.js";
import { mind_write } from "./mind_write.js";
import { mind_observe } from "./mind_observe.js";
import { mind_sit } from "./mind_sit.js";
import { mind_resolve } from "./mind_resolve.js";
import { mind_loop } from "./mind_loop.js";
import { mind_identity } from "./mind_identity.js";
import { mind_vow } from "./mind_vow.js";
import { mind_anchor } from "./mind_anchor.js";
import { mind_desire } from "./mind_desire.js";
import { mind_rethink } from "./mind_rethink.js";
import { mind_relate } from "./mind_relate.js";
import { mind_letter } from "./mind_letter.js";
import { mind_link } from "./mind_link.js";
import { mind_drive } from "./mind_drive.js";
import { mind_weather } from "./mind_weather.js";
import { mind_context } from "./mind_context.js";
import { mind_handoff } from "./mind_handoff.js";
import { mind_thread } from "./mind_thread.js";
import { mind_task } from "./mind_task.js";
import { mind_orient } from "./mind_orient.js";
import { mind_search } from "./mind_search.js";
import { mind_surface } from "./mind_surface.js";

export const registry: Registry = [
  // Wake
  mind_orient,
  // Ops
  mind_health,
  // State
  mind_state, mind_drive, mind_weather, mind_context, mind_handoff,
  // Remember
  mind_write, mind_observe, mind_search, mind_surface,
  // Hold
  mind_sit, mind_resolve, mind_loop, mind_thread, mind_task,
  // Self
  mind_identity, mind_vow, mind_anchor, mind_desire, mind_rethink,
  // Bond
  mind_relate, mind_letter, mind_link,
];

export function findVerb(name: string): Verb | undefined {
  return registry.find((v) => v.name === name);
}
