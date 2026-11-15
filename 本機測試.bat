@echo off
rem Starts a local web server for this folder and opens the page in the browser.
rem Close this window to stop the server.
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8765/index.html"
python -m http.server 8765
