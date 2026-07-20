@echo off
setlocal EnableDelayedExpansion
title ASO Staff OT System — Installer
color 0A

echo.
echo  ===========================================
echo   ASO Staff OT System v9.2 — Auto Installer
echo   American Safety Options
echo  ===========================================
echo.

:: ── Check Admin privileges ─────────────────────────────────
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [!] This installer needs Administrator rights.
    echo      Right-click INSTALL.bat and choose "Run as administrator"
    echo.
    pause
    exit /b 1
)

:: ── Step 1: Check Node.js ──────────────────────────────────
echo  [1/5] Checking Node.js...
where node >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [!] Node.js not found. Downloading Node.js 20 LTS...
    echo      This may take a minute — please wait.
    echo.
    curl -L -o "%TEMP%\node_installer.msi" "https://nodejs.org/dist/v20.19.1/node-v20.19.1-x64.msi"
    if %errorLevel% NEQ 0 (
        echo  [ERROR] Failed to download Node.js.
        echo          Please install it manually from: https://nodejs.org
        pause
        exit /b 1
    )
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    if %errorLevel% NEQ 0 (
        echo  [ERROR] Node.js installation failed.
        echo          Please install it manually from: https://nodejs.org
        pause
        exit /b 1
    )
    :: Refresh PATH after Node install
    call refreshenv >nul 2>&1
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
    echo  [OK] Node.js installed successfully.
) else (
    for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
    echo  [OK] Node.js found: !NODE_VER!
)

:: ── Step 2: Check Python ───────────────────────────────────
echo.
echo  [2/5] Checking Python...
where python >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [!] Python not found. Downloading Python 3.11...
    curl -L -o "%TEMP%\python_installer.exe" "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
    if %errorLevel% NEQ 0 (
        echo  [ERROR] Failed to download Python.
        echo          Please install it manually from: https://www.python.org
        pause
        exit /b 1
    )
    "%TEMP%\python_installer.exe" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0
    if %errorLevel% NEQ 0 (
        echo  [ERROR] Python installation failed.
        pause
        exit /b 1
    )
    set "PATH=%PATH%;%ProgramFiles%\Python311;%ProgramFiles%\Python311\Scripts"
    echo  [OK] Python installed successfully.
) else (
    for /f "tokens=*" %%v in ('python --version 2^>nul') do set PY_VER=%%v
    echo  [OK] Python found: !PY_VER!
)

:: ── Step 3: Install Windows Build Tools ───────────────────
echo.
echo  [3/5] Installing Windows build tools (needed for better-sqlite3)...
echo        This may take several minutes — please wait...
echo.

:: Install Visual Studio Build Tools via npm
call npm install -g windows-build-tools --vs2019 >nul 2>&1

:: Also try installing via choco if available, otherwise use npm node-gyp
call npm install -g node-gyp >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [WARN] node-gyp global install had issues, continuing...
)

:: Set Python path for node-gyp
for /f "delims=" %%p in ('where python 2^>nul') do (
    call npm config set python "%%p" >nul 2>&1
    goto :python_set
)
:python_set
echo  [OK] Build tools configured.

:: ── Step 4: Install npm dependencies ──────────────────────
echo.
echo  [4/5] Installing app dependencies (express + better-sqlite3)...
echo        Installing express...
call npm install express --save >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [ERROR] Failed to install express.
    pause
    exit /b 1
)
echo  [OK] Express installed.

echo        Installing better-sqlite3 (may take 1-2 minutes)...

:: Try prebuilt binary first (fastest, no compile needed)
call npm install better-sqlite3 --save >nul 2>&1
if %errorLevel% NEQ 0 (
    echo  [!] Prebuilt binary failed. Trying to compile from source...
    :: Force rebuild with node-gyp
    call npm install better-sqlite3 --build-from-source >nul 2>&1
    if %errorLevel% NEQ 0 (
        echo.
        echo  [ERROR] better-sqlite3 could not be installed automatically.
        echo.
        echo  Please try these manual steps:
        echo    1. Install Visual Studio Build Tools from:
        echo       https://aka.ms/vs/17/release/vs_buildtools.exe
        echo       (select "Desktop development with C++")
        echo    2. Run this installer again.
        echo.
        pause
        exit /b 1
    )
)
echo  [OK] better-sqlite3 installed.

:: ── Step 5: Create launcher shortcuts ─────────────────────
echo.
echo  [5/5] Creating desktop shortcut...

:: Create a VBS launcher if start.vbs is missing
if not exist "%~dp0start.vbs" (
    echo Set WshShell = CreateObject("WScript.Shell") > "%~dp0start.vbs"
    echo WshShell.CurrentDirectory = "%~dp0" >> "%~dp0start.vbs"
    echo WshShell.Run "node server.js", 0, False >> "%~dp0start.vbs"
    echo WScript.Sleep 2000 >> "%~dp0start.vbs"
    echo WshShell.Run "http://localhost:8420", 1, False >> "%~dp0start.vbs"
)

:: Create desktop shortcut pointing to start.vbs
set SHORTCUT_PATH=%USERPROFILE%\Desktop\ASO OT System.lnk
set VBS_PATH=%~dp0start.vbs

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); ^
   $s.TargetPath = 'wscript.exe'; ^
   $s.Arguments = '\"%VBS_PATH%\"'; ^
   $s.WorkingDirectory = '%~dp0'; ^
   $s.Description = 'ASO Staff OT System'; ^
   $s.Save()" >nul 2>&1

if exist "%SHORTCUT_PATH%" (
    echo  [OK] Desktop shortcut created.
) else (
    echo  [WARN] Could not create shortcut — you can launch via start.vbs manually.
)

:: ── Done ───────────────────────────────────────────────────
echo.
echo  ===========================================
echo   Installation Complete!
echo  ===========================================
echo.
echo   To start the app:
echo     Double-click "ASO OT System" on your Desktop
echo     OR run:  node server.js
echo.
echo   The app will open at: http://localhost:8420
echo   Default login:  admin / admin123
echo.
echo   Data is saved to:
echo   %USERPROFILE%\ASO_OT_Data\aso_ot.db
echo.

set /p LAUNCH=  Start the server now? (Y/N): 
if /i "!LAUNCH!"=="Y" (
    echo.
    echo  Starting server... (close this window to stop)
    echo  Opening http://localhost:8420 in your browser...
    echo.
    start "" "http://localhost:8420"
    cd /d "%~dp0"
    node server.js
) else (
    echo.
    echo  Use the desktop shortcut or run "node server.js" to start.
    pause
)
