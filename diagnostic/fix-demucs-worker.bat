@echo off
setlocal
echo ============================================================
echo  Diagnostic + reparation du worker Demucs (module demucs.api)
echo ============================================================
echo.
echo Interpreteur "python" resolu sur le PATH de cette fenetre :
where python
echo.
python --version
python -c "import sys; print('Executable reellement utilise :', sys.executable)"
echo.
echo --- Version actuelle de demucs ---
python -m pip show demucs
echo.
echo --- Version actuelle de torch (pour verifier la compatibilite apres mise a jour) ---
python -m pip show torch
echo.
echo ============================================================
echo  Mise a jour de demucs (ajoute le module demucs.api manquant)
echo ============================================================
python -m pip install -U demucs
echo.
echo --- Verification post-mise a jour ---
python -m pip show demucs
python -m pip show torch
echo.
python -c "from demucs.api import Separator; print('OK : demucs.api est maintenant disponible')"
echo.
echo ============================================================
echo  Termine. Ferme cette fenetre puis relance le serveur
echo  (npm run dev) pour verifier dans les logs que le worker
echo  Demucs demarre (plus de ligne "worker persistant indisponible").
echo ============================================================
pause
