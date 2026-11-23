<#
  Builds PixCart for Windows hosting (IIS): the Angular app and the API in one folder, ready to copy to the server.

    powershell -ExecutionPolicy Bypass -File tools\publish-windows.ps1 [-Output publish\PixCart]

  Result: publish\PixCart\ with API.dll, web.config and wwwroot\ (the Angular site). Copy it to the IIS site folder
  (e.g. C:\inetpub\PixCart) and recycle the app pool. See docs\DEPLOY_WINDOWS_IIS.md.
#>
param([string]$Output = "publish\PixCart")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "1/3 Building the Angular app (production)..."
Push-Location PixCartWeb
if (-not (Test-Path node_modules)) { npx -y npm@11 ci --no-audit --no-fund }
npx ng build --configuration production
Pop-Location

Write-Host "2/3 Publishing the API (Release, win-x64, framework-dependent)..."
if (Test-Path $Output) { Remove-Item -Recurse -Force $Output }
dotnet publish PixCartAPI\API\API.csproj -c Release -r win-x64 --self-contained false -o $Output

Write-Host "3/3 Copying the Angular app into wwwroot..."
$browser = Get-ChildItem PixCartWeb\dist\*\browser | Select-Object -First 1
New-Item -ItemType Directory -Force (Join-Path $Output "wwwroot") | Out-Null
Copy-Item -Recurse -Force (Join-Path $browser.FullName "*") (Join-Path $Output "wwwroot")
New-Item -ItemType Directory -Force (Join-Path $Output "logs") | Out-Null

Write-Host "Done: $Output"
