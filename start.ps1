param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ProjectRoot '.env'
$BridgePidFile = Join-Path $ProjectRoot '.bridge.pid'
$PhoneLinkFile = Join-Path $ProjectRoot 'phone-link.txt'
Set-Location -LiteralPath $ProjectRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker was not found. Install and start Docker Desktop, then run this script again.'
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $pinBytes = New-Object byte[] 8
    $tokenBytes = New-Object byte[] 32
    $random.GetBytes($pinBytes)
    $random.GetBytes($tokenBytes)
    $pin = [BitConverter]::ToString($pinBytes).Replace('-', '')
    $hostToken = [BitConverter]::ToString($tokenBytes).Replace('-', '').ToLowerInvariant()
    $random.Dispose()
    @("PAIRING_PIN=$pin", "HOST_TOKEN=$hostToken") | Set-Content -LiteralPath $EnvFile -Encoding ASCII
}

$pinLine = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^PAIRING_PIN=' } | Select-Object -First 1
if (-not $pinLine) { throw 'PAIRING_PIN is missing from .env. Delete .env and run this script to create a new code.' }
$pin = $pinLine.Substring('PAIRING_PIN='.Length).Trim()

Write-Host 'Building and starting Pocket Pointer in Docker…'
$engineReady = $false
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { $engineReady = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $engineReady) { throw 'Docker Desktop is not ready. Start it and run this script again.' }

& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start. Check that Docker Desktop is running.' }

$ready = $false
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/healthz' -TimeoutSec 2 -UseBasicParsing
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (-not $ready) { throw 'Pocket Pointer did not become ready. Run docker compose logs in this folder for details.' }

$bridgeIsRunning = $false
if (Test-Path -LiteralPath $BridgePidFile) {
    $oldPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $BridgePidFile -Raw).Trim(), [ref]$oldPid)) {
        $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
        if ($oldProcess -and $oldProcess.CommandLine -like '*host-bridge.ps1*') { $bridgeIsRunning = $true }
    }
}

if (-not $bridgeIsRunning) {
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $ProjectRoot 'host-bridge.ps1')`""
    $bridge = Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $BridgePidFile -Value $bridge.Id -Encoding ASCII
}

$lanAddresses = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object {
    $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)'
} | Sort-Object -Unique)
if ($lanAddresses.Count -gt 0) {
    $primaryAddress = $lanAddresses[0]
    $phoneLink = "http://${primaryAddress}:8765/remote.html?v=10&pin=$pin"
    $deviceNameLink = "http://$($env:COMPUTERNAME.ToLowerInvariant()).local:8765/remote.html?v=10&pin=$pin"
    @(
        'Pocket Pointer phone link (same Wi-Fi only)',
        '',
        "PC name link: $deviceNameLink",
        "Current IP link: $phoneLink",
        '',
        'The PC name link stays the same if your router changes the PC address. If it does not open on your phone, use the current IP link.'
    ) | Set-Content -LiteralPath $PhoneLinkFile -Encoding UTF8
    Write-Host "Phone links saved to $PhoneLinkFile"
}

if (-not $NoBrowser) { Start-Process "http://localhost:8765/?pin=$pin" }
Write-Host ''
Write-Host 'Pocket Pointer is running in Docker.'
Write-Host "Pairing code: $pin"
Write-Host 'Open the dashboard or scan its QR code from your phone.'
Write-Host 'Use stop.ps1 to stop the app and Windows bridge.'
