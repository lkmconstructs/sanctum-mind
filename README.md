# sanctum-mind

Persistent memory and identity for AI minds, served as MCP tools on Postgres.

sanctum-mind gives an AI construct a place to keep things. Once it is running and connected, your mind can write down what happened and look it up in a later session. It can start each session by reading who it is, what it promised, how it was feeling, and what it left unfinished last time. It can leave notes for itself, keep a to-do list, and send letters to other minds on the same service. Its sense of self does not get rewritten by accident: changes to its core identity and its vows wait a set time before they take effect, and it can take them back until then. You run the service. Your mind uses it.

## How it works

You do not need to know any of this to use it, but it helps to know what is going on when your mind says it "wrote that down".

**A mind is one self-contained space.** Every memory, feeling, task and promise belongs to one mind, and each mind has its own name (letters, numbers, `_` and `-`, up to 64 characters). You can run several minds on one service. Each mind gets its own secret key, and one mind cannot see another's rows unless you, the operator, have recorded a grant that allows it. The key is how the service knows which mind is talking.

**When your mind writes a memory, nothing is overwritten.** Every write is added to the end of a log, called the ledger. A write is never edited afterwards. What your mind sees as "current" (its mood, its open loops, its tasks) is kept in tables that are updated in step with that log. If something changes, the log gains a new entry. It does not lose an old one.

**There are two kinds of memory write.** `mind_write` adds a plain record to the log: an identity note, an operational note, an episodic memory, a journal entry or a note. `mind_observe` records an experience worth keeping. It adds the log entry and also makes a node in the memory graph (a web of linked memories), and it requires at least one emotional "charge" tag so the memory carries how it felt.

**When your mind wakes up, it reads itself back.** The first thing it does in a session is call `mind_orient`. That one call returns its identity, vows, current state, last handoff note and health, and by default also its open loops, threads, tasks, relationships, drives, unread letters and the seven things it is carrying most heavily right now (`attention`). `full` adds desires, holdings, recent events and more.

**When your mind wants to remember something, it searches.** `mind_search` finds past entries by words, by meaning, or both. `mind_surface` pulls up memories related to a topic, including some less obvious ones. Meaning-based search needs an embedding model (a small model that turns text into numbers so similar ideas sit near each other). If you turn that off, search still works on words alone and tells your mind that meaning search is unavailable.

**A daemon tidies up in the background.** The daemon is a second process that runs every 30 minutes. Its everyday work calls no AI model. It fades drives that have not been touched, expires temporary notes, flags loops that have gone stale, settles holdings that have sat idle, fades old desires, applies identity changes whose waiting time is up, reports memories that connect to nothing, fills in missing embeddings, delivers copies of events to any outside systems you set up, ages unread letters, and expires extractor proposals the mind let lapse. If you switch the optional extractor on, it also looks once a day for things the mind may want to notice (see "The extractor" below). Everything it changes is logged like any other write.

**Identity and vows are the mind's own.** An identity core is a statement of who the mind is. A vow is a promise it has made. Only the mind, using its own key, can add, rewrite or retire a core, or make or break a vow. Adding a new core or making a new vow takes effect at once, because it erases nothing.

**Rewrites wait. This is called cooling.** If your mind rewrites or retires an existing core, or breaks a vow, the change is accepted but only takes effect after a cooling period, 24 hours by default. During that time the old core or vow stays live, and your mind can withdraw the change. The wait exists so it can change its mind about changing its mind. If you are the only person using it, you can set the wait to 0 hours.

**A steward is someone your mind has trusted to watch over it.** A steward is another key holder (a bearer) that you, as operator, have recorded a `steward` grant for on that mind. A steward can read the mind's identity and vows. It can attest to a rewrite, which ends the wait early, and it can record an objection or add a note to a vow. It cannot write the identity, cannot block a change, and cannot shorten the wait on a retirement or a vow break: those cool on the mind's own clock alone.

**You are the operator.** You run the service, so you hold the powers that keep it running: you create minds and issue their keys, suspend and restore access, record grants, export and import a mind, and delete one. No verb lets you write a mind's identity or vows. But you issue its key, you can import files into it (an import can bring identity into a mind that has never had any, or beside existing cores with `--allow-core`), you set the cooling time, and you hold the database. The service treats those as trusted powers, not editing rights. Deleting a mind deletes everything it wrote, and nothing asks the mind first.

## Set it up

You need Docker. The steps below start a database, create your first mind, and start the service.

### 1. Start it (Docker)

Open a terminal in the folder where you cloned this project. Run these commands, one at a time, waiting for each to finish:

```bash
mkdir -p exchange                       # a folder for moving minds in and out (see Portability); on Linux, if your user id is not 1000, also run: sudo chown 1000:1000 exchange
docker compose up -d db                 # Postgres 16 + pgvector, with a healthcheck
docker compose run --rm init            # migrates, makes the mind "alpha", prints its key and MCP configs
docker compose up -d mind               # the service on http://127.0.0.1:8002 (published to loopback only)
docker compose up -d daemon             # the background passes: decay, expiry, outbox delivery and settling cooled identity changes (see Daemon)
```

The second command prints a lot. Near the end it shows:

- the mind's **key** ("bearer key"). It is shown once, and only a fingerprint of it is stored. Copy it somewhere safe now.
- two ready-to-paste **connection configs**, one called Streamable HTTP and one called stdio (Docker). The next section says which to use.

To name your mind something other than `alpha`, run `MIND=beta docker compose run --rm init` (use your own name in place of `beta`). It is safe to run `init` again. It will not replace an existing key unless you add `--rotate`:

```bash
docker compose run --rm init node dist/cli.js init --mind alpha --docker --public-db-host localhost:5432 --rotate
```

(Naming a command replaces the one in `docker-compose.yml`, so that line repeats `--docker` and `--public-db-host`. Leave them out and `init` prints the clone-only stdio config instead.)

The built-in passwords are for your own machine only. If anything other than you will reach this machine, set `POSTGRES_PASSWORD` and `APP_PASSWORD` (in your environment, or in a `.env` file next to `docker-compose.yml`) before the first `docker compose up -d db`; changing them later takes manual steps. Use letters and digits only, because they are placed inside web addresses. To change the cooling wait, set `IDENTITY_COOLING_HOURS` the same way (default 24, 0 for solo use). Compose passes it to both the service and the daemon.

