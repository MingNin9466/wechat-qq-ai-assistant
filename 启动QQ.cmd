@echo off
chcp 936 >nul
title QQ 协议端（NapCat）
cd /d "%~dp0tools\napcat\shell\napcat"
echo ============================================
echo   QQ 协议端 NapCat
echo ============================================
echo.
echo 1. 启动时会弹「用户账户控制」，请点【是】（注入需要管理员权限）
echo 2. QQ 登录窗口出来后，用 QQ 小号扫码
echo 3. 登录后命令行窗口不要关
echo.
pause
call launcher.bat
echo.
echo 如果 QQ 没起来，把上面的报错截图发我。
pause