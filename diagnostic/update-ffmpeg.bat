@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
set OUT=update-ffmpeg-output.txt
set TMP_DL=%TEMP%\ffmpeg-git-full.7z
set TMP_EXTRACT=%TEMP%\ffmpeg-update-extract
set SEVENZIP=C:\Program Files\7-Zip\7z.exe

echo === Telechargement (gyan.dev, dernier build git) === > %OUT%
curl -L -o "%TMP_DL%" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-full.7z" >> %OUT% 2>&1
echo. >> %OUT%

if not exist "%TMP_DL%" (
  echo ECHEC : le fichier n'a pas ete telecharge. >> %OUT%
  goto :end
)
for %%A in ("%TMP_DL%") do set DLSIZE=%%~zA
echo Taille telechargee : %DLSIZE% octets >> %OUT%
if %DLSIZE% LSS 1000000 (
  echo ECHEC : fichier telecharge trop petit, probablement une erreur. Arret sans toucher a l'installation existante. >> %OUT%
  goto :end
)

echo === Extraction === >> %OUT%
if exist "%TMP_EXTRACT%" rmdir /s /q "%TMP_EXTRACT%"
mkdir "%TMP_EXTRACT%"
"%SEVENZIP%" x "%TMP_DL%" -o"%TMP_EXTRACT%" -y >> %OUT% 2>&1
echo. >> %OUT%

set EXTRACTED=
for /d %%D in ("%TMP_EXTRACT%\ffmpeg-*") do set EXTRACTED=%%D
if "%EXTRACTED%"=="" (
  echo ECHEC : dossier extrait introuvable. Arret sans toucher a l'installation existante. >> %OUT%
  goto :end
)
echo Dossier extrait : %EXTRACTED% >> %OUT%
if not exist "%EXTRACTED%\bin\ffmpeg.exe" (
  echo ECHEC : ffmpeg.exe absent de l'archive extraite. Arret sans toucher a l'installation existante. >> %OUT%
  goto :end
)

echo === Sauvegarde de l'ancien C:\ffmpeg\bin === >> %OUT%
if exist "C:\ffmpeg\bin_backup_2026-08-15" rmdir /s /q "C:\ffmpeg\bin_backup_2026-08-15"
move "C:\ffmpeg\bin" "C:\ffmpeg\bin_backup_2026-08-15" >> %OUT% 2>&1

echo === Installation du nouveau bin === >> %OUT%
move "%EXTRACTED%\bin" "C:\ffmpeg\bin" >> %OUT% 2>&1

echo === Verification version === >> %OUT%
"C:\ffmpeg\bin\ffmpeg.exe" -version >> %OUT% 2>&1

:end
echo.
echo Termine - voir %OUT%
pause
