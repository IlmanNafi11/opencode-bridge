#!/usr/bin/env bash
# fucking-opencode 安装脚本。
#
#   curl -fsSL https://raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main/install.sh | bash
#
# 功能：
#   1. 查找 Bun，找不到则安装。CLI 以 Bun 二进制形式分发，免费额度校验会检查
#      传输指纹：在 Bun 上实测返回 200，在 Node 和 curl 上返回 403。
#   2. 将 gateway 下载到暂存目录并校验，通过后才改动正在运行的任何东西
#   3. 停用 2.0 之前的 `fucking-opencode.service`，它会抢占端口
#   4. 将 gateway 及其工具复制到安装目录（server.js、identity.js、
#      token-budget.js、verify.js、gate-drill.js 以及 transport-fingerprint
#      相关文件），复制前先备份已有安装
#   5. 注册服务，让 gateway 开机自启并在崩溃后重启
#      （Linux 用 systemd，macOS 用 launchd）。不支持 Windows。
#   6. 等待 /health，然后运行自检和 TLS 指纹检查
#
# 如果 gateway 未能启动，脚本会以非零状态退出。只有 gateway 响应后才打印 "Done"。
#
# 环境变量覆盖：
#   PORT       监听端口             （默认 20134）
#   HOST       绑定地址             （默认 127.0.0.1）
#   BINDIR     文件安装位置         （默认 ~/.fucking-opencode）
#   NO_SERVICE 跳过服务安装         （默认：安装服务）
#   REPO       源仓库               （默认 ShinRyu04/Fucking-Opencode）
#   SOURCE     auto | local | remote（默认 auto：从克隆目录运行时用 local）
set -euo pipefail

PORT="${PORT:-20134}"
HOST="${HOST:-127.0.0.1}"
BINDIR="${BINDIR:-$HOME/.fucking-opencode}"
REPO="${REPO:-ShinRyu04/Fucking-Opencode}"
BRANCH="${BRANCH:-main}"
# 本脚本在磁盘上存在时所在的目录。`curl | bash` 方式根本没有文件，
# 因此只有 BASH_SOURCE 指向真实的 install.sh 时才走本地路径；
# 否则 `SOURCE=auto` 会回退到远程下载。
SOURCE_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SOURCE_PATH" ] && [ -f "$SOURCE_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SOURCE_PATH")" && pwd)"
fi

say()  { printf '\033[1;32m[fucking-opencode]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fucking-opencode]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fucking-opencode]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Invalid PORT: $PORT"
[[ "$HOST" =~ ^[A-Za-z0-9.:_-]+$ ]] || die "Invalid HOST: $HOST"
case "$BINDIR" in
  *$'\n'*|*$'\r'*) die "Invalid BINDIR: newline not allowed" ;;
esac

# ---------------------------------------------------------------- Node.js ---
# Bun 是必需项，并非可选项。在同一 IP、同一分钟内使用完全相同的请求头和请求体
# 实测：真实 CLI 和运行在 Bun 上的 gateway 都返回 200，
# 而 Node 和 curl 返回 403。CLI 以 Bun 二进制形式分发，免费额度校验会检查
# 传输指纹，所以只有 Bun 能复现该指纹。
#
# `curl https://bun.sh/install | bash` 会把 bun 装到 `$HOME/.bun/bin`，并且只把
# 它加入 *交互式* shell 的 PATH。因此非交互式 SSH 会话、cron 任务，
# 或在 `sh -c` 下运行的安装脚本，即使二进制文件存在也看不到 `bun`。
# 在断定它缺失之前，先检查这些标准位置。
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  local candidate
  for candidate in "${BUN_INSTALL:-}/bin/bun" "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun" /usr/local/bin/bun /opt/bun/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if BUN_BIN="$(find_bun)"; then
  RUNTIME="$BUN_BIN"
  say "runtime: bun ($("$RUNTIME" --version)) — matches the CLI's transport"
  case ":$PATH:" in
    *":$(dirname "$RUNTIME"):"*) ;;
    *) warn "bun is not on PATH; using $RUNTIME. Add $(dirname "$RUNTIME") to PATH for manual runs." ;;
  esac
