@echo off
cd /d "%~dp0"
set OUT=find-paths-output.txt
echo === WHERE FFMPEG === > %OUT%
where ffmpeg >> %OUT% 2>&1
echo. >> %OUT%
echo === WHERE YT-DLP === >> %OUT%
where yt-dlp >> %OUT% 2>&1
echo. >> %OUT%
echo === PIP LOCATION === >> %OUT%
python -m pip --version >> %OUT% 2>&1
echo.
echo Termine
pause
