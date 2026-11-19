# Changelog

## [0.1.7] — 2026-11-13

Fleet C2 egress registry (Armada Cerdas), optional:

- **Fleet registry (SQLite).** `fleet.db` at `<state>/fleet.db`
  (`FLEET_DB_PATH` override, WAL, mode `0600`) stores `nodes`,
  `node_health`, `quota_signals`, `node_events` plus 5 indexes.
  `registerNode()` is idempotent; `initDB()` creates the schema on
  first use.
- **Register and probe.** `POST /api/fleet/init` and
  `POST /api/fleet/register` add nodes (`label`, `node_type`,
  `connect_kind`, `egress_spec`, `tags`). `POST /api/fleet/probe`
  probes one node or all reachable ones: `probe.js` reuses
  `proxy.testProxy` for `direct-proxy` / `ssh-reverse-tunnel` /
  `wireguard` / `tunnel-cf`, HTTP-GETs `relay-http` nodes, and skips
  `pending` / `unknown` / `warp`.
- **Health monitor.** `fleet-health-monitor.js` loops every
  `FLEET_PROBE_INTERVAL_MS` (default 300000, `unref`ed), writes
  `node_health`, classifies quota signals (`429`, `403`, `quota`,
  `free-tier`, `capacity`, `ip-abuse`), and sets per-node cooldowns
  (`FLEET_COOLDOWN_BASE_MS`, default 120000). Real request failures
  feed the same `quota_signals` table through the egress-failure hook.
- **Pool orchestration.** `POST /api/fleet/apply-pool` — `fleet-orchestrator.js`
  filters registrable nodes (reachable, not cooling, kind not
  `pending`/`unknown`/`relay-http`/`warp`), merges ready WARP farm lanes
  (`warp-f<n>`), and publishes via `proxy.setPool()` only — `proxy.js`
  is untouched. `UPSTREAM_PROXY_POOL` / `UPSTREAM_PROXY_URL` locking the
  pool makes apply fail with `pool_env_locked` (HTTP 409).
  `FLEET_POOL_STRATEGY` (round-robin | failover | random) selects the
  strategy. Auto-actions can notify on cooldown-edge / empty pool and
  activate a standby node (`FLEET_AUTO_ACTIONS=1`, `FLEET_AUTO_SCALE=1`).
- **Observability.** `GET /api/fleet/status` (nodes, health, quota counts,
  pool config, last applied, OK/DEGRADED/CRITICAL summary) and
  `GET /api/fleet/events` (filter `nodeId` / `action` / `since`).

### Fixed

- **Probe results now drive the pool.** `probe.js` writes the verdict back to
  the registry: success sets `nodes.reachable = true` and stamps
  `last_heartbeat_at`, failure sets `reachable = false`. Previously the verdict
  only reached `node_health`, so `apply-pool` kept publishing nodes whose
  tunnel was dead. Both probe paths (`/api/fleet/probe` and the health monitor)
  now select nodes by `connect_kind` rather than by `reachable`, so a failed
  node is re-probed and can recover, and auto-scale no longer treats a
  probed-dead node as standby.
- **Relay probe keeps the gate's own words.** `probe.js` used to throw away the
  `relay-http` response body, so a `403` reading "Free models are only
  available in OpenCode CLI" was classified from the status code alone and
  landed in `quota_signals.sig_type` as `403` instead of `free-tier`. The
  probe now forwards up to 512 bytes of the body, so the classifier sees the
  gate text and records the specific signal. Known limit: on the
  `direct-proxy` / `ssh-reverse-tunnel` / `wireguard` paths `proxy.testProxy`
  still reports a generic "upstream rejected (403)" without the body, so those
  nodes get cooldown but a coarse `403` signal — fixing that requires changing
  `proxy.js`, which the fleet layer deliberately does not touch.

- **Node compat suite matches the supported runtimes.** `server.js` refuses
  to boot under plain `node` (the free-tier gateway rejects its TLS
  fingerprint), which made every e2e test that spawned it fail under
  `npm run test:node` with hung waits (`cancelledByParent`) or `503` from
  routes that need `bun:sqlite`. Tests now spawn through
  `test/spawn-helper.js` with `ALLOW_NODE=1` so the HTTP contract is
  verified on both runtimes, and the fleet e2e suite skips under Node —
  same policy as `fleet.test.js` / `fleet-panel-routes.test.js`.
  `gate-drill.js` gained a `module.exports` so its 429-inconclusive
  semantics are unit-tested (`test/gate-drill.test.js`) instead of only
  exercised live.

## [0.1.6] — 2026-11-11

Operations hardening and panel follow-through:

- **Per-key burst and concurrency limits.** API keys accept `burst` (per 10 s)
  and `concurrency` (in-flight) alongside `rpm`/`daily`. Rejections are `429`
  with `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining`;
  `/api/keys/usage` reports live concurrency and remaining burst.
- **Admin audit log.** Every mutating panel action appends to
  `<state>/audit.jsonl` (mode `0600`, 2 MiB rotation) with sensitive keys
  redacted. `GET/POST /api/audit` reads or clears it.
- **Retention and scheduled backups.** `GET/POST /api/retention` plus
  `/api/retention/run` prune `usage.jsonl`, audit, and snapshots per day/byte
  caps (disabled by default). `GET/POST /api/backups` create, list, schedule,
  and restore whitelisted state files only.
- **Auto-heal round.** `autoheal.js` rotates at most one dead lane per round
  (per-port backoff), restarts the farm only when no lane is ready, and scales
  up on sustained congestion when enabled. `GET/POST /api/autoheal` and
  `/api/autoheal/run` expose it. The scheduler reads `settings.enabled`, so an
  enable saved from the panel starts rounds immediately instead of reporting
  `skipped: "disabled"`. Lane rotation reapplies the pool, and the pool cache
  compares live entries as well as the URL signature, so a shrunk pool is
  restored instead of staying short.
- **Multi-target notifications.** `notify.js` routes to up to 10 targets with
  `minLevel`, quiet hours (critical bypasses), per-minute cap, and 429/5xx
  retry. `GET/POST /api/notify` and `POST /api/notify/test`.
- **Error classification.** Egress failures are bucketed as `abuse`, `shape`,
  `quota`, `auth`, `server`, or `other` and surfaced in `/api/observability`.
- **Model groups.** `modelGroupWeights` (alias → model → 1..100) reorders
  candidates with a stable sort; `GET /api/models/simulate` previews the pick
  and cooldown reasons. Farm resize is `POST /api/farm/resize`.
- **Panel.** Ops view gains audit, retention, backup, auto-heal, notification,
  and error-classification cards, all translated to ID/EN; config gains weights
  and simulation; farm gains resize; keyboard focus, skip link, and mobile
  tables verified.
- **Packaging and self-update.** `install.sh`, the npm `files` list, and
  `UPDATE_FILES` now include every admin module (`audit`, `autoheal`, `backup`,
  `dashboard-api`, `diagnostics`, `notify`, `observability`, `ops`,
  `retention`, `selftest`) so fresh installs and updates cannot miss a module.
  Remote installs download the `warp-farm` Go sources; self-update rewrites
  them and rebuilds the sidecar when Go is available, keeping an old binary on
  build failure.

