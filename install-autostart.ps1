$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $ProjectRoot 'start.ps1'
$TaskName = 'Pocket Pointer'
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`" -NoBrowser"

$action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 20 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Start the Pocket Pointer Docker app and Windows input bridge when you sign in, retrying if Docker is still starting.' -Force | Out-Null
Write-Host 'Pocket Pointer will start in the background after you sign in to Windows.'
Write-Host 'If Docker Desktop is still starting, Windows will retry once per minute for up to 20 minutes.'
Write-Host 'Docker Desktop must also be set to start when you sign in.'
