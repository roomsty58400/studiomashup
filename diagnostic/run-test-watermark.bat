@echo off
cd /d C:\studiomashup\backend\diagnostic
node test-watermark.js > C:\studiomashup\diagnostic\test-watermark-output.log 2>&1
echo === TERMINE — appuyez sur une touche pour fermer ===
pause
