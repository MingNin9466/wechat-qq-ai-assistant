@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8898"
set "URL=http://127.0.0.1:%PORT%"

echo ============================================
echo    DeepSeek 群助手 · 后台
echo ============================================
echo.

echo [1/3] 检查后台是否已在运行...
powershell -NoProfile -Command "try{ (New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close(); exit 0 }catch{ exit 1 }"
if %errorlevel%==0 (
    echo     后台已在运行
    goto open
)

echo [2/3] 后台没运行，正在启动机器人（窗口最小化）...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'start.mjs','--chat','测试ai','--chat','四帮人','--self-name','大肥鱼' -WorkingDirectory '%~dp0' -WindowStyle Minimized"

echo     等待后台就绪（最多 40 秒）...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ Start-Sleep -Milliseconds 1000; try{ (New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close(); exit 0 }catch{} }; exit 1"
if %errorlevel% neq 0 (
    echo     [错误] 后台 40 秒内没起来，请手动运行 start.mjs 看看报错。
    pause
    exit /b 1
)
echo     启动成功

:open
echo [3/3] 打开后台页面...
start "" "%URL%"
ping -n 2 127.0.0.1 >nul
exit /b 0