## [0.1.5b] — 2026-11-11

Stall detection and quota hygiene, matching opencode2api where it matters:

- **First-event timeout.** `FIRST_EVENT_TIMEOUT_MS` (default `15000`, `0`
  disables) applies to the first SSE byte. An upstream that answers `200` and
  then goes silent is canceled, its exit is cooled, the next model-group
  candidate is tried, and only when every candidate stalls does the client get
  a fast `504 first_event_timeout` instead of hanging until the 120 s deadline.
- **Anonymous-lane circuit breaker.** `ANON_BACKOFF_THRESHOLD` (default `0`,
  off), `ANON_BACKOFF_BASE_HOURS` (1), `ANON_BACKOFF_MAX_HOURS` (24). After N
  final `429`/IP-abuse rejections the anonymous lane pauses with exponential
  backoff, persisted in `<state>/anon-backoff.json`; paused requests get an
  immediate `429 anonymous_lane_paused` with `Retry-After`. A success resets it.
- **Per-egress-block cooldown.** When a WARP lane is parked for quota, its
  IPv6 `/64` (IPv4 `/32`) stays out of the pool for 30 minutes, so a lane that
  re-registers onto the same prefix cannot quietly reuse an exhausted block.
  If every ready lane's block is cooling the pool keeps the ready lanes rather
  than emptying: an empty pool means host-IP traffic, which is what triggers
  IP-level abuse, so WARP is always preferred.
- **Pool only takes ready WARP lanes.** Lanes still registering are no longer
  published as SOCKS entries, which previously produced `502 Proxy refused to
  open a tunnel` and burned retries. The watchdog re-applies the pool as each
  lane reports ready.
- **Warm start.** The sidecar registers two lanes concurrently, so the pool has
  a usable exit within seconds while the rest register in the background.
- **Panel docs and cooling status.** The panel now has copy-ready cURL snippets
  for Chat Completions, Responses, and Anthropic Messages, plus OpenAI SDK
  snippets for Python and JavaScript, and the proxy card lists cooling `/64`
  blocks that are temporarily out of rotation.
- **Rotating proxy pool entries.** `pool+http://…` or `http://…#pool` marks an
  endpoint that assigns a new IP per connection. Such entries never cool down
  and are never excluded by retry logic.
- **Reasoning effort defaults.** `config.json` / env `REASONING_EFFORT` and
  `REASONING_EFFORT_BY_MODEL` (JSON model → level) fill `reasoning_effort`
  when the client omits it; an explicit client value always wins.
- **Observability dashboard.** Request traces with a per-exit scoreboard
  (success/429/IP-abuse/5xx/timeout/swaps, p50/p95 first event), in-flight
  list, waterfall detail, combined health score, and an incident banner backed
  by `<state>/incidents.json`; `/metrics` now appends the same counters.
- **Model health.** `GET /api/models` merges catalog verdicts, group candidates
  and cooldowns; the panel tests one alias without warming a real request.
- **Ops controls.** Safe mode pins a single lane and disables rotation until
  it expires; scheduled maintenance rotates/restarts only while idle, honors
  quiet hours and per-incident abuse reactions; every action is persisted.
- **Diagnostics and self-test.** A redacted ZIP bundles health, config, pool,
  farm, usage and recent events; the panel can run `verify --quick`,
  the TLS fingerprint check and the gate drill sequentially and stream output.
- **Config snapshots.** Every `config.json` write archives the previous value
  (last 10); `POST /api/config {"restoreSnapshot":"<id>"}` rolls back
  atomically. The panel adds a model-group editor with candidate ordering.
- **Key usage and backups.** Per-key minute/day usage with 24 h top consumers,
  session→egress affinity, WARP lane probe/rotate endpoints, and a backup
  diff preview before restore.
- **Incident webhooks.** `NOTIFY_WEBHOOK_URL` (Discord/Telegram/generic) sends
  new incidents, deduped for 5 minutes and capped at 10 per minute.

## [0.1.5] — 2026-11-11

Free-tier resilience, modelled on how opencode2api survives per-IP quota:

- A client request now rotates through pool exits on `429`, IP-level `403`,
  and `5xx` instead of replaying the exhausted IP. `UPSTREAM_EGRESS_RETRIES`
  (default `3`, `0` disables) bounds the swaps per request; each failed exit is
  parked in the pool's cooldown and the WARP lane rotation still fires.
- IP-abuse `403` is no longer unconditionally terminal: with another exit it is
  retried there and only reported verbatim after the budget is spent.
- `start-fucking-opencode.cmd` launches the WARP farm (`WARP_FARM=1`, size 8,
  base port 40101) so a default install has several egress IPs.

## [0.1.4] — 2026-11-11

Operational hardening: per-key limits, observability, backup/restore, TLS, and
a farm watchdog.

- Per-key limits: `settings.json` entries now carry `rpm` (sliding 60 s),
  `daily` (rolling 24 h), and `models` (allowlist). The panel's key rows gain a
  **限额** editor; `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`
  return `429` with `Retry-After` (`key_rate_limited` / `key_quota_exceeded`) or
  `403 model_not_allowed`. Counters are in memory and reset on restart. The
  Anthropic/Responses bridges tag self-calls with a per-process internal token
  (`X-Internal-Hop`) so a translated request is neither double-counted nor
  deadlocked.
- Concurrency gate: `MAX_INFLIGHT` (default 64) caps in-flight inference; excess
  requests queue for `MAX_INFLIGHT_WAIT_MS` (default 30 s) and then fail with
  `429 gateway_busy`. `POST /v1/messages/count_tokens` stays outside the gate.
- Observability: `GET /metrics` (Prometheus text; optional `METRICS_TOKEN`),
  `GET /openapi.json` (3.1), and `GET /v1/models/{model}`.
- Legacy endpoints: `POST /v1/completions` translates `prompt` (string or 1–8
  strings) into chat requests and maps the result back to `text_completion`
  (stream and non-stream); `POST /v1/embeddings` answers
  `501 embeddings_not_supported` because the free tier has no embeddings.
- Panel sessions: signed stateless cookies (`<state>/panel-session-secret`,
  `0600`, key derived from the secret and the current password) survive gateway
  restarts within the 12 h TTL. `/api/logout` revokes only that token via
  `<state>/panel-revocations.json` (also persisted, pruned on write); changing
  the password rotates the secret and revokes every session at once.
- Backup: `GET/POST /api/backup` exports or restores the JSON state files
  (`settings.json`, `proxy.json`, `warp-farm.json`, `model-health.json`,
  `config.json`) behind the existing panel session; writes are atomic and
  `0600`. The panel's Settings view links the backup and metrics surfaces.
- TLS: set `PANEL_TLS_CERT` and `PANEL_TLS_KEY` to serve both listeners over
  HTTPS; no self-signed generation.
- Usage ledger: rotation threshold is now `FUCKING_OPENCODE_USAGE_MAX_BYTES`
  (64 KiB–1 GiB, default 5 MiB), halved in place instead of deleted, checked at
  start and every 200 writes.
