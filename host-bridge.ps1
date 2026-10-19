$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ProjectRoot '.env'
$LogDirectory = Join-Path $env:LOCALAPPDATA 'PocketPointer'
$LogFile = Join-Path $LogDirectory 'bridge.log'

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

function Write-BridgeLog([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $LogFile -Value "$stamp $Message" -Encoding UTF8
}

function Read-EnvironmentValue([string]$Name) {
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return $line.Substring($Name.Length + 1).Trim()
}

function Get-LanAddresses {
    $found = @()
    try {
        $found = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object {
            $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)'
        } | Sort-Object -Unique)
    } catch {
        Write-BridgeLog "Could not list network interfaces: $($_.Exception.Message)"
    }
    return $found
}

$nativeInput = @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

public static class PocketPointerInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int dx;
        public int dy;
        public uint data;
        public uint flags;
        public uint time;
        public IntPtr extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public IntPtr extra;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyboardInput keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input {
        public uint type;
        public InputUnion value;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseMove = 0x0001;
    private const uint LeftDown = 0x0002;
    private const uint LeftUp = 0x0004;
    private const uint RightDown = 0x0008;
    private const uint RightUp = 0x0010;
    private const uint MiddleDown = 0x0020;
    private const uint MiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;
    private const uint KeyUp = 0x0002;
    private const uint Unicode = 0x0004;

    private static readonly object Gate = new object();
    private static readonly HashSet<string> HeldKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> HeldButtons = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        { "Enter", 0x0D }, { "Escape", 0x1B }, { "Tab", 0x09 }, { "Backspace", 0x08 },
        { "Delete", 0x2E }, { "ArrowUp", 0x26 }, { "ArrowDown", 0x28 }, { "ArrowLeft", 0x25 },
        { "ArrowRight", 0x27 }, { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 },
        { "PageDown", 0x22 }, { "Space", 0x20 }, { "Control", 0x11 }, { "Alt", 0x12 },
        { "Shift", 0x10 }, { "Meta", 0x5B }, { "CapsLock", 0x14 }, { "Insert", 0x2D },
        { "PrintScreen", 0x2C }, { "ScrollLock", 0x91 }, { "Pause", 0x13 }, { "NumLock", 0x90 },
        { "ContextMenu", 0x5D }, { "F1", 0x70 }, { "F2", 0x71 }, { "F3", 0x72 },
        { "F4", 0x73 }, { "F5", 0x74 }, { "F6", 0x75 }, { "F7", 0x76 }, { "F8", 0x77 },
        { "F9", 0x78 }, { "F10", 0x79 }, { "F11", 0x7A }, { "F12", 0x7B }, { "F13", 0x7C },
        { "F14", 0x7D }, { "F15", 0x7E }, { "F16", 0x7F }, { "F17", 0x80 }, { "F18", 0x81 },
        { "F19", 0x82 }, { "F20", 0x83 }, { "F21", 0x84 }, { "F22", 0x85 }, { "F23", 0x86 }, { "F24", 0x87 }
    };

    private static bool TryGetVirtualKey(string name, out ushort key) {
        if (KeyMap.TryGetValue(name, out key)) return true;
        if (String.IsNullOrEmpty(name) || name.Length != 1) return false;
        char value = Char.ToUpperInvariant(name[0]);
        if ((value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9')) {
            key = value;
            return true;
        }
        switch (name[0]) {
            case ';': key = 0xBA; return true;
            case '=': key = 0xBB; return true;
            case ',': key = 0xBC; return true;
            case '-': key = 0xBD; return true;
            case '.': key = 0xBE; return true;
            case '/': key = 0xBF; return true;
            case '`': key = 0xC0; return true;
            case '[': key = 0xDB; return true;
            case '\\': key = 0xDC; return true;
            case ']': key = 0xDD; return true;
            case '\'': key = 0xDE; return true;
            default: key = 0; return false;
        }
    }

    private static void SubmitMouse(uint flags, uint data = 0, int dx = 0, int dy = 0) {
        var input = new Input { type = InputMouse };
        input.value.mouse = new MouseInput { dx = dx, dy = dy, data = data, flags = flags, extra = IntPtr.Zero };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    private static void SubmitKey(ushort key, bool up) {
        var input = new Input { type = InputKeyboard };
        input.value.keyboard = new KeyboardInput { virtualKey = key, flags = up ? KeyUp : 0, extra = IntPtr.Zero };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    private static void SubmitUnicode(char value, bool up) {
        var input = new Input { type = InputKeyboard };
        input.value.keyboard = new KeyboardInput { scanCode = value, flags = Unicode | (up ? KeyUp : 0), extra = IntPtr.Zero };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
    }

    public static void Move(int dx, int dy) {
        SubmitMouse(MouseMove, 0, dx, dy);
    }

    public static void Wheel(int delta) {
        SubmitMouse(MouseWheel, unchecked((uint)delta));
    }

    public static void Button(string name, bool down) {
        uint downFlag;
        uint upFlag;
        if (String.Equals(name, "left", StringComparison.OrdinalIgnoreCase)) { downFlag = LeftDown; upFlag = LeftUp; }
        else if (String.Equals(name, "right", StringComparison.OrdinalIgnoreCase)) { downFlag = RightDown; upFlag = RightUp; }
        else if (String.Equals(name, "middle", StringComparison.OrdinalIgnoreCase)) { downFlag = MiddleDown; upFlag = MiddleUp; }
        else return;

        lock (Gate) {
            if (down) {
                if (HeldButtons.Add(name)) SubmitMouse(downFlag);
            } else if (HeldButtons.Remove(name)) SubmitMouse(upFlag);
        }
    }

    public static void Key(string name, bool down) {
        ushort key;
        if (!TryGetVirtualKey(name, out key)) return;
        lock (Gate) {
            if (down) {
                if (HeldKeys.Add(name)) SubmitKey(key, false);
            } else if (HeldKeys.Remove(name)) SubmitKey(key, true);
        }
    }

    private static void AppendKeyPress(List<Input> inputs, ushort key) {
        var down = new Input { type = InputKeyboard };
        down.value.keyboard = new KeyboardInput { virtualKey = key };
        inputs.Add(down);
        var up = new Input { type = InputKeyboard };
        up.value.keyboard = new KeyboardInput { virtualKey = key, flags = KeyUp };
        inputs.Add(up);
    }

    private static void AppendUnicode(List<Input> inputs, char value, bool up) {
        var input = new Input { type = InputKeyboard };
        input.value.keyboard = new KeyboardInput {
            scanCode = value,
            flags = Unicode | (up ? KeyUp : 0)
        };
        inputs.Add(input);
    }

    public static void Text(string value) {
        if (String.IsNullOrEmpty(value)) return;
        var inputs = new List<Input>(value.Length * 2);
        for (int i = 0; i < value.Length; i++) {
            char character = value[i];
            if (character == '\r') continue;
            if (character == '\n') { AppendKeyPress(inputs, 0x0D); continue; }
            if (character == '\t') { AppendKeyPress(inputs, 0x09); continue; }
            if (character == '\b') { AppendKeyPress(inputs, 0x08); continue; }
            if (Char.IsControl(character)) continue;
            if (Char.IsHighSurrogate(character) && i + 1 < value.Length && Char.IsLowSurrogate(value[i + 1])) {
                AppendUnicode(inputs, character, false);
                AppendUnicode(inputs, value[++i], false);
                AppendUnicode(inputs, value[i], true);
                AppendUnicode(inputs, character, true);
                continue;
            }
            AppendUnicode(inputs, character, false);
            AppendUnicode(inputs, character, true);
        }
        if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Input)));
    }

    public static void Reset() {
        lock (Gate) {
            foreach (string name in HeldKeys.ToArray()) {
                ushort key;
                if (TryGetVirtualKey(name, out key)) SubmitKey(key, true);
            }
            HeldKeys.Clear();
            foreach (string name in HeldButtons.ToArray()) {
                if (String.Equals(name, "left", StringComparison.OrdinalIgnoreCase)) SubmitMouse(LeftUp);
                else if (String.Equals(name, "right", StringComparison.OrdinalIgnoreCase)) SubmitMouse(RightUp);
                else if (String.Equals(name, "middle", StringComparison.OrdinalIgnoreCase)) SubmitMouse(MiddleUp);
            }
            HeldButtons.Clear();
        }
    }
}
'@

