@echo off
rem 自启动 fucking-opencode（端口 20134）
rem 若已有进程在监听 20134 则直接退出，避免重复启动。
netstat -ano | findstr /R /C:"LISTENING" | findstr /C:":20134 " >nul 2>&1
if %errorlevel%==0 exit /b 0
cd /d "%~dp0"
set PORT=20134
set HOST=127.0.0.1
set NODE_ENV=production
set TOOL_PROFILE_SCOPE=full
rem 面板登录密码放在未跟踪的 panel-password.txt（每行一个密码）。
if exist "%~dp0panel-password.txt" set /p PANEL_PASSWORD=<"%~dp0panel-password.txt"
rem 必须用 Bun 运行：Node 会被运行时守卫拒绝（TLS 指纹基线）。
"C:\Users\Zyrex\.bun\bin\bun.exe" server.js > fucking-opencode-log.txt 2> fucking-opencode-err.txt