- WARP farm watchdog: every 5 s the gateway checks the sidecar; dead lanes are
  removed from the proxy pool (so traffic falls back to direct or the single
  proxy instead of a dead port) and the sidecar restarts when **看门狗** is on
  (`<state>/warp-farm.json`, `watchdog`, default `true`; toggle in the panel).
  Manual stop disables auto-restart.
- Release tooling: `scripts/package-release.sh` cross-builds the Go sidecar for
  linux/darwin/windows × amd64/arm64, embeds the matching binary in each
  archive (`warp-farm/warp-farm[.exe]`), and emits standalone
  `warp-farm_<os>_<arch>` assets with checksums; `install.sh` builds the
  sidecar from a local checkout when Go is present; `.github/workflows/release.yml`
  packages and uploads everything on a `v*` tag.

## [0.1.3] — 2026-11-11

- `warp-farm/` — Go sidecar (no Docker, no TUN): N WARP registrations, one
  userspace WireGuard tunnel each, one loopback SOCKS5 listener per exit
  (`40001..`). `warp-farm.js` spawns it, waits for the control API, and
  registers the lanes in the existing proxy pool. `WARP_FARM=1` starts it at
  boot; `GET|POST /api/warp-farm` reports and controls it. A lane that answers
  `429`/quota or fails at the transport layer is rotated on the same port.
- Identity: `x-opencode-project` now defaults to a fresh sha1-shaped id per
  request (`OPENCODE_PROJECT_MODE=derived` restores the CLI-faithful value),
  and 5xx/gate retries rotate the project id as well as the session id. The
  free tier accounts quota per (project id, egress), so a new id is a new
  bucket.
- `warp-farm/NOTICE.md` records the GPL-3.0/MIT provenance of the Go sidecar.
- Panel: new **WARP Farm** menu (start/stop/restart, per-lane rotate and
  egress test, parameters persisted to `<state>/warp-farm.json`, sidecar log),
  a **Log** menu combining the gateway event ring and sidecar tails
  (`GET /api/logs`), a runtime-config editor backed by `POST /api/config`,
  an identity card showing `OPENCODE_PROJECT_MODE`, a 24-hour quota card
  (`GET /api/quota`), and a model-cooldown reset button
  (`POST /api/model-health/reset`).
- Panel navigation collapsed from 14 flat menus to 6 groups (Overview,
  Egress, Diagnostics, Usage, Developer, Settings); the former pages are now
  sub-tabs inside their group, and hash deep links such as `#warpfarm` or
  `#pool` still open the right group and tab. Every new string is translated
  for `zh`/`id`/`en`; composite status text (`2 / 2 就绪`, `24 小时`,
  `已清空 N 条模型冷却。`, `warp-f2 正常，123 毫秒，出口 1.2.3.4`) is handled by
  pattern rules so switching language re-renders it.

## [0.1.2] — 2026-11-11

Multi-key credentials, an optional admin port, and a movable usage ledger.

- `settings.json` now stores a key list (`apiKeys`) with per-key label and
  enable switch. The legacy single `apiKey` migrates on first write; the panel
  can add, rename, disable, and delete keys, and never returns a full secret.
  `FUCKING_OPENCODE_API_KEYS` entries are read-only.
- `ADMIN_PORT` (with `ADMIN_BIND`) serves the panel and `/api/*` on its own
  listener. The API port answers `/` with a redirect, refuses panel APIs with
  `admin_port_only`, and the admin port refuses inference with
  `api_port_only` while keeping `/health` and `/v1/models`.
- `FUCKING_OPENCODE_USAGE_FILE` relocates `usage.jsonl`, so two gateways can
  share a state directory without merging their ledgers.
- New `config.js` reads `<state>/config.json` (or `FUCKING_OPENCODE_CONFIG`)
  for `defaultModel`, `upstreamTimeoutMs`, `maxBodyBytes`, and `autoUpdate`.
  Precedence is env > file > default; edits hot-reload within a second, invalid
  values keep the last good snapshot, and `GET /api/config` reports values,
  sources, and the parse error.
- `modelGroups` maps an alias to an ordered model list. A `404`/`410`/`429`/`5xx`
  before any client bytes switches to the next candidate; failures persist as
  per-model cooldowns in `<state>/model-health.json` (`FUCKING_OPENCODE_MODEL_GROUPS`
  overrides the file).
- `GET /api/diagnostics?hours=24` aggregates per-egress and per-model requests,
  `429`/`5xx` counts, success streak, and model cooldowns; the routing
  diagnostics view renders the extra columns and a cooldown table.
- `socks5://` and `socks5h://` egress entries are accepted. A loopback HTTP
  CONNECT shim per unique URL performs the SOCKS handshake (none or
  username/password) so Bun still owns TLS and the ClientHello baseline holds.
- Opt-in Cloudflare WARP controls (`WARP_MANAGE=1`): `/api/warp` reports status
  and drives a host-installed `warp-cli`; the egress view gains a WARP card.
  Default off because it changes whole-machine routing.
- Panel copy is fully translated across 中文/ID/EN, including dynamic pool
  results (per-entry probe results, cooldown countdowns, failure reasons) and
  the WARP card; the product version in the panel header and titles now comes
  from the server instead of a hardcoded string.
- Release packaging and the installer fetch list now ship the new runtime
  modules (`config.js`, `model-groups.js`, `socks-bridge.js`, `warp.js`,
  `compat.js`), so installed hosts receive them through both update paths.
- Favicon: the panel and login pages link `/panel-avatar.png`, `GET /favicon.ico`
  serves the same bytes before auth, and the avatar ships through both the
  installer and the self-updater.
- Stats page restyled to a monochrome look: the four usage KPI cards drop the
  colored accent bars (the cost card is gone), and the traffic chart renders
  gray bars per time bucket with hover breakdowns instead of a line chart.

Anthropic and Responses protocols, usage history, opt-in API keys.

Claude Code speaks `/v1/messages`, Codex speaks `/v1/responses`; the bridge
only spoke Chat Completions, so both needed a second gateway in front of it.
The bridge now translates at its own edge instead.

- New optional module `compat.js`: Anthropic Messages ↔ OpenAI Chat
  Completions translation (system, tool_use/tool_result, images, thinking,
  `stop_sequences`, `tool_choice`), Responses API input/output translation,
  and SSE stream transformers for both. `count_tokens` is answered locally
  (4 chars/token approximation + 32/tool) without touching upstream.
- New routes: `POST /v1/messages` (and `/messages`),
  `POST /v1/messages/count_tokens`, `POST /v1/responses` (and `/responses`).
  Each translates, then self-calls the bridge's own
  `/v1/chat/completions` over loopback, so gateway healing, the egress pool,
  session affinity and the audit lanes apply unchanged — the upstream only
  ever sees the Chat Completions shape it already accepts.
- Streamed Anthropic responses use a monotonic block `index` across
  thinking → text → tool_use blocks (Anthropic clients overwrite blocks
  sharing an index).
- New optional module `stats.js`: every inference request (all protocols)
  is appended to `<state dir>/usage.jsonl` — model, protocol, status,
  duration, token counts, egress label, request id. Message bodies are never
  recorded; the file truncates at 5 MB; stats never throws.
- New endpoints: `GET /api/stats?days=`, `GET /api/history?limit=&days=`,
  `POST /api/history/clear`. The panel gained a 用量统计与请求历史 section
  that renders both.
