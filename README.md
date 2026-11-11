<p align="center">
  <img src="panel-avatar.png" alt="Fucking Opencode" width="160">
</p>

<h1 align="center">Fucking Opencode</h1>

<p align="center">
  OpenAI-, Anthropic-, and Responses-compatible gateway for OpenCode free-tier models,<br>
  with a self-hosted operations panel.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black" alt="Bun runtime">
  <img src="https://img.shields.io/badge/dependencies-0-informational" alt="Zero dependencies">
</p>

Fucking Opencode is a local HTTP front end for the **OpenCode free tier**.
Point any harness that speaks OpenAI Chat Completions, Anthropic Messages, or
the OpenAI Responses API at it and calls are forwarded through the same wire
identity the official OpenCode CLI uses.

The gateway keeps the upstream transport, gate handling, proxy pool, and
self-healing engine, then adds a complete control plane: login-protected panel,
editable API key and password, health page, usage charts, request history, API
docs, playground, and agent integration snippets.

Single Bun process, standard library only, no build step, no frontend
dependencies. The panel is server-rendered HTML with inline CSS and vanilla JS.

```text
Panel:   http://127.0.0.1:20134/
API:     http://127.0.0.1:20134/v1
Health:  http://127.0.0.1:20134/health
```

## Quick start

```bash
git clone https://github.com/ShinRyu04/Fucking-Opencode.git
cd Fucking-Opencode
bun server.js
```

The gateway serves on `127.0.0.1:20134`. Open the panel, sign in, and copy the
Base URL and API key from **设置 → Agent 集成**.

On Windows, `start-fucking-opencode.cmd` runs the same headless setup with
`PORT=20134`, binds loopback, loads the panel password from the untracked
`panel-password.txt`, and refuses to double-start when the port is already
listening.

```bat
start-fucking-opencode.cmd
```

Bun 1.4+ is required for live traffic. Node.js is rejected on purpose: the
free-tier gate inspects the TLS `ClientHello`, and the compiled OpenCode CLI is
built on Bun. `ALLOW_NODE=1` exists only for offline tests with a mocked
upstream.

### Prebuilt archives

Every release ships ready-to-run archives (source plus launch scripts, no build
step) with a matching `.sha256` file:

| Platform | Archive |
| --- | --- |
| Linux x86_64 | `fucking-opencode_v0.1.5_linux_amd64.tar.gz` |
| Linux arm64 | `fucking-opencode_v0.1.5_linux_arm64.tar.gz` |
| macOS Intel | `fucking-opencode_v0.1.5_darwin_amd64.tar.gz` |
| macOS Apple silicon | `fucking-opencode_v0.1.5_darwin_arm64.tar.gz` |
| Windows x86_64 | `fucking-opencode_v0.1.5_windows_amd64.zip` |
| Windows arm64 | `fucking-opencode_v0.1.5_windows_arm64.zip` |

```bash
tar -xzf fucking-opencode_v0.1.5_linux_amd64.tar.gz
cd fucking-opencode-0.1.5
./fucking-opencode          # or: bun server.js
```

On Windows extract the zip and run `fucking-opencode.cmd` (or `bun server.js`).
Bun 1.4+ must be on `PATH`; the launchers fail with an install hint otherwise.
Verify a download first with `sha256sum -c <archive>.sha256` (Linux/macOS) or
`Get-FileHash` (Windows). Each archive contains the matching `warp-farm`
sidecar binary; standalone `warp-farm_<os>_<arch>` files are attached to every
release too.

### Dashboard login

`/` and every admin API are behind a password gate when a panel password is
configured. The password is entered without a username. Panel sessions are
signed cookies valid for 12 hours and survive gateway restarts; changing the
password revokes every session, while `/api/logout` revokes only the current
token (the revocation list is persisted too). On this install both the panel
password and the downstream API key are
**`your-secret`**; change either under **设置 → 访问凭据**. When no panel
password is stored and `PANEL_PASSWORD` is unset, the loopback panel stays open.

The API key gates inference routes (`/v1/chat/completions`, `/v1/messages`,
`/v1/responses`). `/v1/models` stays open so clients can discover model IDs.
`PANEL_PASSWORD` and `FUCKING_OPENCODE_API_KEYS` act as fallbacks when no value is stored
in `settings.json`.

<details>
<summary><b>Features</b></summary>

- `POST /v1/chat/completions` — OpenAI Chat Completions, streaming and
  non-streaming, with `reasoning_content` and tool-call name de-collision.
