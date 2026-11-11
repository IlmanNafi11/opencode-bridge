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

这样安装的是**工作树**，而不是 GitHub，因此未推送的提交也能安装并测试。`SOURCE=remote bash install.sh` 强制走下载路径；`SOURCE=local` 则拒绝回退到该路径。安装器现在也会复制 `warp-farm.js`；当 `go` 在 PATH 且来源是本地克隆时，它会 `go build` sidecar 二进制到 `<BINDIR>/warp-farm/warp-farm`（Go 是可选依赖，缺失时只跳过 WARP farm）。

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

### 管理端口（可选）

设 `ADMIN_PORT`（且不同于 `PORT`）后，面板与 `/api/*` 只在管理端口提供，监听地址由 `ADMIN_BIND`（默认 `HOST`）决定。API 端口访问 `/` 会 302 到管理端口，访问其他面板路由返回 `404 admin_port_only`；管理端口拒绝 `/v1/*` 推理（`404 api_port_only`），但保留 `/health` 与 `/v1/models`。不设或设为 `0` 时行为不变。两个网关共用状态目录时，可用 `FUCKING_OPENCODE_USAGE_FILE` 把 `usage.jsonl` 指向不同文件。

### 运行时配置（config.json）

`<状态目录>/config.json`（可用 `FUCKING_OPENCODE_CONFIG` 改路径）支持 `defaultModel`（字符串）、`upstreamTimeoutMs`（1000–600000）、`maxBodyBytes`（1024–104857600）、`autoUpdate`（布尔）、`modelGroups`（别名 → 有序模型数组，最多 20 个）。优先级为环境变量 > 文件 > 内置默认值。改文件后约一秒内生效，无需重启；非法值被拒绝，上一份有效配置继续服务。`GET /api/config`（需面板会话）返回生效值、来源与最近的解析错误。

面板新增菜单与端点：`GET /api/logs`（事件环 + sidecar 日志尾）、`POST /api/config`（写 `config.json`，非法值整体拒绝）、`POST /api/model-health/reset`（清空模型冷却）、`GET /api/quota`（24 小时 429/失败计数、冷却数、farm lane 就绪数）。`/api/settings` 的响应带 `projectMode`（`OPENCODE_PROJECT_MODE`）。

侧栏固定为 6 个分组（概览 / 出口 / 诊断 / 用量 / 接入 / 设置），组内旧页面变成子标签；`VIEW_GROUPS` 与 `GROUP_OF` 在 `panel.js` 的 `SCRIPT` 顶部定义，`go(view)` 接受视图名或分组名，`#warpfarm`、`#pool` 等旧深链仍然有效。新增界面文案必须同时补 `I18N.patch.id` 与 `I18N.patch.en`；带数字或运行时值的句子用 `translatePattern` 规则，不要用 `tr()` 拼整句（切语言时无法还原）。

`OPENCODE_PROJECT_MODE` 控制 `x-opencode-project` 来源：默认 `random` 逐请求铸造新的 sha1 形状 id（免费档按项目 id 记账，换 id 即换额度桶），`derived` 恢复从本 checkout 推导的 CLI 忠实值。客户端自带该头始终优先；5xx 与 gate 重试还会额外换新项目 id。

### WARP farm（可选，无 Docker）

`WARP_FARM=1` 时 `server.js` 启动 `warp-farm/warp-farm[.exe]`（Go，需先 `cd warp-farm && go build -o warp-farm.exe .`），把每个 lane 的 `socks5://127.0.0.1:40001..` 注册进现有代理池。`WARP_FARM_SIZE`（默认 8）、`WARP_FARM_STACK`（默认 `ipv6`，唯一 `/64` 出口；`ipv4` 是共享 NAT）、`WARP_FARM_SOURCE_IPV6`（可选外层前缀）。lane 遇 `429`/额度或传输失败时网关自动让 farm 换注册（同端口，60 秒去抖）。`GET /api/warp-farm` 查看；POST `start|stop|rotate|restart|applyPool|settings` 管理，`settings` 把 `size/basePort/stack/sourceIpv6/watchdog` 持久化到 `<状态目录>/warp-farm.json`，启动参数缺省时优先用它（显式环境变量仍生效）。Go 目录是独立 GPL-3.0 程序，不链接进 `server.js`。

