@echo off
chcp 65001 >nul
setlocal
echo ============================================
echo    DeepSeek 群助手 · 常驻运行设置
echo ============================================
echo.

echo [1/4] 关闭「睡眠」和「休眠」（仅交流电）...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hybrid-sleep-timeout-ac 0
powercfg /change disk-timeout-ac 0
echo     完成：插电时永不自动睡眠

echo.
echo [2/4] 允许定时任务唤醒电脑...
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 >nul 2>&1
powercfg /setactive SCHEME_CURRENT >nul 2>&1
echo     完成

echo.
echo [3/4] 显示器 10 分钟后关闭（省电，不影响运行）...
powercfg /change monitor-timeout-ac 10
echo     完成

echo.
echo [4/4] 关闭“快速启动”（避免关机后显卡/微信状态异常）...
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f >nul 2>&1
if %errorlevel%==0 (echo     完成) else (echo     跳过（需要管理员权限）)

echo.
echo ============================================
echo  已设置完成。请注意：
echo   · 电脑必须保持「开机」状态，合盖/关机则停止工作
echo   · 请把电源计划设为「高性能」并插电
echo   · 建议关闭 Windows 自动更新重启
echo ============================================
echo.
pause
