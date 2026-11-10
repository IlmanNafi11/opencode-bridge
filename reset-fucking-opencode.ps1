# 重置脚本 —— 只动 Fucking Opencode (端口 20134)，绝不碰 8792/8794。
# 免责声明：本地重置不清空、不重置 OpenCode 服务端的任何配额；它只清理本地
# 缓存与健康状态，并重启 Fucking Opencode 进程本身。
# 用法：
#   .\重置免费桥.ps1                # 默认 -StatusOnly，只显示状态
#   .\重置免费桥.ps1 -Reset         # 备份 → 停 20134 → 清缓存/健康 → 重启 → 验证
#   .\重置免费桥.ps1 -Rollback <备份目录>
#   .\重置免费桥.ps1 -TestModel beam-free
param(
  [switch]$状态检查,
  [switch]$重置,
  [string]$回滚,
  [string]$测试模型,
  [switch]$仅显示
)

$ErrorActionPreference = "Continue"
$桥目录   = "D:\ToolsAI\fucking-opencode"
$状态目录 = "C:\Users\Zyrex\.fucking-opencode"
$启动脚本 = Join-Path $桥目录 "start-fucking-opencode.cmd"
$端口     = 20134
$保留端口 = @(8792, 8794)   # opencode2api 与其轮转器 —— 只读记录，永不下手
$健康地址 = "http://127.0.0.1:$端口/health"

function 写日志([string]$消息) {
  $行 = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $消息
  Write-Host $行
}

function 获取监听PID([int]$端口) {
  $连接 = Get-NetTCPConnection -LocalPort $端口 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($连接) { return $连接.OwningProcess }
  return $null
}

function 读健康 {
  try { return Invoke-RestMethod -Uri $健康地址 -TimeoutSec 8 } catch { return $null }
}

function 显示状态 {
  $健康 = 读健康
  $桥PID = 获取监听PID $端口
  Write-Host "==== Fucking Opencode 状态 ===="
  Write-Host ("端口 {0}: {1}" -f $端口, $(if ($桥PID) { "运行中 PID=$桥PID" } else { "未监听" }))
  foreach ($保留 in $保留端口) {
    $保留PID = 获取监听PID $保留
    Write-Host ("端口 {0} (opencode2api，不碰): {1}" -f $保留, $(if ($保留PID) { "PID=$保留PID" } else { "未监听" }))
  }
  if ($健康) {
    Write-Host ("版本: {0}  运行时: {1}" -f $健康.version, $健康.runtime)
    Write-Host ("出口模式: {0}" -f $健康.egress.mode)
    $池 = $健康.egress.proxy.pool
    if ($池) {
      Write-Host ("池: 活跃={0} 大小={1} 启用={2} 就绪={3} 冷却中={4} 策略={5}" -f `
        $池.active, $池.size, $池.enabled, $池.ready, $池.cooling, $池.strategy)
      foreach ($项 in $池.entries) {
        Write-Host ("  [{0}] {1}  状态={2}  失败={3}  冷却剩={4}ms  上次错误={5}" -f `
          $项.id, $项.host, $项.state, $项.failures, $项.cooldownMsLeft, $项.lastError)
      }
    }
    $sidecar = $null
    try { $sidecar = Invoke-RestMethod -Uri "http://127.0.0.1:40000/状态" -TimeoutSec 5 } catch {}
    if ($sidecar) {
      $就绪 = ($sidecar.节点 | Where-Object { $_.ready }).Count
      Write-Host ("WARP sidecar: 就绪 {0}/{1}，唯一出口键 {2}" -f $就绪, $sidecar.节点.Count, $sidecar.唯一出口键)
    } else {
      Write-Host "WARP sidecar: 管理端口 40000 无响应（sidecar 没跑？）"
    }
  } else {
    Write-Host "健康检查: 无响应"
  }
}

function 建备份([string]$原因) {
  $时间戳 = Get-Date -Format "yyyyMMdd-HHmmss"
  $备份目录 = Join-Path $状态目录 "backups\$时间戳-$原因"
  New-Item -ItemType Directory -Path $备份目录 -Force | Out-Null
  $清单 = @()
  foreach ($文件 in @(
    (Join-Path $状态目录 "proxy.json"),
    (Join-Path $状态目录 "pool-health.json"),
    (Join-Path $状态目录 "cache\catalog.json"),
    $启动脚本
  )) {
    if (Test-Path $文件) {
      $目标 = Join-Path $备份目录 (Split-Path $文件 -Leaf)
      Copy-Item $文件 $目标 -Force
      $哈希 = (Get-FileHash $文件 -Algorithm SHA256).Hash
      $清单 += "源=$文件`n备份=$目标`nSHA256=$哈希"
    }
  }
  $清单 | Set-Content (Join-Path $备份目录 "manifest.txt") -Encoding utf8
  Write-Host "备份完成: $备份目录"
  return $备份目录
}

