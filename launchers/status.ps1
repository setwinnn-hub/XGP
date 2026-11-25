. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - สถานะ'
if (Get-RadarProcess) {
  Write-Host ' สถานะ: บอททำงานอยู่' -ForegroundColor Green
} else {
  Write-Host ' สถานะ: บอทไม่ได้ทำงาน' -ForegroundColor Red
}
Write-Host ''
Write-Host ' ===== ความเร็วในการแจ้งเตือน (1 ชั่วโมงล่าสุด) =====' -ForegroundColor Cyan
Invoke-Npm run --silent report 1
Wait-Close
