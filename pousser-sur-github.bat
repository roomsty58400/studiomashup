@echo off
cd /d "%~dp0"
echo Envoi du commit vers GitHub (roomsty58400/studiomashup)...
git push origin main
echo.
echo Termine. Appuie sur une touche pour fermer.
pause >nul
