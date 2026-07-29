@echo off
cd /d C:\studiomashup\diagnostic
node test-frontend-multi.js > test-frontend-multi-output.log 2>&1
echo === TERMINE — appuyez sur une touche pour fermer ===
pause
