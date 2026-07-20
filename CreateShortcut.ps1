# CreateShortcut.ps1
# Run this once from the app folder to put a shortcut on your Desktop.
# Right-click → "Run with PowerShell"

$appFolder  = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath    = Join-Path $appFolder "start.vbs"
$shortcut   = Join-Path ([Environment]::GetFolderPath("Desktop")) "ASO OT System.lnk"

if (-not (Test-Path $vbsPath)) {
    Write-Host "ERROR: start.vbs not found in $appFolder" -ForegroundColor Red
    Write-Host "Make sure CreateShortcut.ps1 and start.vbs are in the same folder." -ForegroundColor Yellow
    pause
    exit 1
}

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($shortcut)
$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = "`"$vbsPath`""
$lnk.WorkingDirectory = $appFolder
$lnk.Description      = "ASO Staff OT System"
# Use the wscript icon (clean, no terminal flash)
$lnk.IconLocation     = "wscript.exe,0"
$lnk.Save()

Write-Host ""
Write-Host "  Desktop shortcut created!" -ForegroundColor Green
Write-Host "  -> $shortcut" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Double-click 'ASO OT System' on your Desktop to launch." -ForegroundColor White
Write-Host ""
pause
