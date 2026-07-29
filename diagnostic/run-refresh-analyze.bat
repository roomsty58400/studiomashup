@echo off
cd /d C:\studiomashup\backend\diagnostic
node test-refresh-analyze.js > C:\studiomashup\diagnostic\test-refresh-analyze-output.log 2>&1
type C:\studiomashup\diagnostic\test-refresh-analyze-output.log
echo.
echo === TERMINE - appuyez sur une touche pour fermer ===
pause
