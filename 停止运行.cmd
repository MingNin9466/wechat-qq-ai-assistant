@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在停止群助手并禁止自动重启...
powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '%~dp0data' | Out-Null; Set-Content -LiteralPath '%~dp0data\STOP.flag' -Value ('stopped ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8"
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
echo.
echo 已停止。看门狗不会再拉起它。
echo 想恢复请运行「恢复运行.cmd」。
timeout /t 3 >nul