新增运维环境变量：`FUCKING_OPENCODE_USAGE_MAX_BYTES`（用量账本轮转阈值，64 KiB–1 GiB，默认 5 MiB，按折半就地轮转）、`MAX_INFLIGHT`（默认 64，`0` 关闭并发闸门）与 `MAX_INFLIGHT_WAIT_MS`（默认 30000，`0` 立即 429 `gateway_busy`）、`METRICS_TOKEN`（`/metrics` 的 Bearer 口令；不设则开放，面板应只绑回环）、`PANEL_TLS_CERT` + `PANEL_TLS_KEY`（同时设置时两个监听器都改 HTTPS）、`UPSTREAM_EGRESS_RETRIES`（单请求内因 429 / IP 级 403 / 5xx 换出口的次数，默认 3，`0` 关闭）、`FIRST_EVENT_TIMEOUT_MS`（上游已接单但迟迟不吐第一个 SSE 事件的判定，默认 15000，`0` 关闭；超时会冷却出口、换出口并继续下一个模型组候选，全部失败回 `504 first_event_timeout`）、`ANON_BACKOFF_THRESHOLD` / `ANON_BACKOFF_BASE_HOURS` / `ANON_BACKOFF_MAX_HOURS`（匿名 lane 连续失败后的全局暂停，默认阈值 `0` 即关闭）、`REASONING_EFFORT` 与 `REASONING_EFFORT_BY_MODEL`（JSON 映射；客户端未显式给 `reasoning_effort` 时才注入）。每 key 的 `rpm`/`daily`/`models` 限额保存在 `settings.json`，面板「限额」按钮编辑；计数在内存中，重启归零。

面板会话现在是**无状态签名 cookie**：`<状态目录>/panel-session-secret`（`0600`，首次登录生成）与当前密码派生 HMAC 密钥，令牌有效 12 小时并跨重启保留；`/api/logout` 只吊销当前令牌（记入同样持久化的 `panel-revocations.json`，写入时清理过期项），改密码会轮换 secret 使所有旧会话立即失效。

模型组别名先走第一个候选；在未向客户端写出任何字节前遇到 `404`/`410`/`429`/`5xx` 就切下一个。失败模型记入 `<状态目录>/model-health.json` 冷却（`404` 5 分钟、`429` 1 分钟、`5xx` 30 秒），后续请求跳过直到冷却结束。可用 `FUCKING_OPENCODE_MODEL_GROUPS`（JSON）临时覆盖组定义，优先级高于文件。

### WARP 管理（可选）

`WARP_MANAGE=1` 才启用面板的 WARP 卡片与 `GET|POST /api/warp`。网关只驱动
宿主机已安装的 `warp-cli`（`connect`/`disconnect`/`status`），不下载二进制、
不写凭据。连接会改变整机路由，因此默认关闭；动作同样经过面板会话、
`Host` 与 JSON Content-Type 门禁。没有该二进制时接口返回 `available: false`；
容器通常无法访问宿主机 WARP 守护进程，请关闭或改在宿主机运行。

零依赖例外：`warp.js` 只调用系统命令，不引入 npm 包。

### 出口代理（面板）

`GET http://127.0.0.1:20134/` 提供 HTML 面板：输入 `http://[user:pass@]host:port`，按 *Simpan dan pakai*，之后所有出站请求（推理、模型发现、身份同步、自更新）都会经该代理隧道传输。*Uji koneksi* 会通过候选代理探测模型端点并报告出口 IP；*Matikan proxy* 返回直连出口。无需重启。

- 支持 HTTP/HTTPS 与 SOCKS5。SOCKS5 由 `socks-bridge.js` 在回环上开 HTTP CONNECT 入口，握手在本地完成；TLS 仍由 Bun 提供，因此 `transport-baseline.json` 保持有效。
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
| 面板设置 SOCKS5 后连接失败 | `socks5://` 由本地 `socks-bridge.js` 转成 HTTP CONNECT；握手失败或凭据错误会返回 502 | 先用 `curl --socks5 host:port https://www.cloudflare.com/cdn-cgi/trace` 验证 SOCKS 服务器本身；认证仅支持无认证或用户名/密码。 |

---

## 5. 仓库架构与代码库指南（面向贡献者）

