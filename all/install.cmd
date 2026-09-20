@echo off
REM aisearch universal installer - Windows (cmd)
REM Delegates to install.ps1 with the same arguments.
REM
REM Usage:
REM   all\install.cmd
REM   all\install.cmd -Test
REM   all\install.cmd -Full -NoJs

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%
