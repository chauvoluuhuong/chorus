# Chorus in a Docker box on Windows, opened in your browser. Served by the website next to install.sh:
#   irm https://chorus-cli.web.app/docker.ps1 | iex
#   preview: $env:CHORUS_CHANNEL="preview"; irm https://chorus-cli.web.app/docker.ps1 | iex
# Needs Docker Desktop (WSL 2, its default). Asks: stable or preview, the folders to share (Enter for your home folder, a path, or
# Browse...), the port. Each folder is mounted at the matching Linux path (C:\Users\Lan -> /mnt/c/Users/Lan). Run it again to open
# Chorus again; to start over: docker rm -f chorus
# Same as docker.sh (macOS, Linux). Options: CHORUS_CHANNEL, CHORUS_SHARE (folders joined by ';'), CHORUS_PORT, CHORUS_NAME,
# CHORUS_VOLUME, CHORUS_NO_OPEN=1, CHORUS_BOX_IMAGE.
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host ""; Write-Host "x $msg" -ForegroundColor Red; throw $msg }

$Image = if ($env:CHORUS_BOX_IMAGE) { $env:CHORUS_BOX_IMAGE } else { 'ghcr.io/chauvoluuhuong/chorus-box:latest' }
$Name = if ($env:CHORUS_NAME) { $env:CHORUS_NAME } else { 'chorus' }
$Volume = if ($env:CHORUS_VOLUME) { $env:CHORUS_VOLUME } else { 'chorus-home' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), then run this again.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running. Start it, wait until it says it is running, then run this again.' }

function Running { (docker inspect -f '{{.State.Running}}' $Name 2>$null) -eq 'true' }

function Show-Chorus {
  $since = docker inspect -f '{{.State.StartedAt}}' $Name
  $url = $null
  for ($i = 0; $i -lt 240 -and -not $url; $i++) {
    $line = docker logs --since $since $Name 2>&1 | Where-Object { "$_" -like 'chorus serve: *' } | Select-Object -Last 1
    if ($line) { $url = "$line".Substring(14).Trim() } elseif (-not (Running)) { break } else { Start-Sleep -Milliseconds 500 }
  }
  if (-not $url) { docker logs --tail 30 $Name; Fail "The box did not start Chorus. Its log is above (docker logs $Name)." }
  # the box prints 127.0.0.1; on Windows the browser reaches the published port as localhost
  $url = $url -replace '^http://127\.0\.0\.1:', 'http://localhost:'
  Write-Host ""
  Write-Host "Chorus is running in the box `"$Name`". Open it in your browser:" -ForegroundColor Green
  Write-Host "  $url"
  Write-Host ""
  Write-Host "  Sign in the AI CLIs from this window:"
  Write-Host "    docker exec -it -u chorus $Name claude auth login"
  Write-Host "    docker exec -it -u chorus $Name codex login --device-auth"
  Write-Host "    docker exec -it -u chorus $Name agy"
  Write-Host "  Stop: docker stop $Name   Open again: run this command again   Start over: docker rm -f $Name"
  if (-not $env:CHORUS_NO_OPEN) { Start-Process $url }
}

# already made: start it if stopped, show the address, ask nothing
docker container inspect $Name *> $null
if ($LASTEXITCODE -eq 0) {
  if (-not (Running)) { Write-Host "Starting the Chorus box `"$Name`"..."; docker start $Name | Out-Null }
  Show-Chorus
  return
}

Write-Host ""
Write-Host 'Chorus in a Docker box: a few questions (press Enter for the default).'
Write-Host ""

# 1. stable or preview
$Channel = $env:CHORUS_CHANNEL
if (-not $Channel) {
  $a = Read-Host "1. Stable or preview? Preview gets every change as soon as it's merged and can break. [stable]"
  $Channel = if ($a -match '^(p|preview|2)$') { 'preview' } else { 'stable' }
}
switch -regex ($Channel) { '^preview$' { $Channel = 'preview' } '^(stable|production)$' { $Channel = 'stable' } default { Fail "CHORUS_CHANNEL is $Channel; it can be stable or preview." } }