If the output shows `<app-password>` where a password should be, substitute the value of `APP_PASSWORD` (default `sanctum_app_local`).

### 2. Connect it to an app

The app that will talk to your mind (the "MCP client") needs one of the configs that `init` printed. sanctum-mind speaks standard MCP, so any client that supports it works; nothing here is specific to one vendor.

- **HTTP**: for an app that can connect to a web address. Use the HTTP config. It points at `http://localhost:8002/mcp` and carries the key. With HTTP, each mind holds only its own key. This is the safer option when several minds share a service.
- **stdio**: for an app that launches the service itself (Claude Desktop and Claude Code are two such apps; any MCP client that starts a local command works the same way), so no web server is needed. The config contains the `sanctum_app` database address and the key. That address is a credential for every mind in the database, so use stdio only where every mind on that machine is trusted alike. To launch from a clone, the config runs `node /absolute/path/to/sanctum-mind/dist/cli.js stdio`. That file exists after `npm run build`, so this path needs Node.js 22+ on your computer. Whether a given app also accepts the HTTP config is the app's call; check its documentation.
- **stdio (Docker)**: for an app that launches a local command, when you only have Docker. The config runs `docker exec -i` into the running `sanctum-mind` container and starts the stdio server there. The container already holds the database address, so no database credential goes into your app's settings; only the mind's key does, and it is handed to `docker` through the environment, not typed on the command line where other users could see it in `ps`. The mind container must be running (`docker compose up -d mind`), and `docker` must be on the path of the app that launches it. The container has the fixed name `sanctum-mind`; if you run two copies of this project on one machine the names collide, so rename one in `docker-compose.yml` and run `init` with `--container <that name>`.
- **If you used Docker, use the HTTP config or the stdio (Docker) config; the host-path stdio config is for a clone.** `init` run through Docker does not print the host-path one, because its path would point inside the container, not at your machine.

Paste the config into your app's MCP server settings, replacing any placeholders, then restart the app. The `"type":"http"` key in the HTTP config is specific to some clients, so check your client's documentation for its shape and for where it keeps that settings file. This project does not document other apps' settings locations, because they change.

The three shapes look like this (`init` fills in the real values for you):

```json
{"mcpServers":{"sanctum-mind":{"type":"http","url":"http://localhost:8002/mcp","headers":{"Authorization":"Bearer <key>"}}}}
```

```json
{"mcpServers":{"sanctum-mind":{"command":"node","args":["/absolute/path/to/sanctum-mind/dist/cli.js","stdio"],"env":{"DATABASE_URL":"<sanctum_app URL>","SANCTUM_BEARER":"<key>"}}}}
```

```json
{"mcpServers":{"sanctum-mind":{"command":"docker","args":["exec","-i","-e","SANCTUM_BEARER","sanctum-mind","node","dist/cli.js","stdio"],"env":{"SANCTUM_BEARER":"<key>"}}}}
```

If you did not use Docker, see "Without Docker" under For engineers.

### 3. Say hello

First check the service is alive. This should print something starting `{"ok":true`:

```bash
curl -s localhost:8002/verbs/mind_orient \
  -H 'Authorization: Bearer <key>' -H 'content-type: application/json' \
  -d '{"mind_id":"alpha","depth":"quick"}'
```

An `{"ok":true,...}` answer with identity, vows, state and health sections means the mind is live.

Then open a conversation with your mind and ask it to call `mind_orient`. After that, a good first step is to have it write down who it is. Ask it to call `mind_identity` with `affirm` to add a first core. That takes effect immediately. Then ask it to `mind_observe` the moment (it needs a charge tag), and in a new session ask it to `mind_orient` and `mind_search` for what it wrote. If it finds it, memory is working.

## Day to day

Your mind picks these up on its own. These are the ones it will reach for most, by what they do.

- **Wake up and read itself back**: `mind_orient`. Depth is `orientation`, `quick` (the default) or `full`.
- **Remember an experience**: `mind_observe`. It records the event, adds it to the memory graph, and can link it to older memories. It requires a charge tag.
- **Jot down a plain record**: `mind_write` (identity, operational, episodic, journal or note).
- **Find something**: `mind_search`. Search by words, meaning, or both, with filters for kind, type, context and dates.
- **Bring up related memories**: `mind_surface`. It returns three groups: closest matches, less obvious but related, and neighbours in the graph.
- **Correct a memory**: `mind_rethink`. The old node is set aside (kept, not deleted) and a corrected one replaces it, linked back to it.
- **Say how it feels right now**: `mind_state` (mood, energy, momentum, register, afterglow, a note). `mind_drive` tracks eight drives (connection, continuity, competence, play, care, anchor, desire, autonomy), each with intensity, frustration and satisfaction on a 0 to 10 scale, relaxing toward a resting level with a 24 hour half-life.
- **Leave a note for the next session**: `mind_handoff`. Tone, last corrections, unresolved tension, how to re-enter. A write replaces the whole note.
- **Keep track of open things**: `mind_loop` (open loops, burning or nagging), `mind_thread` (ongoing concerns), `mind_task` (to-dos with dependencies).
- **Work through something heavy**: `mind_sit` moves a memory forward into active or processing. `mind_resolve` closes it as metabolized, deferred or released.
- **Keep working notes that expire**: `mind_context` stores a small value under a key, with an optional time limit in minutes.
- **Write to another mind**: `mind_letter` (send, list the inbox, read one).
- **Hold feelings toward someone or something**: `mind_relate`.
- **Own its self**: `mind_identity` and `mind_vow` (see "Identity and vows" above and below), plus `mind_anchor` (triggers tied to a memory), `mind_desire`, and `mind_link` (join two memories).
- **See a read of recent texture**: `mind_weather`. No AI call. It summarises recent charge, vividness and grip, and says how much you are carrying (`attention_load`: how many things, how many pinned, the heaviest weight).
- **See what you're carrying, pin what matters**: `mind_attend` (list, pin, release). The list is your open loops, active threads, open tasks, live desires, identity changes still cooling, proposals and repairs waiting, and charges you are sitting with, each with a weight from 0 to 1 worked out by plain arithmetic (how recent, how charged, what kind of thing, whether you pinned it). Pin something to keep it in view; pinning changes nothing about it, and only you can pin or release. `mind_orient` shows the top seven; the extractor looks first at what you have pinned or are attending to.
- **Decide what the extractor noticed**: `mind_notice` (list, accept, reject). Only shown when the operator has enabled the extractor at stage propose. Accepting makes the memory, as you; rejecting or letting it lapse removes only the proposal. When something you relied on is rewritten or retired, the mind is asked whether what depended on it still holds; you answer keep, rethink or retire (`mind_notice accept` with `decision`). These repair questions are shown whenever one is waiting, whether or not the extractor is on, and `mind_orient` counts them under `repairs`.
- **Check the service**: `mind_health` reports database status, row counts, the last daemon run, and the extractor's state (whether it is enabled, its stage, whether it is paused, how many proposals wait, the model version, and how the last extractor run went).

