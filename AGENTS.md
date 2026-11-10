# AGENTS.md：`fucking-opencode` 的 AI 代理操作手册

本文件为 AI 编码代理（OpenCode、Claude Code、Cursor、Codex、Cline、Aider 等）提供安装、运行、连接、排查和修改 `fucking-opencode` 的精确说明。

---

## 1. 关键规则（先读）

1. **运行时必须是 Bun（`bun server.js`）。**
   - **不要**在 Node.js 下运行生产服务器（`node server.js` 会故意以退出码 `1` 结束）。
   - 原因：官方 OpenCode CLI 使用 Bun（BoringSSL）编译。上游的免费层网关会检查 TLS `ClientHello` 指纹（17 个加密套件、12 个扩展）。Node.js（OpenSSL）提供 52 个加密套件，会被以 `403 FreeTierError` 拒绝。
   - `ALLOW_NODE=1` 仅用于使用模拟 `fetch` 的离线单元测试，绝不用于真实流量。
2. **零外部依赖。**
   - 不要运行 `npm install`，也不要向 `package.json` 添加包。网关只使用运行时内置模块。
3. **绝不硬编码模型 ID 或别名。**
   - 上游的模型可用性变化频繁。始终查询 `GET http://127.0.0.1:20134/v1/models` 以查看当前可用的免费模型。
   - 已退役的模型（例如 `cat-jam-free`、`muse-spark-1.3-contributor-free`、`muse-spark-1.2-contributor-free`、`step-5-preview-free`）按设计返回 HTTP `404`。
4. **上游推理要求 `stream: true`。**
   - 上游会以 `403 FreeTierError` 拒绝非流式推理请求。`server.js` 始终向上游发送 `stream: true`，并在客户端请求 `stream: false` 时把 SSE 折叠回 JSON。任何直接诊断探测（`verify.js`、`gate-drill.js`）都必须保持 `stream: true`。

---

## 2. 为用户安装并启动网关

### 方案 A：标准系统安装（推荐用于常驻后台服务）

运行安装脚本。它会查找或安装 `bun`（在精简 Linux 上如有需要先安装 `unzip`），在改动正在运行的服务之前先暂存并校验文件，移除旧的 `fucking-opencode.service` 单元，把文件放到 `~/.fucking-opencode`，把任何 `node` 服务单元迁移到 `bun`，启动 `fucking-opencode` 服务（Linux 上用 `systemd`，macOS 上用 `launchd`），并校验 `/health` 和 TLS 基线：

```bash
curl -fsSL https://raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main/install.sh | bash
```

如果你已经位于本仓库的本地克隆中，请运行：

```bash
bash install.sh
```

这样安装的是**工作树**，而不是 GitHub，因此未推送的提交也能安装并测试。`SOURCE=remote bash install.sh` 强制走下载路径；`SOURCE=local` 则拒绝回退到该路径。

自定义端口或安装目录：

```bash
PORT=20134 HOST=127.0.0.1 BINDIR="$HOME/.fucking-opencode" bash install.sh
```

### 方案 B：直接从本仓库运行（前台或自定义进程管理器）

```bash
# Ensure bun is on PATH (check ~/.bun/bin/bun or ~/.local/bin/bun if not in default PATH)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun server.js
```

### 方案 C：容器部署（Docker / Docker Compose）

```bash
docker compose up -d          # builds the image and starts the gateway
docker compose build --pull && docker compose up -d   # upgrade
```

compose 文件仅在回环地址上发布 `127.0.0.1:20134`，把目录缓存持久化到 `gateway-cache` 卷，并以非 root 的 `bun` 用户运行镜像。基础镜像固定为 `oven/bun:1.4.3-slim`，因为免费层网关会检查 TLS ClientHello —— 可在镜像内用 `docker compose exec gateway bun transport-fingerprint.js --check` 验证。

`AUTO_UPDATE` 在 compose 文件中为 `0`：镜像就是部署单元，因此就地自更新会被下一次构建还原。

### 验证服务器是否健康

```bash
# 1. Check health and derived OpenCode CLI identity
curl -s http://127.0.0.1:20134/health

# 2. List currently active free models
curl -s http://127.0.0.1:20134/v1/models

# 3. Verify Bun TLS ClientHello matches the OpenCode CLI baseline
bun transport-fingerprint.js --check

# 4. Run the quick readiness check (exits 0 if a model answers, 2 if IP quota is throttled, 1 if broken)
bun verify.js --quick

# 5. Send a test chat completion request
curl -s http://127.0.0.1:20134/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Reply with OK"}]}'
```