- `BRIDGE_API_KEYS="k1,k2"` (opt-in, default off) gates every `/v1/*` route
  with a timing-safe Bearer check; `/health`, the panel and `/api/*` stay
  open. `BRIDGE_DEFAULT_MODEL` fills in a missing `model` on Chat
  Completions before validation.
- Every inference response carries `X-Request-Id`, echoed in the history
  record. Self-call results carry the egress label via `X-Bridge-Egress`.

## [2.3.1] — 2026-10-25

`429 FreeUsageLimitError` is also a tool-name filter.

A client tool called `run_code` makes upstream answer the quota message even
when the request is otherwise identical to one that answers `200`; the same
schema under `run-code`, `runcode`, `run_program` or `code_exec` is accepted, and
adding the `read` anchor alongside it does not help. A PTC-style harness that
collapses its tool set into a single `run_code` tool therefore failed every turn
with what looked like a spent allowance.

- A client tool whose name matches `run_code` is sent upstream as `run_program`
  and renamed back on the way out: streaming deltas, `tool_choice` and
  tool-result turns all carry the client's own name.
- An alias the client already owns is left alone; the renamed copy becomes
  `run_program2` instead of shadowing a live tool.
- The filter is documented in the troubleshooting section with the measured
  name matrix.

## [2.3.1] — 2026-10-25

Pool health survives a restart.

A pool that forgets its cooldowns re-burns every spent IP on the first request
after a restart, which is exactly what an Instabox suspend/resume does eight
times a day. The rotation was correct; its memory was not.

- Cooldowns, failure counts and last-seen timestamps are written to
  `<state dir>/pool-health.json` (mode `0600`) and re-applied by
  `loadFromDisk()`. A restart now resumes with the same pool state it went down
  with.
- Records are keyed by a truncated SHA-256 of the egress identity, so the health
  file is not a second copy of the proxy credentials sitting next to
  `proxy.json`.
- A refusal writes immediately; a success is coalesced over one second. The file
  is written by rename, so a crash mid-write keeps the previous copy.
- A corrupt health file costs the cooldowns and nothing else.
- `setPool` no longer calls `resetHealth()`: saving the pool from the panel —
  including a strategy change — used to discard every cooldown it had learned.
  Removed entries are still pruned and the file is rewritten to match.

## [2.3.0] — 2026-10-25

Egress pool: one bridge, many exit IPs.

The free-tier allowance is per egress IP, so the previous answer to "I need more
IPs" was one bridge process per host: eight hosts, eight service units, eight
tunnels, eight catalogs to keep in step. The pool moves that rotation into the
one thing that already makes the request, and the per-host process goes away.

### Pool (`proxy.js`, `server.js`)

- A pool is a list of entries (`url`, `{id,label,url,enabled,weight}`, or
  `{direct: true}` for the hosting machine's own address). `direct` is a
  first-class entry, so the bridge host's IP takes part in the rotation instead
  of being the fallback used only when every proxy is down.
- Strategies: `round-robin` (default), `failover` (sticky, preserving upstream
  prompt caching on one IP), `random` (weighted).
- Health is per entry and keyed by egress identity, not by URL, so `direct`
  cannot share a record with a proxy. Backoff doubles per consecutive failure
  from `cooldownMs` (120 s) up to `maxCooldownMs` (30 min); a success resets it.
  A `429` earns four times the base window.
- When every entry is cooling the one that recovers first is used anyway:
  refusing to send would turn a throttled pool into a dead bridge.
- A gate rejection drops the refused entry and retries through a different one
  inside the same request. An unreachable proxy is failed over too, because
  nothing reached upstream; that path used to surface a 500 to the client.
- Every non-egress retry (protocol lane, endpoint migration, 5xx, gate shape)
  reuses the entry the request started on, since upstream ties a retry to the
  address that saw the first attempt.
- `UPSTREAM_PROXY_POOL` / `UPSTREAM_PROXY_STRATEGY` are operator overrides that
  lock runtime edits, matching `UPSTREAM_PROXY_URL`.

### Egress proxy (`egress-proxy.js`)

A dependency-free HTTP proxy so a host can become a pool member without root, a
package install, or a config file: CONNECT plus absolute-URI HTTP, optional
`EGRESS_PROXY_TOKEN` (Basic, password only), unauthenticated `/healthz` carrying
nothing but a connection count and uptime. TLS is tunneled end to end, so it
never sees plaintext. It binds loopback; reachability is the tunnel's job.

`egress-proxy.js` ships through `UPDATE_FILES`, `install.sh` and `package.json`
`files[]`, and `install.sh` marks it executable.

### Panel

`/` gains a pool section: one proxy per line (`label=url`), strategy selector,
*Uji semua* (probes every entry concurrently and records the verdict in the same
health map the request path uses), *Simpan pool*, and *Kosongkan pool*. The
status block lists each entry with its state, remaining cooldown, failure count
and last error.

### Fixed

- A `429 FreeUsageLimitError` never marked its egress. `isFreeTierCliGateError`
  only recognises 401/403/426, so the refusal fell into the generic non-gate
  branch and the pool learned nothing. Measured on the fleet: six requests
  rotated through six IPs, four answered 429, and `/health` still showed every
  entry `ready` — the pool burned the whole rotation on every request. A 429 now
  parks that entry (four base windows) and the same request retries through
  another one.
- A 5xx does *not* park the egress: that is upstream's fault, and treating it as
  the IP's would empty the pool during a bad hour at the gateway.
- `markFailure`/`markSuccess` treated the `direct` entry's empty URL as "nothing
  to record", so an exhausted bridge host IP was never cooled down. Health is
  keyed by egress identity now, and only a missing state means nothing to record.
- `pick({exclude})` let a round-robin selection return the excluded entry,
  defeating the retry-on-another-egress path entirely.
- `withProxy({}, "")` treated the `direct` entry's empty URL as "no egress" and
  fell back to a pool pick, so an explicitly pinned direct egress was ignored.

## [2.2.2] — 2026-10-25

Fleet release: the catalog-freeze fix plus the delivery fixes below. Every
machine was on 2.2.1, whose `/v1/models` could stay frozen for the life of the
process, so this is the version the fleet is pinned to.

### Upstream catalog froze on crashed boots (identity.js)

Boot-time warm-start from `~/.opencode-free-bridge/cache/catalog.json` filled
`freeModels`, and `refresh()` only re-read the provider catalog when that list
was empty — so a booted process served a permanent snapshot: retired models
(measured: `minimax-m3.1-flash-free` answered upstream with `404` while still
listed) stayed in `/v1/models`, and clients spent the per-IP free burst quota
probing ids upstream no longer knows.

- Both the "up-to-date" and "available-not-adopted" branches of `refresh()`
  now re-read the catalog. `refresh()` is TTL-gated by `ensureFresh`, so this
  costs at most one request per refresh interval.
- `verify.js` now breaks its sweep at the first `429` the same way it already
  breaks on `403 gate-closed` — hammering every model while the IP is
  throttled only prolongs the allowance window.
- `THIRD_PARTY_NOTICES.md` now ships through both delivery paths
  (`UPDATE_FILES` and `install.sh`), fixing the delivery test.

### 429 FreeUsageLimitError was a request-shape problem, not a quota

The gateway answers `429 FreeUsageLimitError` for two unrelated things: an
exhausted free-tier allowance, and a system prompt that lacks the harness
`<env>` block. Only the second one applied here — the CLI answered while the
bridge was refused in the same minute, repeatedly, which the previous
"time-of-measurement artifact" note could not explain.

- Reproduced by capturing the CLI's own request (`opencode run` through a local
  provider pointing at a capture server) and replaying it byte-for-byte: 200.
  The same body with the system prompt replaced by a short one: 429. Both went
  out with the same headers, session id and TLS stack, so the difference is the
  body.
