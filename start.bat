@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Сϫ �� һ������
echo.
echo ==========================================
echo   Сϫ ������� �� һ������
echo ==========================================
echo.

rem ---------- 1. ǰ�˹��� ----------
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
  echo [1/3] ʹ�� Node: !NODE_DIR!
)

where npm >nul 2>nul
if errorlevel 1 goto no_node

if exist "frontend\node_modules" goto build
echo ��װǰ������...
pushd frontend
call npm install
if errorlevel 1 goto install_fail
popd

:build
echo ����ǰ��...
pushd frontend
call npm run build
if errorlevel 1 goto build_fail
popd
goto deps

:install_fail
popd
echo [����] ǰ��������װʧ�ܣ��������������
pause
exit /b 1

:build_fail
popd
echo [����] ǰ�˹���ʧ�ܣ���鿴�Ϸ���־
pause
exit /b 1

:no_node
if exist "frontend\dist\index.html" goto skip_build
echo [����] δ��⵽ Node/npm���� frontend\dist �����ڣ��޷�����ǰ��
pause
exit /b 1

:skip_build
echo [1/3] δ��⵽ Node������������ֱ��ʹ������ frontend\dist

rem ---------- 2. ������� ----------
:deps
echo [2/3] ���������...
where python >nul 2>nul
if errorlevel 1 (
  echo [����] δ��⵽ Python�����Ȱ�װ Python 3.10+
  pause
  exit /b 1
)
python -c "import fastapi, uvicorn, edge_tts" >nul 2>nul
if not errorlevel 1 goto port
echo ��װ�������...
python -m pip install -r backend\requirements.txt
if errorlevel 1 (
  echo [����] ���������װʧ�ܣ��������������
  pause
  exit /b 1
)

rem ---------- 3. ������� ----------
:port
echo [3/3] ����˷���...
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.6); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if errorlevel 1 goto launch
echo ��⵽ 8600 �˿����з��������������...
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
echo ������˷���...
start "Сϫ���" cmd /k "python backend\main.py"

set /a TRIES=0
:wait
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.6); sys.exit(0 if s.connect_ex(('127.0.0.1',8600))==0 else 1)" >nul 2>nul
if not errorlevel 1 goto open
set /a TRIES+=1
if %TRIES% geq 30 goto timeout
ping -n 2 127.0.0.1 >nul
goto wait

:open
start "" http://127.0.0.1:8600
echo.
echo ������ɣ�ҳ���Ѵ򿪣�http://127.0.0.1:8600
ping -n 4 127.0.0.1 >nul
goto end

:timeout
echo [����] �ȴ���˳�ʱ����鿴��Сϫ��ˡ����ڵı�����Ϣ
pause
goto end

:end
endlocal
