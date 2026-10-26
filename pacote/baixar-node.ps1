# Baixa o Node.js (versão LTS mais recente) para a pasta "runtime", ao lado deste arquivo.
# Nada é instalado no Windows e não precisa de administrador.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
# no PowerShell 5.1 a lista chega como um bloco só: ForEach-Object a desfaz item por item
$releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json' | ForEach-Object { $_ }
$version = ($releases | Where-Object { $_.lts } | Select-Object -First 1).version
$name = "node-$version-win-$arch"
$zip = Join-Path $env:TEMP "$name.zip"
$tmp = Join-Path $PSScriptRoot 'runtime-tmp'

Write-Host "Node.js $version ($arch)"
Invoke-WebRequest "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp -Force
Move-Item (Join-Path $tmp $name) (Join-Path $PSScriptRoot 'runtime')
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force