- The trigger is the `<env>` block plus a `Working directory:` line, not the
  prompt length: a 12 KB generic prompt is refused, a 65-byte
  `<env>Working directory: /tmp</env>` is accepted, and `big-pickle` and
  `mimo-v2.6-flash-free` behave identically. Dropping every tool (`tools: []`)
  produces the same 429, which is why that case also looked like a quota error.
- `transformChatMessages` and `extractSystemInstructions` now append the block
  (working directory, workspace root, git-repo flag, platform) to whichever
  system prompt the request carries, synthesizing one when the client sent
  none. A client forwarding the CLI's own prompt keeps its block unchanged and
  gets no duplicate.
- Covered by a regression test in `test/server.test.js` for both protocol
  lanes.

## [2.2.1] — 2026-10-22

Hardening for the egress proxy shipped in 2.2.0. The feature worked, but three
defects made it unsafe to leave as-is.

### An upgrade from 2.1.0 could crash the bridge

2.1.0's self-updater had no `proxy.js`/`panel.js` in `UPDATE_FILES`. Updating
such an install to 2.2.0 wrote a `server.js` that required those modules,
restarted, and died with `Cannot find module './proxy'` — a crash loop with no
recovery except reinstalling. Reproduced end to end before fixing.

- `server.js` and `identity.js` now load `proxy`/`panel` tolerantly: a missing
  own module degrades to direct egress instead of throwing at require time.
  Only a missing *own* module is tolerated; a real error inside the file still
  surfaces.
- The updater reads the **incoming** `server.js`, extracts its relative
  requires, and stages any module the running file list does not name. An old
  `UPDATE_FILES` can no longer install a server it cannot boot.
- On boot, `repairMissingModules()` re-fetches modules that `server.js` requires
  but that are absent, so an already-broken 2.2.0 install heals on restart
  instead of needing `install.sh`. Best-effort and non-blocking.

### The panel API was writable from any website (CSRF)

`POST /api/proxy` accepted `text/plain`, which browsers send cross-origin
without a preflight, and it never looked at `Origin`, `Sec-Fetch-Site`, or
`Host`. Any page the operator visited could point the bridge's egress — and its
self-updater — at an attacker's proxy, or switch it off.

- Writes require `Content-Type: application/json` (415 otherwise).
- Cross-site requests are refused (403) on `Sec-Fetch-Site` and on a foreign
  `Origin`.
- The `Host` header must be a loopback name, the configured bind address, or an
  entry in `PANEL_ALLOWED_HOSTS`, which closes DNS rebinding.
- The panel is served with `X-Frame-Options: DENY`, and `HEAD /` works again
  instead of returning 404.

### Container lost the proxy setting

`proxy.json` was written to `~/.opencode-free-bridge` inside the container,
which is discarded on recreate. The image now sets
`OPENCODE_BRIDGE_STATE_DIR=/data/state` and compose mounts a `bridge-state`
volume there.

### Node compatibility

`testProxy` correctly refuses to run on Node (Node's fetch ignores the `proxy`
option, so a probe would report success while going out directly), but two
tests asserted the Bun behaviour unconditionally. They now assert the refusal
on Node and the probe verdict on Bun.

## [2.2.0] — 2026-10-21

### Egress proxy, configured from the browser

`http://127.0.0.1:20129/` now serves a panel instead of the health document, and
the panel sets an HTTP proxy for **every** outbound request the bridge makes:
inference, model discovery, identity/update sync, and the self-updater. Upstream
sees the proxy's IP, not this machine's.

- **`proxy.js`:** validates `http://`/`https://` URLs (percent-encoded
  credentials supported), refuses SOCKS with Bun's own reason
  (`UnsupportedProxyProtocol`), persists to `~/.opencode-free-bridge/proxy.json`
  at mode `0600`, and exposes `netFetch()` — one egress point used by `server.js`
  and `identity.js`. `UPSTREAM_PROXY_URL` is an operator override that also locks
  runtime edits.
- **`panel.js`:** HTML panel plus `/api/proxy` (GET status, POST set/clear) and
  `/api/proxy/test` (probe). Status, `/api/proxy`, and `/health` expose `host:port`
  only; credentials never leave the process.
- **Test before trusting it:** the probe fetches the models endpoint through the
  candidate and reports the exit IP from `cdn-cgi/trace`, so a working tunnel with
  a refused egress (403) is distinguishable from a broken proxy.
- **No restart:** the URL is read per request.
- **`/health`:** `egress.mode` is now what actually carries traffic (`proxy`,
  `relay`, `direct`), with `egress.proxy` describing the proxy state.
  `verify.js` prints the egress line before probing.
- **Relay interaction:** with both configured, the request still targets
  `UPSTREAM_RELAY_URL` and that connection is dialled through the proxy.
- **Delivery:** `proxy.js` and `panel.js` added to `package.json` `files`,
  `UPDATE_FILES`, and `install.sh` (fetch, syntax check, install, backup), so the
  self-updater cannot leave an install missing the modules `server.js` requires.

### `install.sh` installs the checkout it runs from

`bash install.sh` inside a clone always downloaded from GitHub, so a file added
in the working tree but not yet pushed failed the install with a bare
`curl: (22) The requested URL returned error: 404` that named neither the file
nor the cause. `SOURCE=auto` now installs the local working tree when the script
runs from a checkout, the remote path names the file it could not fetch and
points at `SOURCE=local` as the way out, and `SOURCE=remote` restores the old
behaviour. The `curl | bash` route is unchanged.

## [2.1.0] — 2026-10-21

### Container deployment

The bridge can now run in a container. `Dockerfile` and `docker-compose.yaml`
were contributed in PR #1 by [@rustam76](https://github.com/rustam76); this
release completes them so the container is actually usable. Their commits stay
in the history of this repository as the base of the merge.

- **Pinned base image (`oven/bun:1.4.3-slim`).** The free-tier gate inspects
  the TLS ClientHello, so the Bun version in the image is not interchangeable
  with any other. The pinned tag is the version the fingerprint baseline was
  measured on, and `bun transport-fingerprint.js --check` passes inside the
  image.
- **Writable `/app` (`chown -R bun:bun /data /app`).** `COPY --chown` chowns
  the copied files but not the directory that holds them, so `/app` stayed
  root-owned while the process ran as `bun`. The self-updater stages its temp
  files next to their targets inside `__dirname`, so every in-place update
  died with `EACCES: permission denied`.
- **Loopback-only port publish.** The compose file only had `expose:`, which
  publishes inside the compose network, so the documented base URL
  (`http://127.0.0.1:20129/v1`) was unreachable from the host. It now publishes
  `127.0.0.1:20129:20129` — loopback on purpose, because the bridge has no
  authentication and a `0.0.0.0` publish would be an open relay.
