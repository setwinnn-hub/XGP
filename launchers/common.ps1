# Shared helpers for the desktop launchers. Dot-source from each launcher.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

function Get-RadarProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src/main.ts*' }
}

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
  & npm.cmd @NpmArgs
}

function Wait-Close {
  Write-Host ''
  Read-Host 'กด Enter เพื่อปิดหน้าต่าง' | Out-Null
}
