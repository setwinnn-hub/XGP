. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - ลบ Wallet'
Write-Host ''
Write-Host ' Wallet ที่ติดตามอยู่ตอนนี้:' -ForegroundColor Cyan
Invoke-Npm run --silent wallet -- list
Write-Host ''
$chain = Read-Host ' Chain ของ wallet ที่จะลบ (solana / ethereum / base / bsc)'
$address = Read-Host ' Wallet address ที่จะลบ'
Write-Host ''
Invoke-Npm run --silent wallet -- remove $chain.Trim() $address.Trim()
Wait-Close
