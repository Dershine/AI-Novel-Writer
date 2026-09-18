@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
node scripts\prepare-native-for-electron.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
