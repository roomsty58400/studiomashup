@echo off
cd /d "%~dp0"
set OUT=check-updates-output.txt
echo === FFMPEG === > %OUT%
ffmpeg -version >> %OUT% 2>&1
echo. >> %OUT%
echo === YT-DLP === >> %OUT%
yt-dlp --version >> %OUT% 2>&1
echo. >> %OUT%
echo === NVIDIA-SMI (pilote + version CUDA max supportee) === >> %OUT%
nvidia-smi >> %OUT% 2>&1
echo. >> %OUT%
echo === NVCC (CUDA toolkit, si installe) === >> %OUT%
nvcc --version >> %OUT% 2>&1
echo. >> %OUT%
echo === PYTHON === >> %OUT%
python --version >> %OUT% 2>&1
echo. >> %OUT%
echo === TORCH / CUDA (utilise par Demucs) === >> %OUT%
python -c "import torch; print('torch', torch.__version__); print('cuda disponible', torch.cuda.is_available()); print('cuda version', torch.version.cuda)" >> %OUT% 2>&1
echo. >> %OUT%
echo === DEMUCS === >> %OUT%
python -m demucs --version >> %OUT% 2>&1
echo. >> %OUT%
echo === NODE === >> %OUT%
node --version >> %OUT% 2>&1
echo.
echo Termine - resultats dans %OUT%
pause
