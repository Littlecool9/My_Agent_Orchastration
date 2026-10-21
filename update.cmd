@echo off
node "%~dp0scripts\update.mjs" %*
set "update_exit=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %update_exit%
