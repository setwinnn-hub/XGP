. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - วิเคราะห์เหรียญ'
Write-Host ''
Write-Host ' วิเคราะห์เหรียญตอนนี้: คะแนนโอกาส 0-100 + ระดับความเสี่ยง พร้อมเหตุผล' -ForegroundColor Cyan
Write-Host ' (คะแนนมาจากกฎที่ตรวจสอบได้ ไม่ใช่การทำนายราคา)'
Write-Host ''
$chain = Read-Host ' Chain (solana / ethereum / base / bsc)'
$token = Read-Host ' Contract address ของเหรียญ'
Invoke-Npm run --silent analyse -- $chain.Trim() $token.Trim()
Wait-Close