# 2. the folders to share, each at its Linux path inside the box
function Pick-Folder {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = 'Folder to share with the agents in the Chorus box'
  $d.SelectedPath = $HOME
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
  return $null
}
# C:\Users\Lan -> /mnt/c/Users/Lan (the folder is already a full path)
function LinuxPath($full) {
  if ($full -notmatch '^([A-Za-z]):(.*)$') { Fail "$full is not on a drive letter; choose a folder like C:\Users\you\projects." }
  $rest = ($Matches[2] -replace '\\', '/').TrimEnd('/')
  return '/mnt/' + $Matches[1].ToLower() + $rest
}
$Folders = @()
function Add-Folder($answer) {
  if ($answer -match '^(b|browse|browse\.\.\.)$') { $answer = Pick-Folder; if (-not $answer) { return $false } }
  if (-not (Test-Path -LiteralPath $answer -PathType Container)) { Write-Host "   $answer is not a folder."; return $false }
  $full = (Resolve-Path -LiteralPath $answer).ProviderPath.TrimEnd('\')
  $script:Folders += $full
  return $true
}
if ($env:CHORUS_SHARE) {
  foreach ($f in $env:CHORUS_SHARE.Split(';')) { if ($f) { Add-Folder $f | Out-Null } }
} else {
  do {
    $a = Read-Host "2. Folder to share with the agents: Enter for $HOME, a path, or B to browse"
    if (-not $a) { $a = $HOME }
  } until (Add-Folder $a)
  while ($true) {
    $more = Read-Host '   Share another folder? A path, B to browse, or Enter for no'
    if (-not $more) { break }
    Add-Folder $more | Out-Null
  }
}
if ($Folders.Count -eq 0) { Fail 'No folder to share.' }
foreach ($f in $Folders) {
  if ($f -eq $HOME.TrimEnd('\')) {
    Write-Host '   Note: the agents can read and change anything in your home folder, keys and settings files included.'
    Write-Host "   A projects folder is safer: docker rm -f $Name, then run this again and choose one."
  }
}
# big projects are faster inside WSL than on C:, which Linux reads across the Windows boundary
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $distros = (wsl.exe -l -q 2>$null) -replace "`0", '' | Where-Object { $_ -and $_ -notmatch '^docker-desktop' }
  if ($distros) {
    Write-Host "   Tip: big projects are faster in a folder inside WSL ($(@($distros)[0])). From a WSL terminal there:"
    Write-Host '        curl -fsSL https://chorus-cli.web.app/docker.sh | bash'
  }
}

# 3. the port, on this computer only
function PortFree($p) { -not (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
$Port = $env:CHORUS_PORT
if (-not $Port) {
  $default = 4318
  while (-not (PortFree $default)) { $default++ }
  $Port = Read-Host "3. Port [$default]"
  if (-not $Port) { $Port = "$default" }
}
if ($Port -notmatch '^\d+$') { Fail 'The port must be a number, like 4318.' }
if (-not (PortFree ([int]$Port))) { Fail "Port $Port is in use on this computer. Run this again and choose another." }

Write-Host ""
Write-Host "Getting the box ($Image)..."
docker pull $Image *> $null
if ($LASTEXITCODE -ne 0) { docker image inspect $Image *> $null; if ($LASTEXITCODE -ne 0) { Fail "Could not download $Image. Check your internet connection." } }

$channelEnv = if ($Channel -eq 'preview') { 'preview' } else { 'production' }
$runArgs = @('run', '-d', '--name', $Name, '-p', "127.0.0.1:${Port}:${Port}", '-v', "${Volume}:/home/chorus", '-e', "CHORUS_PORT=$Port", '-e', "CHORUS_BOX_NAME=$Name", '-e', "CHORUS_CHANNEL=$channelEnv")
$shared = @()
foreach ($f in $Folders) {
  $l = LinuxPath $f
  $runArgs += @('-v', "${f}:${l}")
  $shared += $l
}
$runArgs += @('-e', "CHORUS_SHARED=$($shared -join ':')", $Image)
docker @runArgs | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Docker could not start the box (see above).' }
Write-Host "Installing Chorus ($Channel) in the box; the first start takes a minute..."
Show-Chorus
