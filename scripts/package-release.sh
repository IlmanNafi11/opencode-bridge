#!/usr/bin/env bash
# 打包发布产物：六个平台包（linux/darwin/windows × amd64/arm64），每个附 sha256。
# 纯 JS 运行时，包内容相同；平台差异只在启动脚本与压缩格式。
set -euo pipefail

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
NAME="fucking-opencode"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/dist}"
STAGE="$OUT/$NAME-$VERSION"

FILES=(
  server.js identity.js token-budget.js compat.js proxy.js panel.js panel-settings.js
  stats.js egress-proxy.js transport-fingerprint.js transport-baseline.json
  verify.js gate-drill.js install.sh tunnel-doctor.sh package.json
  README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md panel-avatar.png
)

rm -rf "$OUT"
mkdir -p "$STAGE"

for f in "${FILES[@]}"; do
  [ -e "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/"
done

cat > "$STAGE/fucking-opencode" <<'LAUNCH'
#!/usr/bin/env bash
# 启动网关：优先使用已安装的 bun，否则提示安装。
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v bun >/dev/null 2>&1; then
  echo "需要 Bun 1.4+：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
exec bun server.js "$@"
LAUNCH
chmod +x "$STAGE/fucking-opencode"

cat > "$STAGE/fucking-opencode.cmd" <<'LAUNCH'
@echo off
rem 启动网关：优先使用 PATH 中的 bun。
cd /d "%~dp0"
where bun >nul 2>&1 || (echo 需要 Bun: https://bun.sh/install & exit /b 1)
bun server.js %*
LAUNCH

build_unix() {
  local arch="$1"
  local os="$2"
  local pkg="$OUT/${NAME}_v${VERSION}_${os}_${arch}.tar.gz"
  tar -C "$OUT" -czf "$pkg" "$NAME-$VERSION"
  ( cd "$OUT" && sha256sum "$(basename "$pkg")" > "$(basename "$pkg").sha256" )
  echo "built $(basename "$pkg")"
}

build_windows() {
  local arch="$1"
  local zip="$OUT/${NAME}_v${VERSION}_windows_$arch.zip"
  local winStage winOut
  winStage="$(cygpath -w "$STAGE" 2>/dev/null || echo "$STAGE")"
  winOut="$(cygpath -w "$zip" 2>/dev/null || echo "$zip")"
  powershell -NoProfile -Command "Compress-Archive -Path '$winStage' -DestinationPath '$winOut' -Force" >/dev/null
  ( cd "$OUT" && sha256sum "$(basename "$zip")" > "$(basename "$zip").sha256" )
  echo "built $(basename "$zip")"
}

build_unix amd64 linux
build_unix arm64 linux
build_unix amd64 darwin
build_unix arm64 darwin
build_windows amd64
build_windows arm64

ls -1 "$OUT"
