. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Meme Coin Radar - เพิ่ม Wallet'
Write-Host ''
Write-Host ' เพิ่ม Wallet สาธารณะที่ต้องการติดตาม (บอทที่ทำงานอยู่จะเริ่มติดตามภายใน 15 วินาที)'
Write-Host ' ห้ามใส่ Private Key หรือ Seed Phrase เด็ดขาด ใส่แค่ address สาธารณะ' -ForegroundColor Yellow
Write-Host ''
$chain = Read-Host ' Chain (solana / ethereum / base / bsc)'
$address = Read-Host ' Wallet address'
$label = Read-Host ' ชื่อเล่น เช่น เทรดเดอร์ A (เว้นว่างได้)'
Write-Host ''
Invoke-Npm run --silent wallet -- add $chain.Trim() $address.Trim() $label
Wait-Close