---

## 3. 连接客户端与网关

在任何兼容 OpenAI 的工具中使用以下连接信息：

- **基础 URL：** `http://127.0.0.1:20134/v1`
- **API 密钥：** `public`（或任意非空字符串）
- **聊天补全端点：** `POST http://127.0.0.1:20134/v1/chat/completions`
- **模型端点：** `GET http://127.0.0.1:20134/v1/models`

### 面板登录（可选）

设置 `PANEL_PASSWORD`（或将其放入 `start-fucking-opencode.cmd` 旁边的 `panel-password.txt`，该文件被 git 忽略并由启动器读取），以要求先建立会话，`/` 才会提供面板。设置后，没有 `ofb_panel` cookie 时，`/api/proxy*` 和 `/api/stats|history*` 会返回 `401`；`/health` 和 `/v1/*` 保持开放。会话在内存中保留 12 小时（`PANEL_SESSION_TTL_MS`），登录尝试在每 IP 10 分钟内失败 10 次后会被限流。面板语言默认为 `id`，可在顶栏切换为中文或 EN。

### 出口代理（面板）

`GET http://127.0.0.1:20134/` 提供 HTML 面板：输入 `http://[user:pass@]host:port`，按 *Simpan dan pakai*，之后所有出站请求（推理、模型发现、身份同步、自更新）都会经该代理隧道传输。*Uji koneksi* 会通过候选代理探测模型端点并报告出口 IP；*Matikan proxy* 返回直连出口。无需重启。

- 仅支持 HTTP/HTTPS。SOCKS5 会被拒绝（Bun：`UnsupportedProxyProtocol`）。TLS 仍由 Bun 提供，因此 `transport-baseline.json` 保持有效。
- 凭据持久化在 `~/.fucking-opencode/proxy.json`（权限 `0600`），面板、`/api/proxy` 或 `/health` 永远不会返回它们。
- API：`GET /api/proxy`（状态）、`POST /api/proxy` `{"url":"…"}`（设置；`""` 清除）、
  `POST /api/proxy/test` `{"url":"…"}`（探测）。运维覆盖项：`UPSTREAM_PROXY_URL`，它会
  锁定面板。
- 面板和 `/api/proxy` 属于管理面：写入必须为
  `Content-Type: application/json`，跨站请求会被拒绝，且 `Host` 必须是回环地址、
  绑定地址，或列在 `PANEL_ALLOWED_HOSTS` 中。改动该路由时请保留这些检查。
- `/health` → `egress.mode`（`proxy` / `relay` / `direct`）和 `egress.proxy`（仅 host:port）。

### 当前可用的免费模型（也支持家族简写）

始终通过 `GET /v1/models` 核实。截至目录同步 `v2.0.0`：
- `mimo-v2.6-flash-free`（简写：`mimo`）
- `big-pickle`（简写：`big-pickle`）
- `beam-free`（简写：`beam`）
- `nemotron-3-ultra-free`（简写：`nemotron-free`）
- `nemotron-3.5-lightning-free`
- `nemotron-3.5-super-vl-free`
- `longcat-2.5-preview-free`（简写：`longcat`）
- `deepseek-v4.1-flash-free`（简写：`deepseek-flash`）
- `glm-5.3-flash-free`（简写：`glm-flash`）
- `space-bunny-free`

### 多主机 / VPS SSH 隧道设置（用于绕过单 IP 速率限制）

如果用户有另一台机器或 VPS 在端口 `20134` 上运行 `fucking-opencode`，请通过 SSH 转发本地端口，并在其路由器（例如 9Router 或 LiteLLM）中注册这两个端口：

```bash
ssh -N -L 127.0.0.1:20130:127.0.0.1:20134 user@remote-vps
```

对于**反向**隧道（`-R`，发送方主机主动拨号到运行路由器的主机），请将其作为 systemd 单元运行以便重启后仍存活，并让 `-i` 指向该主机上确实存在的密钥：

```ini
[Service]
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -i /root/.ssh/id_vps_master -p 48222 \
  -R 127.0.0.1:20136:127.0.0.1:20134 root@router-host
Restart=always
RestartSec=5
```

#### 非正常断开后的陈旧转发

