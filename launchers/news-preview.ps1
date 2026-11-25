. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - ข่าวล่าสุด'
Write-Host ''
Write-Host ' ข่าว Meme Coin ล่าสุดจากทุกแหล่ง (ดูอย่างเดียว ไม่ส่ง Discord)' -ForegroundColor Cyan
Invoke-Npm run --silent news:preview -- 720
Wait-Close
