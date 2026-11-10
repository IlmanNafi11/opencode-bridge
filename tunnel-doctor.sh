#!/usr/bin/env bash
#
# tunnel-doctor.sh — 回收失效的 SSH 端口转发，并检查用于防止失效的
# keepalive 设置。
#
# 本脚本要解决的问题
# ---------------------------
# 反向隧道（`ssh -R 127.0.0.1:20132:127.0.0.1:20134 …`）由 *接收* 主机上的
# sshd 子进程保持打开。当发送主机重启、断电或休眠时，TCP 连接会在没有 FIN
# 的情况下断开。接收端 sshd 会保留监听套接字直到察觉，在此期间，
# 新的隧道无法占用该端口，因此替换隧道会失败并报出下面这条错误，
# 而旧的监听套接字此时仍然存在：
#
#   Error: remote port forwarding failed for listen port 20132
#
# 在默认的 `ClientAliveInterval 300` / `ClientAliveCountMax 2` 配置下，
# “直到察觉”可能长达十分钟——足以让监管程序放弃，也足以
# 让运维人员认定隧道单元本身已经损坏。本脚本就是针对这段窗口的手动补救，
# 而 `--check` 会报告 keepalive 是否足够紧凑，
# 从而把这段窗口保持在可接受的短时间内。
#
# 什么算作失效
# --------------------
# 判断标准不是“存在监听套接字”——健康的隧道同样在监听。
# 转发端口失效，是指持有它的 sshd 会话 **到对端已没有已建立的 TCP 连接**。
# 监听套接字代表端口转发；ESTAB 套接字才是让转发生效的 SSH 传输层。
# 没有传输层就没有隧道，
# 无论监听套接字仍然声称什么。
#
# 用法
# -----
#   ./tunnel-doctor.sh                  # 仅报告（默认）
#   ./tunnel-doctor.sh --reap           # 杀掉传输层已消失的会话
#   ./tunnel-doctor.sh --reap 20131 20132
#   ./tunnel-doctor.sh --check          # keepalive 审计，过于宽松时退出码为 1
#
# 退出码：0 健康 / 无需回收，1 发现问题（报告模式）
# 或 keepalive 过于宽松（--check），2 用法错误。
#
# 默认扫描整个 20120-20149 区间（设置 TUNNEL_PORTS="20134 20136"
# 可缩小范围）。硬编码的列表会静默跳过新增节点。
#
# 依赖：ss、ps（iproute2 + procps）。必须在接收主机上以 root 身份运行。

set -euo pipefail

PORTS=()
REAP=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --reap) REAP=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) PORTS+=("$1"); shift ;;
  esac
done

if [ "${#PORTS[@]}" -eq 0 ]; then
  # 扫描整个 201xx 区间，而不是硬编码的 20134..20135 列表：新增节点的隧道
  # （本机群中的 20136）曾悄无声息地逃过报告，而这正是本脚本存在要捕获的问题。
  # 可用 TUNNEL_PORTS 覆盖。
  if [ -n "${TUNNEL_PORTS:-}" ]; then
    # shellcheck disable=SC2206
    PORTS=(${TUNNEL_PORTS})
  else
    PORTS=()
    for p in $(seq 20120 20149); do
      PORTS+=("$p")
    done
  fi
fi

# --- keepalive 审计 --------------------------------------------------------
# 会话在 ClientAliveInterval × ClientAliveCountMax 秒后被判定为死亡。
# 超过约 2 分钟就会让已重启对端的端口被占用过久，
# 足以与自动重启发生冲突。
if [ "$CHECK" -eq 1 ]; then
  if ! command -v sshd >/dev/null 2>&1; then
    echo "sshd not found; cannot audit keepalive" >&2
    exit 1
  fi
  # `sshd -T` 需要 root 才能读取自身配置。捕获失败，而不是让 `set -e` +
  # `pipefail` 毫无解释地中止脚本。
  if ! sshd_config=$(sshd -T 2>&1); then
    echo "cannot read the effective sshd config (run as root):" >&2
    echo "  $(echo "$sshd_config" | head -1)" >&2
    exit 1
  fi
  interval=$(printf '%s\n' "$sshd_config" | awk '$1=="clientaliveinterval"{print $2; exit}')
  count=$(printf '%s\n' "$sshd_config" | awk '$1=="clientalivecountmax"{print $2; exit}')
  interval=${interval:-0}
  count=${count:-0}
  window=$((interval * count))
  echo "sshd keepalive: ClientAliveInterval=${interval}s ClientAliveCountMax=${count} -> dead peer detected after ${window}s"
  if [ "$interval" -eq 0 ]; then
    echo "FAIL: keepalive is disabled; a rebooted peer's forwards are held until the kernel gives up" >&2
    exit 1
  fi
  if [ "$window" -gt 120 ]; then
    echo "FAIL: ${window}s is too long; an automatic tunnel restart will collide with the stale listener" >&2
    echo "      Set ClientAliveInterval 30 + ClientAliveCountMax 4 (120s), or 15 + 4 (60s)." >&2
    echo "      Note OpenSSH uses the FIRST value it reads: a drop-in must sort BEFORE any" >&2
    echo "      existing one (e.g. /etc/ssh/sshd_config.d/00-keepalive.conf), or it is ignored." >&2
    exit 1
  fi
  echo "OK: a dead peer is detected within ${window}s"
fi

if [ "$CHECK" -eq 1 ] && [ "$REAP" -eq 0 ] && [ "$#" -eq 0 ]; then
  exit 0
fi

# --- 失效转发回收 ----------------------------------------------------------
# 对每个端口：找到持有监听套接字的 sshd 会话，然后判断同一进程是否仍有
# ESTAB 套接字。`ss -tanp` 会在特权父进程和会话子进程下都列出传输层，
# 所以匹配整个会话的 pid 集合，而不是单个 pid。
problems=0
reaped=0

for port in "${PORTS[@]}"; do
  holder=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  if [ -z "${holder:-}" ]; then
    printf '%-6s no listener (nothing to reap)\n' "$port"
    continue
  fi

  cmd=$(ps -o cmd= -p "$holder" 2>/dev/null || true)
  case "$cmd" in
    *sshd-session*) : ;;
    *)
      printf '%-6s held by pid %s (%s) — not sshd, leaving alone\n' "$port" "$holder" "$(echo "$cmd" | cut -c1-40)"
      continue
      ;;
  esac

  estab=$(ss -tanp 2>/dev/null | awk -v pid="pid=$holder," '$0 ~ pid && $1=="ESTAB"' | wc -l)
  if [ "$estab" -gt 0 ]; then
    printf '%-6s pid %-8s OK (%s established)\n' "$port" "$holder" "$estab"
    continue
  fi

  problems=$((problems + 1))
  printf '%-6s pid %-8s STALE (listener held, no established transport)\n' "$port" "$holder"
  if [ "$REAP" -eq 1 ]; then
    if kill "$holder" 2>/dev/null; then
      printf '%-6s killed %s\n' "$port" "$holder"
      reaped=$((reaped + 1))
    else
      printf '%-6s could not kill %s\n' "$port" "$holder" >&2
    fi
  fi
done

if [ "$REAP" -eq 1 ]; then
  echo
  echo "reaped ${reaped} stale session(s); restart the tunnel unit(s) to re-establish the forwards"
  exit 0
fi

if [ "$problems" -gt 0 ]; then
  echo
  echo "${problems} stale forward(s). Re-run with --reap to clear them." >&2
  exit 1
fi

echo
echo "all forwarded ports have a live transport"
