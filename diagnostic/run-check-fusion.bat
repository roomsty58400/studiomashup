@echo off
cd /d C:\studiomashup\diagnostic
node check-fusion.js > check-fusion-output.log 2>&1
type check-fusion-output.log
echo.
echo === TERMINE - appuyez sur une touche pour fermer ===
pause
