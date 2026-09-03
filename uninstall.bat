@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Uninstaller

:: =============================================================
::  Claude Count Usage - Windows Desktop UNINSTALLER
::  Created by Abdullah Alhar
:: =============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

cls
echo.
echo ================================================
echo    Claude Count Usage - Uninstaller
echo    by Abdullah Alhar
echo ================================================
echo.

set "NODE_DIR=%LOCALAPPDATA%\ClaudeCountUsage\node"
if exist "!NODE_DIR!\node.exe" (
    set "PATH=!NODE_DIR!;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is required to unpatch.
    pause
    exit /b 1
)

if exist "%SCRIPT_DIR%\desktop-injector.js" (
    node "%SCRIPT_DIR%\desktop-injector.js" unpatch
) else (
    echo [Restore] Checking Claude installations...
    set "PORTABLE_DIR=%LOCALAPPDATA%\ClaudeDesktopInjector\Claude"
    if exist "!PORTABLE_DIR!\resources\app.asar.bak" (
        copy /y "!PORTABLE_DIR!\resources\app.asar.bak" "!PORTABLE_DIR!\resources\app.asar" >nul
        if exist "!PORTABLE_DIR!\resources\injected-extension" rmdir /s /q "!PORTABLE_DIR!\resources\injected-extension"
        echo [OK] Portable Claude restored.
    )
)

:: Restart Claude
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 1 /nobreak >nul

set "PORTABLE_EXE=%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\Claude.exe"
if exist "%PORTABLE_EXE%" (
    start "" "%PORTABLE_EXE%"
) else (
    start claude: >nul 2>&1
)

echo.
echo ================================================
echo    Uninstall complete!
echo ================================================
echo.
echo Claude Desktop has been restored to its original state.
echo.
pause
