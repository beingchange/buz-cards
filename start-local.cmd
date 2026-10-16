@echo off
rem Buz Cards on this computer only (http://localhost:4173)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.18+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing... & call npm ci || (pause & exit /b 1))
if not exist dist\index.html (echo Building... & call npm run build || (pause & exit /b 1))
start "" http://localhost:4173
call npm start
pause