elif [ -n "${ALLOW_NODE:-}" ] && command -v node >/dev/null 2>&1; then
  RUNTIME="$(command -v node)"
  warn "runtime: node — NOT supported for live use. The free-tier gate refuses Node's"
  warn "transport fingerprint with 403. Proceeding because ALLOW_NODE is set."
else
  # 提供一键安装脚本，是为了让新用户不必去读手册。
  # 只告诉他们“先装 Bun”然后退出就失去意义了，所以直接安装。
  say "Bun is not installed; installing it now (required for the transport fingerprint)"
  if ! command -v unzip >/dev/null 2>&1 && ! command -v 7z >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ] || (command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1); then
      SUDO_CMD=""
      [ "$(id -u)" != "0" ] && SUDO_CMD="sudo -n"
      say "Installing unzip (required by the Bun installer)..."
      if command -v apt-get >/dev/null 2>&1; then
        $SUDO_CMD apt-get update -qq >/dev/null 2>&1 && $SUDO_CMD apt-get install -y -qq unzip >/dev/null 2>&1 || true
      elif command -v dnf >/dev/null 2>&1; then
        $SUDO_CMD dnf install -y -q unzip >/dev/null 2>&1 || true
      elif command -v yum >/dev/null 2>&1; then
        $SUDO_CMD yum install -y -q unzip >/dev/null 2>&1 || true
      elif command -v apk >/dev/null 2>&1; then
        $SUDO_CMD apk add --no-cache -q unzip >/dev/null 2>&1 || true
      elif command -v pacman >/dev/null 2>&1; then
        $SUDO_CMD pacman -Sy --noconfirm unzip >/dev/null 2>&1 || true
      fi
    fi
  fi
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL https://bun.sh/install | bash >/tmp/ofb-bun-install.log 2>&1; then
      warn "Bun installation failed. Log:"
      tail -5 /tmp/ofb-bun-install.log >&2 2>/dev/null || true
      die "install Bun manually: https://bun.sh"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -qO- https://bun.sh/install | bash >/tmp/ofb-bun-install.log 2>&1; then
      warn "Bun installation failed. Log:"
      tail -5 /tmp/ofb-bun-install.log >&2 2>/dev/null || true
      die "install Bun manually: https://bun.sh"
    fi
  else
    die "neither curl nor wget is available, so Bun cannot be installed. Install Bun manually: https://bun.sh"
  fi
  rm -f /tmp/ofb-bun-install.log
  if ! BUN_BIN="$(find_bun)"; then
    die "Bun was installed but cannot be found in ~/.bun/bin. Open a new shell and re-run this installer."
  fi
  RUNTIME="$BUN_BIN"
  say "runtime: bun ($("$RUNTIME" --version)) — installed by this script"
fi
# 这里不对 Bun 设版本门槛：gateway 只使用长期稳定的 API，且 Bun
# 1.4.2（CLI 自带版本）和 1.4.3 都已验证。Node 则有版本要求。
if [ "$(basename "$RUNTIME")" = "node" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $(node -v))"
fi

# -------------------------------------------------------------- 迁移 ---
# 从 1.x 或早期 2.x 升级意味着底层有三处变化：
#
#   * 运行时（node -> bun），所以仍写着 `node` 的服务单元需要修改
#   * 文件集合（identity.js 和传输相关工具是新增的），所以旧安装器只复制部分
#     文件会导致 gateway 无法启动
#   * 传输本身，所以过去“能用”的旧安装现在需要 Bun 才能拿到 403 以外的响应
#
# 旧文件是移到一边而不是删除，所以升级失败时可以手动回退。
PREV_VERSION=""
if [ -f "$BINDIR/package.json" ]; then
  PREV_VERSION="$("$RUNTIME" -e 'try{process.stdout.write(require(process.argv[1]).version||"")}catch{}' "$BINDIR/package.json" 2>/dev/null || true)"
fi
if [ -n "$PREV_VERSION" ]; then
  say "Found existing install: v$PREV_VERSION in $BINDIR"
  BACKUP="$BINDIR/.backup-v$PREV_VERSION-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$BACKUP"
  for f in server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js transport-baseline.json package.json tunnel-doctor.sh proxy.js panel.js egress-proxy.js THIRD_PARTY_NOTICES.md; do
    [ -f "$BINDIR/$f" ] && cp -p "$BINDIR/$f" "$BACKUP/$f" 2>/dev/null || true
  done
  say "Backed up to $BACKUP"
  if [ -f "$BINDIR/server.js" ] && ! grep -q '#!/usr/bin/env bun' "$BINDIR/server.js" 2>/dev/null; then
    say "Old install ran on Node; this version requires Bun for the live gate"
  fi
