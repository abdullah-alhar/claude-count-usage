@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Installer

:: =============================================================
::  Claude Count Usage - Windows Desktop Installer
::  Created by Abdullah Alhar
::
::  HOW TO USE:
::    Double-click this file.
::    Works standalone (auto-downloads extension if run alone)
::    and directly patches official Claude Desktop.
:: =============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "GITHUB_ZIP=https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

cls
echo.
echo ================================================
echo    Claude Count Usage - Desktop Installer
echo    by Abdullah Alhar
echo ================================================
echo.

:: ── 1. Check or Auto-Install Node.js ──────────────────────────
echo [Checking] Node.js...
set "NODE_DIR=%LOCALAPPDATA%\ClaudeCountUsage\node"
if exist "!NODE_DIR!\node.exe" (
    set "PATH=!NODE_DIR!;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [Info] Node.js not detected - downloading portable Node.js for Windows...
    if not exist "!NODE_DIR!" mkdir "!NODE_DIR!" >nul 2>&1
    set "NODE_ARCH=x64"
    if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"

    echo [Downloading] Fetching Node.js from nodejs.org...
    powershell -NoProfile -Command "$arch = '%NODE_ARCH%'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $html = (New-Object System.Net.WebClient).DownloadString('https://nodejs.org/dist/latest-v20.x/'); if ($html -match 'node-(v[0-9.]+)-win-' + $arch + '\.zip') { $file = $matches[0]; $url = 'https://nodejs.org/dist/latest-v20.x/' + $file; $zip = Join-Path $env:TEMP $file; (New-Object System.Net.WebClient).DownloadFile($url, $zip); $extDir = Join-Path $env:TEMP 'node_tmp'; Expand-Archive -Path $zip -DestinationPath $extDir -Force; $inner = Get-ChildItem $extDir | Select-Object -First 1; Copy-Item -Path ($inner.FullName + '\*') -Destination '!NODE_DIR!' -Recurse -Force; Remove-Item $zip -Force; Remove-Item $extDir -Recurse -Force; }"

    if exist "!NODE_DIR!\node.exe" (
        set "PATH=!NODE_DIR!;%PATH%"
        echo [OK] Node.js installed automatically
    ) else (
        echo [ERROR] Could not auto-install Node.js.
        echo Please install Node.js from https://nodejs.org
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo [OK] Node.js !NODE_VER! ready.

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

:: ── 4. Run Injector to patch Claude Desktop ───────────────────
echo.
echo [Installing] Injecting into Claude Desktop...
node "%EXT_DIR%\desktop-injector.js" install "%EXT_DIR%"
if errorlevel 1 (
    echo [ERROR] Installation failed.
    pause
    exit /b 1
)

:: Clean up temp folder if any
if "!IS_TEMP_SOURCE!"=="1" (
    if exist "!TMP_DIR!" rmdir /s /q "!TMP_DIR!" >nul 2>&1
)

:: ── 5. Restart Claude ──────────────────────────────────────────
echo.
echo [Launch] Restarting Claude...
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 1 /nobreak >nul

set "PORTABLE_EXE=%LOCALAPPDATA%\ClaudeDesktopInjector\Claude\Claude.exe"
if exist "%PORTABLE_EXE%" (
    start "" "%PORTABLE_EXE%"
    echo [OK] Claude Desktop launched from portable installation.
) else (
    start claude: >nul 2>&1 || (
        echo [OK] Installation complete. Please launch Claude from Start Menu.
    )
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
