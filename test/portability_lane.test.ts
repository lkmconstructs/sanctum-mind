// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

// Runs every test of portability.test.ts again with export and import connected as the sanctum_import login (the lane the
// compose "tools" service uses), so the import path is proved end to end under the lane guards, not only on the legacy lane.
process.env.PORTABILITY_LANE = "import";
await import("./portability.test.js");
