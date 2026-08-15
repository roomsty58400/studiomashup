@echo off
cd /d "%~dp0"
set OUT=final-verify-output.txt
echo === FFMPEG === > %OUT%
ffmpeg -version | findstr /C:"ffmpeg version" >> %OUT% 2>&1
echo. >> %OUT%
echo === YT-DLP === >> %OUT%
yt-dlp --version >> %OUT% 2>&1
echo. >> %OUT%
echo === IMPORT CHECK (torch/numpy/librosa/demucs) === >> %OUT%
python -c "import torch, numpy, librosa, demucs; print('torch', torch.__version__, '| cuda', torch.cuda.is_available()); print('numpy', numpy.__version__); print('librosa OK'); print('demucs OK')" >> %OUT% 2>&1
echo.
echo Termine
pause