fi

# 旧安装器写的服务单元仍指向 `node`，升级后会悄无声息地持续失败。
# 如果可能，就改写它。
migrate_service_runtime() {
  local unit esc_runtime esc_bindir
  esc_runtime="$(printf '%s' "$RUNTIME" | sed 's/[\\&|]/\\&/g')"
  esc_bindir="$(printf '%s' "$BINDIR" | sed 's/[\\&|]/\\&/g')"
  for unit in "/etc/systemd/system/fucking-opencode.service" \
              "$HOME/.config/systemd/user/fucking-opencode.service"; do
    [ -f "$unit" ] || continue
    if grep -q 'ExecStart=.*node' "$unit" 2>/dev/null; then
      sed -i.bak -E "s|^ExecStart=.*|ExecStart=\"$esc_runtime\" \"$esc_bindir/server.js\"|" "$unit" 2>/dev/null || {
        warn "could not rewrite $unit — update ExecStart to: \"$RUNTIME\" \"$BINDIR/server.js\""
        continue
      }
      say "Service unit updated to run under $(basename "$RUNTIME"): $unit"
      if [ "${unit#/etc}" != "$unit" ]; then
        systemctl daemon-reload 2>/dev/null || true
      else
        systemctl --user daemon-reload 2>/dev/null || true
      fi
    fi
  done
  local plist="$HOME/Library/LaunchAgents/com.fucking-opencode.plist"
  if [ -f "$plist" ] && grep -q '<string>.*node</string>' "$plist" 2>/dev/null; then
    sed -i.bak -E "s|<string>[^<]*node</string>|<string>$esc_runtime</string>|" "$plist" 2>/dev/null || true
    say "launchd agent updated to run under $(basename "$RUNTIME")"
  fi
}
migrate_service_runtime

# ------------------------------------------------------- 旧版清理 ---
# v2.0 之前的版本注册的是 `fucking-opencode.service`，而不是
# `fucking-opencode.service`。两者会绑定同一端口，若旧的单元仍处于启用状态，
# 新服务会因 EADDRINUSE 失败并无限重启循环。找到本仓库并在仍留有旧 gateway
# 的机器上重新运行安装器的用户，应该得到升级，而不是端口冲突。
port_holder() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | awk -v p=":$PORT$" '$4 ~ p {print; exit}'
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print; exit}'
    return 0
  fi
  return 0
}

legacy_unit_active() {
  systemctl is-active --quiet fucking-opencode 2>/dev/null && return 0
  systemctl --user is-active --quiet fucking-opencode 2>/dev/null && return 0
  return 1
}

# 端口是否被本安装器即将替换的那个 gateway 占用？在已有安装上重新运行
# 安装器必须能正常工作，所以 gateway 自身的进程不算冲突。其他任何进程都算。
#
# 注意 `|| true`：安装器在 `set -euo pipefail` 下运行，如果管道中的 `grep`
# 没有匹配项就会以状态 1 退出，从而让整个安装无提示中止。这里的每个探测
# 都必须允许返回空结果。
pid_on_port() {
  local pid
  pid="$(port_holder | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -z "$pid" ]; then
    pid="$(port_holder | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1 || true)"
  fi
  if [ -z "$pid" ] && command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  fi
  printf '%s\n' "$pid"
}

port_held_by_own_gateway() {
  local pid cwd target
  pid="$(pid_on_port)"
  [ -n "$pid" ] || return 1

  # 分离运行的 gateway 是在 pushd 之后以 `bun server.js` 启动的，所以它的
  # 命令行是相对路径，只有 cwd 能标识它。安装目录被替换后，
  # readlink 会追加 " (deleted)"，这不能导致匹配失败。
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null | sed 's/ (deleted)$//' || true)"
  target="$(readlink -f "$BINDIR" 2>/dev/null || printf '%s' "$BINDIR")"
  [ -n "$cwd" ] && [ -n "$target" ] && [ "$cwd" = "$target" ] && return 0

  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$BINDIR/server.js" && return 0
  ps -p "$pid" -o command= 2>/dev/null | grep -qF "$BINDIR/server.js" && return 0
  command -v lsof >/dev/null 2>&1 && lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qF "n$target" && return 0
  return 1
}

