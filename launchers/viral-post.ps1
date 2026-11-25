. "$PSScriptRoot\common.ps1"
$Host.UI.RawUI.WindowTitle = 'Viral World Radar - ส่งรายงาน'
$latest = Get-ChildItem (Join-Path $ProjectDir 'docs\viral') -Filter *.json -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latest) {
  Write-Host ' ไม่พบไฟล์รายงานในโฟลเดอร์ docs\viral' -ForegroundColor Red
  Wait-Close
  exit
}
Write-Host ''
Write-Host " รายงานล่าสุด: $($latest.Name)" -ForegroundColor Cyan
Write-Host ' จะส่งเข้า Discord ช่อง Viral World ทีละเรื่อง พร้อมรูป'
Write-Host ''
$answer = Read-Host ' พิมพ์ y แล้วกด Enter เพื่อส่ง (อย่างอื่น = ยกเลิก)'
if ($answer.Trim().ToLower() -ne 'y') {
  Write-Host ' ยกเลิกแล้ว ไม่ได้ส่งอะไร'
  Wait-Close
  exit
}
Invoke-Npm run --silent viral:post -- $latest.FullName
Wait-Close
