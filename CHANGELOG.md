# Changelog

All notable changes to sanctum-mind are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Moving between versions is described in [UPGRADING.md](UPGRADING.md).

## [0.2.0] - 2026-10-12

### Added

- Per-lane database roles (migration 0026). The service, the daemon, the operator commands and import/export each log in as their own database role (`sanctum_verb`, `sanctum_daemon`, `sanctum_operator`, `sanctum_import`), and the database works out who is acting from the login, not from a setting the client can type. A holder of the daemon's address can no longer decide what the mind notices.
- `sanctum-mind upgrade`: applies pending migrations, repairs the lane roles and their grants (no password is changed), adds any missing belief-repair work for every mind (on every run, so an install that already has 0025 gets it too), and prints the steps that still need you, read from the database each time. `--dry-run` changes nothing, `--no-backfill` prints the command instead. Exit 0 when nothing detectable is left, 3 when steps remain, 1 on failure or when the database was migrated by a newer version.
- `sanctum-mind version` prints the package version and build info.
- `http`, `stdio`, `daemon` and the commands that write (`import-mind`, `embed-backfill`, `extractor`, `grant`, `sinks requeue`, `import-revien`) refuse to run on a database that is behind (or newer than the build):  "database is N migration(s) behind: run `sanctum-mind upgrade` with the admin URL". `export-mind` runs with a warning.
- `mind_health` reports `version: {package, schema, pending}`, and `GET /health` reports `version` and `schema`.
- UPGRADING.md and this file.

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