Add-Type -TypeDefinition $nativeInput -ErrorAction Stop
$pairingPin = Read-EnvironmentValue 'PAIRING_PIN'
$hostToken = Read-EnvironmentValue 'HOST_TOKEN'
if (-not $pairingPin -or -not $hostToken) { throw 'The .env file is missing. Run start.ps1 first.' }

$webSocketUri = [Uri]'ws://127.0.0.1:8765/host'
Write-BridgeLog 'Bridge process started.'

while ($true) {
    $client = $null
    $cancellation = $null
    try {
        $client = [System.Net.WebSockets.ClientWebSocket]::new()
        $cancellation = [System.Threading.CancellationTokenSource]::new()
        $client.ConnectAsync($webSocketUri, $cancellation.Token).GetAwaiter().GetResult()

        $hello = @{
            type = 'hello'
            token = $hostToken
            addresses = @(Get-LanAddresses)
        } | ConvertTo-Json -Compress -Depth 4
        $helloBytes = [System.Text.Encoding]::UTF8.GetBytes($hello)
        $helloSegment = [System.ArraySegment[byte]]::new($helloBytes)
        $client.SendAsync($helloSegment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult()
        Write-BridgeLog 'Connected to the Docker app.'

        $buffer = New-Object byte[] 8192
        while ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $stream = [System.IO.MemoryStream]::new()
            do {
                $segment = [System.ArraySegment[byte]]::new($buffer)
                $result = $client.ReceiveAsync($segment, $cancellation.Token).GetAwaiter().GetResult()
                if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
                $stream.Write($buffer, 0, $result.Count)
            } while (-not $result.EndOfMessage)

            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                $stream.Dispose()
                break
            }

            $messageText = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
            $stream.Dispose()
            $packet = $messageText | ConvertFrom-Json
            if ($packet.type -ne 'input') { continue }

            switch ([string]$packet.action) {
                'move' { [PocketPointerInput]::Move([int]$packet.dx, [int]$packet.dy) }
                'button' { [PocketPointerInput]::Button([string]$packet.button, ([string]$packet.state -eq 'down')) }
                'wheel' { [PocketPointerInput]::Wheel([int]$packet.delta) }
                'key' { [PocketPointerInput]::Key([string]$packet.key, ([string]$packet.state -eq 'down')) }
                'text' { [PocketPointerInput]::Text([string]$packet.text) }
                'reset' { [PocketPointerInput]::Reset() }
            }
        }
        [PocketPointerInput]::Reset()
        Write-BridgeLog 'Connection closed. Reconnecting.'
    } catch {
        [PocketPointerInput]::Reset()
        Write-BridgeLog "Bridge connection error: $($_.Exception.Message)"
    } finally {
        if ($client) { $client.Dispose() }
        if ($cancellation) { $cancellation.Dispose() }
    }
    Start-Sleep -Seconds 2
}
