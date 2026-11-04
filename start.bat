@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title XiaoXi Launcher
echo.
echo ==========================================
echo   XiaoXi Virtual Companion - Launcher
echo ==========================================
echo.

rem ---------- 1. Frontend build ----------
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
  echo [1/3] Using Node: !NODE_DIR!
)

where npm >nul 2>nul
if errorlevel 1 goto no_node

if exist "frontend\node_modules" goto build
echo Installing frontend dependencies...
pushd frontend
call npm install
if errorlevel 1 goto install_fail
popd

:build
echo Building frontend...
pushd frontend
call npm run build
if errorlevel 1 goto build_fail
popd
goto deps

:install_fail
popd
echo [ERROR] Frontend dependency install failed. Check the log above.
pause
exit /b 1

:build_fail
popd
echo [ERROR] Frontend build failed. Check the log above.
pause
exit /b 1

:no_node
if exist "frontend\dist\index.html" goto skip_build
echo [ERROR] Node/npm not found and frontend\dist is missing.
pause
exit /b 1

:skip_build
echo [1/3] Node not found. Using existing frontend\dist.

rem ---------- 2. Backend dependencies ----------
:deps
echo [2/3] Checking backend dependencies...
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python 3.10+.
  pause
  exit /b 1
)
python -c "import fastapi, uvicorn, edge_tts" >nul 2>nul
if not errorlevel 1 goto port
echo Installing backend dependencies...
python -m pip install -r backend\requirements.txt
if errorlevel 1 (
  echo [ERROR] Backend dependency install failed. Check the log above.
  pause
  exit /b 1
)

rem ---------- 3. Start service ----------
:port
echo [3/3] Starting backend service...
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.6); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if errorlevel 1 goto launch
echo Port 8600 is in use. Restarting service...
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
echo Starting backend service...
start "XiaoXi Backend" cmd /k "python backend\main.py"

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
echo Opening browser...
powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:8600'" >nul 2>nul
if errorlevel 1 start "" "http://127.0.0.1:8600"
echo.
echo Done. Page opened: http://127.0.0.1:8600
ping -n 4 127.0.0.1 >nul
goto end

:timeout
echo [WARN] Backend startup is slow. Opening the page anyway; refresh if it fails to load.
powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:8600'" >nul 2>nul
if errorlevel 1 start "" "http://127.0.0.1:8600"
echo Check the "XiaoXi Backend" window for errors.
pause
goto end

:end
endlocal
