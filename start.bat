@echo off
cd /d "%~dp0"
if not exist .env (
  echo [ForceAI] .env is missing.
  echo Copy .env.example to .env and put your ANTHROPIC_API_KEY inside, then run this again.
  pause
  exit /b 1
)
echo [ForceAI] starting... dashboard will open at http://localhost:3008
start "" "http://localhost:3008"
npx tsx src/index.ts
pause
