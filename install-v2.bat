@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Installer v2

:: =============================================================
::  Claude Count Usage - Windows Desktop Installer v2
::  Created by Abdullah Alhar
::
::  HOW TO USE:
::    Double-click this file, or run from Command Prompt:
::      cd C:\path\to\claude-count-usage
::      install-v2.bat
::
::  What's new in v2:
::    Fixed: Patch now survives Windows restarts
::    Fixed: Better ASAR corruption recovery
::    Fixed: Cleaner temp file cleanup on failed runs
::    Fixed: Improved Claude.exe integrity hash update
:: =============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "GITHUB_ZIP=https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

cls
echo.
echo ================================================
echo    Claude Count Usage - Installer v2
echo    by Abdullah Alhar
echo ================================================
echo.

:: ── 1. Check Node.js ──────────────────────────────────────────
echo [Checking] Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js is not installed.
    echo.
    echo  Please install Node.js from: https://nodejs.org
    echo  Then double-click this installer again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo [OK] Node.js !NODE_VER! found.

:: ── 2. Check or Download Extension Files ───────────────────────
set "IS_TEMP_SOURCE=0"
set "EXT_DIR=%SCRIPT_DIR%"

if not exist "%SCRIPT_DIR%\manifest_electron.json" (
    echo.
    echo [Info] Standalone installer detected - fetching latest extension from GitHub...
    set "TMP_DIR=%TEMP%\ccu-dl-%RANDOM%"
    set "IS_TEMP_SOURCE=1"
    mkdir "!TMP_DIR!" >nul 2>&1
    set "ZIP_PATH=!TMP_DIR!\repo.zip"

    echo [Downloading] Downloading latest release from GitHub...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('%GITHUB_ZIP%', '!ZIP_PATH!')"
    if errorlevel 1 (
        echo [ERROR] Failed to download extension files from GitHub.
        pause
        exit /b 1
    )

    echo [Extracting] Unpacking extension files...
    powershell -NoProfile -Command "Expand-Archive -Path '!ZIP_PATH!' -DestinationPath '!TMP_DIR!' -Force"
    set "EXT_DIR=!TMP_DIR!\claude-count-usage-main"
    if not exist "!EXT_DIR!\manifest_electron.json" (
        echo [ERROR] Downloaded archive did not contain extension files.
        pause
        exit /b 1
    )
    echo [OK] Downloaded latest extension files from GitHub
) else (
    echo [OK] Using local extension files from: %SCRIPT_DIR%
)

:: ── 3. Configure manifest and dataclasses ───────────────────────
echo.
echo [Configuring] Preparing extension files...
if exist "%EXT_DIR%\manifest_electron.json" (
    copy /y "%EXT_DIR%\manifest_electron.json" "%EXT_DIR%\manifest.json" >nul
)
if exist "%EXT_DIR%\scripts\build-dataclasses.js" (
    node "%EXT_DIR%\scripts\build-dataclasses.js" >nul 2>&1
)
echo [OK] Extension ready

:: ── 4. Close Claude & Clean up stale temp files ──────────────
echo.
echo [Closing] Closing Claude Desktop to release file locks...
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1 || ping -n 3 127.0.0.1 >nul

:: Clear any stale temp/corrupted packages from earlier failed runs
del /f /q "%TEMP%\Claude-*.msix" >nul 2>&1
del /f /q "%TEMP%\Claude-*.zip" >nul 2>&1
del /f /q "%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\app\resources\app.asar.tmp-*" >nul 2>&1
del /f /q "%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\resources\app.asar.tmp-*" >nul 2>&1
del /f /q "%LOCALAPPDATA%\Programs\Claude\resources\app.asar.tmp-*" >nul 2>&1

:: ── 5. Run Injector ─────────────────────────────────────────
echo.
echo [Installing] Injecting into Claude Desktop (v2)...

node "%EXT_DIR%\desktop-injector.js" install "%EXT_DIR%"
if errorlevel 1 (
    echo.
    echo [ERROR] Installation failed.
    echo If Claude Desktop is still open, please close it completely
    echo from Task Manager (Ctrl+Shift+Esc) and try again.
    echo.
    pause
    exit /b 1
)

:: Clean up temp folder if any
if "!IS_TEMP_SOURCE!"=="1" (
    if exist "!TMP_DIR!" rmdir /s /q "!TMP_DIR!" >nul 2>&1
)

:: ── 6. Verify patch ─────────────────────────────────────────
echo.
echo [Verifying] Checking patch status...
set "PATCH_STATUS=UNKNOWN"
for /f "usebackq tokens=*" %%s in (`node "%EXT_DIR%\desktop-injector.js" check 2^>nul`) do set "PATCH_STATUS=%%s"
if "!PATCH_STATUS!"=="PATCHED" (
    echo [OK] Verified: Claude Desktop is correctly patched
) else (
    echo [WARN] Patch status: !PATCH_STATUS! - Claude may still work, verify manually
)

:: ── 7. Restart Claude ──────────────────────────────────────────
echo.
echo [Launch] Starting Claude Desktop...
ping -n 2 127.0.0.1 >nul

set "CLAUDE_EXE=%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\Claude.exe"
if not exist "%CLAUDE_EXE%" set "CLAUDE_EXE=%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\app\Claude.exe"
if not exist "%CLAUDE_EXE%" set "CLAUDE_EXE=%LOCALAPPDATA%\Programs\Claude\Claude.exe"

set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Claude.lnk"

set "LAUNCHED=0"
if exist "%CLAUDE_EXE%" (
    for %%I in ("%CLAUDE_EXE%") do set "EXE_DIR=%%~dpI"
    start "" /d "!EXE_DIR!" "%CLAUDE_EXE%"
    echo [OK] Claude Desktop launched successfully!
    set "LAUNCHED=1"
)
if "!LAUNCHED!"=="0" if exist "%SHORTCUT%" (
    start "" "%SHORTCUT%"
    echo [OK] Claude Desktop launched from Start Menu shortcut!
    set "LAUNCHED=1"
)
if "!LAUNCHED!"=="0" (
    start "" "claude:" >nul 2>&1
    echo [OK] Claude Desktop launch triggered!
)

:: ── 8. Done ───────────────────────────────────────────────────
echo.
echo ================================================
echo    Installation complete! (v2)
echo ================================================
echo.
echo What to look for in Claude Desktop:
echo   * Left sidebar   -^> Usage bars (Session 5h + Weekly)
echo   * In any chat    -^> Token / Cost / Cache stats below heading
echo.
echo What's new in v2:
echo   * Better ASAR corruption recovery (auto-restores from backup)
echo   * Improved Claude.exe integrity hash patching
echo   * Cleaner handling of stale temp files
echo.
echo To uninstall later: double-click  uninstall.bat
echo.
pause
