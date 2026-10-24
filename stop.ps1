$ErrorActionPreference = 'SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot

$stateFile = Join-Path $PSScriptRoot '.processes.json'
if (Test-Path -LiteralPath $stateFile) {
    try {
        $records = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        foreach ($record in @($records)) {
            $p = Get-Process -Id $record.id -ErrorAction SilentlyContinue
            if ($p) {
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
}

# 1. Kill any process currently listening on port 9815
try {
    $connections = Get-NetTCPConnection -LocalPort 9815 -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        if ($conn.OwningProcess -and $conn.OwningProcess -gt 0) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}

# 2. Kill any Node.js or Cloudflared processes running inside this project folder
try {
    $escapedRoot = [regex]::Escape($PSScriptRoot)
    $projectProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.Name -eq 'node.exe' -or $_.Name -eq 'cloudflared.exe') -and
        $_.CommandLine -and
        ($_.CommandLine -like "*TachyonStream*" -or $_.CommandLine -match $escapedRoot)
    }
    foreach ($proc in $projectProcs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

Write-Host "Stopped all TachyonStream processes (server, bot, and cloudflared tunnel)."
