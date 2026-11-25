. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - รายชื่อ Wallet'
Write-Host ''
Write-Host ' Wallet ที่ติดตามอยู่:' -ForegroundColor Cyan
Invoke-Npm run --silent wallet -- list
Wait-Close
