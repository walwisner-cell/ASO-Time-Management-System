@echo off
title ASO OT System — Create Desktop Shortcut
color 0A

echo.
echo  Creating desktop shortcut for ASO OT System...
echo.

:: Get the folder this batch file is in
set "APP_DIR=%~dp0"
:: Remove trailing backslash
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "VBS_PATH=%APP_DIR%\start.vbs"
set "SHORTCUT=%USERPROFILE%\Desktop\ASO OT System.lnk"

:: Check start.vbs exists
if not exist "%VBS_PATH%" (
    echo  [ERROR] Cannot find start.vbs in:
    echo          %APP_DIR%
    echo.
    echo  Make sure this file is in the same folder as start.vbs
    pause
    exit /b 1
)

:: Write a tiny VBS just to create the shortcut
set "MAKER=%TEMP%\make_shortcut.vbs"

echo Set ws = CreateObject("WScript.Shell")                          > "%MAKER%"
echo Set lnk = ws.CreateShortcut("%SHORTCUT%")                      >> "%MAKER%"
echo lnk.TargetPath = "wscript.exe"                                 >> "%MAKER%"
echo lnk.Arguments = Chr(34) ^& "%VBS_PATH%" ^& Chr(34)            >> "%MAKER%"
echo lnk.WorkingDirectory = "%APP_DIR%"                             >> "%MAKER%"
echo lnk.Description = "ASO Staff OT System"                        >> "%MAKER%"
echo lnk.IconLocation = "shell32.dll,23"                            >> "%MAKER%"
echo lnk.Save                                                        >> "%MAKER%"

cscript //nologo "%MAKER%"
del "%MAKER%" >nul 2>&1

if exist "%SHORTCUT%" (
    echo  [OK]  Shortcut created on your Desktop!
    echo.
    echo        Double-click "ASO OT System" on your Desktop to launch the app.
    echo.
) else (
    echo  [FAIL] Shortcut could not be created.
    echo.
    echo  Try this instead:
    echo    1. Right-click your Desktop
    echo    2. New ^> Shortcut
    echo    3. Target:   wscript.exe "%VBS_PATH%"
    echo    4. Name it:  ASO OT System
    echo.
)

pause
