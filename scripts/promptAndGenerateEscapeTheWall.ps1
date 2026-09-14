# Prompt for GROQ_API_KEY in this terminal (not chat), then generate Escape the Wall audio.
# Usage:
#   powershell -File scripts/promptAndGenerateEscapeTheWall.ps1
#   powershell -File scripts/promptAndGenerateEscapeTheWall.ps1 -- --force --only escape-the-wall-00.wav,escape-the-wall-09.wav

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host ""
Write-Host "Paste your Groq API key below and press Enter (input hidden)."
Write-Host "It stays in this terminal session only and is cleared afterward."
Write-Host ""

$secure = Read-Host "GROQ_API_KEY" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:GROQ_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
}

if (-not $env:GROQ_API_KEY) {
    Write-Error "No key entered."
    exit 1
}

# Allow: script.ps1 -- --force --only a,b
$nodeArgs = @($args)
if ($nodeArgs.Count -gt 0 -and $nodeArgs[0] -eq "--") {
    $nodeArgs = $nodeArgs | Select-Object -Skip 1
}

try {
    node scripts/generateEscapeTheWallAudio.mjs @nodeArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\GROQ_API_KEY -ErrorAction SilentlyContinue
    Write-Host "Cleared GROQ_API_KEY from this session."
}

exit $code
