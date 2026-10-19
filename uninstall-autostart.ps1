$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'Pocket Pointer' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Pocket Pointer no longer starts when you sign in.'
