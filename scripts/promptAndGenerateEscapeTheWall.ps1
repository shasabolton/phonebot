# Prompt for GROQ_API_KEY in this terminal (not chat), then generate Escape the Wall audio.
# Usage: powershell -File scripts/promptAndGenerateEscapeTheWall.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host ""
Write-Host "Paste your Groq API key below and press Enter."
Write-Host "It stays in this terminal session only and is cleared afterward."
Write-Host ""

$env:GROQ_API_KEY = Read-Host "GROQ_API_KEY"
if (-not $env:GROQ_API_KEY) {
    Write-Error "No key entered."
    exit 1
}

try {
    node scripts/generateEscapeTheWallAudio.mjs @args
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\GROQ_API_KEY -ErrorAction SilentlyContinue
    Write-Host "Cleared GROQ_API_KEY from this session."
}

exit $code
