# ── MacheUp Studio — lancement complet ──────────────────────────────────
# Démarre le backend + le frontend, ouvre le navigateur, puis force un
# rafraîchissement complet façon Ctrl+Shift+R (vide le cache du navigateur)
# — utile pour ne jamais retomber sur une ancienne version JS/CSS en cache
# après une mise à jour du code, notamment si un onglet MacheUp Studio était
# déjà resté ouvert d'une session précédente.

$root = $PSScriptRoot

# Même correction de codepage pour CETTE fenêtre (celle qui exécute start.ps1
# lui-même) — sans ça, ses propres Write-Host avec accents/emoji ("✅ MacheUp
# Studio est lancé !") peuvent eux aussi s'afficher corrompus.
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Tout ce qui s'affiche dans les fenêtres backend/frontend est aussi
# enregistré dans ces fichiers — pour relire un message (rouge = erreur) qui
# a défilé trop vite à l'écran, ouvre simplement le fichier .log correspondant
# dans le Bloc-notes, tranquillement, sans course contre le défilement.
$logsDir = "$root\logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$backendLog = "$logsDir\backend.log"
$frontendLog = "$logsDir\frontend.log"

# Les fenêtres backend/frontend démarrent par défaut sur le codepage Windows
# historique (souvent CP850/1252, pas UTF-8) — le backend Node écrit ses
# logs en UTF-8 (accents, ✅❌, etc.), donc sans ce réglage le pipeline
# PowerShell ("npm run dev 2>&1 | Tee-Object ...") redécode ces octets avec
# le mauvais codepage AVANT même que Tee-Object les écrive dans le .log : le
# texte affiché à l'écran ET enregistré dans le fichier sont alors corrompus
# de la même façon ("✅" → "Ô£à", "é" → "├®"...). chcp 65001 + l'encodage de
# sortie .NET en UTF-8 réglent les deux en une fois, AVANT de lancer npm.
$utf8Fix = "chcp 65001 | Out-Null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "

Write-Host "→ Démarrage du backend (port 3001)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "$utf8Fix" + "cd `"$root\backend`"; npm run dev 2>&1 | Tee-Object -FilePath `"$backendLog`""
)

Write-Host "→ Démarrage du frontend (port 5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "$utf8Fix" + "cd `"$root\frontend`"; npm run dev 2>&1 | Tee-Object -FilePath `"$frontendLog`""
)

Write-Host "→ Logs enregistrés dans : $logsDir (backend.log / frontend.log)" -ForegroundColor DarkGray

Write-Host "→ Attente du démarrage des serveurs..." -ForegroundColor DarkGray
Start-Sleep -Seconds 5

# Paramètre de requête anti-cache : force le navigateur à recharger la page
# HTML elle-même plutôt que de servir une version déjà en cache pour cette
# URL exacte (sans ça, un onglet jamais fermé peut rester bloqué dessus).
$cacheBuster = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$url = "http://localhost:5173/?_=$cacheBuster"

Write-Host "→ Ouverture du navigateur..." -ForegroundColor Cyan
Start-Process $url

# Laisse la page (et son <title>"MacheUp Studio"</title>) se charger, puis
# simule Ctrl+Shift+R sur cette fenêtre — vide le cache du navigateur pour
# CETTE page, comme si tu l'avais fait toi-même au clavier.
# NOTE : ça suppose que la fenêtre du navigateur passe au premier plan et que
# son titre contient "MacheUp" — si ça ne fonctionne pas chez toi (autre
# comportement de navigateur, fenêtre pas encore prête...), le rafraîchissement
# simulé peut simplement ne rien faire ; le chargement initial via l'URL avec
# paramètre anti-cache ci-dessus reste fait dans tous les cas.
Start-Sleep -Seconds 3
try {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $browserWindow = Get-Process | Where-Object { $_.MainWindowTitle -like "*MacheUp*" } | Select-Object -First 1
  if ($browserWindow) {
    [Microsoft.VisualBasic.Interaction]::AppActivate($browserWindow.Id) | Out-Null
    Start-Sleep -Milliseconds 400
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.SendKeys("^+r")
    Write-Host "→ Rafraîchissement forcé envoyé (Ctrl+Shift+R)." -ForegroundColor Green
  } else {
    Write-Host "→ Fenêtre du navigateur pas encore détectée — rafraîchissement simulé ignoré (page déjà ouverte fraîche via l'URL anti-cache)." -ForegroundColor Yellow
  }
} catch {
  Write-Host "→ Rafraîchissement simulé indisponible sur cette machine (sans incidence : la page a déjà été ouverte fraîche)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ MacheUp Studio est lancé !" -ForegroundColor Green
