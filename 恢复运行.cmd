@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在恢复群助手...
powershell -NoProfile -Command "Remove-Item -LiteralPath '%~dp0data\STOP.flag' -Force -ErrorAction SilentlyContinue"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\watchdog.ps1"
echo.
echo 已恢复，大约 20 秒后就绪。
timeout /t 3 >nul