@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 小汐 · 一键启动
echo.
echo ==========================================
echo   小汐 虚拟伴侣 · 一键启动
echo ==========================================
echo.

rem ---------- 1. 前端构建 ----------
set "NODE_DIR="
where npm >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.fnm\node-portable" (
    for /d %%d in ("%USERPROFILE%\.fnm\node-portable\node-*") do (
      if not defined NODE_DIR set "NODE_DIR=%%d"
    )
  )
)
if defined NODE_DIR (
  set "PATH=!NODE_DIR!;!PATH!"
  echo [1/3] 使用 Node: !NODE_DIR!
)

where npm >nul 2>nul
if errorlevel 1 goto no_node

if exist "frontend\node_modules" goto build
echo 安装前端依赖...
pushd frontend
call npm install
if errorlevel 1 goto install_fail
popd

:build
echo 构建前端...
pushd frontend
call npm run build
if errorlevel 1 goto build_fail
popd
goto deps

:install_fail
popd
echo [错误] 前端依赖安装失败，请检查上方日志
pause
exit /b 1

:build_fail
popd
echo [错误] 前端构建失败，请检查上方日志
pause
exit /b 1

:no_node
if exist "frontend\dist\index.html" goto skip_build
echo [错误] 未检测到 Node/npm，且 frontend\dist 不存在，无法构建前端
pause
exit /b 1

:skip_build
echo [1/3] 未检测到 Node，跳过构建，直接使用已有 frontend\dist

rem ---------- 2. 后端依赖 ----------
:deps
echo [2/3] 检查后端依赖...
where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Python，请先安装 Python 3.10+
  pause
  exit /b 1
)
python -c "import fastapi, uvicorn, edge_tts" >nul 2>nul
if not errorlevel 1 goto port
echo 安装后端依赖...
python -m pip install -r backend\requirements.txt
if errorlevel 1 (
  echo [错误] 后端依赖安装失败，请检查上方日志
  pause
  exit /b 1
)

rem ---------- 3. 启动服务 ----------
:port
echo [3/3] 启动后端服务...
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.6); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if errorlevel 1 goto launch
echo 检测到 8600 端口已有服务，正在重启...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8600 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

set /a FREE_TRIES=0
:wait_free
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if errorlevel 1 goto launch
set /a FREE_TRIES+=1
if %FREE_TRIES% geq 10 goto launch
ping -n 2 127.0.0.1 >nul
goto wait_free

:launch
echo 正在拉起后端服务...
start "小汐后端" cmd /k "python backend\main.py"

set /a TRIES=0
:wait
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.6); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if not errorlevel 1 goto open
set /a TRIES+=1
if %TRIES% geq 40 goto timeout
ping -n 2 127.0.0.1 >nul
goto wait

:open
ping -n 3 127.0.0.1 >nul
echo 正在打开页面...
powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:8600'" >nul 2>nul
if errorlevel 1 start "" "http://127.0.0.1:8600"
echo.
echo 启动完成，页面已打开：http://127.0.0.1:8600
ping -n 4 127.0.0.1 >nul
goto end

:timeout
echo [提示] 后端启动较慢，先打开页面，若显示无法连接请稍后刷新
powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:8600'" >nul 2>nul
if errorlevel 1 start "" "http://127.0.0.1:8600"
echo 请查看「小汐后端」窗口中的报错信息
pause
goto end

:end
endlocal
