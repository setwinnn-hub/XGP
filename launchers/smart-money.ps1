. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - Smart Money Ranking'
Write-Host ''
Write-Host ' อันดับ Wallet ที่ติดตาม (30 วันล่าสุด) จากการซื้อขายจริงที่บันทึกไว้' -ForegroundColor Cyan
Write-Host ''
Invoke-Npm run --silent smartmoney -- 30
Write-Host ''
$answer = Read-Host ' ส่งอันดับนี้เข้า Discord ด้วยไหม? พิมพ์ y แล้วกด Enter (อย่างอื่น = ไม่ส่ง)'
if ($answer.Trim().ToLower() -eq 'y') { Invoke-Npm run --silent smartmoney -- 30 --post }
Wait-Close
