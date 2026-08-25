@echo off
setlocal enabledelayedexpansion
title Claude Count Usage Uninstaller

:: =============================================================
::  Claude Count Usage - Windows Desktop UNINSTALLER
::  Created by Abdullah Alhar
::
::  HOW TO USE:
::    Double-click this file.
::    Restores Claude to its original state.
:: =============================================================

set "LAUNCHER_DIR=%APPDATA%\Claude WebExtension Launcher"
set "EXTS_DIR=%LAUNCHER_DIR%\web-extensions"
set "TARGET_EXT=%EXTS_DIR%\usage-tracker"
set "BACKUP_DIR=%LAUNCHER_DIR%\usage-tracker-backup"
set "OLD_WRONG_BACKUP=%EXTS_DIR%\usage-tracker-original-backup"

:: Find Claude executable
set "CLAUDE_EXE="
if exist "%LAUNCHER_DIR%\app-latest\Claude.exe"          set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\Claude.exe"
if exist "%LAUNCHER_DIR%\app-latest\claude\Claude.exe"   set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\claude\Claude.exe"
if exist "%LAUNCHER_DIR%\app-latest\app\Claude.exe"      set "CLAUDE_EXE=%LAUNCHER_DIR%\app-latest\app\Claude.exe"

cls
echo.
echo ================================================
echo    Claude Count Usage - Uninstaller
echo    by Abdullah Alhar
echo ================================================
echo.

:: Check launcher exists
if not exist "%EXTS_DIR%" (
    echo [ERROR] Claude WebExtension Launcher not found.
    echo         Nothing to uninstall.
    echo.
    pause
    exit /b 1
)

:: Remove any stale wrong backup from inside web-extensions
if exist "%OLD_WRONG_BACKUP%" (
    echo [Fix] Removing stale backup from inside web-extensions...
    rmdir /s /q "%OLD_WRONG_BACKUP%"
    echo [OK] Cleaned up
)

:: Remove our extension
echo.
echo [Removing] Claude Count Usage extension...
if exist "%TARGET_EXT%" (
    rmdir /s /q "%TARGET_EXT%"
    echo [OK] Extension removed
) else (
    echo [WARN] Extension not found - may already be uninstalled
)

:: Restore original usage-tracker
echo.
if exist "%BACKUP_DIR%" (
    echo [Restore] Restoring original usage-tracker...
    xcopy /e /i /q "%BACKUP_DIR%" "%TARGET_EXT%\" >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Restore failed. You can reinstall via the launcher app.
    ) else (
        rmdir /s /q "%BACKUP_DIR%"
        echo [OK] Original usage-tracker restored
    )
) else (
    echo [WARN] No backup found - original usage-tracker was not restored.
    echo        Run the Claude WebExtension Launcher app to reinstall it.
)

:: Kill and relaunch Claude
echo.
echo [Launch] Restarting Claude...
taskkill /f /im Claude.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if defined CLAUDE_EXE (
    start "" "%CLAUDE_EXE%"
    echo [OK] Claude launched
) else (
    echo [WARN] Claude.exe not found - please open Claude manually.
)

echo.
echo ================================================
echo    Uninstall complete!
echo ================================================
echo.
echo Claude Count Usage has been removed.
echo.
pause
