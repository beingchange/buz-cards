@echo off
rem Buz Cards on this computer AND phones on the same Wi-Fi.
rem The window shows the address to open on the phone and the access code.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.18+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing... & call npm ci || (pause & exit /b 1))
if not exist dist\index.html (echo Building... & call npm run build || (pause & exit /b 1))
set HOST=0.0.0.0
start "" http://localhost:4173/#/settings
call npm start
pause
