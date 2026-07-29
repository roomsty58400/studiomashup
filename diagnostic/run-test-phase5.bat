@echo off
cd /d C:\studiomashup\backend\diagnostic
node test-phase5.js > C:\studiomashup\diagnostic\test-phase5-output.log 2>&1
type C:\studiomashup\diagnostic\test-phase5-output.log
echo.
echo === TERMINE - appuyez sur une touche pour fermer ===
pause