stop_own_gateway() {
  local pid
  pid="$(pid_on_port)"
  [ -n "$pid" ] || return 0

  # 如果 gateway 由 systemd 监管，就通过 systemd 停止它。直接杀掉 pid
  # 会被 Restart=always 立即恢复。
  if systemctl is-active --quiet fucking-opencode 2>/dev/null; then
    say "Stopping the running gateway service to replace it"
    systemctl stop fucking-opencode 2>/dev/null || true
    return 0
  fi
  if systemctl --user is-active --quiet fucking-opencode 2>/dev/null; then
    say "Stopping the running gateway service to replace it"
    systemctl --user stop fucking-opencode 2>/dev/null || true
    return 0
  fi

  say "Stopping the running gateway (pid $pid) to replace it"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
}

# 在改动任何东西之前先做决定。如果端口被其他进程占用，先停掉用户正在运行的
# gateway 会让他们一无所有。
if [ -n "$(port_holder)" ] && ! legacy_unit_active && ! port_held_by_own_gateway; then
  warn "port $PORT is already in use:"
  warn "  $(port_holder)"
  warn "Nothing was changed. Either stop that process, or install on another port:"
  warn "  PORT=20130 bash install.sh"
  die "port $PORT is occupied by another process"
fi

retire_legacy_service() {
  local name="fucking-opencode.service"
  local stamp retired=0
  stamp="$(date +%Y%m%d%H%M%S)"

  if [ -f "/etc/systemd/system/$name" ] || systemctl cat "$name" >/dev/null 2>&1; then
    if systemctl is-active --quiet "$name" 2>/dev/null; then
      systemctl stop "$name" 2>/dev/null && retired=1
    fi
    systemctl disable "$name" >/dev/null 2>&1 || true
    if [ -f "/etc/systemd/system/$name" ]; then
      mv -f "/etc/systemd/system/$name" "/etc/systemd/system/$name.retired-$stamp" 2>/dev/null || true
    fi
    rm -f "/etc/systemd/system/multi-user.target.wants/$name" 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true
    say "Retired legacy unit $name (it held the old gateway on port $PORT)"
  fi

  if [ -f "$HOME/.config/systemd/user/$name" ]; then
    systemctl --user stop "$name" 2>/dev/null || true
    systemctl --user disable "$name" >/dev/null 2>&1 || true
    mv -f "$HOME/.config/systemd/user/$name" "$HOME/.config/systemd/user/$name.retired-$stamp" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/default.target.wants/$name" 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
    say "Retired legacy user unit $name"
  fi

  # 让旧进程先释放监听套接字，再让新服务尝试绑定。
  if [ "$retired" = "1" ]; then sleep 1; fi
}

# ------------------------------------------------------------------ 获取 ---
# 一切都要在改动正在运行的 gateway *之前* 完成暂存和语法检查。因此升级过程中
# 的网络故障会让旧 gateway 继续提供服务，而不是让用户面对一个已停止的服务
# 和一份写了一半的安装。
#
# 来源选择：本仓库的克隆会安装它自己的工作树。这就是在检出目录中执行
# `bash install.sh` 的含义，也是安装尚未推送的提交的唯一方式（curl 方式从
# GitHub 拉取，对仅存在于本地的文件返回 404）。在克隆目录中设置 SOURCE=remote
# 可强制走下载路径。
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
SOURCE="${SOURCE:-auto}"
SRC_DIR=""
if [ "$SOURCE" = "auto" ]; then
  if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
    SOURCE="local"
  else
    SOURCE="remote"
  fi
fi
if [ "$SOURCE" = "local" ]; then
  SRC_DIR="$SCRIPT_DIR"
  say "Source: local checkout ($SRC_DIR)"
elif [ "$SOURCE" = "remote" ]; then
  say "Source: ${RAW}"
else
  die "Invalid SOURCE: $SOURCE (expected auto, local, or remote)"
fi

