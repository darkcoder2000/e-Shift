@echo off
REM Serve the app so soundconfig.json can be fetched (blocked on file://).
setlocal
set PORT=8777
cd /d "%~dp0"

where python >nul 2>&1 && (
  echo Serving http://127.0.0.1:%PORT%/  -  Ctrl+C to stop
  start "" http://127.0.0.1:%PORT%/
  python -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

where npx >nul 2>&1 && (
  echo Serving http://127.0.0.1:%PORT%/  -  Ctrl+C to stop
  npx --yes serve -l %PORT% .
  goto :eof
)

echo Neither python nor npx was found on PATH.
echo Open index.html directly instead - the app falls back to js/fallback-config.js.
pause
