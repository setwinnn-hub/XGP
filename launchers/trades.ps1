. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - การซื้อขายของ Wallet'
Write-Host ''
Write-Host ' การซื้อขายของ Wallet ที่ติดตาม (24 ชั่วโมงล่าสุด)' -ForegroundColor Cyan
Invoke-Npm run --silent trades 24
Wait-Close
