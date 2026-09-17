# Prompt for GROQ_API_KEY in this terminal (not chat), fetch /v1/models, write JSON file.
# Usage:
#   powershell -File scripts/listGroqModels.ps1
#   powershell -File scripts/listGroqModels.ps1 -OutFile groq-models.json

param(
    [string]$OutFile = "groq-models.json"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host ""
Write-Host "Paste your Groq API key below and press Enter (input hidden)."
Write-Host "It stays in this terminal session only and is cleared afterward."
Write-Host ""

$secure = Read-Host "GROQ_API_KEY" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
}

if (-not $apiKey) {
    Write-Error "No key entered."
    exit 1
}

try {
    $headers = @{
        Authorization = "Bearer $apiKey"
        "Content-Type" = "application/json"
    }
    $response = Invoke-RestMethod -Method Get -Uri "https://api.groq.com/openai/v1/models" -Headers $headers
    $json = $response | ConvertTo-Json -Depth 20
    $outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path (Get-Location) $OutFile }
    Set-Content -Path $outPath -Value $json -Encoding utf8
    Write-Host "Wrote $($response.data.Count) model(s) to $outPath"
} finally {
    $apiKey = $null
    Remove-Item Env:\GROQ_API_KEY -ErrorAction SilentlyContinue
    Write-Host "Cleared API key from memory/session."
}
