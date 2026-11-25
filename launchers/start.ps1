. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - กำลังทำงาน'

# Refuse to start a second copy: two copies would send every alert twice.
if (Get-RadarProcess) {
  Write-Host ''
  Write-Host ' บอททำงานอยู่แล้ว ไม่ต้องเปิดซ้ำ (ถ้าเปิดซ้ำ alert จะเข้า Discord ซ้ำ)' -ForegroundColor Yellow
  Write-Host ' ถ้าต้องการเริ่มใหม่ ให้รัน "2 หยุดบอท" ก่อน'
  Wait-Close
  exit
}

Write-Host ''
Write-Host ' ===== Meme Coin Radar =====' -ForegroundColor Cyan
Write-Host ' กำลังเริ่มบอท... ข้อความด้านล่างคือ log การทำงาน'
Write-Host ' ปิดหน้าต่างนี้ = หยุดบอท' -ForegroundColor Yellow
Write-Host ''
Invoke-Npm start
Write-Host ''
Write-Host ' บอทหยุดทำงานแล้ว' -ForegroundColor Red
Wait-Close