- **`AUTO_UPDATE=0` by default.** The image is the unit of deployment, so an
  in-place self-update is reverted by the next `docker compose build`. Upgrade
  with `docker compose build --pull && docker compose up -d`.
- **`.dockerignore`.** Keeps `.git`, `.github`, and `test/` out of the build
  context. A `.git` directory inside the image defeats the self-updater's
  `git-checkout` guard, and it is not something a published image should
  carry.
- **Hardened runtime:** `cap_drop: [ALL]` next to `no-new-privileges`, and a
  `HEALTHCHECK` in the Dockerfile so a plain `docker run` is health-checked too.
- **Docs:** README gains a Docker install section, AGENTS.md a container
  install option and rows for the new files.

The container files ship in the repository, not in the npm tarball: they are
build inputs for a checkout, not runtime files a host install needs, so they
stay out of `package.json` `files` (which the self-updater and `install.sh`
both have to deliver).

### A note on the contributor graph

[@MBMoulidharan](https://github.com/MBMoulidharan) is the same person as
[@rustam76](https://github.com/rustam76) — two accounts registered ninety
minutes apart on 2019-04-12, with user IDs `49561459` and `49564359` (the
digits transposed). Only `rustam76` authored anything here: all three commits
of PR #1 are attributed to `rustam76` by GitHub itself.

A `Co-Authored-By` trailer on the merge and the follow-up commit briefly
carried `49561459+rustam76@users.noreply.github.com` — a transposed typo —
and GitHub maps the numeric prefix of a `noreply` address to the account with
that id, so the credit landed on `MBMoulidharan` and produced a second entry
in the contributor graph. The trailer is corrected in the current history.
Forks taken before the correction still carry the old commits, so their graphs
show the same extra entry until they re-sync.

---

## [2.0.3] — 2026-10-20

### IP-level abuse blocks are terminal, not a stale identity

Upstream now returns a second, explicit `403 FreeTierError` message for a
network-level flag (*"OpenCode's free models aren't available from your current
network because we've detected abusive traffic from this IP address"*, and the
earlier `Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic`). The
bridge treated it like the shape gate: forced a GitHub/catalog refresh, re-minted
the session id, and replayed the request once. No identity change can clear a
flag keyed to the egress IP, so the retry only extended the penalty and appended
a misleading "update opencode-free-bridge" hint to the refusal.

- **Terminal classifier (`identity.js`):** `isIpAbuseRejection` matches the
  known phrasings; `onGateRejection` returns `{retry:false, reason:"ip-abuse",
  terminal:true}` before consulting the refresh cooldown.
- **No refresh, no retry (`server.js`):** the gate branch short-circuits on the
  first abuse message and returns it verbatim with
  `X-OpenCode-Gate: ip-abuse` and upstream's `x-opencode-log-id`. The retry path
  applies the same rule when the first attempt carried the ambiguous shape
  message.
- **Accurate diagnosis:** `/health` reports `identity.gate.status: "ip-blocked"`
  plus `ipBlockedSince` and `lastRejection.kind`, and a later success clears it.
  The generic gate diagnostic is labelled `kind: "free-tier-gate"`.
- **`verify.js`:** reads `X-OpenCode-Gate` (`ip-throttled` / `ip-abuse` →
  `gate-closed`, exit `2`; `shape-rejected` → failure) and falls back to the
  abuse wording. A correctly installed bridge is no longer reported as broken,
  and the installer repeats the right verdict.
- **Tests:** both abuse phrasings assert exactly one upstream call, zero
  `onGateRejection` calls, a verbatim body, and the `ip-abuse` header; identity
  tests assert no refresh; the retry path is covered when the block appears only
  on the second attempt.
- **Docs:** README and AGENTS troubleshooting sections now route abuse blocks to
  upstream support instead of reinstall/update advice.

### Optional egress relay

`UPSTREAM_RELAY_URL` sends inference through a relay implementing the 9Router
`x-relay-target` / `x-relay-path` contract, so upstream sees the relay's egress
IP instead of this host's. It covers the initial request and every retry; model
discovery and identity sync stay direct. Empty (the default) keeps direct
egress. `/health` reports `egress.mode` and the relay's origin only (credentials
and query strings are not exposed), and changing the variable requires a
restart.

---

## [2.0.1] — 2026-10-18

### Tunnel lifecycle tooling actually reaches installed hosts

`tunnel-doctor.sh` was added in 2.0.0 but no delivery path carried it: it was
absent from `install.sh` (fetch, move, backup, `chmod`), absent from the
self-updater's `UPDATE_FILES`, and absent from the npm `files` list. A fresh
one-liner install and an auto-update both produced a bridge without it, while
`AGENTS.md` and `README.md` told operators to run it.

#### Delivery (`install.sh`, `server.js`, `package.json`)
- **Installer:** fetches `tunnel-doctor.sh`, validates it with `bash -n` before the running bridge is stopped, moves it into `BINDIR`, marks it executable, and includes it in the pre-upgrade backup.
- **Self-updater:** `tunnel-doctor.sh` is in `UPDATE_FILES`. Because `new Function` cannot parse bash, the updater checks the shebang, then runs `bash -n` on the staged temp file, and applies mode `0755`. A host without bash is not treated as a syntax failure.
- **npm `files`:** the script ships in the published tarball.

#### Correctness (`tunnel-doctor.sh`)
- **Default port scan widened to `20120-20149`.** The previous hardcoded `20129-20135` list silently omitted a newly added node's tunnel on `20136` — the exact failure the script exists to catch. Narrow it with `TUNNEL_PORTS="20129 20136"`.
- **No-bash guard in the updater:** the earlier code removed the staged file before `chmod`, so a host without bash would fail the update instead of skipping the parse.

#### Documentation
- `README.md`: test count corrected (121 → 137), the stale-forward symptom and the `00-` prefix ordering rule for sshd keepalive drop-ins documented, and the installer's validation step now mentions `bash -n`.

---

## [2.0.0] — 2026-10-18

### Adaptive OpenCode CLI Synchronization & Bun Transport Parity

`2.0.0` replaces the static `1.x` gate constants and hardcoded model tables with full runtime derivation from the official OpenCode CLI release pipeline, GitHub source tree, and provider catalog, paired with Bun TLS transport parity.

#### 1. Bun Runtime & TLS `ClientHello` Parity (`server.js`, `transport-fingerprint.js`)
- **Bun required for live traffic:** The official OpenCode CLI is compiled with Bun (BoringSSL). Upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 cipher suites, 12 TLS extensions in exact order) and refuses Node.js (OpenSSL, 52 ciphers) with `403 FreeTierError`.
- **Startup guard & TLS baseline check:** `node server.js` exits with code `1` and clear instructions unless `ALLOW_NODE=1` is set for offline tests. `transport-fingerprint.js --check` captures the runtime's raw TLS `ClientHello` against a local TCP listener and verifies cipher and extension parity against `transport-baseline.json`.

