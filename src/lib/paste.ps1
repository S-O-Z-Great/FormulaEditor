# Auto-paste helper. Runs as a long-lived PowerShell process, reads commands from stdin.
#
# Why long-lived: spawning PowerShell costs 600-900ms per call, which is unusable for
# a paste operation. We compile the C# once at startup, then every command is sub-10ms.
#
# Commands:
#   host          hwnd|process|windowclass of the foreground window (call before panel shows)
#   title         window text of the foreground window, base64(utf8) - ASCII safe
#   focus [hwnd]  bring that window to the front, no keystrokes
#   undo          send Ctrl+Z to the foreground window (self-test only)
#   grab          remember the current foreground window handle (call before panel shows)
#   paste [hwnd]  give focus back to that window, then send Ctrl+V
#   selall        select all + copy in the foreground window (self-test only)
#   ping          liveness probe
#   quit          exit
#
# ENCODING: this file must stay pure ASCII. PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so any non-ASCII character corrupts the embedded C# source and Add-Type fails.

$ErrorActionPreference = 'Stop'

$compiled = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class FeWin {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    // Find a visible top-level window by (partial) title.
    // Process.MainWindowHandle is not reliable for apps that put the document
    // inside a frame window (WPS does): the handle you get back may not be the one
    // SetForegroundWindow needs. Searching by title gives the real target.
    // Returns "hwnd|base64(title)" or "none".
    public static string Find(string text) {
        string found = "";
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            string t = sb.ToString();
            if (t.Length > 0 && t.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = h.ToInt64().ToString() + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(t));
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found.Length == 0 ? "none" : found;
    }

    public const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // Clipboard inspection (see Clip()).
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetClipboardFormatName(uint format, StringBuilder lpszFormatName, int cchMaxCount);

    const byte VK_CONTROL = 0x11;
    const byte VK_V = 0x56;
    const byte VK_A = 0x41;
    const byte VK_C = 0x43;
    const byte VK_MENU = 0x12;
    const byte VK_SHIFT = 0x10;
    const uint KEYUP = 0x0002;

    static void Tap(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
    }

    // "hwnd|processname|windowclass" - lets the host pick the right clipboard format
    public static string Host() {
        IntPtr h = GetForegroundWindow();
        uint pid = 0;
        GetWindowThreadProcessId(h, out pid);
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        string proc = "";
        try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
        return h.ToInt64().ToString() + "|" + proc + "|" + cls.ToString();
    }

    // Window title of the foreground window, base64(utf8).
    // Document titles are usually Chinese; PowerShell would mangle them through the
    // console code page, so we hand back base64 and let the caller decode it.
    public static string Title() {
        IntPtr h = GetForegroundWindow();
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString()));
    }

    // List the clipboard formats currently on the clipboard, e.g. "HTML Format,PNG,text/plain".
    // "Does WPS see an image or text?" cannot be answered by the Electron clipboard API
    // (its has() can be optimistic); this asks Windows directly.
    public static string Clip() {
        if (!OpenClipboard(IntPtr.Zero)) return "err";
        StringBuilder sb = new StringBuilder();
        try {
            uint f = 0;
            while ((f = EnumClipboardFormats(f)) != 0) {
                string name = "";
                if (f >= 0xC000) {
                    StringBuilder n = new StringBuilder(256);
                    if (GetClipboardFormatName(f, n, 256) > 0) name = n.ToString();
                } else {
                    name = StandardFormat(f);
                }
                if (name.Length == 0) name = "fmt" + f;
                if (sb.Length > 0) sb.Append(",");
                sb.Append(name);
            }
        } finally { CloseClipboard(); }
        return sb.ToString();
    }

    static string StandardFormat(uint f) {
        if (f == 1) return "text";
        if (f == 2) return "bitmap";
        if (f == 3) return "metafile";
        if (f == 8) return "dib";
        if (f == 13) return "unicode-text";
        if (f == 16) return "locale";
        if (f == 17) return "dibv5";
        return "";
    }

    // Bring a window to the front and verify it actually got there.
    // SetForegroundWindow's return value lies: Windows may refuse the switch and
    // still return true, so we re-read GetForegroundWindow and compare handles.
    //
    // Windows also refuses SetForegroundWindow outright when the caller does not
    // own the current foreground window - that is why a plain call came back
    // "focus=false" while some other app happened to be in front. Attaching to the
    // foreground thread lifts that restriction for the duration of the call.
    public static bool FocusIt(IntPtr h) {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        for (int i = 0; i < 3; i++) {
            IntPtr fg = GetForegroundWindow();
            uint fgPid = 0, tgPid = 0;
            uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
            uint tgTid = GetWindowThreadProcessId(h, out tgPid);
            bool attached = false;
            try {
                // Send the ALT before attaching: once the input queues are shared,
                // the keystroke would go to the target window (and pop its menu).
                keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
                keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
                if (fgTid != 0 && tgTid != 0 && fgTid != tgTid) {
                    attached = AttachThreadInput(fgTid, tgTid, true);
                }
                if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
                BringWindowToTop(h);
            } finally {
                if (attached) AttachThreadInput(fgTid, tgTid, false);
            }
            System.Threading.Thread.Sleep(90);
            if (GetForegroundWindow() == h) return true;
        }
        return false;
    }

    // Never send Ctrl+V into a window we did not manage to focus: the text would
    // land in whatever happened to be in front, which is worse than not pasting.
    public static string PasteTo(IntPtr h) {
        if (!FocusIt(h)) return "nofocus";
        Paste();
        return "ok";
    }

    public static void Paste() {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(12);
        keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    }

    public static void Undo() {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Tap(0x5A); /* VK_Z */
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    }

    // Send an arbitrary key combo, e.g. "ctrl+alt+q". Used to self-test the
    // global hotkey without someone physically pressing it.
    public static bool Combo(string spec) {
        if (spec == null || spec.Length == 0) return false;
        string[] parts = spec.ToLower().Split('+');
        byte[] vk = new byte[parts.Length];
        for (int i = 0; i < parts.Length; i++) {
            string p = parts[i].Trim();
            if (p == "ctrl" || p == "control") { vk[i] = VK_CONTROL; }
            else if (p == "alt") { vk[i] = VK_MENU; }
            else if (p == "shift") { vk[i] = VK_SHIFT; }
            else if (p == "win" || p == "meta") { vk[i] = 0x5B; }
            else if (p.Length == 1) { vk[i] = (byte)char.ToUpper(p[0]); }
            else if (p.Length >= 2 && p[0] == 'f' && char.IsDigit(p[1])) {
                int n = int.Parse(p.Substring(1));
                if (n < 1 || n > 12) return false;
                vk[i] = (byte)(0x6F + n);
            }
            else { return false; }
        }
        for (int i = 0; i < vk.Length; i++) keybd_event(vk[i], 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        for (int i = vk.Length - 1; i >= 0; i--) keybd_event(vk[i], 0, KEYUP, UIntPtr.Zero);
        return true;
    }

    public static void SelectAllCopy() {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Tap(VK_A);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
        System.Threading.Thread.Sleep(70);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Tap(VK_C);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
        System.Threading.Thread.Sleep(70);
    }
}
'@
    $compiled = $true
}
catch {
    $compiled = $false
}

