# Updating a running sanctum-mind

One command brings an existing install to the version you have checked out: `sanctum-mind upgrade`. It needs the admin database address (a superuser, such as the `postgres` user), the same one `init` uses.

## Where new versions come from

The project is not on npm yet, so `git pull` is the fetch step. Tagged releases on GitHub (`v0.1.0`, `v0.2.0`, ...) are the versions to move between: `git fetch --tags` then `git checkout v0.2.0` pins one, and `git pull` on the main branch follows the latest. Read the release's entry in [CHANGELOG.md](CHANGELOG.md) first; each one has an "Upgrading" part with anything you must do by hand.

Back up before you start. A migration is never undone by a later version, and there is no downgrade: to go back, restore the backup and check out the older version. Under Docker: `docker compose exec -T db pg_dump -U postgres sanctum_mind > backup.sql` (`-T` keeps the dump free of terminal characters).

## Docker

```bash
git pull
docker compose build
docker compose run --rm init node dist/cli.js upgrade
docker compose up -d
```

The order matters: build the new image, migrate the database with it, and only then restart the services. `docker compose up -d` before `upgrade` starts the new code on the old schema, and `mind` and `daemon` refuse to start until `upgrade` has run (they say so).

`init` is still the service's default command (`docker compose run --rm init` sets up or repairs a mind and prints its keys); `upgrade` is the command you name after it.

Coming from 0.1.0 under Docker you also need the lane logins that 0.2.0 introduced. After `upgrade`, run `docker compose run --rm init` once (it creates them with the passwords in `docker-compose.yml`), and then `docker compose up -d`. Until the logins exist, `upgrade` exits 3 and says so.

## A clone (no Docker)

```bash
git pull && npm ci && npm run build
DATABASE_URL=<admin url> npm start -- upgrade
DATABASE_URL=<admin url> npm start -- init --mind alpha
```

`init` after `upgrade` creates the lane logins that 0.2.0 introduced (it never replaces a key that exists, and leaves a login's password alone unless you pass one). Keep the two on separate lines: `upgrade` exits 3 while a step is open, and that must not stop `init`. Then change `DATABASE_URL` of the services to the lane addresses `init` printed, and restart them (`http`, `stdio` clients, `daemon`).

## What `upgrade` does

In this order:

1. Prints the package version, how many migrations the database has applied, and which are pending. A database that records migrations this build does not carry was migrated by a newer version: `upgrade` says so and exits 1, because there is no downgrade (check out the newer version again, or restore a backup).
2. Applies the pending migrations (the same runner as `migrate`). Before 0020 it looks for cores with two open declarations, names them, and stops before applying anything (see the table below).
3. Repairs the four lane roles and their grants. It creates a missing role without a login and never changes a password.
4. Checks every mind for repair work that is missing (rewrites and retirements made before migration 0025, and nodes brought in by an import) and adds it. This happens on every run, not only when 0025 is applied, so an install whose 0025 was applied long ago still gets it. `--no-backfill` prints the exact command for each mind instead. A mind whose access is suspended cannot be checked: it is listed with `sanctum-mind restore-access --mind <id>`.
5. Prints the steps that still need you, read from the database each time: for example the lane logins that do not exist yet. It also prints, for information only, how many sessions are still connected as the legacy `sanctum_app` login.

`--dry-run` prints all of this and changes nothing. Running it again on a finished install prints "nothing to do".

| Exit | Meaning |
| --- | --- |
| 0 | Nothing detectable is left to do (a dry run exits 0 unless it cannot connect) |
| 3 | The database is upgraded, but steps remain (a lane login is missing, a suspended mind, `--no-backfill`); they are printed, and they are printed again on every run until they are done |
| 1 | It failed (a migration refused, the connection is not a superuser one, the database is newer than this build); what was applied stays applied, fix the cause and run it again |

A script can run `sanctum-mind upgrade` and branch on 0 and 3.

## Which version am I on

- `sanctum-mind version` prints the package version and build info (Docker: `docker compose run --rm init node dist/cli.js version`).
- `mind_health` has `version: {package, schema, pending}`: the package version, the last migration the database has applied, and how many this version still has to apply (0 when current).
- `GET /health` has `version` and `schema`.

`http`, `stdio`, `daemon` and the commands that write (`import-mind`, `embed-backfill`, `extractor`, `grant`, `sinks requeue`, `import-revien`) check at start and refuse to run on a database that is out of step with the build: "database is N migration(s) behind: run `sanctum-mind upgrade` with the admin URL". `export-mind` only reads, so it runs and prints a warning.

## Steps that need you, by release

<!-- manual-steps:begin (generated from MANUAL_STEPS in src/upgrade.ts; test/upgrade.test.ts keeps it in sync) -->
| Release | Migration | When | What you do |
| --- | --- | --- | --- |
| 0.1.0 | 0020 | when it refuses | if the migration refused on proposals_one_open_per_core, withdraw one of the two open declarations on that core through the still-running old version (the new service refuses to start while the database is behind), or as the database admin with update proposals set status='withdrawn', withdrawn_at=now() where id='<proposal id>' (an admin action, not the mind's), then run upgrade again |
| 0.2.0 | 0026 | while sanctum_verb or sanctum_daemon has no login | services now log in as lanes: run init with the admin URL to create the lane logins (Docker: docker compose run --rm init), then set DATABASE_URL per service to the lane URLs init printed; until then they run on the legacy login with a warning |
<!-- manual-steps:end -->

The 0020 step: `upgrade` lists the cores that have two open declarations (mind, core and the proposal ids) before it applies anything. Withdraw one through the old version, which is still running at that point, or as the database admin with `update proposals set status='withdrawn', withdrawn_at=now() where id='<id>'` (an admin action, not the mind's own), then run `upgrade` again. The 0026 step is shown on every run while `sanctum_verb` or `sanctum_daemon` has no login, and clears once `init` has created them.
