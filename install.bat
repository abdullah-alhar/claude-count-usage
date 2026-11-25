@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Installer

:: =============================================================
::  Claude Count Usage - Windows Desktop Installer
::  Created by Abdullah Alhar
::
::  HOW TO USE:
::    Double-click this file.
::    Downloads the extension from GitHub automatically
::    and directly patches official Claude Desktop.
:: =============================================================

set "GITHUB_ZIP=https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

cls
echo.
echo ================================================
echo    Claude Count Usage - Desktop Installer
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

:: ── 2. Download Extension Files ────────────────────────────────
echo.
echo [Downloading] Fetching extension files from GitHub...
set "TMP_DIR=%TEMP%\ccu-dl-%RANDOM%-%RANDOM%"
mkdir "%TMP_DIR%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Could not create a temporary download folder.
    pause
    exit /b 1
)
set "ZIP_PATH=%TMP_DIR%\repo.zip"

powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile($env:GITHUB_ZIP, $env:ZIP_PATH)"
if errorlevel 1 (
    echo [ERROR] Failed to download extension files from GitHub.
    goto :install_failed
)

echo [Extracting] Unpacking extension files...
powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:ZIP_PATH -DestinationPath $env:TMP_DIR -ErrorAction Stop"
if errorlevel 1 (
    echo [ERROR] Failed to unpack extension archive.
    goto :install_failed
)

set "EXT_DIR=%TMP_DIR%\claude-count-usage-main"
if not exist "%EXT_DIR%\manifest_electron.json" goto :missing_files
if not exist "%EXT_DIR%\desktop-injector.js" goto :missing_files
if not exist "%EXT_DIR%\wrapper-runtime.js" goto :missing_files
if not exist "%EXT_DIR%\ccu-update.js" goto :missing_files
echo [OK] Downloaded extension files from GitHub

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

:: ── 4. Close Claude & Run Injector ───────────────────────────
echo.
echo [Closing] Closing Claude Desktop to release file locks...
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 1 /nobreak >nul 2>&1 || ping -n 2 127.0.0.1 >nul

:: Clear any stale/corrupted packages and leftover temp files from earlier runs
del /f /q "%TEMP%\Claude-*.msix" >nul 2>&1
del /f /q "%TEMP%\Claude-*.zip" >nul 2>&1
del /f /q "%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\app\resources\app.asar.tmp-*" >nul 2>&1
del /f /q "%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\resources\app.asar.tmp-*" >nul 2>&1
del /f /q "%LOCALAPPDATA%\Programs\Claude\resources\app.asar.tmp-*" >nul 2>&1

echo [Installing] Injecting into Claude Desktop...

node "%EXT_DIR%\desktop-injector.js" install "%EXT_DIR%"
if errorlevel 1 (
    echo.
    echo [ERROR] Installation failed.
    echo If Claude Desktop is still open, please close it completely from Task Manager and try again.
    goto :install_failed
)

rmdir /s /q "%TMP_DIR%" >nul 2>&1

:: ── 5. Restart Claude ──────────────────────────────────────────
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

:: ── 6. Done ───────────────────────────────────────────────────
echo.
echo ================================================
echo    Installation complete!
echo ================================================
echo.
echo What to look for in Claude Desktop:
echo   * Left sidebar   -^> Usage bars (Session 5h + Weekly)
echo   * In any chat    -^> Token / Cost / Cache stats below heading
echo.
echo To uninstall later: double-click  uninstall.bat
echo.
pause
exit /b 0

:missing_files
echo [ERROR] Downloaded archive did not contain expected extension files.

:install_failed
rmdir /s /q "%TMP_DIR%" >nul 2>&1
pause
exit /b 1
