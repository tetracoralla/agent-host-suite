@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AgentHost.ps1"
if errorlevel 1 (
  echo.
  echo Agent Host installation did not complete.
  pause
  exit /b 1
)