$out = [Console]::Out
$in = [Console]::In

$running = $true
while ($running -and $null -ne ($line = $in.ReadLine())) {
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line -split '\s+'
    $cmd = $parts[0]

    if ($cmd -eq 'quit') {
        $out.WriteLine('bye')
        $running = $false
    }
    elseif (-not $compiled) {
        $out.WriteLine('err')
    }
    elseif ($cmd -eq 'host') {
        try {
            $out.WriteLine([FeWin]::Host())
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'find') {
        try {
            if ($parts.Count -ge 2) {
                $text = ($line -replace '^\S+\s+', '')
                $out.WriteLine([FeWin]::Find($text))
            }
            else { $out.WriteLine('none') }
        }
        catch { $out.WriteLine('none') }
    }
    elseif ($cmd -eq 'title') {
        try {
            $out.WriteLine([FeWin]::Title())
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'grab') {
        try {
            $h = [FeWin]::GetForegroundWindow().ToInt64()
            if ($h -lt 0) { $h = 0 }
            $out.WriteLine([string]$h)
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'focus') {
        try {
            if ($parts.Count -ge 2) {
                if ([FeWin]::FocusIt([IntPtr][long]$parts[1])) { $out.WriteLine('ok') }
                else { $out.WriteLine('nofocus') }
            }
            else { $out.WriteLine('err') }
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'undo') {
        try {
            [FeWin]::Undo()
            $out.WriteLine('ok')
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'paste') {
        try {
            if ($parts.Count -ge 2) {
                $h = [IntPtr][long]$parts[1]
                $out.WriteLine([FeWin]::PasteTo($h))
            }
            else {
                [FeWin]::Paste()
                $out.WriteLine('ok')
            }
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'clip') {
        try {
            $out.WriteLine([FeWin]::Clip())
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'combo') {
        try {
            if ($parts.Count -ge 2 -and [FeWin]::Combo($parts[1])) { $out.WriteLine('ok') }
            else { $out.WriteLine('err') }
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'selall') {
        try {
            [FeWin]::SelectAllCopy()
            $out.WriteLine('ok')
        }
        catch { $out.WriteLine('err') }
    }
    elseif ($cmd -eq 'ping') {
        $out.WriteLine('pong')
    }
    else {
        $out.WriteLine('err')
    }
    $out.Flush()
}
