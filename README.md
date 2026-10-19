# Pocket Pointer

Use a phone as the mouse and keyboard for a Windows PC on the same Wi-Fi network. The Docker app serves the dashboard and phone controller. A small PowerShell bridge runs on Windows and passes approved mouse and keyboard events to the desktop. Docker containers cannot inject input into the Windows desktop by themselves.

## Start it

1. Install Docker Desktop and let it use Linux containers.
2. In PowerShell, open this folder and run `Set-ExecutionPolicy -Scope Process Bypass`, then `./start.ps1`.
3. The dashboard opens on the PC. Scan its QR code with your phone while both devices are on the same Wi-Fi.
4. If Windows Firewall asks, allow Docker Desktop on your private network.

The first start creates `.env` with a random pairing code and a private bridge key. Keep `.env` on this PC. The pairing code grants control to anyone who has it. Each start also updates `phone-link.txt` with a reusable PC-name link and the current IP link.

## Keep it running

Docker uses `restart: unless-stopped`, so the web app returns when Docker starts. To start the app and Windows bridge when you sign in, enable Docker Desktop's sign-in startup option, then run `./install-autostart.ps1` once in PowerShell. The task runs in the background under your Windows account without administrator privileges. If Docker is still starting, Windows retries once per minute for up to 20 minutes. You can close the PowerShell window after setup; the bridge process is hidden and reconnects if Docker restarts.

The bridge starts after you sign in to Windows. It does not run before sign-in, so it can send input only in your signed-in desktop session.

Run `./stop.ps1` to stop Docker and the bridge. Run `./uninstall-autostart.ps1` to remove the Windows sign-in task.

## Controls

The dashboard and phone page can each pause all input. Mouse movement, keyboard, scrolling, mouse buttons, and tap-to-click have separate switches. Settings persist in a Docker volume. The phone keyboard sends text when you tap **Send text** or press Enter. Quick keys include arrows, Enter, Escape, Backspace, and modifier keys.

## Notes

- The phone and PC must be on the same local network. The app does not use a cloud relay.
- The bridge uses Windows `SendInput`. Windows may block it from controlling an elevated app or secure sign-in screen.
- The host bridge uses a normal Windows PowerShell process and does not need administrator access.
- Bridge logs are saved at `%LOCALAPPDATA%\PocketPointer\bridge.log`.
- To open the dashboard manually, use `http://localhost:8765/?pin=<pairing-code>`. The code is also printed by `start.ps1`.
- If Docker Desktop or the PC sleeps, the phone cannot send input until it wakes.