| 文件 | 职责 |
|---|---|
|`server.js`|HTTP 服务器（`/` 处的面板、`/v1/chat/completions`、`/v1/models`、`/v1/models/{id}`、`/metrics`、`/openapi.json`、`/health`、带 `adminRequestError` CSRF/Host 防护的 `/api/proxy` 与 `/api/backup`）、Bun 运行时守卫、对 `proxy.js`/`panel.js` 的容错加载以及 `repairMissingModules()`，使半安装的树也能启动并自愈、可配置的 DNS 结果顺序（`DNS_RESULT_ORDER`）、会话亲和性缓存、客户端工具别名（`read` -> `read_client`）、SSE 流规范化（`reasoning_content`、`usage`、`finish_reason`）、带 30 秒 IP 冷却重试抑制（`GATE_RETRY_COOLDOWN_MS`）的 403/426/404 响应式重试循环、IP 滥用分支（`X-OpenCode-Gate: ip-abuse`；有其它出口时先在预算内换出口重试，全部失败才原样上报且不刷新）、`UPSTREAM_EGRESS_RETRIES` 控制的 429/IP 封锁/5xx 出口轮换、`FIRST_EVENT_TIMEOUT_MS` 首事件超时后的换出口与模型组候选 failover（全败回 `504 first_event_timeout`）、匿名 lane 熔断暂停（`ANON_BACKOFF_*`，默认关）、出口代理（推理、发现和自更新时使用 `proxy.netFetch`）以及可选的 `UPSTREAM_RELAY_URL` 中继（`x-relay-target` / `x-relay-path`），还有 6 小时自更新器（`checkAndApplyUpdate`），它会暂存传入的 `server.js` 所需的任何模块，即使正在运行的 `UPDATE_FILES` 列表早于该模块。并发闸门（`MAX_INFLIGHT` / `MAX_INFLIGHT_WAIT_MS`）、每 key 的 `rpm`/`daily`/`models` 限额、`METRICS_TOKEN`、可选 `PANEL_TLS_CERT`/`PANEL_TLS_KEY` 也在这里。|
| `identity.js` | 自适应 OpenCode CLI 同步：发布握手（`opencode.ai/update/api`）、GitHub 源码获取器（`identifier.ts`、`session-id.ts`、`app.ts`、`model-request.ts`、`tool/plugin/*.ts`、`codemode/tool.ts`）、Effect Schema AST 解析器（`extractToolFromSource`）、提供方目录解析器与磁盘缓存（`~/.fucking-opencode/cache/catalog.json`）、30 秒强制刷新冷却（`GATE_REFRESH_COOLDOWN_MS`）、终止性 `isIpAbuseRejection` 守卫，以及池化 CSPRNG 会话 ID 生成器（`createSessionId`）与项目 ID 生成器（`createProjectId`，逐请求换新以重置按项目记账的免费额度；`OPENCODE_PROJECT_MODE=derived` 恢复 CLI 忠实推导）。 |
| `token-budget.js` | 加法式 token 预算计算（推理模型为 `max(requested, 1024) + 4096`，标准模型为 `max(requested, 512)`），由目录 `modelFacts` 驱动。 |
| `proxy.js` | 出口：URL 校验（HTTP/HTTPS/SOCKS5，凭据需百分号编码）、在 `<state dir>/proxy.json`（权限 `0600`）中为单个代理和代理池持久化、带面板锁定的 `UPSTREAM_PROXY_URL`/`UPSTREAM_PROXY_POOL` 覆盖、按条目健康检查与指数冷却（`markFailure`/`markSuccess`/`pick`），持久化在 `<state dir>/pool-health.json`（权限 `0600`，以出口身份的截断 SHA-256 为键，因此绝不会重复代理凭据，通过重命名写入，拒绝立即生效 / 成功合并写入）、`withProxy`/`netFetch`（显式出口参数）供 `server.js` 和 `identity.js` 中的每次出站调用使用，以及 `testProxy`/`testPool`（上游探测 + `cdn-cgi/trace` 出口 IP）。池 URL 以 `#pool` 结尾（或 `source.rotating`）表示旋转入口：每条连接都是新 IP，永不冷却/剔除。 |
| `egress-proxy.js` | 无依赖的 HTTP 代理，用于把主机变成代理池成员：CONNECT 加绝对 URI HTTP、可选的 `EGRESS_PROXY_TOKEN`（Basic，仅密码）、未认证的 `/healthz`。默认绑定回环地址；可达性由隧道负责。 |
| `socks-bridge.js` | 把 `socks5://` 出口包装成回环 HTTP CONNECT 代理（无认证或用户名/密码），按 URL 复用，带连接/空闲超时与计数；TLS 仍由 Bun 发出。 |
| `config.js` | 读取 `<状态目录>/config.json`（或 `FUCKING_OPENCODE_CONFIG`），优先级 env > 文件 > 默认值，按 mtime 热加载，校验非法值并保留上一份有效配置；支持 `reasoningEffort` 与 `reasoningEffortByModel`（客户端未显式给 `reasoning_effort` 时才注入）。 |
| `model-groups.js` | 模型组别名解析与候选排序，支持 `modelGroupWeights` 权重（大者优先，稳定序）与 `模拟()`（面板预览实际选择/冷却原因），失败模型按 `404`/`429`/`5xx` 冷却并持久化到 `<状态目录>/model-health.json`。 |
|`warp.js`|可选的 Cloudflare WARP 控制：探测 `warp-cli`，解析 `status`，执行 `connect`/`disconnect`；仅 `WARP_MANAGE=1` 时动作生效。|
|`observability.js`|请求痕迹环形缓冲（300 条）、in-flight、出口记分牌（成功/429/abuse/5xx/超时/换线，p50/p95 首事件）、首事件直方图、事故持久化 `<state>/incidents.json`（0600）、健康评分与 Prometheus `指标()`。重启只保留事故。|
|`notify.js`|事故 webhook：多目标路由（`targets[]`、`minLevel`、安静时段、critical 穿透）、Discord/Telegram/generic，`NOTIFY_WEBHOOK_URL` + `NOTIFY_TELEGRAM_CHAT_ID`，去重 5 分钟、每分钟上限、429/5xx 退避重试，网络请求由 `设置网络请求`（`proxy.netFetch`）注入；配置写入 `<state>/notify.json`（0600），回显只给 host。|
|`diagnostics.js`|零依赖 ZIP（store + central dir）诊断包，`去敏` 抹除 token/API key/密码与消息内容。|
|`selftest.js`|顺序执行 `verify.js --quick`、`transport-fingerprint.js --check`、`gate-drill.js`（`Bun.spawn`，临时状态目录、空 `PANEL_PASSWORD`），保留输出与退出码。|
|`ops.js`|安全模式（单出口/禁轮换，到期自动关闭）与维护调度（`intervalHours`、安静时段、ip-abuse 时轮换/重启），持久化 `<state>/maintenance.json`；`节拍(ctx)` 仅在 `idle` 时动作。|
| `autoheal.js` | 自动修复：按 `readyFloorPct` 判定健康，每轮最多轮换一个失效 lane（按端口退避），全部不健康才重启 farm（15 分钟冷却），拥塞连续多轮且 `autoScale` 时扩容（30 分钟冷却，不缩容）；状态 `<state>/autoheal.json`。 |
| `audit.js` | 管理动作审计 JSONL：`<state>/audit.jsonl`（0600，2 MiB 轮转为 `.1`），敏感键自动脱敏，读取最新 500 条。 |
| `retention.js` | 数据保留：`usageDays`/`maxUsageMb`/`auditDays`/`backupKeep`，默认关闭；裁剪 `usage.jsonl` 用临时文件原子替换，并调用 audit/backup 的裁剪。 |
| `backup.js` | 状态快照与恢复：白名单文件写入 `<state>/backups/backup-<iso>.json`，恢复仅接受 `列表()` 中的名称并逐文件原子写入；`节拍()` 按间隔幂等执行。 |
| `dashboard-api.js` | 面板管理 JSON 路由（observability/models/simulate/diag/bundle/selftest/ops/keys/sessions/farm/resize/backup/preview/audit/retention/backups/autoheal/notify），统一 `panelAuthorized` + loopback `Host` + JSON Content-Type 门禁。 |
| `warp-farm.js` | Go sidecar 桥：找/运行 `warp-farm` 二进制，轮询 control HTTP，把 lane 注册进现有代理池，失败/额度耗尽时轮换 lane（每 lane 60 秒去抖）。`WARP_FARM=1` 开机自启；`GET|POST /api/warp-farm` 提供 status/start/stop/rotate/restart/applyPool/settings。5 秒看门狗在进程消失或 control 端口无响应时从池中移除 `warp-f*` 条目（picker 不会回退，死 lane 会把全部请求送进死端口），并在 `warp-farm.json` 的 `watchdog`（默认 `true`）开启时自动重启；手动 stop 抑制自动重启。只有 `lane.ready` 为真的 lane 才进池（避免 502 tunnel）；失败出口的 `/64` 进入 30 分钟块冷却，但池永不为空（全部冷却时仍用 ready WARP lane，绝不回落宿主机直连）；`/api/warp-farm` 的 `coolingBlocks` 供面板显示冷却块。 |
| `warp-farm/` | 独立 Go 模块（GPL-3.0-or-later，见 `NOTICE.md`）：N 个 WARP 注册 → 每注册一个 userspace WireGuard（UDP，无 TUN）→ 每个 exit 一个回环 SOCKS5 listener（`40001..`）+ 回环 control HTTP。不通过 Docker；与网关只经 SOCKS5/HTTP 通信。 |
| `panel.js` | 在 `/` 提供的 HTML 面板：概览/健康/诊断/事件/日志/出口/代理池/WARP 农场/统计/历史/接入点/文档/测试台/设置 视图，同源表单读写 `/api/*`，对每个配置值转义，不暴露凭据。 |
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

如果本机 `settings.json` 已配置 API key 或面板密码，演练会读到真实状态目录而返回 `401`。此时用空状态目录运行：`FUCKING_OPENCODE_STATE_DIR="$(mktemp -d)" bun gate-drill.js`。`session-shape` 出现 `429` 表示上游额度窗口已用尽，不是代码缺陷；等额度恢复后重跑。
