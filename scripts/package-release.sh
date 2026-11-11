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
  config.js model-groups.js socks-bridge.js warp.js warp-farm.js
  stats.js egress-proxy.js transport-fingerprint.js transport-baseline.json
  verify.js gate-drill.js install.sh tunnel-doctor.sh package.json
  README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md panel-avatar.png
)

rm -rf "$OUT"
mkdir -p "$STAGE"

for f in "${FILES[@]}"; do
  [ -e "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/"
done

# WARP farm sidecar：只带源码与模块文件；二进制按平台在本机构建。
mkdir -p "$STAGE/warp-farm"
for f in "$ROOT"/warp-farm/*.go "$ROOT"/warp-farm/go.mod "$ROOT"/warp-farm/go.sum "$ROOT"/warp-farm/LICENSE "$ROOT"/warp-farm/NOTICE.md; do
  [ -e "$f" ] && cp "$f" "$STAGE/warp-farm/"
done

# 交叉编译 sidecar：每个平台包只带自己那份二进制，另附独立资产。
HAS_GO=0
command -v go >/dev/null 2>&1 && HAS_GO=1
SIDECAR_OUT="$OUT/.sidecar"
mkdir -p "$SIDECAR_OUT"

sidecar_build() {
  local goos="$1" goarch="$2" ext=""
  [ "$goos" = "windows" ] && ext=".exe"
  local out="$SIDECAR_OUT/warp-farm_${goos}_${goarch}${ext}"
  [ -f "$out" ] && return 0
  ( cd "$ROOT/warp-farm" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -o "$out" . )
}

sidecar_stage() {
  local goos="$1" goarch="$2" ext=""
  [ "$goos" = "windows" ] && ext=".exe"
  rm -f "$STAGE/warp-farm/warp-farm" "$STAGE/warp-farm/warp-farm.exe"
  if [ "$HAS_GO" = "1" ]; then
    sidecar_build "$goos" "$goarch"
    cp "$SIDECAR_OUT/warp-farm_${goos}_${goarch}${ext}" "$STAGE/warp-farm/warp-farm${ext}"
    chmod +x "$STAGE/warp-farm/warp-farm${ext}" 2>/dev/null || true
  fi
}

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
  sidecar_stage "$os" "$arch"
  local pkg="$OUT/${NAME}_v${VERSION}_${os}_${arch}.tar.gz"
  ( cd "$OUT" && tar -czf "$(basename "$pkg")" "$NAME-$VERSION" )
  ( cd "$OUT" && sha256sum "$(basename "$pkg")" > "$(basename "$pkg").sha256" )
  echo "built $(basename "$pkg")"
}

build_windows() {
  local arch="$1"
  sidecar_stage windows "$arch"
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

if [ "$HAS_GO" = "1" ]; then
  for os in linux darwin windows; do
    for arch in amd64 arm64; do
      ext=""
      [ "$os" = "windows" ] && ext=".exe"
      sidecar_build "$os" "$arch"
      cp "$SIDECAR_OUT/warp-farm_${os}_${arch}${ext}" "$OUT/warp-farm_${os}_${arch}${ext}"
      ( cd "$OUT" && sha256sum "warp-farm_${os}_${arch}${ext}" > "warp-farm_${os}_${arch}${ext}.sha256" )
    done
  done
else
  echo "Go not found: archives ship warp-farm sources without prebuilt binaries"
fi
rm -rf "$SIDECAR_OUT"

ls -1 "$OUT"
