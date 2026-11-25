. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - หยุดบอท'
$running = @(Get-RadarProcess)
if ($running.Count -eq 0) {
  Write-Host ' ไม่มีบอททำงานอยู่'
} else {
  foreach ($p in $running) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host " หยุดบอทแล้ว (PID $($p.ProcessId))" -ForegroundColor Green
  }
}
Wait-Close
