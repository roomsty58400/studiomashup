@echo off
cd /d "%~dp0"
set OUT=check-updates-output2.txt
echo === PIP SHOW DEMUCS === > %OUT%
python -m pip show demucs >> %OUT% 2>&1
echo. >> %OUT%
echo === PIP SHOW TORCH === >> %OUT%
python -m pip show torch >> %OUT% 2>&1
echo. >> %OUT%
echo === PIP SHOW LIBROSA === >> %OUT%
python -m pip show librosa >> %OUT% 2>&1
echo. >> %OUT%
echo === PIP SHOW NUMPY === >> %OUT%
python -m pip show numpy >> %OUT% 2>&1
echo.
echo Termine
pause
