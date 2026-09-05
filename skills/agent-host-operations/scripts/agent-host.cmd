@echo off
setlocal DisableDelayedExpansion

if defined AGENT_HOST_CLI (
  if defined AGENT_HOST_NODE (
    "%AGENT_HOST_NODE%" "%AGENT_HOST_CLI%" %*
  ) else (
    "%AGENT_HOST_CLI%" %*
  )
  exit /b %ERRORLEVEL%
)

set "INSTALL_ROOT=%LOCALAPPDATA%\Programs\openAdam\Agent Host"
if exist "%INSTALL_ROOT%\runtime\node.exe" if exist "%INSTALL_ROOT%\app\bin\agent-host.mjs" (
  "%INSTALL_ROOT%\runtime\node.exe" "%INSTALL_ROOT%\app\bin\agent-host.mjs" %*
  exit /b %ERRORLEVEL%
)

for /f "delims=" %%I in ('where agent-host.cmd 2^>NUL') do (
  if /I not "%%~fI"=="%~f0" (
    call "%%~fI" %*
    exit /b %ERRORLEVEL%
  )
)

echo AGENT_HOST_CLI_UNAVAILABLE: Install Agent Host for Windows or the published agent-host CLI. 1>&2
exit /b 127