mkdir -p "$BINDIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ofb-stage.XXXXXX")"
cleanup_stage() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup_stage EXIT
say "Installing into $BINDIR"

fetch() {
  local file="$1"
  local tmp="$STAGE/$file"
  if [ "$SOURCE" = "local" ]; then
    [ -f "$SRC_DIR/$file" ] || die "$file is missing from the local checkout ($SRC_DIR)"
    cp -p "$SRC_DIR/$file" "$tmp"
    return 0
  fi
  # raw.githubusercontent.com 位于 CDN 之后，推送后一段时间内可能仍提供上一个
  # 提交的内容。过期的 install.sh 无害（它已经运行过了），但过期的 server.js
  # 搭配新的 identity.js 就有问题。查询字符串会被服务端忽略，且能绕过缓存。
  local url="$RAW/$file?cb=$(date +%s)"
  if command -v curl >/dev/null 2>&1; then
    # 单独的 `curl: (22)` 既不指出是哪个文件，也不说明原因。这里指明文件，
    # 因为常见原因是发布中列出了一个从未推送的文件。
    curl -fsSL --retry 3 -H 'Cache-Control: no-cache' -o "$tmp" "$url" \
      || die "could not download $file from $RAW (HTTP error above). The release may be missing this file; retry with SOURCE=local from a checkout."
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$url" \
      || die "could not download $file from $RAW. The release may be missing this file; retry with SOURCE=local from a checkout."
  else
    die "neither curl nor wget is available"
  fi
  [ -s "$tmp" ] || die "downloaded $file is empty"
}


fetch package.json
fetch server.js
fetch identity.js
fetch token-budget.js
fetch verify.js
fetch gate-drill.js
fetch transport-fingerprint.js
fetch transport-baseline.json
fetch tunnel-doctor.sh
fetch proxy.js
fetch panel.js

# 语法损坏的发布绝不能替换可用的安装。
#
# `bun --check` 并不等于“只解析”：Bun 没有 --check 参数，所以它会把这个文件
# 当成入口并 *运行* 它。这曾在安装期间启动了第二个服务器，更糟的是让每次升级
# 都以 “failed a syntax check” 中止。改为解析源码：new Function 编译但不执行。
syntax_check() {
  "$RUNTIME" -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8").replace(/^#!.*\n/, "");
    try { new Function(src); } catch (err) { console.error(err.message); process.exit(1); }
  ' "$1"
}

for js in server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js proxy.js panel.js; do
  syntax_check "$STAGE/$js" >/dev/null 2>&1 || die "$js failed a syntax check; the running gateway was left untouched"
done
for json in package.json transport-baseline.json; do
  "$RUNTIME" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STAGE/$json" \
    || die "$json is not valid JSON; the running gateway was left untouched"
done
# tunnel-doctor.sh 是 bash 而非 JS，所以 `new Function` 无法检查它。`bash -n`
# 只解析不执行，正是这里需要的保证。
if [ -f "$STAGE/tunnel-doctor.sh" ]; then
  if command -v bash >/dev/null 2>&1; then
    bash -n "$STAGE/tunnel-doctor.sh" || die "tunnel-doctor.sh failed a syntax check; the running gateway was left untouched"
  fi
fi

# 已暂存并校验。现在才可以安全地停止旧 gateway。
retire_legacy_service
stop_own_gateway

# 旧进程在收到 SIGTERM 后会异步释放套接字。等它释放，而不是与绑定竞争，
# 并且如果始终未释放则清晰报告。
for _ in $(seq 1 10); do
  [ -z "$(port_holder)" ] && break
  sleep 0.5
done
if [ -n "$(port_holder)" ]; then
  warn "port $PORT is still held after stopping the old gateway:"
  warn "  $(port_holder)"
  die "cannot bind port $PORT"
fi

for file in package.json server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js transport-baseline.json tunnel-doctor.sh proxy.js panel.js egress-proxy.js THIRD_PARTY_NOTICES.md; do
  [ -f "$STAGE/$file" ] && mv -f "$STAGE/$file" "$BINDIR/$file"