- `POST /v1/messages` — Anthropic Messages compatibility.
- `POST /v1/responses` — OpenAI Responses wire format, including streamed
  lifecycle events for Codex-style clients.
- Adaptive identity — derives the OpenCode CLI version, session ID recipe,
  User-Agent, gate headers, tool schemas, and inference endpoints from the
  update API, GitHub source, and provider catalog.
- Reactive self-healing — on `403`, `426`, or `404` the gateway refreshes its
  recipe and catalog, evicts stale sessions, escalates the tool profile, and
  retries once. Duplicate retries and GitHub refreshes are suppressed for 30
  seconds after a full-shape refusal.
- Gate-shape audit — an ambiguous `403 FreeTierError` is checked against the
  required anchors (`read`, the CLI User-Agent shape, session headers) before
  it is reported as an egress problem. An explicit IP abuse block is terminal
  and is never retried.
- Egress control — direct, single HTTP/HTTPS proxy, egress relay, or a proxy
  pool with per-entry health, cooldown, and persisted state.
- Usage metering — local JSONL history, six KPI cards, a 24-bucket stacked
  token chart, cached-token tracking, and per-model totals.
- Operations panel — overview, health, egress, pool, usage, history, endpoint,
  API docs, playground, and settings. Chinese, Indonesian, and English.
- Editable credentials — API key and panel password stored in
  `~/.fucking-opencode/settings.json` with mode `0600`.
- Optional self-update from this repository every six hours.

</details>

<details>
<summary><b>Install, service, and Docker</b></summary>

### One-line installer (Linux and macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main/install.sh | bash
```

The installer finds or installs Bun, stages and syntax-checks every file before
touching a running gateway, retires a legacy `fucking-opencode.service`, rewrites
`node` units to `bun`, installs `systemd` or `launchd`, waits for `/health`,
and verifies the TLS baseline before printing success.

```bash
PORT=20134 BINDIR="$HOME/.fucking-opencode" bash install.sh
NO_SERVICE=1 bash install.sh    # install files only
PORT=20140 bash install.sh      # install alongside an existing gateway
```

From a checkout, `bash install.sh` installs the working tree, including
uncommitted files. `SOURCE=remote bash install.sh` forces a download. With `go`
on `PATH`, a checkout install also builds the `warp-farm` sidecar into
`<BINDIR>/warp-farm/warp-farm`; without Go the gateway installs normally and
only WARP farm stays unavailable.

### Docker

```bash
git clone https://github.com/ShinRyu04/Fucking-Opencode.git
cd Fucking-Opencode
docker compose up -d
```

The container publishes `127.0.0.1:20134` on loopback only, runs as the
non-root `bun` user, drops all capabilities, and persists catalog cache and
panel state in named volumes. The base image pins `oven/bun:1.4.3-slim` because
the gate checks the TLS ClientHello.

```bash
docker compose build --pull && docker compose up -d   # upgrade
```

Plain `docker run` works too:

```bash
docker build -t fucking-opencode .
docker run -d --name fucking-opencode \
  -p 127.0.0.1:20134:20134 \
  -e OPENCODE_CACHE_DIR=/data/cache \
  -e FUCKING_OPENCODE_STATE_DIR=/data/state \
  -v fucking-opencode-cache:/data/cache \
  -v fucking-opencode-state:/data/state \
  fucking-opencode
