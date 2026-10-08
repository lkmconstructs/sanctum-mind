import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Applied migration files are never edited: their checksums are recorded in schema_migrations and verified on every
 * run. This pins each applied file (sha256 of the utf8 text, exactly as src/db/migrate.ts computes it). Wording fixes
 * go in the next migration's header or in the docs. A new migration is not listed here and does not fail this test;
 * add it to the map only when it has been applied somewhere and is final.
 */
const PINNED: Record<string, string> = {
  "0001_core.sql": "8ecd21bad5888f3ce190535c23c1b2d552ce6f58987321d10c0d67a033ff8da3",
  "0002_hold.sql": "dd70a6f2683481cd866ee5dda9a79cff346aac8cdfe2cd8689870b68ba8a1949",
  "0003_self.sql": "f9b70bae2f88eb6debf26a64126bb5bd166a6074caf62d39f072dc277c3686b4",
  "0004_bond.sql": "ad991f224d35df5aea09a73b450bc9e1f484090e63af12bbaab6a5306e0f57ae",
  "0005_integrity.sql": "d1962e117ec99c59b0e008b937b9c42244567af7719235cb774c9274da5ead49",
  "0006_state.sql": "f3c8ae6864cdae92044783fa1fc8cead48569e52032b777ecb6adc390b173c2d",
  "0007_threads_tasks.sql": "fecb38f5c435839f9541d620c9c0fe63ae4f3bb95992059b9dd2b8808b409d1b",
  "0008_weather_index.sql": "5d92e7242bef99e93a2c757bdb5ce42ea90069bb15391be9f0040181b2aca8c8",
  "0009_retrieval.sql": "92898f79acfae99820f6fa864bb1737c54196fc0eac3d24ab79915b193a61729",
  "0010_trigger_tighten.sql": "16a7fdf8f1225f2e9f092de65222ef0ce292ceec99d94e9203e652fe8cdb19f7",
  "0011_daemon.sql": "20186317e2bfd8a53871d98242f3ed2f31636682244c5fcfb1fe4627752ca07c",
  "0012_import_index.sql": "58353001a9a9e1160c06b9d3cd4c3514fcf198af6229a60dd524f58e432a65f5",
  "0013_govern.sql": "0647504e44d46857a15b52cc3dff7c6254d500705d2e14ad6c710f69df61508d",
  "0014_outbox.sql": "9ee71a2b7d616b21faaefce464ae884139b9932781df167757afbe0984051c5e",
  "0015_purge.sql": "4ad15f13c83d9400978202d87d7482f729635e184d88b97cdb260cb47b69ef43",
  "0016_integrity2.sql": "378bfcd34322cfef0162ac65b80123c0e10e64b1fec8d29c25254b32644963bc",
  "0017_steward.sql": "e502540041547d8f4d82ac2b5f99ff0819abbaeb02977fed1b184f6965f62602",
  "0018_identity_guard.sql": "bc89dffe455780754207e044025e51d468fe1af784c5b573495852eb364f37fd",
  "0019_retire.sql": "6a17cc66ffc3fb86e6540beb0e6e85816b0cd9f9e1b7fbf369d6b4416590fcc3",
};

const DIR = fileURLToPath(new URL("../migrations", import.meta.url));
// the same computation as src/db/migrate.ts: sha256 over the file read as utf8
const checksum = (file: string) => createHash("sha256").update(readFileSync(path.join(DIR, file), "utf8")).digest("hex");

describe("applied migrations are immutable", () => {
  it("every pinned migration still exists", () => {
    for (const file of Object.keys(PINNED)) expect(existsSync(path.join(DIR, file)), `${file} is missing`).toBe(true);
  });

  for (const [file, pinned] of Object.entries(PINNED)) {
    it(`${file} is byte for byte as applied`, () => {
      expect(
        checksum(file),
        `${file} was edited after it was applied. Never edit an applied migration; add a new migration (or fix the wording in the next migration's header or the docs) instead.`,
      ).toBe(pinned);
    });
  }
});
