# Watchdog: restart the bot if the admin port is not listening.
# ASCII-only on purpose: Windows PowerShell 5.1 reads this file as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$port = 8898
$log = Join-Path $root 'data\logs\watchdog.log'
$cfg = Join-Path $PSScriptRoot 'watchdog-chats.txt'

$logDir = Split-Path $log
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

$alive = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect('127.0.0.1', $port)
  $c.Close()
  $alive = $true
} catch { }

if ($alive) { exit 0 }

# 人工停止标记：存在就绝不自动拉起（打游戏/睡觉时用）
$stopFlag = Join-Path $root 'data\STOP.flag'
if (Test-Path $stopFlag) { exit 0 }

# 前台是全屏程序（游戏/全屏视频）时不要拉起，避免弹窗打断
try {
  Add-Type -AssemblyName System.Windows.Forms
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
  if (-not ('FgWin' -as [type])) { Add-Type -TypeDefinition $sig }
  $h = [FgWin]::GetForegroundWindow()
  $r = New-Object FgWin+RECT
  if ([FgWin]::GetWindowRect($h, [ref]$r)) {
    $w = $r.R - $r.L
    $hgt = $r.B - $r.T
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($w -ge $screen.Width -and $hgt -ge $screen.Height) {
      Write-Log 'foreground is fullscreen, skip restart'
      exit 0
    }
  }
} catch { }

$wechat = Get-Process -Name Weixin -ErrorAction SilentlyContinue
if (-not $wechat) {
  Write-Log 'WeChat not running, skip'
  exit 1
}

$botName = ''
$chats = @()
if (Test-Path $cfg) {
  $lines = Get-Content -LiteralPath $cfg -Encoding utf8 | Where-Object { $_.Trim() -ne '' }
  if ($lines.Count -ge 2) {
    $botName = $lines[0].Trim()
    $chats = $lines[1..($lines.Count - 1)] | ForEach-Object { $_.Trim() }
  }
}
# 私聊名单（tools\watchdog-private.txt，每行一个昵称或 wxid）
$pvFile = Join-Path $PSScriptRoot 'watchdog-private.txt'
if (Test-Path $pvFile) {
  $pv = Get-Content -LiteralPath $pvFile -Encoding utf8 | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }
  foreach ($x in $pv) { $chats += $x.Trim() }
}
if (-not $chats) {
  Write-Log 'no chat config, skip'
  exit 1
}

$argList = @('start.mjs', '--qq')
foreach ($c in $chats) { $argList += '--chat'; $argList += $c }
if ($botName) { $argList += '--self-name'; $argList += $botName }

# 本地密钥（不进 git）：有就加载，没有就跳过
$secretFile = Join-Path $PSScriptRoot 'secrets.local.ps1'
if (Test-Path $secretFile) { . $secretFile }

Write-Log ('starting bot: ' + ($argList -join ' '))
$outLog = Join-Path $logDir 'console.log'
Start-Process -FilePath 'node' -ArgumentList $argList -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError (Join-Path $logDir 'console.err.log')
Write-Log 'start command sent'
exit 0
