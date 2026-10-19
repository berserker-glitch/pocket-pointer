$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgePidFile = Join-Path $ProjectRoot '.bridge.pid'
Set-Location -LiteralPath $ProjectRoot

if (Test-Path -LiteralPath $BridgePidFile) {
    $bridgePid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $BridgePidFile -Raw).Trim(), [ref]$bridgePid)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid" -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -like '*host-bridge.ps1*') {
            Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $BridgePidFile -Force
}

& docker compose down
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not stop. Check that Docker Desktop is running.' }
Write-Host 'Pocket Pointer has stopped. Saved settings are still in Docker.'
