@echo off
chcp 936 >nul
title 一键重启（微信 + QQ）
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
    echo 需要管理员权限来结束旧进程，正在申请...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ============================================
echo   一键重启：微信群助手 + QQ 协议端
echo ============================================
echo.
echo [1/4] 停止旧进程...
powershell -NoProfile -Command "Get-Process node,python -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>&1
timeout /t 4 >nul

echo [2/4] 清除停止标记...
if exist "%~dp0data\STOP.flag" del /q "%~dp0data\STOP.flag"

echo [3/4] 通过计划任务启动机器人（非管理员权限，便于管理）...
schtasks /run /tn DeepSeekBotWatchdog >nul 2>&1
echo     等待就绪（约 30 秒）...
timeout /t 30 >nul

echo [4/4] 启动 QQ 协议端...
cd /d "%~dp0tools\napcat\shell\napcat"
start "" launcher.bat
cd /d "%~dp0"

echo.
echo ============================================
echo  完成
echo   · 微信：每个群要有独立窗口
echo   · QQ ：NapCat 窗口需登录
echo   · 后台：http://127.0.0.1:8898
echo ============================================
pause