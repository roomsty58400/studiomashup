@echo off
cd /d "%~dp0"
set OUT=update-python-tools-output.txt
echo === UPGRADE YT-DLP === > %OUT%
python -m pip install --upgrade yt-dlp >> %OUT% 2>&1
echo. >> %OUT%
echo === UPGRADE TORCH / TORCHVISION / NUMPY === >> %OUT%
python -m pip install --upgrade torch torchvision numpy >> %OUT% 2>&1
echo. >> %OUT%
echo === VERSIONS FINALES === >> %OUT%
yt-dlp --version >> %OUT% 2>&1
python -c "import torch,numpy; print('torch',torch.__version__); print('numpy',numpy.__version__); print('cuda ok',torch.cuda.is_available())" >> %OUT% 2>&1
echo.
echo Termine
pause