done
chmod +x "$BINDIR/server.js" "$BINDIR/identity.js" "$BINDIR/verify.js" "$BINDIR/gate-drill.js" "$BINDIR/transport-fingerprint.js" "$BINDIR/tunnel-doctor.sh" "$BINDIR/egress-proxy.js" 2>/dev/null || true
say "Files installed (v$("$RUNTIME" -e 'try{process.stdout.write(require(process.argv[1]).version||"latest")}catch{process.stdout.write("latest")}' "$BINDIR/package.json" 2>/dev/null || echo 'latest'))"

# ---------------------------------------------------------------- 服务 ---
SERVICE_SCOPE="none"
install_service() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"

  if [ "$os" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    local unit_dir="/etc/systemd/system"
    local unit="$unit_dir/fucking-opencode.service"
    if [ -w "$unit_dir" ]; then
      cat > "$unit" <<UNIT
[Unit]
Description=OpenCode Free Gateway (OpenAI-compatible, free-tier models)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$BINDIR
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable fucking-opencode >/dev/null 2>&1 || true
      if ! systemctl restart fucking-opencode; then
        warn "systemd refused to start fucking-opencode — inspect: systemctl status fucking-opencode"
        return 1
      fi
      SERVICE_SCOPE="system"
      say "systemd service installed and restarted"
      return 0
    elif systemctl --user status >/dev/null 2>&1; then
      local user_unit_dir="$HOME/.config/systemd/user"
      local user_unit="$user_unit_dir/fucking-opencode.service"
      mkdir -p "$user_unit_dir"
      cat > "$user_unit" <<UNIT
[Unit]
Description=OpenCode Free Gateway (OpenAI-compatible, free-tier models)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BINDIR
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M
[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable fucking-opencode >/dev/null 2>&1 || true
      if ! systemctl --user restart fucking-opencode; then
        warn "systemd --user refused to start fucking-opencode — inspect: systemctl --user status fucking-opencode"
        return 1
      fi
      SERVICE_SCOPE="user"
      command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
      say "systemd --user service installed and restarted"
      return 0
    else
      warn "no write access to $unit_dir — skipping service install (run with sudo to enable it)"
      return 1
    fi
  fi

  if [ "$os" = "darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.fucking-opencode.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fucking-opencode</string>
  <key>ProgramArguments</key>
  <array><string>$RUNTIME</string><string>$BINDIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$BINDIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string><key>HOST</key><string>$HOST</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/fucking-opencode.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/fucking-opencode.log</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
    mkdir -p "$HOME/Library/Logs"
    launchctl unload "$plist" >/dev/null 2>&1 || true
    launchctl load "$plist"
    SERVICE_SCOPE="launchd"
    say "launchd agent installed and restarted"
    return 0
  fi

  warn "no supported service manager found — start it manually: PORT=$PORT $RUNTIME $BINDIR/server.js"
  return 1
}

SERVICE_OK=1
if [ "${NO_SERVICE:-0}" != "1" ]; then
  install_service || SERVICE_OK=0
else
  SERVICE_OK=0
fi

# ------------------------------------------------------------ 启动检查 ---
if [ "$SERVICE_OK" != "1" ]; then
  say "Starting in the background (no service manager)"
  pkill -f -- "$BINDIR/server.js" 2>/dev/null || true
  sleep 0.5
  # 这里有两个要点，且都经过实测：
  #
  #   * 不用子 shell。`( ... & )` 会让 bash 等待子进程，于是通过管道运行的
  #     安装器会一直阻塞到 gateway 退出——在最小复现中为 70s，
  #     真实安装则永远不返回。
  #   * setsid + 从 /dev/null 读取 stdin，使子进程不持有调用者终端或管道的
  #     任何描述符。
  #
  # pushd/popd 切换目录而不 fork。实测：0.004s。
  pushd "$BINDIR" >/dev/null
  if command -v setsid >/dev/null 2>&1; then
    setsid env PORT="$PORT" HOST="$HOST" "$RUNTIME" server.js </dev/null >"$BINDIR/gateway.log" 2>&1 &
  else
    env PORT="$PORT" HOST="$HOST" nohup "$RUNTIME" server.js </dev/null >"$BINDIR/gateway.log" 2>&1 &
  fi
  disown 2>/dev/null || true
  popd >/dev/null
fi

PROBE_HOST="$HOST"
if [ "$PROBE_HOST" = "0.0.0.0" ] || [ "$PROBE_HOST" = "::" ]; then
  PROBE_HOST="127.0.0.1"
fi

probe_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "http://$PROBE_HOST:$PORT/health" >/dev/null 2>&1
  else
    "$RUNTIME" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "http://$PROBE_HOST:$PORT/health" >/dev/null 2>&1
  fi
}

say "Waiting for the gateway to come up..."
GATEWAY_UP=0
for _ in $(seq 1 20); do
  # -m 很重要：不可路由的 HOST 会让 curl 挂起数分钟，
  # 过去安装器会一直卡在那里直到用户杀掉它。
  if probe_health; then GATEWAY_UP=1; break; fi
  sleep 1
done

if [ "$GATEWAY_UP" != "1" ]; then
  warn "the gateway did not answer on http://$PROBE_HOST:$PORT/health after 20s"
  if [ "$SERVICE_OK" = "1" ]; then
    if [ "$SERVICE_SCOPE" = "user" ]; then
      warn "inspect: systemctl --user status fucking-opencode ; journalctl --user -u fucking-opencode -n 30"
    else
      warn "inspect: systemctl status fucking-opencode ; journalctl -u fucking-opencode -n 30"
    fi
  else
    warn "inspect: $BINDIR/gateway.log"
  fi
  die "install finished but the service is not running"
fi
say "Gateway is answering on http://$PROBE_HOST:$PORT"

echo
say "Running self-check (quick — full check: $RUNTIME $BINDIR/verify.js)"
echo
# 有意加上限：自检会访问可能限流的实时上游。没有硬性上限，
# 缓慢的上游会让安装器看起来卡死，用户在服务注册前就把进程杀掉。
if command -v timeout >/dev/null 2>&1; then
  set +e
  PORT="$PORT" HOST="$HOST" timeout 120 "$RUNTIME" "$BINDIR/verify.js" --quick
  CHECK_RC=$?
  set -e
else
  set +e
  PORT="$PORT" HOST="$HOST" "$RUNTIME" "$BINDIR/verify.js" --quick
  CHECK_RC=$?
  set -e
fi
case "$CHECK_RC" in
  0) ;;
  2) warn "the gateway is installed and healthy, but upstream refused this IP (free-tier allowance or an abuse block)"
     warn "the official OpenCode CLI gets the same refusal from this network; the self-check above says which one"
     warn "re-check later with the command below" ;;
  124) warn "self-check hit the 120s cap; the gateway is installed, run the check again when upstream is responsive" ;;
  *) warn "self-check reported a problem; inspect the log with the command below" ;;