反向隧道由**接收**端主机上的 `sshd-session` 保持打开。当发送方主机重启或断电时，TCP 连接会在没有 FIN 的情况下断开，接收端 sshd 会一直保留监听套接字，直到它察觉为止。此时替换隧道会失败并报：

```
Error: remote port forwarding failed for listen port 20136
```

默认的 `ClientAliveInterval 300` × `ClientAliveCountMax 2` 会把该窗口留到**十分钟**。有两种修复方式，两者都值得采用：

1. **收紧保活设置**（在接收端主机上）。OpenSSH 使用它读到的**第一个**值，因此插入式配置片段必须排在所有现有文件*之前*：

   ```bash
   # /etc/ssh/sshd_config.d/00-keepalive.conf   (note the 00- prefix)
   ClientAliveInterval 30
   ClientAliveCountMax 4      # dead peer detected after 120s
   ```

   用 `sshd -T | grep -i clientalive` 验证，然后执行 `systemctl reload ssh`。

2. **回收陈旧会话**（当它已经发生时）。`tunnel-doctor.sh`（随本仓库提供）通过检查持有监听器的 sshd 会话是否仍有已建立的传输，来区分*活动*转发和陈旧转发 —— 仅有监听器本身不能证明任何事：

   ```bash
   ./tunnel-doctor.sh                 # report
   ./tunnel-doctor.sh --reap          # kill sessions with no transport
   ./tunnel-doctor.sh --check         # audit the keepalive window
   ```

---

## 4. 代理故障排查指南

当用户报告错误时，请先使用此决策表进行诊断，然后再更改任何代码或配置：

