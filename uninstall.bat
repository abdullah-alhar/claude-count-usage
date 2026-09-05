@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Uninstaller

:: =============================================================
::  Claude Count Usage - Windows Desktop UNINSTALLER
::  Created by Abdullah Alhar
::
::  Performs a COMPLETE uninstall: deletes the Claude Desktop app
::  entirely, rather than restoring the patched app.asar in place
::  (that relied on a backup made on first patch, which goes stale
::  the moment Claude Desktop auto-updates).
::
::  Uses desktop-injector.js's locateClaude() - the SAME lookup the
::  installer already relies on - so it finds Claude wherever it
::  actually lives (portable copy, Programs, AppData, MSIX, etc.)
::  instead of guessing a single fixed path.
::
::  After this runs, download a fresh copy of Claude Desktop from
::  https://claude.ai/download if you want to keep using it without
::  this extension.
:: =============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "GITHUB_ZIP=https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"
set "IS_TEMP_SOURCE=0"
set "EXT_DIR=%SCRIPT_DIR%"

cls
echo.
echo ================================================
echo    Claude Count Usage - Uninstaller
echo    by Abdullah Alhar
echo ================================================
echo.

:: ── Find Node ────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is required to locate Claude Desktop.
    echo         Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

:: ── Get desktop-injector.js (always fetch the latest from GitHub) ──
echo [Info] Fetching latest uninstaller files from GitHub...
set "TMP_DIR=%TEMP%\ccu-uninstall-%RANDOM%"
set "IS_TEMP_SOURCE=1"
mkdir "!TMP_DIR!" >nul 2>&1
set "ZIP_PATH=!TMP_DIR!\repo.zip"

powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('%GITHUB_ZIP%', '!ZIP_PATH!')"
if errorlevel 1 (
    echo [ERROR] Failed to download uninstaller files from GitHub.
    pause
    exit /b 1
)
powershell -NoProfile -Command "Expand-Archive -Path '!ZIP_PATH!' -DestinationPath '!TMP_DIR!' -Force"
set "EXT_DIR=!TMP_DIR!\claude-count-usage-main"
if not exist "!EXT_DIR!\desktop-injector.js" (
    echo [ERROR] Downloaded archive did not contain desktop-injector.js.
    pause
    exit /b 1
)

:: ── Locate Claude Desktop ────────────────────────────────────
set "LOCATE_OUTPUT="
for /f "delims=" %%A in ('node "%EXT_DIR%\desktop-injector.js" locate 2^>nul') do set "LOCATE_OUTPUT=%%A"

if "%LOCATE_OUTPUT%"=="NOT_FOUND" (
    echo [!] Claude Desktop was not found on this PC.
    echo     Nothing to uninstall.
    call :cleanup_temp
    pause
    exit /b 0
)

echo %LOCATE_OUTPUT%| findstr /b "PROTECTED:" >nul
if not errorlevel 1 (
    set "APP_PATH=%LOCATE_OUTPUT:PROTECTED:=%"
    echo [!] Claude Desktop at !APP_PATH! is a Microsoft Store / managed install.
    echo     That needs to be removed through Windows Settings, not this script.
    echo     Opening Settings -^> Apps for you now...
    start ms-settings:appsfeatures
    call :cleanup_temp
    pause
    exit /b 0
)

echo %LOCATE_OUTPUT%| findstr /b "FOUND:" >nul
if errorlevel 1 (
    echo [ERROR] Could not determine whether Claude Desktop is installed.
    echo         Unexpected output: %LOCATE_OUTPUT%
    call :cleanup_temp
    pause
    exit /b 1
)
set "APP_PATH=%LOCATE_OUTPUT:FOUND:=%"

echo This will completely DELETE Claude Desktop from this PC:
echo     %APP_PATH%
echo.
echo This is a full uninstall, not just a revert of our patch.
echo Your Claude login/chat data is stored separately and will
echo NOT be touched - only the application itself is removed.
echo.
set /p CONFIRM=Continue? [y/N]: 
if /i not "%CONFIRM%"=="y" (
    echo Cancelled.
    call :cleanup_temp
    pause
    exit /b 0
)

echo.
echo [Info] Deleting Claude Desktop...
set "DELETE_OUTPUT="
for /f "delims=" %%A in ('node "%EXT_DIR%\desktop-injector.js" delete 2^>nul') do set "DELETE_OUTPUT=%%A"

echo %DELETE_OUTPUT%| findstr /b "DELETED:" >nul
if errorlevel 1 (
    echo [!] Could not confirm deletion - check manually: %APP_PATH%
) else (
    echo [OK] Deleted %APP_PATH%
)

call :cleanup_temp

echo.
echo ================================================
echo    Uninstall complete!
echo ================================================
echo.
echo Claude Desktop has been removed from this PC.
echo To use Claude Desktop again (without this extension), download
echo a fresh copy from: https://claude.ai/download
echo.
pause
exit /b 0

:cleanup_temp
if "%IS_TEMP_SOURCE%"=="1" (
    if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%" >nul 2>&1
)
exit /b 0