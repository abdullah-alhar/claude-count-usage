@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Installer

:: =============================================================
::  Claude Count Usage - Windows Desktop Installer
::  Created by Abdullah Alhar
::
::  HOW TO USE:
::    Double-click this file.
::
::  REQUIRES:
::    - Node.js installed (https://nodejs.org)
::    - Claude WebExtension Launcher run at least once
:: =============================================================

:: ── Paths ─────────────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "LAUNCHER_DIR=%APPDATA%\Claude WebExtension Launcher"
set "EXTS_DIR=%LAUNCHER_DIR%\web-extensions"
set "TARGET_EXT=%EXTS_DIR%\usage-tracker"
set "BACKUP_DIR=%LAUNCHER_DIR%\usage-tracker-backup"
set "OLD_WRONG_BACKUP=%EXTS_DIR%\usage-tracker-original-backup"

:: Find Claude executable (check multiple possible paths)
set "CLAUDE_EXE="
if exist "%LAUNCHER_DIR%\app-latest\Claude.exe"          set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\Claude.exe"
if exist "%LAUNCHER_DIR%\app-latest\claude\Claude.exe"   set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\claude\Claude.exe"
if exist "%LAUNCHER_DIR%\app-latest\app\Claude.exe"      set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\app\Claude.exe"

cls
echo.
echo ================================================
echo    Claude Count Usage - Desktop Installer
echo    by Abdullah Alhar
echo ================================================
echo.

:: ── 1. Check Launcher ─────────────────────────────────────────
echo [Checking] Claude WebExtension Launcher...
if not exist "%EXTS_DIR%" (
    echo.
    echo [ERROR] Claude WebExtension Launcher is not set up.
    echo.
    echo  Please run the Claude WebExtension Launcher app first,
    echo  then double-click this installer again.
    echo.
    pause
    exit /b 1
)
echo [OK] Launcher found at:
echo      %LAUNCHER_DIR%

:: ── 2. Check Node.js ──────────────────────────────────────────
echo.
echo [Checking] Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js is not installed.
    echo.
    echo  Install it from: https://nodejs.org
    echo  Then double-click this installer again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo [OK] Node.js %NODE_VER%

:: ── 3. Check extension files ───────────────────────────────────
echo.
echo [Checking] Extension files...
if not exist "%SCRIPT_DIR%\manifest_electron.json" (
    echo [ERROR] manifest_electron.json not found.
    echo         Make sure install.bat is inside the claude-count-usage folder.
    pause
    exit /b 1
)
if not exist "%SCRIPT_DIR%\background.js" (
    echo [ERROR] background.js not found.
    pause
    exit /b 1
)
echo [OK] Extension files verified

:: ── 4. Remove any stale backup from INSIDE web-extensions ─────
echo.
if exist "%OLD_WRONG_BACKUP%" (
    echo [Fix] Removing old backup from inside web-extensions (caused duplicates)...
    rmdir /s /q "%OLD_WRONG_BACKUP%"
    echo [OK] Old stale backup cleaned up
)

:: ── 5. Backup original usage-tracker OUTSIDE web-extensions ───
echo.
if not exist "%BACKUP_DIR%" (
    if exist "%TARGET_EXT%" (
        echo [Backup] Saving original usage-tracker...
        xcopy /e /i /q "%TARGET_EXT%" "%BACKUP_DIR%\" >nul 2>&1
        if errorlevel 1 (
            echo [WARN] Backup failed, continuing anyway...
        ) else (
            echo [OK] Backup saved to:
            echo      %BACKUP_DIR%
        )
    )
) else (
    echo [WARN] Backup already exists - updating previous installation
)

:: ── 6. Remove unwanted extensions ─────────────────────────────
echo.
echo [Cleaning] Removing extensions that add unwanted toolbar icons...
for %%E in (sentinel userscript-toolbox) do (
    if exist "%EXTS_DIR%\%%E" (
        echo  Removing: %%E
        rmdir /s /q "%EXTS_DIR%\%%E"
    )
)
echo [OK] Unwanted extensions removed

:: ── 7. Install our extension ───────────────────────────────────
echo.
echo [Installing] Claude Count Usage...
if exist "%TARGET_EXT%" rmdir /s /q "%TARGET_EXT%"
mkdir "%TARGET_EXT%"

:: robocopy: copy all, exclude installer/doc files and .git
robocopy "%SCRIPT_DIR%" "%TARGET_EXT%" /e ^
    /xf install.bat uninstall.bat install.command uninstall.command ^
        asar-patcher.js README.md PRIVACY.md manifest_chrome.json ^
    /xd .git ^
    /nfl /ndl /njh /njs /nc /ns /np >nul 2>&1

:: Set Electron manifest as the active manifest
copy /y "%TARGET_EXT%\manifest_electron.json" "%TARGET_EXT%\manifest.json" >nul
echo [OK] Extension installed to:
echo      %TARGET_EXT%

:: ── 8. Build generated content-component files ────────────────
echo.
if exist "%TARGET_EXT%\scripts\build-dataclasses.js" (
    echo [Build] Generating content-components...
    node "%TARGET_EXT%\scripts\build-dataclasses.js"
    if errorlevel 1 (
        echo [WARN] Build step failed - pre-built files will be used
    ) else (
        echo [OK] Content components generated
    )
)

:: ── 9. Kill and relaunch Claude ────────────────────────────────
echo.
echo [Launch] Restarting Claude...
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if defined CLAUDE_EXE (
    start "" "%CLAUDE_EXE%"
    echo [OK] Claude launched from:
    echo      %CLAUDE_EXE%
) else (
    echo [WARN] Claude.exe not found automatically.
    echo        Please open Claude manually from the launcher app.
    echo.
    echo  Common locations to check:
    echo    %LAUNCHER_DIR%\app-latest\
)

:: ── Done ───────────────────────────────────────────────────────
echo.
echo ================================================
echo    Installation complete!
echo ================================================
echo.
echo What to look for in Claude:
echo   ^* Left sidebar   -^> Usage bars ^(Session + Weekly^)
echo   ^* Open any chat  -^> Token / Cost / Cache stats below heading
echo.
echo No Ko-fi button. No duplicate stats. No extra toolbar icons.
echo.
echo To uninstall later: double-click  uninstall.bat
echo.
pause
