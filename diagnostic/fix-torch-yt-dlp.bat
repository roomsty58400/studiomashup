@echo off
cd /d "%~dp0"
set OUT=fix-torch-yt-dlp-output.txt

echo === REINSTALL TORCH CUDA (cu132, evite le build CPU par defaut) === > %OUT%
python -m pip install --upgrade --index-url https://download.pytorch.org/whl/cu132 torch torchvision >> %OUT% 2>&1
echo. >> %OUT%

echo === REVERT NUMPY 2.4.4 (2.5.2 casse numba/librosa : numba exige numpy<2.5) === >> %OUT%
python -m pip install "numpy==2.4.4" >> %OUT% 2>&1
echo. >> %OUT%

echo === VERIF TORCH / NUMPY / CUDA === >> %OUT%
python -c "import torch,numpy; print('torch',torch.__version__); print('numpy',numpy.__version__); print('cuda ok',torch.cuda.is_available())" >> %OUT% 2>&1
echo. >> %OUT%

echo === SELF-UPDATE YT-DLP (binaire reellement sur PATH) === >> %OUT%
for /f "delims=" %%P in ('where yt-dlp') do set YTDLP_PATH=%%P
echo Binaire cible : %YTDLP_PATH% >> %OUT%
"%YTDLP_PATH%" -U >> %OUT% 2>&1
echo. >> %OUT%
"%YTDLP_PATH%" --version >> %OUT% 2>&1

echo.
echo Termine
pause