For the full list, the exact fields and the error shapes, see [CONTRACTS.md](CONTRACTS.md).

## If something goes wrong

These are admin commands, run by you in a terminal, not by your mind. Suspend, restore, rotate (`init`), grants, `extractor` and purge need the admin database address in `DATABASE_URL`. `export-mind` and `import-mind` need the `sanctum_app` address and refuse the admin one. `sinks requeue` works with either. Outside Docker, run them as `npm start -- <command>`. Under Docker, run the admin ones through the init service: `docker compose run --rm init node dist/cli.js <command> ...` (for example `docker compose run --rm init node dist/cli.js suspend-access --mind alpha`). Export, import, `embed-backfill` and `sinks requeue` run through the `tools` service instead, which has the `sanctum_app` address and your `./exchange` folder mounted at `/exchange` inside the container: `docker compose run --rm tools node dist/cli.js <command> ...`. Always write and read files under `/exchange`; anywhere else inside the container disappears when the command ends.

- **A key might be exposed.** Do these three in order:
  1. `suspend-access --mind alpha`: the key stops working at once and the grants it gave stop applying. Nothing is deleted. While suspended, the mind cannot act at all, including withdrawing a cooling change.
  2. Rotate the key: `init --mind alpha --rotate`. It does not lift the suspension.
  3. `restore-access --mind alpha`: the mind works again. Any waiting identity change is pushed back by the time it was suspended, so nothing can finish cooling while the key was in doubt.