| 症状 | 根本原因 | 应采取的操作 |
|---|---|---|
| `node server.js` 退出并显示 `fucking-opencode requires Bun` | 服务器是用 Node.js 而不是 Bun 启动的 | 用 `bun server.js` 启动（或运行 `bash install.sh` 把 systemd/launchd 服务单元改写为使用 `bun`）。 |
| `HTTP 403`，消息中包含 `abusive traffic`、`Detect Abuse Traffic` 或 `Abuse of traffic`（响应头 `X-OpenCode-Gate: ip-abuse`；`/health` -> `identity.gate.status: "ip-blocked"`） | 网关标记了该出口 IP。这与账号和请求形态无关，因此任何身份变更都无法清除它。 | **不要**重装、修改请求头或重试。网关已经跳过刷新/重试并原样返回拒绝信息。请从同一网络用官方 CLI 确认；只有上游才能清除它（`help@anoma.ly`，引用 `x-opencode-log-id`）。更换出口（SSH 隧道/中继）或等待。 |
| `HTTP 403 FreeTierError` 在日志显示 `refreshing identity and retrying once with full tool set` 或 `skipping retry because a full-shape retry already failed <30s ago` **之后**返回给客户端（且 `verify.js` 以 `2` 退出并显示 `GATE`） | **两个不同原因，一条无法区分的上游消息。** 阅读日志尾部：它现在以 *“the request carried every anchor the gate checks, so this is the egress”* 或 *“this gateway produced a shape the gate refuses — missing …”* 结尾。后者是网关缺陷，不是配额问题。 | **先读日志行中的结论。** 如果它说形态完整，则出口被拒绝：不要修改请求头或代码，运行 `bun gate-drill.js` 并检查 `upstream control`（`HTTP 403 -> gate CLOSED` 表示该 IP 被拒绝；官方 `opencode` CLI 从该 IP 也同样失败）。如果它指出缺少锚点，则派生的配方/工具配置丢失了一个 —— 检查 `/health` → `identity.gate.anchors` 和 `identity.gate.lastRejection`。网关会抑制重复的 403 重试和强制 GitHub 刷新 30 秒（`GATE_RETRY_COOLDOWN_MS`、`GATE_REFRESH_COOLDOWN_MS`），以免延长 IP 惩罚。 |
| `verify.js` 以 `1` 退出并显示 `TLS fingerprint drift detected` 或 `Server is running on Node.js` | 运行时的 TLS `ClientHello` 与 `transport-baseline.json` 不匹配 | 运行 `bun transport-fingerprint.js --check` 检查加密套件/扩展差异，并确保服务运行在当前的 Bun 1.4+ 二进制上。 |
| 在全新 SSH 会话中出现 `bun: command not found`，但服务运行正常 | `bun.sh/install` 只修改交互式 shell 的 PATH | 使用绝对路径（`~/.bun/bin/bun`）或导出 `PATH="$HOME/.bun/bin:$PATH"`。不要重装。 |
| `verify.js` 中出现 `HTTP 429` 或 `BUSY` | **两个原因，一条消息。** 要么模型/IP 容量耗尽，要么请求的系统提示缺少客户端框架的 `<env>` 块（`<env>` + 一行 `Working directory:`）—— 网关对两者都返回 `429 FreeUsageLimitError`。实测：65 字节的 env 块可以通过，而 12 KB 的通用提示会失败，`tools: []` 也会失败。 | 如果网关版本早于 `<env>` 修复，请先升级。否则从 `GET /v1/models` 切换模型 ID，或等待额度窗口。通过在同一分钟内交错执行 `opencode run -m opencode/<model>` 和对网关的 `curl` 来确认：两者都被拒绝说明是容量问题；CLI 能应答而网关拒绝说明是形态缺陷。`verify.js` 现在会在第一个 `429` 处停止扫描（在 2026-10-25 之前它会扫描全部 11 个模型，从而延长惩罚）。 |
| `HTTP 404 Model '<id>' has been retired upstream` | 客户端请求了已弃用的模型（例如 `cat-jam-free`、`muse-spark-*`、`step-5-preview-free`） | 获取 `GET /v1/models` 并更新客户端配置以使用可用的模型 ID。 |
| `HTTP 404 Model '<id>' is not on the free tier` | 客户端请求了付费模型（例如 `gpt-5.4`、`claude-sonnet-4-5`） | 网关只提供零成本模型（`cost.input === 0`）。从 `GET /v1/models` 中选择模型。 |
| 在 `install.sh` 期间发生端口冲突（`port 20134 is occupied by another process`） | 另一个非网关进程正在监听端口 20134 | 停止冲突进程，或安装到其他端口（`PORT=20130 bash install.sh`）。旧的 `fucking-opencode.service` 和网关自身的进程会被自动移除/替换。 |
| 面板中已设置代理，但 `/health` 仍显示 `egress.mode: "direct"` | 该设置按请求读取；面板被锁定（`locked: true`）表示环境中的 `UPSTREAM_PROXY_URL` 拥有它 | 读取 `egress.proxy.source`（`file` / `env` / `none`）和 `egress.proxy.error`。要更改被环境锁定的代理，请编辑服务单元并重启。 |
| *Uji koneksi* 报告代理返回 `403` | 代理隧道工作正常，但上游拒绝该出口 IP | 换一个代理；被拒绝的是 IP，不是请求形态。切换后运行 `bun verify.js --quick` 确认。 |
| 面板拒绝 `socks5://…` | Bun fetch 仅支持 HTTP/HTTPS 代理，对 SOCKS 会抛出 `UnsupportedProxyProtocol` | 使用 `http://host:port`（Clash/v2ray 会暴露一个混合 HTTP 端口），或在本地 HTTP 代理中终止 SOCKS。 |

---

## 5. 仓库架构与代码库指南（面向贡献者）

