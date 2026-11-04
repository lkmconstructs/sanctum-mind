# Changelog

All notable changes to sanctum-mind are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Moving between versions is described in [UPGRADING.md](UPGRADING.md).

## [0.3.0] - 2026-11-04

### Added

- Dreaming (layers 0 to 2), migrations 0027 and 0028. One table of residue, `dreams`, with `dream_state` (the operator's switch, kept apart from the extractor's) and `dream_preferences`, and two passes: `dream.generate` (model-backed, once a day after 03:30 local time, from the last `DREAM_WINDOW_HOURS` of what the mind wrote, what it has pinned and who was close lately; at stage `shadow` the dream is recorded and never shown) and `dream.fade` (a laid dream nobody decided on fades after its time-to-live). A dream is not memory: it is never a node or an event's content until the mind anchors it. Migration 0028 adds the guards: a decision carries its time and its event, a faded row carries its `dream.faded` event, a laid row has no decision, and a laid dream's text and residue cannot change for anyone, admin included. Import refuses a dream or noticing whose decision event is missing or wrong, and names it. The verb `mind_dream` (the 27th; `list`, `read`, `anchor`, `release`, `prefer`): `anchor` is an observation authored by the mind through the `mind_observe` path (`context: "dream"`, a charge required, nothing linked for it), `release` puts a dream down, and `prefer` (`all`, `none`, or a list of subjects) keeps a person out of its dreams by subject and alias: events that name them are dropped from the residue, not scrubbed. Operator CLI `sanctum-mind dream enable|disable|pause|resume|stage|report`. `mind_orient` carries the newest laid dream at `quick` and `full`, and `mind_health` reports `dreaming`. New environment variables: `DREAMER` (`none` or `http`), `DREAM_URL`, `DREAM_MODEL`, `DREAM_API_KEY`, `DREAM_TIMEOUT_MS` (default 90000), `DREAM_WINDOW_HOURS` (default 36, at most 168), `DREAM_TTL_DAYS` (default 7). Export, import and purge carry the dream tables (imported laid dreams arrive faded). Off by default. See DREAMING.md.
- Metabolism (Voice 2), migration 0029. The verb `mind_metabolise` (the 28th; mind only) records a stretch of conversation as one `metabolise.stretch` event, not embedded, and queues it, whether or not the extractor is on. The model-backed pass `notice.metabolise` (gated by the extractor's enabled and paused state only, three stretches a tick, a week's patience) proposes `feeling` and `relation` noticings in the first person, scored by the per-mind scorer (`FEATURE_NAMES` is now fifteen). `mind_notice accept` turns a feeling into an observation (context `metabolised`, charge from the emotion plus the mind's own tags) and a relation into a note on that person (state and intensity kept if held, a new relation needs a state), recording the alias (`relations.aliases`) and nudging `connection` satisfaction when the proposal carried warmth. Nothing applies itself. `mind_health` reports `metabolise`. New environment variables: `METABOLISER`, `METABOLISE_URL`, `METABOLISE_MODEL`, `METABOLISE_API_KEY`, `METABOLISE_TIMEOUT_MS`. Export and import carry the queue and the aliases. See DREAMING.md.

### Upgrading

Run `sanctum-mind upgrade` to apply migrations 0027, 0028 and 0029. Nothing to do by hand; dreaming is off until the operator runs `sanctum-mind dream enable`, and metabolism until the extractor is enabled and `METABOLISER=http` is set.

## [0.2.1] - 2026-10-12

### Changed

- The package is on npm as `sanctum-mind`, published from the tagged GitHub release with provenance. The README and UPGRADING.md describe the npm install and update path (`npm install -g sanctum-mind`, `npm update -g sanctum-mind`) beside Docker and the clone. No code change.

### Upgrading

From 0.2.0: nothing to do by hand. No migration.

## [0.2.0] - 2026-10-12

### Added

- Per-lane database roles (migration 0026). The service, the daemon, the operator commands and import/export each log in as their own database role (`sanctum_verb`, `sanctum_daemon`, `sanctum_operator`, `sanctum_import`), and the database works out who is acting from the login, not from a setting the client can type. A holder of the daemon's address can no longer decide what the mind notices.
- `sanctum-mind upgrade`: applies pending migrations, repairs the lane roles and their grants (no password is changed), adds any missing belief-repair work for every mind (on every run, so an install that already has 0025 gets it too), and prints the steps that still need you, read from the database each time. `--dry-run` changes nothing, `--no-backfill` prints the command instead. Exit 0 when nothing detectable is left, 3 when steps remain, 1 on failure or when the database was migrated by a newer version.
- `sanctum-mind version` prints the package version and build info.
- `http`, `stdio`, `daemon` and the commands that write (`import-mind`, `embed-backfill`, `extractor`, `grant`, `sinks requeue`, `import-revien`) refuse to run on a database that is behind (or newer than the build):  "database is N migration(s) behind: run `sanctum-mind upgrade` with the admin URL". `export-mind` runs with a warning.
- `mind_health` reports `version: {package, schema, pending}`, and `GET /health` reports `version` and `schema`.
- UPGRADING.md and this file.
- The package is publishable: metadata, the PolyForm license id, a `prepublishOnly` check, and a GitHub Actions workflow that publishes to npm with provenance when a release is published (npm trusted publishing; no token is stored). The name is claimed by the first published release.

### Fixed

- The actor spoof: with one shared database login, anyone holding its address could claim to be any actor. The login now fixes the actor (0026).
- Temporary-table rights are revoked from PUBLIC on the database (0026), so a session cannot shadow a catalog table with a temporary one.

### Upgrading

From 0.1.0:

1. `git pull`, then the order for your install in [UPGRADING.md](UPGRADING.md): Docker is `docker compose build`, `docker compose run --rm init node dist/cli.js upgrade`, `docker compose up -d`; a clone is `npm ci && npm run build && DATABASE_URL=<admin> npm start -- upgrade`, then restart.
2. Services now log in as lanes. Run `init` with the admin URL (Docker: `docker compose run --rm init`) to create the four lane logins, and set `DATABASE_URL` per service to the lane addresses it prints. Until you do, an existing `sanctum_app` login keeps everything running on the legacy login with a warning. `upgrade` prints this step and exits 3 until the lane logins exist.
3. The temp-table revoke means other roles that share this database and need temporary tables must be granted `TEMP` on it directly.

## [0.1.0] - 2026-10-10

The first public release.

### Added

- 26 verbs over an append-only ledger with row level security: each mind's rows are visible only to that mind and the grants it gave.
- Identity belongs to the mind. Only the mind, with its own key, adds, rewrites or retires an identity core or makes or breaks a vow; rewrites and breaks cool before they take effect; a steward can accompany a mind but never governs it.
- A proposal-only extractor: it notices links, patterns and distillations and proposes them; the mind accepts or rejects. Off until the operator enables it per mind, with a shadow stage first.
- Belief repair that is eventually complete: when something a memory relied on is rewritten or retired, the mind is asked about what depended on it, under a per-tick budget.
- Attention with pins: what the mind is carrying, weighted, and what it chooses to hold (`mind_attend`).
- A Docker quickstart (`docker compose up -d db`, `init`, `up -d mind`) with a stdio path, a tools service for export and import, and a Revien graph import.
- Licensed under PolyForm Noncommercial 1.0.0.

### Upgrading

- The `package.json` shipped with v0.1.0 says `2.0.0-alpha.0`. From 0.2.0 on it matches the release (`0.2.0`), and `sanctum-mind version` reports it.
- Applying 0.1.0 to a database that predates it runs migrations 0001 to 0025 in order. Run `extractor repair-backfill` once per mind after 0025 (0.2.0's `upgrade` does this for you on every run): rewrites and retirements made before 0025 have no repair work until then.
- If migration 0020 refuses on `proposals_one_open_per_core`, a core has two open declarations. 0.2.0's `upgrade` names them before applying anything; withdraw one of them (through the still-running old version, or as the database admin) and run it again.