esac

# TLS 指纹就是门槛。过旧的 Bun 会顺利安装并启动，然后拿到一个看起来与
# IP 额度耗尽完全相同的 403，所以在这里检查，而不是让用户去排查错误的方向。
if [ -f "$BINDIR/transport-fingerprint.js" ] && [ -f "$BINDIR/transport-baseline.json" ]; then
  set +e
  ( cd "$BINDIR" && "$RUNTIME" transport-fingerprint.js --check >/dev/null 2>&1 )
  TLS_RC=$?
  set -e
  if [ "$TLS_RC" != "0" ]; then
    warn "this Bun build's TLS ClientHello does not match the recorded OpenCode CLI baseline"
    warn "upstream inspects that fingerprint; expect 403 until it matches."
    warn "inspect: cd $BINDIR && $RUNTIME transport-fingerprint.js --check"
  fi
fi

echo
say "Done."
cat <<NEXT

  Endpoint : http://$PROBE_HOST:$PORT/v1
  API key  : public  (any value is accepted)
  Models   : curl http://$PROBE_HOST:$PORT/v1/models

  Add it to 9Router, Cursor, Continue, or any OpenAI-compatible client as a
  custom provider. Re-run the self-check any time with:

      "$RUNTIME" $BINDIR/verify.js

NEXT

if [ "$SERVICE_OK" = "1" ]; then
  if [ "$SERVICE_SCOPE" = "user" ]; then
    echo "  Logs     : journalctl --user -u fucking-opencode -f"
  elif [ "$SERVICE_SCOPE" = "system" ]; then
    echo "  Logs     : journalctl -u fucking-opencode -f"
  else
    echo "  Logs     : tail -f ~/Library/Logs/fucking-opencode.log"
  fi
fi
echo