function 停桥进程 {
  $桥PID = 获取监听PID $端口
  if (-not $桥PID) { Write-Host "端口 $端口 无进程，无需停止"; return }
  # 双保险：确认 PID 的进程命令行里确实有 gateway 字样，才准杀。
  $进程 = Get-CimInstance Win32_Process -Filter "ProcessId=$桥PID" -ErrorAction SilentlyContinue
  if ($进程 -and $进程.CommandLine -notmatch "server\.js|bun") {
    Write-Host "安全中止: PID $桥PID 的命令行不像 Fucking Opencode（$($进程.CommandLine)）"
    throw "端口 $端口 的进程不是 Fucking Opencode"
  }
  Write-Host "停止 Fucking Opencode PID=$桥PID"
  Stop-Process -Id $桥PID -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function 起桥进程 {
  Write-Host "启动 Fucking Opencode (start-fucking-opencode.cmd)"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$启动脚本`"" -WindowStyle Hidden
  $截止 = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $截止) {
    Start-Sleep -Milliseconds 800
    if (读健康) { Write-Host "Fucking Opencode 已就绪"; return $true }
  }
  Write-Host "30 秒内健康检查未通过"
  return $false
}

function 清理临时状态 {
  # 只删运行时可再生的状态；proxy.json（出口配置）永远保留。
  foreach ($文件 in @(
    (Join-Path $状态目录 "cache\catalog.json"),
    (Join-Path $状态目录 "pool-health.json")
  )) {
    if (Test-Path $文件) {
      Remove-Item $文件 -Force
      Write-Host "已清理: $文件"
    }
  }
}

function 做重置 {
  Write-Host "免责声明：本地重置不清空、不重置 OpenCode 服务端配额。只清理本地状态。"
  $桥PID前 = 获取监听PID $端口
  $保留PID前 = @{}
  foreach ($保留 in $保留端口) { $保留PID前[$保留] = 获取监听PID $保留 }
  Write-Host "重置前 PID: 20134=$桥PID前 8792=$($保留PID前[8792]) 8794=$($保留PID前[8794])"

  $备份目录 = 建备份 "reset"
  停桥进程
  清理临时状态
  $就绪 = 起桥进程

  $桥PID后 = 获取监听PID $端口
  foreach ($保留 in $保留端口) {
    $后 = 获取监听PID $保留
    if ($保留PID前[$保留] -and $后 -ne $保留PID前[$保留]) {
      Write-Host "严重: 端口 $保留 的 PID 变了（$($保留PID前[$保留]) → $后）！opencode2api 可能被波及，立即检查！"
    } else {
      Write-Host "端口 $保留 未受影响 (PID=$后)"
    }
  }
  if ($就绪 -and $桥PID后) {
    Write-Host "重置成功。备份在: $备份目录"
  } else {
    Write-Host "重置后健康检查失败；可用 -Rollback $备份目录 恢复"
  }
  return $备份目录
}

function 做回滚([string]$备份目录) {
  if (-not (Test-Path $备份目录)) { Write-Host "备份目录不存在: $备份目录"; return }
  Write-Host "免责声明：回滚只恢复本地文件，不涉及服务端配额。"
  停桥进程
  foreach ($文件 in (Get-ChildItem $备份目录 -File | Where-Object { $_.Name -notin @("manifest.txt", "SHA256SUMS.txt") })) {
    switch -Wildcard ($文件.Name) {
      "catalog.json"  { Copy-Item $文件.FullName (Join-Path $状态目录 "cache\catalog.json") -Force; Write-Host "恢复 catalog.json" }
      "pool-health.json" { Copy-Item $文件.FullName (Join-Path $状态目录 "pool-health.json") -Force; Write-Host "恢复 pool-health.json" }
      "proxy.json"    { Copy-Item $文件.FullName (Join-Path $状态目录 "proxy.json") -Force; Write-Host "恢复 proxy.json" }
      "start-fucking-opencode.cmd" { Copy-Item $文件.FullName $启动脚本 -Force; Write-Host "恢复 start-fucking-opencode.cmd" }
      default { Write-Host "跳过: $($文件.Name)" }
    }
  }
  if (起桥进程) { Write-Host "回滚完成" } else { Write-Host "回滚后健康检查未通过，请手动检查" }
}

function 测模型([string]$模型) {
  Write-Host "免责声明：这次测试会消耗少量上游配额（max_tokens=8）。"
  $体 = @{ model = $模型; max_tokens = 8; messages = @(@{ role = "user"; content = "回复两个字：收到" }) } | ConvertTo-Json -Depth 4
  try {
    $响应 = Invoke-WebRequest -Uri "http://127.0.0.1:$端口/v1/chat/completions" -Method Post `
      -ContentType "application/json" -Body $体 -TimeoutSec 60 -UseBasicParsing
    Write-Host ("HTTP {0}: 模型 {1} 有响应" -f $响应.StatusCode, $模型)
    Write-Host ($响应.Content.Substring(0, [Math]::Min(300, $响应.Content.Length)))
  } catch {
    $码 = $_.Exception.Response.StatusCode.value__
    Write-Host ("HTTP {0}: {1}" -f $码, $_.ErrorDetails.Message)
    if ($码 -eq 429) {
      Write-Host "429：上游仍限流。不要连续重置 —— 看 /health 里哪个出口进了冷却。"
    }
  }
}

# ---- 入口 ----
if ($回滚) {
  做回滚 $回滚
} elseif ($重置) {
  做重置
} elseif ($测试模型) {
  测模型 $测试模型
} else {
  # 默认只看状态，绝不擅自动手。
  显示状态
}
