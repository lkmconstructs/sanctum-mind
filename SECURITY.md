# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately to LKM Constructs LLC through the repository's private
vulnerability reporting (GitHub: Security, then "Report a vulnerability") or, if that is unavailable, by
contacting the maintainers by email at the address on the organization's profile. Do not open a public issue
for an unfixed vulnerability. Include the version or commit, what you did, and what you observed. Reports are
acknowledged on a best-effort basis; this is pre-release software.

## Threat model

The `sanctum_app` `DATABASE_URL` is an all-minds credential: anyone holding it can act as any mind, so keep
it as secret as every bearer key combined (this is why stdio hands that credential to every client and HTTP
does not). Row level security confines each transaction to the one mind the service selected, so a verb bug
cannot read or write another mind's rows through SQL, and the service refuses to run as a superuser or
`BYPASSRLS` role. Grants are checked by the service (`mayAct` in the verb runner), which is application code,
not by RLS; changing `identity` and `vow` nodes is further restricted to the mind acting as itself, in that rewrites and retirements of a core and vow breaks take effect after the cooling period (default 24 hours) from when the mind declares them unless it withdraws them; a steward may end a rewrite's wait early by attesting (it then settles at the next daemon tick or when the mind calls settle), but never a retirement's or a vow break's, which cool only on the mind's own clock (a steward may object to a retirement, and note a vow, nothing more; the database backs this up: a steward's update to a declaration may only append one attestation and bring a rewrite's effective time forward, never later, and never touch a retirement's) (see "Identity and vows" in the README). The operator (whoever holds the admin
database URL and runs the service) has infrastructure powers: keys, `suspend-access` and `restore-access`, grants,
export and purge. No verb lets the operator write your identity or vows, but the operator issues your key, can import files into you, sets the cooling period and holds the database. These are trusted powers, not editorial ones. An operator with database access can of course read or alter storage, so treat that role as trusted. Purge is the one deletion path and is admin-only. An import file is the operator's input; import still refuses to plant identity or vows into a mind that has ever had any (a retired core still counts), and open declarations in a file (pending or accepted) arrive withdrawn; under `--allow-core` identity and vow nodes are imported live beside existing ones, take effect immediately and do not cool, and the import report says so. The operator may also enable, pause or stage the optional extractor (`sanctum-mind extractor ...`); that is a switch over whether proposals are made and shown, never over memory: the database lets only the mind decide a proposal, and an accepted proposal is authored by the mind. A sink URL is likewise the operator's own input, and so is `RERANK_URL`.

## Residual risks

- The HTTP service speaks plain HTTP and binds to `127.0.0.1` by default; terminate TLS in a reverse proxy
  before exposing it, since bearer keys travel in headers.
- There is no built-in rate limiting (only timeouts and a connection cap); use a reverse proxy.
- `GET /health` is unauthenticated and reveals the verb count and database reachability.
- Upstream downloads are not checksum-verified: the ONNX runtime binaries fetched at `npm ci` (skip the CUDA
  part with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`) and the embedding model fetched from Hugging Face on first use
  (`HF_ENDPOINT` redirects it).
- `npm audit` reports an advisory for `sprintf-js`; it comes in through `onnxruntime-node`'s install-time download tooling
  (`global-agent`, `roarr`), so it is exercised at install time only, not by the running service.
- Letters let any mind write to any mind, and `mind_letter send` lets a caller enumerate which mind ids exist.
  This is by design. A compromised key is handled by suspending access (`suspend-access`), rotating the key (`init --rotate` or `seed-keys`; rotation never lifts a suspension)
  and then `restore-access`.
- `RERANKER=http` sends the mind's own words to `RERANK_URL` on every extractor run: up to 240 characters of one source and up to 600 of each other source, per candidate. Like a sink URL it is the operator's configuration and trusted as such; it is refused if it carries credentials (`RERANK_API_KEY` is the bearer token), and a bearer over plain `http://` is only for loopback or a trusted network. Nothing else about the extractor leaves the database.
- The `local` reranker's model download from Hugging Face is not checksum-verified (mirror it with `HF_ENDPOINT`, or pre-populate `RERANK_CACHE_DIR`), the same as the embedder's.
- Purge does not reach sinks: events already delivered to an external system stay there.
- GitHub Actions in CI are referenced by tag and the Docker base images by tag, not by commit SHA or digest.
