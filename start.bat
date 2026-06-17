@echo off
cd /d "%~dp0"
echo [ForceAI] starting... the dashboard will open at http://localhost:3008
echo [ForceAI] first time? the setup guide in the browser walks you through your API key + WhatsApp QR.
start "" "http://localhost:3008"
npx tsx src/index.ts
pause