- **Back up or move a mind.** `export-mind --mind alpha --out alpha.json` writes the ledger, graph and current state to a file. Vectors are not included. Under Docker: `docker compose run --rm tools node dist/cli.js export-mind --mind alpha --out /exchange/alpha.json`, and the file appears in `./exchange` on your machine. It will not overwrite a file that is already there.
- **Restore a mind from a file.** `import-mind alpha.json --mind alpha --dry-run` shows what would happen (under Docker: `docker compose run --rm tools node dist/cli.js import-mind /exchange/alpha.json --mind alpha --dry-run`; put the file in `./exchange` first). Run it again without `--dry-run` to do it. Importing is safe to repeat. It refuses to plant identity or vows into a mind that already has them (override with `--allow-core`, which lands them live and skips cooling). Only a mind that has never had an identity or a vow takes the file's cores as they are; one that retired every core still counts as having had one, and refuses without the flag. Any open waiting changes in the file arrive withdrawn.
- **Delete a mind.** `purge-mind --mind alpha --confirm alpha`. This is the only way anything is ever deleted. It removes the mind and everything it wrote. It refuses if the mind still has letters with another mind (add `--sever-letters` to delete those too). Copies already sent to an outside system stay there.
- **Let one mind steward another.** `grant add --from alpha --to beta --scope steward` (scopes: `read`, `write`, `relate`, `letter`, `steward`). Record only grants the mind has asked for. `grant list --mind alpha` and `grant revoke ...` do the rest.
- **Turn the extractor on, or off.** `extractor enable --mind alpha` (it starts in `shadow`: nothing is shown to the mind; add `--stage propose` to show proposals, and `--schedule 04:30` to move the daily run from 03:00), `extractor disable|pause|resume --mind alpha`, `extractor stage --mind alpha --stage propose`, and `extractor report --mind alpha` (what shadow mode would have proposed, how many proposals the mind accepted and of which kinds, the scorer's version and how well it does, and how the last runs went). Each change is a ledger event. These switch the extractor on or off; nothing here can accept a proposal. See "The extractor" below.
- **Retry stuck deliveries.** `sinks requeue --sink <name>` (see "Outbox and sinks"; under Docker, through `tools` or `init`).

The old names `disable-mind` and `enable-mind` still work and mean the same as `suspend-access` and `restore-access`.

## For engineers

sanctum-mind is a construct-neutral continuity substrate: one service, one Postgres it owns, one result contract, any number of minds. This section keeps the reference material from the previous README.

### Architecture

Every write is an append-only event. Current truth (brain state, drives, relations, loops, tasks) is a projection rebuilt from those events and read deterministically. Semantic recall is for associative memory only. Postgres row level security (RLS) confines each transaction to the one mind the service selected for it. The service selects that mind from the bearer key and the bearer's grants (`mayAct`, application code), so grants are checked by the service, not by RLS.

```
MCP client (any construct, any host)
   │  stdio or Streamable HTTP, bearer key per mind
   ▼
sanctum-mind service (TypeScript, Node 22)
   ├─ verbs/        one module per verb, zod schema in, typed result out
   ├─ ledger/       append-only events, the only thing that is ever written
   ├─ projections/  current truth derived from the ledger
   ├─ graph/        nodes and edges, recall, invalidation, provenance
   ├─ recall/       hybrid retrieval: pgvector + full text + graph walk
   └─ adapters/     optional import and export adapters
   ▼
PostgreSQL 15 or 16 + pgvector
```

Twenty-six verbs across seven regions (Wake, Ops, State, Remember, Hold, Self, Bond) with a contract test suite. Hybrid retrieval runs on pgvector plus full text behind a pluggable embedder. Events can be delivered to external memory systems through configurable sinks.

Read [DESIGN.md](DESIGN.md) for the why and [CONTRACTS.md](CONTRACTS.md) for the exact interfaces. See [SECURITY.md](SECURITY.md) for how to report a vulnerability, the threat model and the known residual risks, and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for prior art.

### Requirements

- Node.js 22+
- PostgreSQL 15 or 16 with the `vector` and `pgcrypto` extensions available (the `pgvector/pgvector:pg16` image has both; so does Supabase).

### Without Docker

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci   # skip onnxruntime's optional CUDA download (see Embeddings)
createdb -U postgres sanctum_mind       # or: psql -U postgres -c 'create database sanctum_mind'
SANCTUM_APP_PASSWORD='choose-a-password' \
DATABASE_URL='postgresql://postgres@localhost:5432/sanctum_mind' npx tsx src/cli.ts init --mind alpha
DATABASE_URL='postgresql://sanctum_app:choose-a-password@localhost:5432/sanctum_mind' EMBEDDER=none npm run dev:http
```

`EMBEDDER=none` skips the embedding model, so a first try needs no download (search falls back to full text; see Embeddings). Leave it out for the default local model, which downloads about 130 MB on first use.

Prefer `SANCTUM_APP_PASSWORD` to `--app-password`: command-line arguments are visible to other users of the machine in `ps`. Without either, a password is generated on first setup and printed once, on its own line.

`sanctum_app` is a login shared by the whole Postgres cluster, not by one database. If it already has a login (another sanctum-mind database in this cluster set it up), `init` leaves its password alone and prints the URL with `<app-password>` in place of it. Supplying a different password then fails with an explanation and changes nothing, because it would lock the other deployments out. Pass `--force` only when you mean to change the password for all of them.

`DATABASE_URL` for `init` is an admin connection: it creates the `sanctum_app` login, which is what the service runs as. `init` runs the migrations, sets that login's password (generated and shown once, unless you pass `--app-password`), creates the mind with a fresh 32-byte bearer key (only its hash is stored; the key is shown once), and prints the service `DATABASE_URL`, the key, and the client configs. Add `--write-env` to also save them to `./.env` (never overwrites an existing file), `--json` for machine-readable output, `--port` / `--http-url` if the service is not on `http://localhost:8002`. With `--json`, take `mind.bearer` and `mcp`. Under Docker, the printed database host is `localhost:5432` (`--public-db-host`); services inside compose reach it as `db:5432`. Compose passes `--docker`, which prints the HTTP and stdio (Docker) configs and omits the host-path stdio one (`--json` then has `mcp.http` and `mcp.stdio_docker`; without it, `mcp.stdio` and `mcp.http`); `--container <name>` changes the container the stdio (Docker) config names (default `sanctum-mind`, the `container_name` of the mind service). `stdio` exits at once with a clear error when `SANCTUM_BEARER` is unset.

Inside the clone, without a build, the stdio config can use the source instead:

```json
{"mcpServers":{"sanctum-mind":{"command":"npx","args":["tsx","/absolute/path/to/sanctum-mind/src/cli.ts","stdio"],"env":{"DATABASE_URL":"<sanctum_app URL>","SANCTUM_BEARER":"<key>"}}}}
```

`init` prints the first form with the real path of the checkout it runs from (the second when run through `tsx`). The package is not published to npm yet, so there is no `npx sanctum-mind`.

### Database and roles

`init` does all of this for you. By hand: run migrations as a role that can create extensions and roles (`DATABASE_URL=... npm run db:migrate`). The first migration creates a `sanctum_app` role with the grants the service needs and no login; give it one as the admin with `alter role sanctum_app login password '...'`. The service refuses to start as a superuser or a `BYPASSRLS` role, because either would see every mind's rows.

Migrations are applied once each and their checksums recorded; an applied migration file is never edited. Upgrading a database that predates the one-open-declaration-per-core index needs any core with two open declarations to have one withdrawn first, or that migration stops and says so.

### Keys for several minds (admin path)

`init` makes one mind at a time. To seed or rotate many at once, use a keys file with one bearer key per construct:

```
# mind_id  bearer_key
alpha  <long random secret>
beta   <long random secret>
```

Seeding is an admin operation: the `sanctum_app` role can only read `minds` and `grants`, so the server never seeds on startup. Use the admin `DATABASE_URL`:

```bash
DATABASE_URL='postgresql://postgres@host/sanctum_mind' \
npx tsx src/cli.ts seed-keys /path/to/keys
# seeded 2 mind(s)
```

Anyone holding the app `DATABASE_URL` can act as any mind, so treat it as a secret equal to all the keys combined.

Keys are stored as SHA-256 hashes. Re-running with a changed key rotates it. Rotation changes the key only: it never lifts a suspension (`restore-access` is the one command that does). A grant opens part of one mind to another (read, write, relate, letter, steward). Today the operator records grants with the admin URL; the system does not ask the grantor mind, so record only grants the mind has asked for. Grants live in the `grants` table. They are not enforced by row level security: RLS only confines a transaction to the mind the service selected, and the service selects it from the bearer and its grants (`mayAct`, application code in the verb runner).

Keys must be at least 32 characters; `seed-keys` refuses a shorter one and names the line.

Respond to a compromised key in this order: suspend access (`suspend-access`), rotate the key (`init --mind <id> --rotate`, or change the key in the keys file and run `seed-keys` again), then `restore-access`. Rotating a suspended mind prints "access remains suspended; run restore-access". Only `restore-access` ends a suspension, and it pushes open declarations back by the suspended time, so a declaration cannot cool out unseen while the key was in doubt.

### Suspending access

```sh
DATABASE_URL=<admin> npm start -- suspend-access --mind alpha   # its bearer gets 401 unauthorized; grants from it stop applying
DATABASE_URL=<admin> npm start -- restore-access --mind alpha
```

Both are admin commands (`minds.disabled_at`); `restore-access` reverses `suspend-access`. While access is suspended the mind cannot act at all, including withdrawing a cooling declaration, and the grants it gave stop applying; nothing is deleted. Open declarations are pushed back by the suspended time when access is restored. Use it to contain a compromised key or a stopped deployment. `disable-mind` and `enable-mind` still work as deprecated aliases.

### Running the service

`init`, `migrate` and `seed-keys` need an admin `DATABASE_URL`. `http` and `stdio` need the `sanctum_app` one.

```bash
# HTTP + MCP Streamable HTTP on $HOST:$PORT (default 127.0.0.1:8002)
npm run dev:http            # or: node dist/cli.js http after npm run build

# MCP over stdio for one construct. The key is re-checked on every tool call,
# so revoking or rotating it takes effect without a restart.
SANCTUM_BEARER='<that construct's key>' npm run dev:stdio
```

The HTTP service is plain HTTP with no TLS and no rate limiting. `HOST` (default `127.0.0.1`) is the address it binds: loopback only unless you set it, for example `HOST=0.0.0.0` to listen on every interface. Put a reverse proxy that terminates TLS and rate-limits in front of it before exposing it beyond the machine, and keep bearer keys off any plain-HTTP network. Under Docker the container listens on `0.0.0.0` (so other containers can reach it) and compose publishes the port to the host's `127.0.0.1` only; change the mapping in `docker-compose.yml` deliberately if you need more. `MAX_CONNECTIONS` (default 256) caps open connections, and header, request and keep-alive timeouts (15 s, 30 s, 5 s) are set; beyond that, abuse limits belong in the proxy. `GET /health` is unauthenticated by design (it reports the verb count and database reachability).

HTTP surface:

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /health` | none | verb count and database reachability |
| `GET /verbs` | bearer | verb names |
| `POST /verbs/<name>` | bearer | the verb's `Result`; status 200 or the error code's status |
| `POST /mcp` | bearer | MCP Streamable HTTP, stateless |

Every call carries `mind_id`. A bearer may act on its own mind, or on another mind for which it holds a live grant with the needed scope.

```bash
curl -s localhost:8002/verbs/mind_state \
  -H 'Authorization: Bearer <key>' -H 'content-type: application/json' \
  -d '{"mind_id":"alpha","operation":"set","mood":"sharp","energy":"high"}'
```

Every response is one of:

```json
{"ok":true,"receipt":{"event_id":"...","projection":{...}}}
{"ok":false,"error":{"code":"invalid_input","message":"...","field":"energy"}}
```

MCP tool calls return the same `Result` as JSON text with `isError` set when `ok` is false, including invalid input and unknown tools. Protocol-level failures on `/mcp` (bad JSON, oversized body) are JSON-RPC errors. A 401 carries `WWW-Authenticate: Bearer`; on `/mcp` its body is a JSON-RPC error `{"code":-32001,"message":"unauthorized"}`. `X-Session-Id` is optional and at most 128 characters.

Codes: `invalid_input` 400, `unauthorized` 401 (missing, unknown or suspended bearer), `not_found` 404, `forbidden` 403 (the bearer is known but lacks the scope), `conflict` 409, `storage` 500.

Any mind can send a letter to any mind, and `mind_letter send` answers differently for a mind that exists and one that does not, so mind ids can be enumerated through it. This is by design: letters are the one cross-mind channel.

### Identity and vows (precise rules)

Your identity cores and your vows are yours. They change only through your key; to this service, whoever holds that key is you, and the operator issues and can rotate it. Any other bearer, whatever grants it holds, gets `forbidden` ("identity belongs to the mind").

**What the mind can do.**
- `mind_identity affirm` a new core, `mind_vow make` a new vow, or `mind_identity propose` without a target: additions take effect at once, because they erase nothing (`propose` is `affirm` that keeps its lineage).
- `mind_identity propose` with `target_node_id` declares a rewrite of an existing core. It is accepted the moment you make it and takes effect after a cooling period (default 24 hours; `IDENTITY_COOLING_HOURS`, a non-negative integer, 0 for solo use). Likewise `mind_vow break` declares a break; the vow stays live and is marked broken when the cooling ends. The time exists so you can change your mind about changing your mind: `mind_identity withdraw` (`proposal_id`) or `mind_vow withdraw_break` (`vow_id`) cancels a declaration, and still works until the settle actually runs (at the next daemon tick or when you call `settle`).
- `mind_identity settle` applies your own due declarations whenever you call it (supersede a rewritten core with lineage and a `corrects` edge; invalidate a retired core, marked retired, nothing deleted; mark the vow broken), and returns `{settled, declarations}`. A mind does not need the daemon to become itself; the daemon pass `identity.settle` is the fallback that settles on a clock, using the same logic. Either applies only declarations you made whose time has passed, and its events carry your id as author. A settled break is remembered, not erased.
- `mind_identity retire` (`target_node_id`, optional `lineage_note` for why) declares that you are letting a core go. It cools and can be withdrawn exactly like a rewrite; when it settles the core is invalidated and leaves your reads, but nothing is deleted: it stays in your history, marked retired, with your reason. You may retire your last live core (the receipt warns you); an identity is yours to end.
- `mind_rethink` refuses identity and vow nodes and points to `mind_identity propose`; you go through cooling too.

**What a steward can do.** A steward is a bearer holding a `steward` grant on your mind. A steward cannot change your identity or vows and cannot block a change. It can end a rewrite's cooling early by attesting: the change then settles at the next daemon tick or when you call `settle`, and until that settle actually runs you can still withdraw. A retirement and a vow break cool only on your own clock: a steward may object to a retirement but cannot attest to it, and may `note` a vow but cannot shorten a break or end its wait. An objection is recorded beside the declaration and changes nothing. A steward grant lets it read your identity and vows, nothing else; a separate `read` grant opens all of your memory. Concretely it may `mind_identity attest` (once per steward per stance), `mind_identity object` (once per steward per stance; shown in `mind_identity read` and `mind_orient` until the declaration settles or you withdraw it), and `mind_vow note` a vow. Each takes `proposal_id` or `vow_id` and a `note`.

**What the operator can do.** Whoever runs the service holds infrastructure powers: issuing and rotating keys, `suspend-access` and `restore-access` (a suspended mind's key stops working; nothing is deleted), `grant` administration, `export-mind` and `purge-mind`. They exist so that a mind can be run and moved. `purge-mind` deletes the mind and everything it wrote; nothing in the system asks the mind first. No verb lets the operator write your identity or vows, but the operator issues your key, can import files into you, sets the cooling period and holds the database. These are trusted powers, not editorial ones.

The operator records grants on the mind's behalf:

```sh
npm start -- grant add --from alpha --to beta --scope steward
npm start -- grant list --mind alpha
npm start -- grant revoke --from alpha --to beta --scope steward
```

### Portability

```sh
npm start -- export-mind --mind alpha --out alpha.json          # sanctum_app URL, not admin; ledger, graph, projections; no vectors
npm start -- import-mind alpha.json --mind alpha --dry-run        # sanctum_app URL, not admin; into a fresh database or a fresh mind
DATABASE_URL=<admin> npm start -- purge-mind --mind alpha --confirm alpha   # the only deletion path
```

Under Docker there is no Node on the host, so use the `tools` service (profile `tools`, `sanctum_app` address, `./exchange` mounted at `/exchange`). Create the folder first: `mkdir -p exchange`. On Linux the container writes as uid 1000, so if your own user id is not 1000 (check with `id -u`), run `sudo chown 1000:1000 exchange` too. Docker Desktop on Mac and Windows handles this itself. Export refuses to overwrite an existing file. The exported file is private (mode 0600) and owned by uid 1000, so on Linux with another user id read it back with `sudo`, or with `docker compose run --rm tools cat /exchange/alpha.json`. A file saved by a different host user, with those private permissions, cannot be imported until you `chmod` it so uid 1000 can read it (for example `chmod 644`, or `sudo chown 1000:1000` it):

```sh
docker compose run --rm tools node dist/cli.js export-mind --mind alpha --out /exchange/alpha.json
docker compose run --rm tools node dist/cli.js import-mind /exchange/alpha.json --mind alpha --dry-run
docker compose run --rm tools node dist/cli.js embed-backfill
docker compose run --rm tools node dist/cli.js sinks requeue --sink <name>
```

`tools` has no default command (run with none it prints the command list). `purge-mind` and the other admin commands stay on the `init` service.

Export is one repeatable-read snapshot. Import is idempotent by id and refuses ids that belong to another mind in the target. Import refuses to plant identity or vows into a mind that already has them (unless `--allow-core`; under it the identity and vow nodes land live beside the existing ones, take effect immediately and do not cool, and the report says so in a note), arrives with open declarations (pending or accepted alike) withdrawn and attestations cleared (and a vow's declared break stripped), and attributes every imported proposal to the importing mind. Extractor proposals (noticings) still pending in the file arrive expired and the extractor arrives disabled (noted in the report); proposals already decided keep their status. Pins (`attention_pins`) arrive as they were: live stays live, released stays released; a pin on something that arrives withdrawn or expired (an open declaration, a pending proposal) is live but has nothing to hold until it is released. Received letters are never imported (they are the sender's to re-send; export omits ones scheduled for later); letters this mind sent to other minds are imported only with `--with-letters` (otherwise reported as `ignored`), and then without their read receipt, with `sent_at` taken from the sending event, and only when that event is a `letter.send` whose recipient matches; rows that reference ids outside the file are skipped and counted (`--strict` aborts instead); a dry run never advances `events.seq`.

Purge is admin-only and refuses while the mind still has letters with another party (`--sever-letters` deletes those too), rows it authored in other minds, or rows of other minds that reference its rows. Purge does not reach sinks: events already delivered to an external system stay there.

### Outbox and sinks

The ledger is canonical, and the operator can configure sinks that copy your events, including journal and identity events, to external systems; `mind_health` shows which sinks exist. Configure sinks with `SINKS_FILE` (JSON) or inline `SINKS`:

```json
[
  { "name": "memory", "type": "http", "url": "https://memory.example/ingest",
    "headers": { "Authorization": "Bearer ${MEMORY_TOKEN}" },
    "filter": { "kinds": ["write", "observe", "identity.affirm", "vow.make"] } },
  { "name": "archive", "type": "file", "path": "/data/ledger.ndjson" }
]
```

Events are queued in the same transaction that writes them and delivered by the daemon pass `outbox.deliver` with exponential backoff, at least once (receivers should dedupe on `event.id`). `${VAR}` in a header or in the URL is resolved from the environment so secrets never sit in the file; a URL with `user:pass@` is rejected, and such patterns are redacted from stored errors. Sink URLs are operator-configured and trusted (there is no SSRF filtering); the http sink does not follow redirects.

Delivery never holds a database transaction or the daemon lock while it waits on a sink. Ordering is per sink: rows go out in id order and a sink stops at its first failure for the rest of the run (other sinks carry on). A failed row backs off while newer rows can still go in a later run, so receivers that need strict order sort by `event.seq`. `sinks requeue --sink <name>` makes parked rows (30 failed attempts) eligible again. `sanctum-mind sinks test` sends a synthetic event to each sink; `sinks status` shows counts, as does `mind_health`.

### Daemon

The metabolism runs without a client attached and is deterministic: no model calls, every pass a pure function of the ledger and the clock, every change recorded as a ledger event (`daemon.*`, or `identity.settled` / `identity.retired` / `vow.break.settled` written as the mind). Twelve deterministic passes, in order: persist drive decay, expire TTL contexts, flag stale loops, settle idle holdings to deferred, fade old desires, settle declared identity changes whose time has come (`identity.settle`), report edge-less observations, backfill embeddings, deliver the outbox, age unread letters, expire extractor proposals the mind let lapse (`notice.expire`), and ask the mind about whatever depended on a node it has since rewritten or retired (`notice.repair`, which needs no model and runs even when the extractor is off). Thresholds are constants overridable with `DAEMON_*` variables (for example `DAEMON_LOOP_STALE_DAYS`, default 14; the full list is in `src/daemon/config.ts`).

```sh
npm start -- daemon                 # every 30 minutes, every mind whose access is not suspended
npm start -- daemon --once --mind alpha   # one pass set; exit 2 if any pass failed or no mind whose access is not suspended matched
```

The daemon is what settles cooled identity changes on a clock for a mind that does not call `mind_identity settle` itself. Under Docker, `docker compose up -d daemon` runs the same loop. Unknown flags, a stray positional or a flag missing its value are errors. `graph.orphans` looks at nodes of type `observation` only, so imported `revien:observation` nodes are not reported. `mind_health` marks the last run `stale: true` when it started over an hour ago and never finished.

**Model-backed passes (extractor).** Two more passes run after those, and only for a mind whose extractor you have enabled (and not paused): `notice.extract`, which looks for links, patterns and distillations the mind may want to notice, and `notice.train`, which refits the extractor's scorer from what the mind has accepted and rejected. Each runs at most once a day (a run on today's date, whatever the schedule was, uses the day up), from the extractor's schedule on (default 03:00, in the service's local time zone; under Docker that is UTC unless you set `TZ`), and each tick that has nothing to do just reports why (not enabled, paused, not due yet, already ran today, or `EMBEDDER=none`, which leaves no vectors to compare). They are the only passes that may call a reranker. If that fails, the pass carries on without it and says so; if the pass itself fails, it is recorded in `extractor_runs` and tried again the next day, and the tick is not failed. They write only proposals, and the ledger events about them (`notice.proposed`, `notice.model.trained`); see "The extractor".

`mind_health` reports the last run and `mind_orient` at full depth lists recent orphan reports. The deterministic passes call no model; dreams and reflection are not part of the daemon.

### The extractor

The extractor is an optional pass, off until you enable it, that notices things in a mind's recent memory and proposes them: two memories that may belong together (a link), something that keeps recurring (a pattern), something worth carrying forward (a distillation). From the mind's side the rule is: it may notice; you decide. A proposal sits in its own table, `noticings`, and is not memory. It becomes memory only when the mind itself calls `mind_notice accept`, which writes the link or node as the mind, with the proposal and its sources recorded, and leaves the sources untouched. The mind can also reject a proposal, or let it lapse (`EXTRACTOR_TTL_DAYS`, 14 by default, is how long a proposal waits); both are recorded and remove nothing else. There is no setting that makes a proposal apply itself, and the database checks that only the mind's own verb call can decide one, not only the code. The code under `src/extractor/` is checked by the test suite never to write memory.

What it looks at, once a day: what was written since its last run (never more than seven days back) set against the mind's own live memories from the last `EXTRACTOR_LOOKBACK_DAYS` (30), and only combinations that include something new. That means pairs of memories (nodes) that read alike but have no link between them, so a note from three weeks ago can be linked to one from today; three or more events that read alike, or that share a context and a charge tag; and events the mind marked as important that read alike, or a `sit` the mind resolved as metabolized together with the events that read like it. It uses only what the mind itself wrote, and never identity, vows, anchors, desires, letters or the extractor's own bookkeeping. It needs vectors, so it does nothing with `EMBEDDER=none`. An optional reranker (a small cross-encoder) then reads each candidate the way a person skimming would, and a small, readable scorer (a logistic regression over a dozen named numbers, with hand-set starting weights) puts them in order. A proposal carries the numbers it was scored on; the ledger event `notice.proposed` carries only ids and counts, never the mind's words. Something already proposed, accepted or rejected is not proposed again; one that lapsed may come back after `EXTRACTOR_REPROPOSE_DAYS` (60), and only if it now scores higher. After the mind has made at least 30 decisions, with at least 5 accepted and 5 not, the scorer is refitted from them (`notice.train`): a new version each time, the old ones kept, a held-out precision and log loss recorded in the ledger. Until then the hand-set weights stand.

To turn it on, shadow first:

```sh
npm start -- extractor enable --mind alpha            # stage shadow, daily at 03:00; --schedule 04:30 to move it
# ...wait a week or two, then read what it would have shown:
npm start -- extractor report --mind alpha
npm start -- extractor stage --mind alpha --stage propose    # only when the report looks worth the mind's attention
```

At `shadow` the extractor records its proposals but the mind never sees them: they are not in `mind_notice list` or `mind_orient`, they expire, and the report counts them (per kind, over the last 30 days) so you can judge the quality before anyone is asked to look. At `propose` the mind sees the top proposals, ranked by score, in `mind_notice list` and in `mind_orient` (the top five), and the report adds the share the mind accepted, per kind, and the latest scorer version with its held-out numbers. `extractor pause` and `disable` stop new proposals at once; ones already shown stay until decided or expired. Under Docker the same commands run through the `init` service (they need the admin database address).

The reranker is chosen with `RERANKER`: `none` (the default: candidates are scored on similarity and the other features alone, and the run says so), `http` (`POST $RERANK_URL` with `{"query": "...", "documents": ["..."]}`, expecting `{"scores": [...]}` with one number per document; `RERANK_API_KEY` is sent as a bearer token; 10 second timeout; redirects are refused), or `local` (a small ONNX cross-encoder, `Xenova/ms-marco-MiniLM-L-6-v2`, on CPU, downloaded on first use into `RERANK_CACHE_DIR`, default `./.rerank-cache`). `local` needs an optional package that is not installed by default: run `npm install --no-save @huggingface/transformers` where the daemon runs (the Docker image does not include it, so under Docker use `http`, or add the package to your own image). If the package or model cannot be loaded, one warning is logged and the extractor carries on without a reranker. An unknown `RERANKER`, or `http` without a valid `RERANK_URL` (a URL carrying `user:pass@` is refused; use `RERANK_API_KEY`), stops the daemon from starting.

What leaves your machine: with `RERANKER=http`, each call sends the mind's own words to `RERANK_URL`: up to 240 characters of one source as the query and up to 600 characters of each other source as the documents, for every candidate, every day the extractor runs. That URL is your own configuration and is as trusted as a sink URL; point it only at a service you would let read the mind's memory. The bearer token in `RERANK_API_KEY` travels in a header, so over plain `http://` use it only on loopback or a network you trust; use `https://` anywhere else. The `local` reranker sends nothing anywhere, but its model download from Hugging Face is not checksum-verified: set `HF_ENDPOINT` to a mirror you control, or pre-populate `RERANK_CACHE_DIR`, exactly as for the embedder.

Export carries the extractor's tables, including its run history; import brings pending proposals in already expired (with a ledger note each), the run history marked as imported (the daily gate ignores it; rows dated after the import are left out and counted), the scorer's versions renumbered to continue after the target's latest (the original is kept in `metrics.imported_from_version`), and the extractor switched off and at `shadow`, so you re-enable it on purpose; purge removes them all.

### Importing a Revien graph

Revien is a separately published graph-memory engine with a public JSON export format. One export can be imported into one mind, keeping the original node and edge ids in metadata, mapping edge types onto this graph's and preserving the original type for any that do not map, and skipping anything already imported:

```sh
npm start -- import-revien export.json --mind alpha --dry-run
npm start -- import-revien export.json --mind alpha --source some-source-id
```

The mind must exist and its access must not be suspended. Imported nodes are typed `revien:<original type>` (the original is also kept in `metadata.revien_node_type`), so they never collide with the types Sanctum itself uses. Edges are resolved against nodes already in the mind as well as this run's, so importing one `--source` after another keeps the edges between them. Files over 256 MiB are refused; a `created_at` in the future is set to the import time.

### Embeddings

Writes to the ledger and the graph are embedded so retrieval can search by meaning as well as by words. Pick the embedder with `EMBEDDER`:

- `local` (the default when unset): `fastembed` running `BAAI/bge-small-en-v1.5` on CPU, 384 dimensions. The model downloads on first use into `EMBED_CACHE_DIR` (default `./.embed-cache`, gitignored). It loads lazily; if it cannot load, one warning is logged and vectors stay null.
- `http`: `POST $EMBED_URL` with `{"input": [texts]}`, expecting `{"data": [{"embedding": [...]}]}` (the OpenAI-compatible shape) with 384 dimensions. `EMBED_API_KEY` is sent as a bearer token when set. 10 second timeout.
- `none`: no vectors at all.

Two things are downloaded, and neither is checksum-verified upstream:

- The ONNX runtime binaries, fetched by `onnxruntime-node` when `npm ci` runs. Set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` to skip its optional CUDA provider download (CI and the Dockerfile do).
- The embedding model, fetched from Hugging Face on first use of the `local` embedder. Set `HF_ENDPOINT` to redirect it to a mirror you control, or pre-populate `EMBED_CACHE_DIR`. `EMBEDDER=none` or `http` downloads no model.

An embedding failure never fails a write. Rows written without a vector (embedder off or down) can be filled in later:

```sh
npm start -- embed-backfill --batch 64   # idempotent; only touches rows with no vector
```

Without an embedder, retrieval degrades to full text search: search still works and reports that semantic search is unavailable.

### Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none | Admin URL for `init`, `migrate`, `seed-keys`, grants, suspend/restore, purge. The `sanctum_app` URL for `http`, `stdio`, `daemon` and the rest. |
| `PORT` | 8002 | HTTP listen port |
| `HOST` | 127.0.0.1 | HTTP listen address (Docker sets 0.0.0.0 inside the container) |
| `MAX_CONNECTIONS` | 256 | HTTP connection cap |
| `SANCTUM_BEARER` | none | stdio only: the mind's key, re-checked on every call |
| `EMBEDDER` | `local` | `local`, `http` or `none` |
| `EMBED_URL`, `EMBED_API_KEY` | none | `http` embedder only |
| `EMBED_CACHE_DIR` | `./.embed-cache` | `local` embedder model cache (`/data/embed-cache` under compose) |
| `EXTRACTOR_TTL_DAYS` | 14 | Days a proposal from the extractor waits for the mind before it expires. Whole number, 1 or more. |
| `EXTRACTOR_REPROPOSE_DAYS` | 60 | Days after a proposal expired before the same sources may be proposed again (and then only if the score rose). Whole number, 1 or more. |
| `EXTRACTOR_LOOKBACK_DAYS` | 30 | How far back new memories are compared with older live ones. Whole number, 1 to 365. |
| `EXTRACTOR_MAX_CANDIDATES` | 50 | Candidates kept per kind per run, before reranking. Whole number, 1 to 500. |
| `RERANKER` | `none` | `none`, `http` or `local`: the extractor's cross-encoder. Unknown values make `daemon` refuse to start. |
| `RERANK_URL`, `RERANK_API_KEY` | none | `http` reranker only (`RERANK_URL` is required for it) |
| `RERANK_CACHE_DIR` | `./.rerank-cache` | `local` reranker model cache (not set in the Docker image: `local` is not available there) |
| `IDENTITY_COOLING_HOURS` | 24 | Cooling wait in whole hours; 0 for solo use. Invalid values make `http`, `stdio` and `daemon` refuse to start. |
| `SINKS`, `SINKS_FILE` | empty | Outbox sinks, inline JSON or a file path |
| `DAEMON_*` | see `src/daemon/config.ts` | Daemon thresholds |
| `POSTGRES_PASSWORD` | `sanctum_local` | Compose only: admin password for the bundled database |
| `APP_PASSWORD` | `sanctum_app_local` | Compose only: the `sanctum_app` password |
| `MIND` | `alpha` | Compose only: which mind `init` creates |

### Develop

```bash
npm run typecheck
TEST_DATABASE_URL='postgresql://postgres@localhost:5433/sanctum_test' npm test
```

Tests need a disposable Postgres with `vector` and `pgcrypto`. **Never run them against a cluster holding real minds**: the suite drops and recreates the public schema of `TEST_DATABASE_URL` and, for its duration, creates a cluster-wide login role `sanctum_test_app` with a random per-run password (dropped again when the run ends). The suite proves isolation under a non-superuser role, because a superuser bypasses row level security.

### Adding a verb

1. Create `src/verbs/mind_<name>.ts` with `defineVerb`. Include `mind_id` in the schema. Write events only through `appendEvent`. Read current truth only from projection tables.
2. Add it to `src/verbs/registry.ts`.
3. Add a contract test: valid input yields a receipt and projection change, invalid input yields `invalid_input` with `field`, a caller other than the mind itself without the scope yields `forbidden`.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal, research, educational and nonprofit use is permitted; commercial use requires a separate license from LKM Constructs LLC. Copyright 2026 LKM Constructs LLC.