| 文件 | 职责 |
|---|---|
| `server.js` | HTTP 服务器（`/` 处的面板、`/v1/chat/completions`、`/v1/models`、`/health`、带 `adminRequestError` CSRF/Host 防护的 `/api/proxy`）、Bun 运行时守卫、对 `proxy.js`/`panel.js` 的容错加载以及 `repairMissingModules()`，使半安装的树也能启动并自愈、可配置的 DNS 结果顺序（`DNS_RESULT_ORDER`）、会话亲和性缓存、客户端工具别名（`read` -> `read_client`）、SSE 流规范化（`reasoning_content`、`usage`、`finish_reason`）、带 30 秒 IP 冷却重试抑制（`GATE_RETRY_COOLDOWN_MS`）的 403/426/404 响应式重试循环、终止性 IP 滥用分支（`X-OpenCode-Gate: ip-abuse`，不刷新/重试）、出口代理（推理、发现和自更新时使用 `proxy.netFetch`）以及可选的 `UPSTREAM_RELAY_URL` 中继（`x-relay-target` / `x-relay-path`），还有 6 小时自更新器（`checkAndApplyUpdate`），它会暂存传入的 `server.js` 所需的任何模块，即使正在运行的 `UPDATE_FILES` 列表早于该模块。 |
| `identity.js` | 自适应 OpenCode CLI 同步：发布握手（`opencode.ai/update/api`）、GitHub 源码获取器（`identifier.ts`、`session-id.ts`、`app.ts`、`model-request.ts`、`tool/plugin/*.ts`、`codemode/tool.ts`）、Effect Schema AST 解析器（`extractToolFromSource`）、提供方目录解析器与磁盘缓存（`~/.fucking-opencode/cache/catalog.json`）、30 秒强制刷新冷却（`GATE_REFRESH_COOLDOWN_MS`）、终止性 `isIpAbuseRejection` 守卫，以及池化 CSPRNG 会话 ID 生成器（`createSessionId`）。 |
| `token-budget.js` | 加法式 token 预算计算（推理模型为 `max(requested, 1024) + 4096`，标准模型为 `max(requested, 512)`），由目录 `modelFacts` 驱动。 |
| `proxy.js` | 出口：URL 校验（仅 HTTP/HTTPS，凭据需百分号编码）、在 `<state dir>/proxy.json`（权限 `0600`）中为单个代理和代理池持久化、带面板锁定的 `UPSTREAM_PROXY_URL`/`UPSTREAM_PROXY_POOL` 覆盖、按条目健康检查与指数冷却（`markFailure`/`markSuccess`/`pick`），持久化在 `<state dir>/pool-health.json`（权限 `0600`，以出口身份的截断 SHA-256 为键，因此绝不会重复代理凭据，通过重命名写入，拒绝立即生效 / 成功合并写入）、`withProxy`/`netFetch`（显式出口参数）供 `server.js` 和 `identity.js` 中的每次出站调用使用，以及 `testProxy`/`testPool`（上游探测 + `cdn-cgi/trace` 出口 IP）。 |
| `egress-proxy.js` | 无依赖的 HTTP 代理，用于把主机变成代理池成员：CONNECT 加绝对 URI HTTP、可选的 `EGRESS_PROXY_TOKEN`（Basic，仅密码）、未认证的 `/healthz`。默认绑定回环地址；可达性由隧道负责。 |
| `panel.js` | 在 `/` 提供的 HTML 面板：同源表单，读写 `/api/proxy`，在不暴露凭据的情况下显示实时状态，并对每个配置值进行转义。 |
| `transport-fingerprint.js` | 针对本地 TCP 监听器捕获运行时的原始 TLS `ClientHello` 字节，并将加密套件和扩展顺序与 `transport-baseline.json` 比较。 |
| `gate-drill.js` | 端到端自愈演练套件（4 个在线演练 + 6 个确定性离线演练，包括 `full-corrupt`）。 |
| `verify.js` | 在线模型就绪检查器（`bun verify.js` / `bun verify.js --quick`）；发送 `stream: true`，并在 `gate-closed`（`403` 且带 `X-OpenCode-Gate: ip-throttled` 或 `ip-abuse`，或免费层/滥用消息）**以及第一个 `429` 额度**处立即停止 —— 两者都意味着必须停止扫描，以免延长 IP 冷却。 |
| `install.sh` | 跨平台安装器，以及面向 Linux（`systemd`）和 macOS（`launchd`）的 `node` -> `bun` 服务单元迁移器。 |
| `Dockerfile` | 网关的容器镜像：固定 `oven/bun:1.4.3-slim` 基础镜像（固定 Bun 版本是因为免费层网关会检查 TLS ClientHello）、非 root 的 `bun` 用户、可写的 `/app` 以便就地自更新器暂存临时文件、用于目录缓存的 `OPENCODE_CACHE_DIR=/data/cache`，以及用于面板代理设置的 `FUCKING_OPENCODE_STATE_DIR=/data/state`。 |
| `docker-compose.yaml` | 单服务容器部署：重启策略、仅回环端口发布（`127.0.0.1:20134:20134` —— 网关没有认证）、持久的 `gateway-cache` 和 `gateway-state` 卷、`no-new-privileges` + `cap_drop: [ALL]`、健康检查，以及 `AUTO_UPDATE=0`（镜像就是部署单元）。 |
| `.dockerignore` | 将 `.git`、`.github` 和 `test/` 排除在构建上下文之外：镜像内的 `.git` 目录会破坏自更新器的 `git-checkout` 守卫，而已发布的镜像不应携带它。 |

### 提交更改前的强制验证

本仓库中的任何代码更改都必须通过全部三项检查：

```bash
bun test test/*.test.js
bun transport-fingerprint.js --check
bun gate-drill.js
```