#### 2. Full Source & Catalog Derivation (`identity.js`, `token-budget.js`)
- **Release handshake (`resolveRelease`):** Queries `https://opencode.ai/update/api/latest/cli/npm` (with GitHub `releases.atom` fallback) to resolve the active CLI version, minimum version floor, and exact release commit SHA.
- **TypeScript AST / source extraction (`extractRecipe`, `extractToolFromSource`):** Fetches and parses upstream's release source files at the resolved commit SHA:
  - `packages/schema/src/identifier.ts` & `session-id.ts`: session ID prefix (`ses_`), length (`26`), base62 charset, and timestamp multiplier (`4096`).
  - `packages/core/src/app.ts`: `User-Agent` template (`opencode/${channel}/${version}/${cli}`).
  - `packages/core/src/session/model-request.ts`: required and optional gate headers (`x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`, `User-Agent`, `x-opencode-project`, `x-opencode-session`, `x-opencode-client`) plus W3C `traceparent` / `b3` trace headers and derived project hash.
  - `packages/core/src/tool/plugin/*.ts`, `codemode/tool.ts`, and `@opencode/schema/*`: dynamically discovers and parses all 13 CLI tool plugins (Effect Schema AST to JSON Schema, cross-file struct references, sibling `.txt` descriptions, and model-conditional `patch` vs `edit`/`write` swaps).
- **Zero hardcoded model tables (`extractCatalog`, `parseCatalogData`):** Removed `MODEL_MAP` and `REASONING_MODEL_HINTS`. Active free models (`cost.input === 0`, non-deprecated), paid/deprecated model verdicts, family shorthand aliases (`mimo`, `longcat`, `beam`, `deepseek-flash`, `glm-flash`, `nemotron-free`), inference endpoints (`chatUrl`, `responsesUrl` validated under `https://*.opencode.ai`), and per-model `reasoning` / `maxOutput` facts are derived from `https://models.opencode.ai/api.json`.
- **On-disk catalog cache:** Persists the fetched catalog to `~/.opencode-free-bridge/cache/catalog.json` (configurable via `OPENCODE_CACHE_DIR`, disabled with `off`) and warm-starts at module load so aliases, verdicts, and token budgets work on the first request and when offline.

#### 3. Multi-Layer Reactive Self-Healing & Cooldown Protection (`server.js`, `identity.js`, `gate-drill.js`)
- **Reactive heal on `403` / `426` / `404`:**
  - On `403 FreeTierError` or `426 UpgradeRequired`, the bridge refreshes its recipe and catalog from upstream, evicts the rejected session ID from `sessionCache`, mints a fresh `ses_...` ID, escalates from `core` to the `full` tool profile, and retries once transparently.
  - On `404` / `410` route migration, re-derives the endpoint URL from the catalog and retries once when the URL moved.
