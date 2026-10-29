# Builds a self-contained zip for installing on another Windows computer (Node runtime included).
#   powershell -File tools\package.ps1      ->  dist\AllinOne-<version>.zip
# On the target: unzip, double-click Setup.cmd (installs to %LOCALAPPDATA%\Programs\AllinOne, desktop icon, autostart).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $env:TEMP "allinone-package-$version"
$dist = Join-Path $root 'dist'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage, $dist, (Join-Path $stage 'runtime'), (Join-Path $stage 'build\android') | Out-Null

foreach ($item in 'src', 'web', 'web-control', 'tray', 'node_modules', 'package.json', 'AllinOne.vbs', 'Setup.cmd', 'README.md', 'LICENSE') {
  Copy-Item (Join-Path $root $item) (Join-Path $stage $item) -Recurse
}
Copy-Item (Join-Path $root 'runtime\node') (Join-Path $stage 'runtime\node') -Recurse
$apk = Join-Path $root 'build\android\AllinOne.apk'
if (Test-Path $apk) { Copy-Item $apk (Join-Path $stage 'build\android\AllinOne.apk') } # served by the hub at /app.apk

$zip = Join-Path $dist "AllinOne-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Remove-Item $stage -Recurse -Force
# Upload both to the GitHub release: the hub checks the download against the .sha256 before installing it.
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$zip.sha256", "$sha  AllinOne-$version.zip`n")
$size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
"$zip ($size MB)"
"$zip.sha256"
