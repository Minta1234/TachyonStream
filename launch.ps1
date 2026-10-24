$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Automatically load .env variables into PowerShell process
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line.Split('=', 2)
            $k = $parts[0].Trim()
            $v = $parts[1].Trim()
            if (-not [string]::IsNullOrEmpty($k)) {
                [Environment]::SetEnvironmentVariable($k, $v, 'Process')
            }
        }
    }
}

$stateFile = Join-Path $PSScriptRoot '.processes.json'
& (Join-Path $PSScriptRoot 'stop.ps1')
$processes = @()
function Save-Process($process) {
    $script:processes += @{ id = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks }
    ConvertTo-Json -InputObject @($script:processes) | Set-Content -LiteralPath $stateFile
}
$node = (Get-Command node -ErrorAction Stop).Source
foreach ($entry in @('server', 'bot')) {
    $process = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $PSScriptRoot ($entry + '.js')) + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot ($entry + '.log')) -RedirectStandardError (Join-Path $PSScriptRoot ($entry + '.error.log')) -PassThru
    Save-Process $process
}
if ($env:TUNNEL_TOKEN) {
    $tunnel = (Get-Command cloudflared -ErrorAction Stop).Source
    $process = Start-Process -FilePath $tunnel -ArgumentList 'tunnel', 'run', '--token', $env:TUNNEL_TOKEN -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'tunnel.log') -RedirectStandardError (Join-Path $PSScriptRoot 'tunnel.error.log') -PassThru
    Save-Process $process
    Write-Host 'Cloudflare Tunnel started with TUNNEL_TOKEN.'
} else {
    Write-Host 'TUNNEL_TOKEN is not set. Existing tunnels remain running; no new tunnel started.'
}
Write-Host 'Started. Open http://localhost:9815. Logs are in server.log / server.error.log. No admin password is required.'