- **IP-cooldown retry & refresh protection (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`):** When a full-shape retry with the freshly synced identity still returns `403 FreeTierError` (indicating a per-IP upstream cooldown rather than a stale request shape), subsequent requests within the 30s cooldown window skip duplicate `403` retries and redundant GitHub/catalog fetches until the identity changes or a request succeeds.
- **Streaming probes & self-healing drill suite (`verify.js`, `gate-drill.js`):**
  - `verify.js` and `gate-drill.js` send `stream: true` on all upstream probes to match the CLI's streaming wire shape, and stop probing remaining models immediately on `gate-closed` (`403 FreeTierError`) so diagnostics never extend an IP cooldown.
  - `gate-drill.js` includes 4 live drills (`version-floor`, `empty-tools`, `session-shape`, `legacy-shape`) gated by a control probe and 6 deterministic offline drills (`routing`, `allowlist`, `retry-endpoint`, `endpoint-move`, `gate-heal`, `full-corrupt`).

#### 4. Universal Installer & Safe Self-Updater (`install.sh`, `server.js`)
- **Staged, zero-dead-end installer (`install.sh`):** Finds or installs Bun (plus `unzip` on minimal Linux), downloads and validates all files in a staging directory (`new Function` syntax check and `JSON.parse`) before stopping a running service, migrates legacy `opencode-bridge.service` / Node units to Bun, configures `systemd` (Linux) or `launchd` (macOS), and verifies `/health` and `transport-fingerprint.js --check`.
- **Bun-compatible self-updater (`checkAndApplyUpdate`):** Validates staged updates in-process without spawning `bun --check`, bypasses GitHub raw CDN caches, and skips overwriting files inside a `.git` checkout.

---

## [1.5.3] — 2026-10-15

### Pruned, Hardened & Deep-Optimized

- **Removed runtime self-updater bloat (`FIND-02`)**: deleted `checkAndApplyUpdate()`,
  `isNewerVersion()`, `fs`/`path`/`child_process`/`vm` imports, and `AUTO_UPDATE`
  from `server.js`. Updating is handled cleanly by `install.sh` or `git pull`.
- **Zero-allocation hot paths**:
  - Pre-computed and froze `CANONICAL_TOOLS_CHAT`, `CANONICAL_TOOLS_RESPONSES`,
    `FINGERPRINT_PARAM_STRINGS`, and `DEFAULT_PLACEHOLDER_NOTE` at module load so
    tool-less or standard requests allocate zero tool objects/maps.
  - Pooled `crypto.randomFillSync` (3.5 KB buffer, 256 IDs per syscall) in
    `createId()`.
  - Pre-serialized `/health` and `/v1/models` JSON payloads on discovery change
    and replaced `new URL()` + regex path parsing with direct string indexing.
  - Added zero-split `consumeSseLines()` scanner and zero-parse SSE passthrough
    fast path when no tool aliases or `reasoning` field normalization are needed.
- **Responses API system/developer instructions & multimodal inputs (`FIND-01`, `FIND-04`)**:
  extracts `system` and `developer` messages from `body.messages` into
  `upstreamBody.instructions` alongside `placeholderNote`, preserves multimodal
  `image_url` / `input_image` / `input_file` parts, and forwards `temperature`,
  `top_p`, `stop`, `response_format`, and `reasoning_effort`.
- **Chunked 413 stream cleanup (`FIND-03`)**: when a streaming request body
  exceeds `MAX_BODY_BYTES`, `readRequestBody` detaches listeners, pauses the
  stream immediately, and destroys the socket without calling `req.resume()`.
- **Localhost-scoped CORS (`FIND-05`)**: restricts `Access-Control-Allow-Origin`
  to `localhost` / `127.0.0.1` / `[::1]` by default (configurable via
  `CORS_ORIGIN`) so arbitrary third-party websites cannot drain local IP quota.
- **Collision-resistant headerless session hashing (`FIND-06`)**: samples both
  head and tail plus total length (`messageSignatureSample`) so conversations
  sharing a long (>1000 char) system prompt prefix do not collide.
- **Reasoning hint & installer quoting (`FIND-04`, `FIND-07`)**: added
  `deepseek` to `REASONING_MODEL_HINTS` in `token-budget.js` and hardened path
  quoting in `install.sh`.

## [1.5.2] — 2026-10-15

### Performance — 4 hot-path optimizations (zero-deps, all covered by `test/optimizations.test.js`)

- **Single-flight discovery**: 50 parallel `/v1/models` hits after TTL expiry
  share one upstream fetch (was: 50 parallel fetches = thundering herd).
- **Discovery no longer waits on the CLI version feed**: feed refreshes in
  parallel fire-and-forget and is cached 6h (was: every hourly discovery
  blocked up to 5s on the Atom feed).
- **Session fast path**: requests carrying a session header skip message
  hashing entirely; headerless fallback slices *before* stringify via new
  `shortText()` so a multi-MB system prompt is never serialized for a hash.
- **Early 413 reject**: bodies declaring `content-length` over the limit are
  refused without buffering a byte.

Measured: 50 parallel GETs served in 0.22s with 1 upstream fetch;
header-path session lookups with 5MB messages in ~6ms.

## [1.5.1] — 2026-10-15

### Removed — hardcoded model fallback

- **No more `FALLBACK_MODELS` / built-in list.** `server.js` starts with an
  empty model list and serves only live discovery results. An empty
  `/v1/models` honestly means "upstream not reached yet", so gateways and
  harnesses apply their own fallback instead of being served a stale list.
- Removed retired `ling-3.1-flash-free` aliases (upstream retired the model),
  removed its hint from `token-budget.js`, and replaced it with
  `deepseek-v4.1-flash-free` in `README.md`.
- Added `deepseek` / `big-pickle` shorthand aliases to `MODEL_MAP`.
- Unified log prefix to `[opencode-free-bridge]`, fixed stale comments
  referencing the removed cache/fallback.
- Boot no longer blocks on network: `server.listen` first, discovery runs in
  background and refreshes hourly.

## [1.5.0] — 2026-10-14

### Fixed — OpenCode v2 `/inference/v1` gate migration (`403 FreeTierError`, 9router#4837)

OpenCode v2 migrated free-tier inference from `/zen/v1/*` to `/inference/v1/*`
and added multi-layer request verification:

- **Endpoints**: moved responses, chat completions, and model discovery to
  `https://opencode.ai/inference/v1/{responses,chat/completions,models}`.
- **User-Agent**: updated to the v2 CLI format (`opencode/latest/2.0.29/cli`)
  with automatic version refresh from the upstream GitHub release Atom feed.
- **Session headers & counter gate**: sends the required session header mirrors
  (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
  `x-session-id`), removes `x-opencode-request` (rejected by v2), and clamps the
  12-bit inverted session counter to `1..16` per millisecond in `createId`.
- **Canonical tool fingerprint & conflict aliasing**: injects verbatim `read`
  and `shell` schemas required by upstream, omits `tool_choice: "none"`,
  aliases conflicting client `read`/`shell` tools (`read_client`,
  `shell_client`) with transparent response restoration, and appends a
  placeholder system instruction so injected fingerprint tools are not invoked.

### Fixed — token budget, `usage`, and `finish_reason`

- **Unified additive token budget**: `server.js` now calls
  `effectiveMaxTokens` from `token-budget.js` (`max(requested, 1024) + 4096` for
  reasoning models including `longcat-2.5-preview-free` and `cat-jam-free`),
  removing the duplicate flat `Math.max` logic and handling `max_tokens: 0` and
  numeric strings without jumping to `131072`.
- **Non-streaming `usage` in Chat Completions**: sends
  `stream_options: { include_usage: true }` upstream so `prompt_tokens`,
  `completion_tokens`, and `total_tokens` are populated instead of `{0, 0, 0}`.
- **Real `finish_reason` propagation**: propagates upstream `finish_reason`
  (`"length"`, `"content_filter"`, `"tool_calls"`, `"stop"`) across both Chat
  Completions and Responses API (`response.incomplete`).

### Changed — reliability, validation, and unit test suite

- Added `AbortController` upstream timeout (`UPSTREAM_TIMEOUT_MS`, default 120s),
  automatic upstream cancellation on client disconnect, and `req`/`res` stream
  error handlers.
- Added 10 MiB request body limit (`413 payload_too_large`) and `400` validation
  for missing/empty `model`, missing `messages`, or malformed JSON.
- Fixed `sessionCache` eviction to true $O(1)$ LRU instead of FIFO.
- Single-sourced `VERSION` from `package.json` in `server.js` and `install.sh`.
- Added automatic protocol fallback & caching when upstream returns
  `400 ModelProtocolUnsupported`.
- Added zero-network unit & HTTP integration tests (`npm test` via `node:test`)
  and GitHub Actions CI (`.github/workflows/ci.yml`).

---

## [1.4.0] — 2026-10-13

### Fixed — reasoning models returned empty answers on short requests

Reasoning models on the free tier (Muse Spark, MiMo, Nemotron, LongCat,
cat-jam, big-pickle) emit chain-of-thought tokens that count against the
**same** output budget as the visible answer. A client asking for a small
`max_tokens` — a probe, a title, a one-word reply — had the entire budget
consumed by reasoning, and the bridge returned `content: null` with
`finish_reason: "stop"`. No error, no content, tokens still billed.

Measured against the live upstream gateway:

| `max_tokens` | Result |
|---|---|
| 50 | empty for Muse Spark |
| 100 | empty for Muse Spark and cat-jam |
| 256 | empty for big-pickle; longcat finished exactly on the cap |
| 512 | content returned, truncated on long answers |
| 2048 + headroom | complete answers |

The bridge now enforces a floor, using the additive budget the wider ecosystem
settled on (OpenRouter documents the shared-budget behaviour; goose#11142
adopts the pi coding agent's formula):

```
reasoning model : max_tokens = max(requested, 1024) + 4096
plain model     : max_tokens = max(requested, 512)
both clamped to 131072
```

The client's value is only ever raised, never lowered. Reasoning detection
also honours `reasoning_effort`, so a client asking for thinking on an
unlisted model still gets headroom. See `token-budget.js`.

### Added — one-line installer

`install.sh` installs the bridge, registers a boot service (systemd on Linux,
launchd on macOS), starts it, and runs the self-check. No manual steps.

### Added — `verify.js` self-check

`node verify.js` probes every discovered model with a real prompt and prints a
summary. It distinguishes "rate-limited" (upstream throttling this IP, not a
misconfiguration) from "not answering", so a new user can tell whether their
setup is correct without reading logs.

### Added — `token-budget.js`

The token budgeting logic, extracted and documented with the measurements it
is based on, so the numbers can be re-derived rather than taken on faith.

### Changed — README rewritten around the default path

The first thing a reader sees is now: install, add one local connection,
done. Multi-host setups moved to their own section, since they are optional
and only useful for spreading upstream rate limits.

### Changed — package.json

Version corrected (was `1.0.0` while the server reported `1.3.0`), `verify`
and `test` scripts added, `files` list added so `npm publish` ships the right
set.

---

## [1.3.0] — 2026-10-13

### Added — real-time auto-discovery of upstream free models

The model list is fetched from the upstream gateway on startup and refreshed
hourly. New free models appear without a code change; retired ones disappear.
Falls back to a built-in list when upstream is unreachable.

---

## [1.0.0] — 2026-10-13

### Added — initial release

OpenAI-compatible bridge for OpenCode free-tier models. Dual-protocol routing
(Responses API for Muse, Chat Completions for the rest), desktop identity
headers to avoid `FreeTierError`, `reasoning_content` normalization, and a
persistent session cache so upstream prompt caching survives across turns.
