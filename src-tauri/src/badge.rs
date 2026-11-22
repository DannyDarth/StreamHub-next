//! The ad blocking badge: a small transparent, always-on-top window shown in the top-right corner
//! of the video player's window while a stream starts, switches proxies or blocks an ad.

#[cfg(windows)]
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::adblock::Status;

pub const LABEL: &str = "badge";
pub const TITLE: &str = "StreamHub ad blocking badge";

/// Finds the first visible top-level window of Streamlink or its descendants (Streamlink starts the
/// player as a child process) and shows the badge window (found by its title) in that window's
/// top-right corner, inside the monitor's work area, without taking the focus.
/// With STREAMHUB_FALLBACK=1 and no player window it uses the top-right corner of the monitor the
/// badge is on. Prints "moved", "placed", "no-player" or "no-badge".
#[cfg(windows)]
const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StreamHubWin32 {
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
	[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
	[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
	[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
	[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
'@
[StreamHubWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$badge = [StreamHubWin32]::FindWindow($null, $env:STREAMHUB_BADGE_TITLE)
if ($badge -eq [IntPtr]::Zero) { 'no-badge'; exit }
$ids = @([int]$env:STREAMHUB_PID)
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
for ($i = 0; $i -lt 4; $i++) {
	$ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }) | Select-Object -Unique)
}
$player = [IntPtr]::Zero
foreach ($id in $ids) {
	if ($id -le 0) { continue }
	$p = Get-Process -Id $id
	if ($p -and $p.MainWindowHandle -ne 0 -and [StreamHubWin32]::IsWindowVisible($p.MainWindowHandle)) { $player = $p.MainWindowHandle; break }
}
$result = 'moved'
$anchor = $player
if ($player -eq [IntPtr]::Zero) {
	if ($env:STREAMHUB_FALLBACK -ne '1') { 'no-player'; exit }
	$anchor = $badge
	$result = 'placed'
}
$info = New-Object StreamHubWin32+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
[StreamHubWin32]::GetMonitorInfo([StreamHubWin32]::MonitorFromWindow($anchor, 2), [ref]$info) | Out-Null
$work = $info.rcWork
$pr = New-Object StreamHubWin32+RECT
if ($player -ne [IntPtr]::Zero) { [StreamHubWin32]::GetWindowRect($player, [ref]$pr) | Out-Null } else { $pr = $work }
$dpi = [StreamHubWin32]::GetDpiForWindow($anchor); if (-not $dpi) { $dpi = 96 }
$margin = [int](16 * $dpi / 96)
# twice: Windows may rescale the badge when it moves to a monitor with different scaling
for ($pass = 0; $pass -lt 2; $pass++) {
	$br = New-Object StreamHubWin32+RECT
	[StreamHubWin32]::GetWindowRect($badge, [ref]$br) | Out-Null
	$w = $br.R - $br.L; $h = $br.B - $br.T
	$x = [Math]::Min($pr.R, $work.R) - $w - $margin
	$y = [Math]::Max($pr.T, $work.T) + $margin
	$x = [Math]::Max($work.L, [Math]::Min($x, $work.R - $w))
	$y = [Math]::Max($work.T, [Math]::Min($y, $work.B - $h))
	# HWND_TOPMOST, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
	[StreamHubWin32]::SetWindowPos($badge, [IntPtr](-1), $x, $y, 0, 0, 0x0051) | Out-Null
}
$result
"#;

/// Create the (hidden) badge window. It loads now so it's ready when the first stream starts.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("badge.html".into()))
        .title(TITLE)
        .inner_size(300.0, 64.0)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    builder.build()?;
    Ok(())
}

#[cfg(windows)]
fn run_script(pid: u32, fallback: bool) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("STREAMHUB_PID", pid.to_string())
        .env("STREAMHUB_BADGE_TITLE", TITLE)
        .env("STREAMHUB_FALLBACK", if fallback { "1" } else { "0" })
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .last()
                .unwrap_or("error")
                .to_string()
        })
        .unwrap_or_else(|_| "error".into())
}

/// Update the badge and show it on the player's window (Streamlink's process `pid`).
pub fn show(app: &AppHandle, pid: u32, status: &Status) {
    let _ = app.emit_to(LABEL, "badge-status", status);
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            // the player's window may not exist yet right after Streamlink starts it
            for attempt in 1..=4 {
                let last = attempt == 4;
                match run_script(pid, last).as_str() {
                    "moved" | "placed" => return,
                    "no-player" if !last => std::thread::sleep(Duration::from_millis(1500)),
                    _ => break,
                }
            }
        }
        // the script couldn't show it: show it where it is
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.show();
        }
    });
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Called by the badge after it has faded out.
#[tauri::command]
pub fn badge_hide(app: AppHandle) {
    hide(&app);
}