```

</details>

<details>
<summary><b>Configuration (all environment variables)</b></summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `20134` / `127.0.0.1` | Listen address; keep loopback unless fronted by auth |
| `ADMIN_PORT` / `ADMIN_BIND` | `0` / `HOST` | Serve the panel and `/api/*` on a separate port; inference stays on `PORT` |
| `PANEL_PASSWORD` | *(empty)* | Fallback panel password when `settings.json` has none |
| `PANEL_ALLOWED_HOSTS` | *(empty)* | Extra `Host` names accepted by the panel and admin APIs |
| `FUCKING_OPENCODE_API_KEYS` | *(empty)* | Comma-separated fallback API keys; every listed key is accepted |
| `FUCKING_OPENCODE_DEFAULT_MODEL` | *(empty)* | Model used when a chat request omits `model` |
| `FUCKING_OPENCODE_STATE_DIR` | `~/.fucking-opencode` | Settings, proxy, pool health, usage, history |
| `FUCKING_OPENCODE_USAGE_FILE` | `<state>/usage.jsonl` | Override the usage ledger path (absolute or relative to state dir) |
| `FUCKING_OPENCODE_CONFIG` | `<state>/config.json` | Runtime config file, hot-reloaded on change |
| `OPENCODE_CACHE_DIR` | `<state>/cache` | Catalog cache (`off` disables disk caching) |
| `CORS_ORIGIN` | *(empty, localhost)* | Allowed CORS origins, comma-separated or `*` |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream fetch deadline |
| `MAX_BODY_BYTES` | `10485760` | Maximum request body (10 MiB) |
| `IDENTITY_TTL_MS` | `900000` | Identity freshness window (15 minutes) |
| `UPDATE_MODE` | `reactive` | `reactive` adopts releases on `403`/`426`; `always` adopts on TTL expiry |
| `GATE_RETRY_COOLDOWN_MS` | `30000` | Duplicate full-shape retry suppression |
| `GATE_REFRESH_COOLDOWN_MS` | `30000` | Forced GitHub/catalog refresh suppression |
| `DNS_RESULT_ORDER` | `ipv4first` | `ipv4first`, `ipv6first`, or `verbatim` |
| `TOOL_PROFILE_SCOPE` | `core` | `core` sends minimal anchors then escalates; `full` always sends all tools |
| `OPENCODE_CHANNEL` | `latest` | `latest`, `beta`, or `dev` |
| `OPENCODE_MAJOR` | *(unset)* | Pin a CLI major version |
| `OPENCODE_USER_AGENT` | *(derived)* | Override the User-Agent and disable derivation |
| `OPENCODE_CATALOG_URL` | `https://models.opencode.ai/api.json` | Provider catalog |
| `OPENCODE_CHAT_URL` | *(derived)* | Upstream Chat Completions endpoint |
| `OPENCODE_RESPONSES_URL` | *(derived)* | Upstream Responses endpoint |
| `UPSTREAM_RELAY_URL` | *(unset)* | Inference egress relay (`x-relay-target` / `x-relay-path`) |
| `UPSTREAM_PROXY_URL` | *(unset)* | Lock egress to one HTTP/HTTPS proxy |
| `UPSTREAM_PROXY_POOL` | *(unset)* | Lock egress to a pool, comma- or newline-separated |
| `UPSTREAM_PROXY_STRATEGY` | `round-robin` | `round-robin`, `failover`, or `random` |
| `AUTO_UPDATE` | `1` | Check for updates every six hours; skipped inside a git checkout |
| `WARP_MANAGE` | `0` | `1` enables the optional `/api/warp` connect/disconnect controls for a host-installed `warp-cli` |
| `ALLOW_NODE` | *(unset)* | Bypass the Bun guard for offline tests only |
| `FUCKING_OPENCODE_USAGE_MAX_BYTES` | `5242880` | Usage ledger rotation threshold (64 KiB–1 GiB); rotated by halving in place |
| `MAX_INFLIGHT` | `64` | Concurrent inference cap; `0` disables the gate |
| `MAX_INFLIGHT_WAIT_MS` | `30000` | Queue wait before `429 gateway_busy`; `0` fails immediately |
| `METRICS_TOKEN` | *(unset)* | Require `Authorization: Bearer` on `/metrics` |
| `UPSTREAM_EGRESS_RETRIES` | `3` | Exit swaps per request when the upstream answers `429`, an IP-level `403`, or `5xx`; `0` disables. |
| `PANEL_TLS_CERT` / `PANEL_TLS_KEY` | *(unset)* | Serve panel, API, and inference over HTTPS on both listeners when both are set |

Changing a credential or proxy in the panel applies immediately. Other
environment changes require a restart.

`config.json` (path overridable with `FUCKING_OPENCODE_CONFIG`) accepts
`defaultModel` (string), `upstreamTimeoutMs` (1000–600000),
`maxBodyBytes` (1024–104857600), `autoUpdate` (boolean), and `modelGroups`
(alias → ordered model list, max 20). Precedence is environment > file >
built-in default. Edits apply within one second, no restart; invalid values are
rejected and the last valid snapshot stays active. `GET /api/config` returns the
effective values, their source, and the last parse error.

A request for a group alias is sent to the first candidate; a `404`/`410`/
`429`/`5xx` before any response bytes tries the next one. Failed models cool
down in `<state>/model-health.json` (`404` 5 min, `429` 1 min, `5xx` 30 s) and
are skipped by later requests until the cooldown expires.

`GET /api/diagnostics?hours=24` returns per-egress and per-model request
counts, `429`/`5xx` totals, the current success streak, active model
cooldowns, and the last gateway rejection. The panel's Routing Diagnostics
view renders it alongside pool health.

### Cloudflare WARP (optional)

`WARP_MANAGE=1` enables the panel's WARP card and `GET|POST /api/warp`. The
gateway only drives a host-installed `warp-cli` (`connect`, `disconnect`,
`status`); it never downloads binaries or writes credentials. Connecting
changes whole-machine routing, so it is off by default and every action needs
the panel session plus the same admin `Host`/JSON guard as `/api/proxy`.
Without the binary the card reports `available: false`. Containers normally
cannot reach the host's WARP daemon; run the gateway on the host or leave the
feature disabled.

### WARP farm without Docker (Go sidecar)

`warp-farm/` is a small Go program that registers N Cloudflare WARP devices,
runs one userspace WireGuard tunnel per device (UDP packets, no TUN, no
Docker), and exposes one SOCKS5 listener per exit on `127.0.0.1:40001..`.
The gateway spawns it and registers the lanes in the existing proxy pool, so
health checks, cooldowns, and the panel need no special case.

```bash
cd warp-farm && go build -o warp-farm.exe .   # once per machine
WARP_FARM=1 bun server.js                     # gateway starts the sidecar
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `WARP_FARM` | `0` | `1` starts the sidecar at boot and applies it to the pool |
| `WARP_FARM_SIZE` | `8` | Number of exits / SOCKS5 ports |
| `WARP_FARM_BASE_PORT` | `40001` | First SOCKS5 port |
| `WARP_FARM_STACK` | `ipv6` | `ipv6` (unique `/64` egress), `ipv4` (shared NAT), or `dual` |
| `WARP_FARM_SOURCE_IPV6` | — | Optional outer `/64` prefix each exit binds from (Linux needs `IPV6_FREEBIND`) |
| `WARP_FARM_BIN` | `warp-farm/warp-farm[.exe]` | Explicit binary path |
| `WARP_FARM_START_TIMEOUT_MS` | `90000` | How long boot waits for the first ready lane |

`GET|POST /api/warp-farm` reports the process, lanes, egress addresses, dial
counters, saved parameters, and the last log lines. POST actions: `start`
(`size`, `basePort`, `stack`, `sourceIpv6`), `stop`, `rotate` (`port`, omit for
all lanes), `restart`, `applyPool`, and `settings` (persists the same fields to
`<state>/warp-farm.json`, which `start` uses when the env leaves them unset).
All actions use the same admin guard as `/api/proxy`.

When a lane answers `429`/quota or fails at the transport layer, the gateway
asks the farm to retire that exit and swap in a new registration on the same
port (debounced to one rotation per lane per minute). A new registration has a
new WireGuard key and IPv6 egress, so the per-ID quota bucket starts empty.
`-stack ipv6` is the default for that reason; the shared IPv4 WARP address is
almost always already exhausted.

The panel exposes the farm as the **WARP Farm** tab under **Egress**
(start/stop/restart, per-lane rotate and egress test, saved parameters, sidecar
log), with gateway and sidecar tails in the **Log** tab under **Diagnostics**,
the runtime-config editor and identity card under **Settings**, the 24-hour
quota card under **Overview**, and the model-cooldown reset under
**Route diagnostics**. The sidebar itself is six groups — Overview, Egress,
Diagnostics, Usage, Developer, Settings — with the former pages as sub-tabs.

This directory is derived from GPL-3.0 code and is licensed GPL-3.0-or-later
(see `warp-farm/NOTICE.md`). It talks to the gateway only over SOCKS5 and HTTP;
no GPL code is linked into `server.js`.

</details>

<details>
<summary><b>API reference and client examples</b></summary>

### Routes

| Route | Dialect | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat | Streaming folded to JSON for `stream: false` |
| `POST /v1/completions` | OpenAI legacy | Translated to Chat and back to `text_completion`; `prompt` may be 1–8 strings |
| `POST /v1/embeddings` | OpenAI | `501 embeddings_not_supported` (upstream has no embeddings) |
| `POST /v1/messages` | Anthropic | Usage mapping includes cached tokens |
| `POST /v1/responses` | OpenAI Responses | Full streamed lifecycle |
| `GET /v1/models` | OpenAI | Active free models only; remains open |
| `GET /v1/models/{model}` | OpenAI | Single model entry; `404 model_not_found` when retired/unknown |
| `GET /metrics` | Prometheus | `text/plain; version=0.0.4`; optional `METRICS_TOKEN` bearer |
| `GET /openapi.json` | OpenAPI 3.1 | Minimal spec for client generators |
| `GET /health` | — | Identity, gate, egress, and runtime state |
| `POST /api/login` | — | Panel login; throttled after 10 failures per IP in 10 minutes |
| `POST /api/logout` | — | Clears the panel session |
| `GET/POST /api/settings` | — | Read masked credentials; update API key or panel password |
| `GET/POST /api/proxy` | — | Read or update egress; `toggle` enables or disables one pool entry, `coolClear` clears one entry's cooldown (or `"*"` for all) |
| `POST /api/proxy/test` | — | Probe a candidate proxy and report the exit IP; `testId` probes one pool entry by id |
| `GET/POST /api/warp-farm` | — | Go WARP sidecar status; POST `start`, `stop`, `rotate`, `restart`, `applyPool`, `settings` |
| `GET /api/logs` | — | Gateway event ring plus sidecar stdout/stderr tails (`?lines=`) |
| `GET/POST /api/config` | — | Read or rewrite `config.json` (`defaultModel`, timeouts, `modelGroups`, …); invalid values are rejected whole |
| `POST /api/model-health/reset` | — | Clear all model cooldowns |
| `GET /api/quota` | — | 24-hour `429`/failure totals, cooldown count, farm lane readiness |
| `GET /api/stats` | — | Totals, model/provider/client/key breakdowns, 24-bucket series, P50/P95/P99, TTFT average |
| `GET /api/history` | — | Request history with range filters |
| `GET /api/events` | — | Gateway log ring tail from `?after=<sequence>` |
| `GET/POST /api/backup` | — | Export or restore `settings.json`, `proxy.json`, `warp-farm.json`, `model-health.json`, `config.json` (panel session required) |

### Connect anything

The examples use port `20134` (what `start-fucking-opencode.cmd` sets). Substitute your
`PORT` when different.

OpenAI wire format:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20134/v1", api_key="your-secret")
response = client.chat.completions.create(
    model="mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "hello"}],
)
print(response.choices[0].message.content)
```

Anthropic wire format (Claude Code, Aider, and others):

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:20134
export ANTHROPIC_AUTH_TOKEN=your-secret
```

curl:

```sh
curl -s http://127.0.0.1:20134/v1/chat/completions \
  -H 'Authorization: Bearer your-secret' \
  -H 'Content-Type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"ping"}],"stream":true}'
```

When a key exists, copy it from **设置 → Agent 集成** or the **API 文档** page.
Send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.

### LiteLLM

```yaml
model_list:
  - model_name: fucking-opencode-mimo
    litellm_params:
      model: openai/mimo-v2.6-flash-free
      api_base: http://127.0.0.1:20134/v1
      api_key: your-secret
```

### 9Router

Add a custom OpenAI-compatible provider with Base URL
`http://127.0.0.1:20134/v1` and the configured key, then import models from the
`/models` endpoint. Register each gateway host as a separate connection if you
run several machines; per-IP limits then fail over.

</details>

<details>
<summary><b>Models and token budgets</b></summary>

Model IDs change upstream. Never hardcode one in a client; read the live list:

```bash
curl -s http://127.0.0.1:20134/v1/models
```

The gateway exposes only zero-cost, non-deprecated catalog entries
(`cost.input === 0`). The catalog is cached at `<cache>/catalog.json` for cold
starts and offline use.

Family shorthands accepted by the gateway include `mimo`, `beam`, `longcat`,
`big-pickle`, `nemotron-free`, `deepseek-flash`, and `glm-flash`. Retired IDs
(for example `cat-jam-free`, `muse-spark-*`, `step-5-preview-free`) return HTTP
`404` locally. Paid models also return `404` instead of being forwarded.

Reasoning models spend tokens before visible output. `token-budget.js` applies
an additive floor so a small client `max_tokens` does not return empty content:

| Request | Effective upstream budget |
| --- | --- |
| Catalog `reasoning: true`, or a request with `reasoning_effort` | `min(max(requested, 1024) + 4096, modelMaxOutput)` |
| Standard model | `min(max(requested, 512), modelMaxOutput)` |

The client's requested value is never lowered unless it exceeds the model's
catalog output limit.

</details>

<details>
<summary><b>Panel behavior</b></summary>

The panel is a server-rendered shell with a hash router, no CDN, and no build
step. Language options are 中文, ID, and EN; Indonesian is the default.

- **概览 / Ikhtisar** — KPI cards, egress card, gate state, recent requests.
- **健康检查 / Pemeriksaan kesehatan** — live `/health` facts and raw JSON.
  Model count comes from `discoveredModels`; proxy details from `egress.proxy`.
- **出口代理 / Proxy Egress** — set, test, and clear a single proxy.
- **代理池 / Pool Proxy** — pool entries, strategy, readiness, cooldown; each
  entry can be toggled, probed by id, and have its cooldown cleared without
  exposing its URL to the browser.
- **用量统计 / Statistik Pemakaian** — five KPI cards (requests, input, cached,
  output, estimated cost), a Breakdown panel with model/provider/client/key
  tabs, a Traffic chart with requests/tokens/cache tabs, and a request table
  with provider, key label, status, tokens, TPS, TTFT, duration, plus
  P50/P95/P99 latency and average TTFT.
- **请求历史 / Riwayat Permintaan** — paginated request log and filters.
- **事件流 / Aliran Peristiwa** — live tail of the gateway's own log ring
  (`/api/events`), newest last, incremental by sequence number.
- **接入点 / Titik Akses** — base URLs, auth headers, model table.
- **API 文档 / Dokumentasi API** — every real route, OpenAI and Anthropic
  examples, copyable headers.
- **测试台 / Playground** — send a probe request from the browser.
- **设置 / Pengaturan** — access credentials, agent integration, runtime,
  egress, gate, data, and preferences.

### Access credentials

| Value | Used for | Priority |
| --- | --- | --- |
| API key | `Authorization: Bearer` on inference routes | `settings.json` → `FUCKING_OPENCODE_API_KEYS` |
| Panel password | Panel and admin APIs | `settings.json` → `PANEL_PASSWORD` |

Both are stored in `<state dir>/settings.json` with mode `0600`. The panel
returns only a masked preview (`kamu…am`), never the full value. Changing the
panel password clears every existing session and reissues a cookie for the
acting browser.

### Egress proxy and pool

Every outbound request — inference, discovery, identity sync, self-update —
uses the configured egress. HTTP, HTTPS, and SOCKS5 proxies are supported;
SOCKS5 runs through a loopback HTTP CONNECT shim (`socks-bridge.js`) so Bun
still owns TLS. Credentials persist in `<state dir>/proxy.json` (mode `0600`)
and never appear in `/health`, `/api/proxy`, or the panel.

A pool keeps per-entry health with exponential cooldown persisted to
`<state dir>/pool-health.json` (mode `0600`). Records are keyed by a hash of the
egress identity, never the credentials. Strategies: `round-robin`, `failover`,
weighted `random`. `/health` reports each entry's host, state, cooldown, and
failure count.

To add another host to the pool:

```bash
PORT=8888 EGRESS_PROXY_TOKEN=secret bun egress-proxy.js
ssh -L 127.0.0.1:20251:127.0.0.1:8888 node
```

### Usage and history

Requests append to `<state dir>/usage.jsonl`. Each record carries the model,
protocol, stream flag, status, tokens (input, cached, output), duration, the
first-token time for streamed calls (`ttft_ms`), the egress label, plus the
provider, client address, and API-key label (`default` / `none`). Message
content is never stored.

The Usage view aggregates that file: totals, a 24-bucket series with a
per-bucket request count, faceted breakdowns by model, provider, client, and
key, P50/P95/P99 latency over successful requests only, and the average TTFT
over streamed requests. Old records without the newer fields show as unknown
instead of fabricated values. History reads the same file with range filters.

</details>

<details>
<summary><b>Self-healing, gate rules, and errors</b></summary>

```text
Client ──▶ Gateway (:20134, Bun) ──▶ https://opencode.ai/inference/...
                 │
                 ├─ 1. Handshake: opencode.ai/update/api/latest/cli/npm
                 │     → CLI version, minimum floor, GitHub commit SHA
                 ├─ 2. Source parse: raw.githubusercontent.com/anomalyco/opencode/<sha>/...
                 │     → session ID recipe, User-Agent, gate headers, tool schemas
                 ├─ 3. Catalog: models.opencode.ai/api.json (disk cached)
                 │     → endpoints, free models, aliases, reasoning limits
                 └─ 4. On 403 / 426 / 404:
                       refresh recipe and catalog, evict stale session ID,
                       mint a fresh ID, escalate tools, retry once
                       (suppressed for 30 s after a full-shape refusal)
```

- A second `403 FreeTierError` within 30 seconds does not trigger another
  GitHub refresh or full-shape retry, so an IP penalty is not amplified.
- An explicit abuse block (`abusive traffic` / `Detect Abuse Traffic`) is
  terminal. The gateway returns it verbatim with
  `X-OpenCode-Gate: ip-abuse` and performs no refresh or retry.
- A shape bug is reported separately: the outgoing request is audited against
  the gate anchors and the missing anchors are named.
- The upstream `x-opencode-log-id` is recorded and exposed at
  `identity.gate.lastRejection` for support tickets.
- `429 FreeUsageLimitError` can mean the allowance is spent or the request is
  missing the harness `<env>` block. The gateway appends the env block when the
  client does not provide one. `verify.js` stops on the first `429` so the
  cooldown is not extended.

### Live health

```bash
curl -s http://127.0.0.1:20134/health
```

The response reports `status`, `version`, `runtime`, `discoveredModels`,
`identity` (User-Agent, release SHA, headers, endpoints, tools),
`identity.gate` (status, cooldown, last rejection), and `egress` (`direct`,
`proxy`, `pool`, or `relay`).

</details>

<details>
<summary><b>Files</b></summary>

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server, panel routes, gate retry loop, self-updater |
| `panel.js` | Server-rendered panel and login page: style, views, i18n |
| `panel-settings.js` | Stored API key and panel password, mode `0600` |
| `identity.js` | CLI handshake, source parsing, catalog cache, session IDs |
| `token-budget.js` | Reasoning-aware token budget |
| `proxy.js` | Single proxy, proxy pool, health, cooldowns |
| `egress-proxy.js` | Dependency-free HTTP proxy for pool members |
| `stats.js` | Usage JSONL, totals, 24-bucket series |
| `compat.js` | Anthropic and Responses translation |
| `transport-fingerprint.js` | TLS ClientHello check against the baseline |
| `verify.js` | Live model readiness check |
| `gate-drill.js` | Live and offline self-healing drills |
| `install.sh` | Cross-platform installer and service migration |
| `tunnel-doctor.sh` | Reverse-tunnel stale-listener diagnosis |
| `start-fucking-opencode.cmd` | Windows launcher on port `20134` |
| `Dockerfile` / `docker-compose.yaml` | Container deployment |
| `test/` | Offline unit, contract, and regression tests |

</details>

<details>
<summary><b>Testing and verification</b></summary>

```bash
bun test test/*.test.js          # offline unit, contract, and regression tests
bun verify.js                    # live: probe every discovered free model
bun verify.js --quick            # live: stop at the first model that answers
bun gate-drill.js                # live + offline self-healing drills
bun transport-fingerprint.js --check
bash -n install.sh && bash -n tunnel-doctor.sh
```

`verify.js` exits `0` when a model answers, `2` when the gateway is healthy but
upstream refuses this egress IP, and `1` for a real failure (gateway unreachable,
Node runtime, or TLS drift). A `403` or the first `429` stops the sweep so the
IP cooldown is not extended.

`gate-drill.js` corrupts gateway state and verifies recovery: version floor,
empty tools, session shape, endpoint migration, retry routing, and a
multi-layer corruption. Live drills skip when the control probe is throttled;
offline drills still determine the exit code.

On Windows, POSIX permission tests (`0600`), the installer CRLF checks, and the
Node-runtime guard test are expected to fail. Those are platform limitations,
not gateway failures.

</details>

<details>
<summary><b>Implementation notes</b></summary>

1. **Panel credentials beat environment.** `panel-settings.js` reads and writes
   `<state dir>/settings.json`; `PANEL_PASSWORD` and `FUCKING_OPENCODE_API_KEYS` are
   fallbacks only. File: `panel-settings.js`.
2. **Session rotation.** Changing the panel password clears the in-memory
   session map and reissues a cookie for the acting admin. Sessions last 12
   hours and use an HTTP-only, `SameSite=Strict` cookie. File: `server.js`.
3. **Chart math.** Each bucket splits usage into `input - cached`, `cached`, and
   `output`, so cached tokens are shown but never double-counted. File:
   `stats.js`.
4. **Cached token plumbing.** Chat streams, non-streaming responses, and
   compatibility routes all record `prompt_tokens_details.cached_tokens`. Files:
   `server.js`, `compat.js`, `stats.js`.
5. **Panel token handling.** Every dynamic string is inserted with
   `textContent`; server-rendered values pass through `escapeHtml`. File:
   `panel.js`.
6. **Admin guard.** `/api/settings`, `/api/proxy`, `/api/stats`, and
   `/api/history` require a session when a password exists, accept JSON writes
   only, reject cross-site requests, and validate `Host`. File: `server.js`.
7. **Update channel.** The six-hour updater reads from
   `raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main` and stages new
   modules before swapping. File: `server.js`.
8. **Windows launcher.** `start-fucking-opencode.cmd` sets `PORT=20134`, binds loopback,
   loads the password from an untracked `panel-password.txt`, and logs to
   `fucking-opencode-log.txt` / `fucking-opencode-err.txt`.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

### `node server.js` exits immediately

The runtime guard refuses Node.js. Start with `bun server.js`. Use
`ALLOW_NODE=1` only for offline tests with a mocked upstream.

### `403` with "detected abusive traffic"

The gateway flagged the egress IP. The gateway does not retry and returns
`X-OpenCode-Gate: ip-abuse`. `/health` reports
`identity.gate.status: "ip-blocked"`. Only upstream can clear the flag
(`help@anoma.ly`, include the time and `x-opencode-log-id`). Change egress
(proxy, pool, SSH tunnel) or wait.

### `403 FreeTierError` after the automatic retry

The egress IP is in a temporary free-tier cooldown. The gateway suppresses
duplicate retries for 30 seconds. The official CLI gets the same answer from the
same IP. Use another egress or wait.

### `429 RateLimitError` / `FreeUsageLimitError`

Either the per-IP or per-model allowance is spent, or the request is missing the
harness `<env>` block. The gateway appends the block automatically. If the CLI
answers while the gateway refuses in the same minute, upgrade the gateway.

### `404 Model '<id>' has been retired upstream`

The model is deprecated or paid. Read `/v1/models` and switch.

### The panel asks for a password I do not know

The value is in `<state dir>/settings.json` or in `PANEL_PASSWORD`. If both are
empty, the panel is open. On this install the value is `your-secret`. Clear or
rotate it under **设置 → 访问凭据**.

### A client gets `401` after changing the API key

Clients must use the new key immediately. Clearing the key disables the gate and
accepts any non-empty bearer token. `/v1/models` remains open.

### `bun: command not found` in a fresh SSH session

The installer edits only an interactive shell's `PATH`. Use
`~/.bun/bin/bun` explicitly or:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

The service unit records the absolute path, so the running gateway is unaffected.

### Proxy set in the panel but `/health` shows direct

Read `egress.proxy.source`. `env` means `UPSTREAM_PROXY_URL` owns the setting
and locks the panel; edit the service unit and restart. `file` means the panel
value is active. `none` means no proxy is configured.

### SOCKS5 proxy fails

`socks5://` and `socks5h://` are accepted; the gateway starts a loopback HTTP
CONNECT shim per unique URL. Check the panel's Routing Diagnostics and the
`/health` egress mode. Authentication is none or username/password. If the
shim reports `SOCKS5 连接失败`, the SOCKS server refused the target; test it
with `curl --socks5 host:port https://www.cloudflare.com/cdn-cgi/trace`.

### Reverse tunnel drops after a reboot

```bash
./tunnel-doctor.sh          # report
./tunnel-doctor.sh --reap   # kill sessions with no transport
./tunnel-doctor.sh --check  # audit the keepalive window
```

On the receiving host, shorten the detection window with a drop-in that sorts
first:

```ini
# /etc/ssh/sshd_config.d/00-keepalive.conf
ClientAliveInterval 30
ClientAliveCountMax 4
```

### Service logs

```bash
journalctl --user -u fucking-opencode -n 50 --no-pager
journalctl -u fucking-opencode -n 50 --no-pager
tail -50 ~/Library/Logs/fucking-opencode.log
```

On Windows, `start-fucking-opencode.cmd` writes `fucking-opencode-log.txt` and `fucking-opencode-err.txt`
next to the script.

</details>

<details>
<summary><b>Security</b></summary>

- Keep the gateway on loopback. It is designed for a local machine or a private
  network behind an authenticated reverse proxy.
- The panel is an admin surface. Do not expose it publicly without TLS and an
  additional access layer.
- `settings.json`, `proxy.json`, and `pool-health.json` are mode `0600`. Treat
  them as secrets.
- The gateway does not store message content. Usage records contain model,
  status, latency, and token counts only.
- No full secret is returned to the browser; the settings API returns a masked
  preview.

</details>

## License

MIT — see [LICENSE](LICENSE).
