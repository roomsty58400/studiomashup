@echo off
cd /d "%~dp0"
set OUT=check-7z-output.txt
echo === WHERE 7Z === > %OUT%
where 7z >> %OUT% 2>&1
where 7za >> %OUT% 2>&1
if exist "C:\Program Files\7-Zip\7z.exe" echo FOUND: C:\Program Files\7-Zip\7z.exe >> %OUT%
if exist "C:\Program Files (x86)\7-Zip\7z.exe" echo FOUND: C:\Program Files (x86)\7-Zip\7z.exe >> %OUT%
echo. >> %OUT%
echo === CURL VERSION === >> %OUT%
curl --version >> %OUT% 2>&1
echo.
echo Termine
pause
