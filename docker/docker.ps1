# Chorus in a Docker box on Windows, opened in your browser. Served by the website next to install.sh:
#   irm https://chorus-cli.web.app/docker.ps1 | iex
#   preview: $env:CHORUS_CHANNEL="preview"; irm https://chorus-cli.web.app/docker.ps1 | iex
#   update:  $env:CHORUS_UPDATE="1"; irm https://chorus-cli.web.app/docker.ps1 | iex   (the newest box and Chorus, for a box you have)
# Needs Docker Desktop (WSL 2, its default). The first time it asks: stable or preview, the folders to share (Enter for your home
# folder, a path, or Browse...); it picks a free port. Each folder is mounted at the matching Linux path (C:\Users\Lan ->
# /mnt/c/Users/Lan). Run it again to open Chorus again: a stopped box is started; nothing is asked or updated. CHORUS_UPDATE=1 gets the
# newest box image and the newest Chorus on the box's channel, keeping its folders, port and home (data and sign-ins); with
# CHORUS_CHANNEL it also switches the channel. To start over: docker rm -f chorus
# Same as docker.sh (macOS, Linux). Options: CHORUS_CHANNEL, CHORUS_UPDATE=1, CHORUS_SHARE (folders joined by ';'), CHORUS_PORT,
# CHORUS_NAME, CHORUS_VOLUME, CHORUS_NO_OPEN=1, CHORUS_BOX_IMAGE.
# 'Continue', not 'Stop': in Windows PowerShell 5.1 (what irm | iex runs in) a native command's stderr, once redirected, becomes an
# error record, and 'Stop' ends the script on the first one ("No such container" on a first install). Failures are checked with
# $LASTEXITCODE and Fail instead.
$ErrorActionPreference = 'Continue'

function Fail($msg) { Write-Host ""; Write-Host "x $msg" -ForegroundColor Red; throw $msg }
$DiskFull = "Docker's disk is full. See what uses it with: docker system df. Free space with docker builder prune and docker image prune (Docker can download or build those again), or give Docker Desktop more disk in Settings > Resources. Then run this again."

$Image = if ($env:CHORUS_BOX_IMAGE) { $env:CHORUS_BOX_IMAGE } else { 'ghcr.io/chauvoluuhuong/chorus-box:latest' }
$Name = if ($env:CHORUS_NAME) { $env:CHORUS_NAME } else { 'chorus' }
$Volume = if ($env:CHORUS_VOLUME) { $env:CHORUS_VOLUME } else { 'chorus-home' }
$Update = [bool]$env:CHORUS_UPDATE

# stable and production are one channel (the box's environment says production); '' is "not chosen"
function Channel($c) {
  switch -regex ("$c") { '^preview$' { return 'preview' } '^(stable|production)$' { return 'stable' } '^$' { return '' } default { Fail "CHORUS_CHANNEL is $c; it can be stable or preview." } }
}
$Channel = Channel $env:CHORUS_CHANNEL

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), then run this again.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running. Start it, wait until it says it is running, then run this again.' }

function Running { (docker inspect -f '{{.State.Running}}' $Name 2>$null) -eq 'true' }
# a variable the box was made with (docker run -e)
function EnvOf($key) {
  $line = docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $Name 2>$null | Where-Object { "$_" -like "$key=*" } | Select-Object -First 1
  if ($line) { return "$line".Substring($key.Length + 1) } else { return '' }
}
# the Chorus version installed in the box, like 2.7.0 ('' when the box is stopped or has none yet)
function BoxVersion {
  $l = docker exec $Name readlink /home/chorus/.chorus/current 2>$null
  if ($LASTEXITCODE -eq 0 -and $l) { return ("$l".Trim() -split '/')[-1] } else { return '' }
}

# the newest box image; an older copy is used, with a warning, when the download fails
function Get-Image {
  Write-Host ""
  Write-Host "Getting the newest box ($Image)..."
  docker pull $Image
  if ($LASTEXITCODE -eq 0) { return }
  $created = docker image inspect -f '{{.Created}}' $Image 2>$null
  if ($LASTEXITCODE -eq 0 -and $created) {
    Write-Host ""
    Write-Host "! Could not download the newest box; using the copy from $("$created".Substring(0, 10))." -ForegroundColor Yellow
    Write-Host "  Check the internet connection and Docker's free disk space (docker system df)."
  } else {
    Fail "Could not download $Image. Check the internet connection and Docker's free disk space (docker system df), then run this again."
  }
}

function Show-Chorus {
  $since = docker inspect -f '{{.State.StartedAt}}' $Name
  $url = $null
  # waits while the box is starting: a first start installs Chorus, up to 10 minutes on a slow line
  for ($i = 1; $i -le 1200 -and -not $url; $i++) {
    $line = docker logs --since $since $Name 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -like 'chorus serve: *' } | Select-Object -Last 1
    if ($line) { $url = $line.Substring(14).Trim() }
    elseif (-not (Running)) { break }
    else {
      if ($i % 120 -eq 0) { Write-Host "  Still starting after $($i / 2) s (docker logs $Name shows what it is doing)..." }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $url) {
    $log = docker logs --since $since --tail 30 $Name 2>&1 | ForEach-Object { "$_" }
    $log | ForEach-Object { Write-Host $_ }
    if (($log -join "`n") -like '*No space left on device*') { Fail $DiskFull }
    if (Running) { Fail "Chorus did not start in the box within 10 minutes. Its log is above (docker logs $Name)." }
    Fail "The box stopped before Chorus started. Its log is above (docker logs $Name)."
  }
  # the box prints 127.0.0.1; on Windows the browser reaches the published port as localhost
  $url = $url -replace '^http://127\.0\.0\.1:', 'http://localhost:'
  $version = BoxVersion
  Write-Host ""
  Write-Host "$(if ($version) { "Chorus $version" } else { 'Chorus' }) is running in the box `"$Name`". Open it in your browser:" -ForegroundColor Green
  Write-Host "  $url"
  Write-Host ""
  Write-Host "  Sign in to Claude Code, Codex and Antigravity in Chorus: click Log in next to each one."
  Write-Host "  Stop: docker stop $Name   Open again: run this command again   Update: `$env:CHORUS_UPDATE=`"1`" first   Start over: docker rm -f $Name"
  if (-not $env:CHORUS_NO_OPEN) { Start-Process $url }
}

# C:\Users\Lan -> /mnt/c/Users/Lan (the folder is already a full path)
function LinuxPath($full) {
  if ($full -notmatch '^([A-Za-z]):(.*)$') { Fail "$full is not on a drive letter; choose a folder like C:\Users\you\projects." }
  $rest = ($Matches[2] -replace '\\', '/').TrimEnd('/')
  return '/mnt/' + $Matches[1].ToLower() + $rest
}
# and back, for a box made again: /mnt/c/Users/Lan -> C:\Users\Lan
function WindowsPath($linux) {
  if ($linux -notmatch '^/mnt/([a-z])(/.*)?$') { return $null }
  return $Matches[1].ToUpper() + ':' + ("$($Matches[2])" -replace '/', '\') + $(if (-not $Matches[2]) { '\' } else { '' })
}

# makes the box from $Port, $Channel, $Folders (Windows paths) and $Volume
function Run-Box {
  $channelEnv = if ($Channel -eq 'preview') { 'preview' } else { 'production' }
  $runArgs = @('run', '-d', '--name', $Name, '-p', "${Port}:${Port}", '-v', "${Volume}:/home/chorus", '-e', "CHORUS_PORT=$Port", '-e', "CHORUS_BOX_NAME=$Name", '-e', "CHORUS_CHANNEL=$channelEnv")
  $shared = @()
  foreach ($f in $Folders) {
    $l = LinuxPath $f
    $runArgs += @('-v', "${f}:${l}")
    $shared += $l
  }
  $runArgs += @('-e', "CHORUS_SHARED=$($shared -join ':')", $Image)
  docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker could not start the box (its message is above).' }
}

# CHORUS_UPDATE on a box that exists: the newest image (the box is made again from it, same settings) or, when it has the newest image
# already, a restart, which installs the newest Chorus on its channel (docker/box/entrypoint.sh)
function Update-Box($have) {
  $before = if (Running) { BoxVersion } else { '' }
  if (-not $script:Channel) { $script:Channel = $have }
  $old = docker inspect -f '{{.Image}}' $Name
  Get-Image
  $new = docker image inspect -f '{{.Id}}' $Image
  if ($new -ne $old -or $script:Channel -ne $have) {
    $script:Port = EnvOf 'CHORUS_PORT'; if (-not $script:Port) { $script:Port = '4318' }
    $v = docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/chorus"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' $Name
    if ($v) { $script:Volume = "$v".Trim() }
    $script:Folders = @((EnvOf 'CHORUS_SHARED').Split(':') | Where-Object { $_ } | ForEach-Object { WindowsPath $_ } | Where-Object { $_ })
    Write-Host ""
    if ($new -ne $old) { Write-Host "Making the box `"$Name`" again from the newest image, on the $($script:Channel) channel..." }
    else { Write-Host "Making the box `"$Name`" again on the $($script:Channel) channel..." }
    Write-Host "  Kept: its home ($($script:Volume): Chorus's data and the sign-ins), port $($script:Port) and shared folders. Chats running in it stop."
    docker rm -f $Name | Out-Null
    Run-Box
    # the old image, unless another box still uses it: 2 GB each, and a full disk stops the box (2026-11-19)
    if ($new -ne $old) { docker image rm $old *> $null }
  } else {
    Write-Host ""
    Write-Host "The box has the newest image. Restarting it to install the newest Chorus ($($script:Channel)); chats running in it stop..."
    docker restart $Name | Out-Null
  }
  Show-Chorus
  $after = BoxVersion
  if ($before -and $before -ne $after) { Write-Host "  Updated Chorus $before -> $after." }
  else { Write-Host "  Chorus $after is the newest on the $($script:Channel) channel." }
}

# a box that exists: open it (start it if stopped), or update it with CHORUS_UPDATE; nothing is asked
docker container inspect $Name *> $null
if ($LASTEXITCODE -eq 0) {
  $have = Channel (EnvOf 'CHORUS_CHANNEL'); if (-not $have) { $have = 'stable' }
  if ($Update) { Update-Box $have; return }
  if ($Channel -and $Channel -ne $have) {
    Write-Host "The box `"$Name`" is on the $have channel. To switch it to ${Channel}: `$env:CHORUS_UPDATE=`"1`"; `$env:CHORUS_CHANNEL=`"$Channel`" and run this again."
  }
  if (-not (Running)) { Write-Host "Starting the Chorus box `"$Name`"..."; docker start $Name | Out-Null }
  Show-Chorus
  return
}
if ($Update) { Write-Host "There is no box `"$Name`" yet: making one." }

# Yes: true for yes (Enter, y, yes), false for no (n, no); asks again otherwise
function Yes($q) {
  while ($true) {
    $a = (Read-Host "$q [Y/n]").Trim()
    if ($a -match '^(|y|yes)$') { return $true }
    if ($a -match '^(n|no)$') { return $false }
    Write-Host '   Type y for yes or n for no (Enter is yes).'
  }
}

Write-Host ""
Write-Host 'Chorus in a Docker box. A few yes/no questions: Enter means yes.'
Write-Host ""
$N = 0  # questions are numbered as they are asked

# 1. stable or preview
if (-not $Channel) {
  $N++; Write-Host "$N. Which version of Chorus?"
  Write-Host "   Stable is the released version. Preview has every change as soon as it's merged, and can break."
  $Channel = if (Yes '   Use the stable version?') { 'stable' } else { 'preview' }
  Write-Host ""
}
Write-Host "   Chorus version: $Channel"
Write-Host ""

# 2. the folders to share, each at its Linux path inside the box
function Pick-Folder {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = 'Folder to share with the agents in the Chorus box'
  $d.SelectedPath = $HOME
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
  return $null
}
$Folders = @()
function Add-Folder($answer) {
  if (-not $answer) { Write-Host '   Type a folder path, or B to pick it in a window.'; return $false }
  if ($answer -match '^(b|browse|browse\.\.\.)$') { $answer = Pick-Folder; if (-not $answer) { return $false } }
  if (-not (Test-Path -LiteralPath $answer -PathType Container)) { Write-Host "   $answer is not a folder."; return $false }
  $full = (Resolve-Path -LiteralPath $answer).ProviderPath.TrimEnd('\')
  $script:Folders += $full
  return $true
}
# a folder browser drawn in the console, as in docker.sh (owner, 2026-11-19: in the terminal, the same on every OS). Starts at $start
# with "Share this folder" selected, so Enter right away shares it. Up/Down move, Enter or Right open (or choose), Left or Backspace
# up, / type a path, a letter jumps to it. Returns the chosen folder.
function Browse-Folder($start) {
  $sep = [IO.Path]::DirectorySeparatorChar
  $dir = $start; $sel = 0; $top = 0
  $rows = [Math]::Max(3, [Math]::Min(12, [Console]::WindowHeight - 8))
  $cols = [Math]::Max(30, [Console]::WindowWidth - 1)
  $height = $rows + 2
  # room for the drawing and one line under it (for a typed path), so drawing never scrolls the window
  for ($i = 0; $i -le $height; $i++) { Write-Host '' }
  $origin = [Console]::CursorTop - $height - 1
  try { [Console]::CursorVisible = $false } catch {}
  while ($true) {
    $items = @('+ Share this folder', '..') + @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
      Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::Hidden) -and -not $_.Name.StartsWith('.') } |
      Sort-Object Name | ForEach-Object { "$($_.Name)$sep" })
    $n = $items.Count
    if ($sel -ge $n) { $sel = $n - 1 }
    if ($sel -lt $top) { $top = $sel }
    if ($sel -ge $top + $rows) { $top = $sel - $rows + 1 }
    [Console]::SetCursorPosition(0, $origin)
    $line = "   Folder: $dir"; Write-Host $line.Substring(0, [Math]::Min($line.Length, $cols)).PadRight($cols)
    for ($i = $top; $i -lt $top + $rows; $i++) {
      if ($i -ge $n) { Write-Host (' ' * $cols) }
      $t = $items[$i]
      if ($i -eq $sel) {
        Write-Host ' ' -NoNewline
        $t = " > $t "; Write-Host $t.Substring(0, [Math]::Min($t.Length, $cols - 2)) -NoNewline -ForegroundColor Black -BackgroundColor Gray
        Write-Host (' ' * [Math]::Max(0, $cols - 1 - [Math]::Min($t.Length, $cols - 2)))
      } else { $t = "   $t"; Write-Host $t.Substring(0, [Math]::Min($t.Length, $cols)).PadRight($cols) }
    }
    $more = if ($n -gt $top + $rows) { " - $($n - $top - $rows) more" } else { '' }
    $line = "   Up/Down move - Enter open or choose - Left back - / type a path$more"
    Write-Host $line.Substring(0, [Math]::Min($line.Length, $cols)).PadRight($cols) -ForegroundColor DarkGray

    $k = [Console]::ReadKey($true)
    $parent = [IO.Directory]::GetParent($dir.TrimEnd($sep))
    switch ($k.Key) {
      'UpArrow' { if ($sel -gt 0) { $sel-- } }
      'DownArrow' { if ($sel -lt $n - 1) { $sel++ } }
      { "$_" -in 'LeftArrow', 'Backspace' } { if ($parent) { $dir = $parent.FullName; $sel = 0; $top = 0 } }
      { "$_" -in 'Enter', 'RightArrow' } {
        if ($sel -eq 0) { if ($k.Key -eq 'Enter') { $done = $true } }
        elseif ($sel -eq 1) { if ($parent) { $dir = $parent.FullName; $sel = 0; $top = 0 } }
        else {
          $p = Join-Path $dir $items[$sel].TrimEnd($sep)
          if (Test-Path -LiteralPath $p -PathType Container) { $dir = (Resolve-Path -LiteralPath $p).ProviderPath; $sel = 0; $top = 0 }
        }
      }
      default {
        $c = "$($k.KeyChar)"
        if ($c -eq '/' -or $c -eq '~') {
          [Console]::SetCursorPosition(0, $origin + $height)
          try { [Console]::CursorVisible = $true } catch {}
          $p = Read-Host '   Path'
          try { [Console]::CursorVisible = $false } catch {}
          [Console]::SetCursorPosition(0, $origin + $height); Write-Host (' ' * $cols)
          if ($p) {
            $p = $p.Trim() -replace '^~', $HOME
            if (Test-Path -LiteralPath $p -PathType Container) { $dir = (Resolve-Path -LiteralPath $p).ProviderPath; $sel = 0; $top = 0 }
          }
        } elseif ($c -match '^\w$') {
          # a letter: the next folder starting with it
          for ($j = 1; $j -le $n; $j++) {
            $x = ($sel + $j) % $n
            if ($x -ge 2 -and $items[$x].StartsWith($c, [StringComparison]::OrdinalIgnoreCase)) { $sel = $x; break }
          }
        }
      }
    }
    if ($done) { break }
  }
  # clear the drawing; the caller prints the choice in its place
  [Console]::SetCursorPosition(0, $origin)
  for ($i = 0; $i -le $height; $i++) { Write-Host (' ' * $cols) }
  [Console]::SetCursorPosition(0, $origin)
  try { [Console]::CursorVisible = $true } catch {}
  return $dir
}
# No: true for no (Enter, n, no), false for yes (y, yes)
function No($q) {
  while ($true) {
    $a = (Read-Host "$q [y/N]").Trim()
    if ($a -match '^(|n|no)$') { return $true }
    if ($a -match '^(y|yes)$') { return $false }
    Write-Host '   Type y for yes or n for no (Enter is no).'
  }
}
# the console can draw the browser: not redirected (a pipe, a scheduled task), and the host has a real console (not the ISE)
function Console-Ok { try { return (-not [Console]::IsInputRedirected) -and ([Console]::WindowHeight -gt 0) } catch { return $false } }
if ($env:CHORUS_SHARE) {
  foreach ($f in $env:CHORUS_SHARE.Split(';')) { if ($f) { Add-Folder $f | Out-Null } }
} else {
  $N++; Write-Host "$N. Which folders can the agents work in?"
  Write-Host '   The agents in the box see only the folders you share.'
  if (Console-Ok) {
    # Enter right away shares the home folder (owner, 2026-11-19)
    do {
      $f = Browse-Folder $HOME
      Add-Folder $f | Out-Null
      Write-Host "   + $f"
    } until (No '   Share another folder too?')
  } else {
    if (Yes "   Share your whole home folder ($HOME)?") { Add-Folder $HOME | Out-Null }
    else {
      do { $a = Read-Host '   Folder to share: type its path, or B to pick it in a window' } until (Add-Folder $a)
      while (-not (Yes '   Is that all the folders?')) {
        do { $a = Read-Host '   Another folder: type its path, or B to pick it in a window' } until (Add-Folder $a)
      }
    }
  }
  $homeFull = (Resolve-Path -LiteralPath $HOME).ProviderPath.TrimEnd('\')
  if ($Folders -contains $homeFull) { Write-Host '   Note: the agents can read and change anything in your home folder, keys and settings files included.' }
  Write-Host ""
}
if ($Folders.Count -eq 0) { Fail 'No folder to share.' }
Write-Host "   Shared: $($Folders -join ', ')"
Write-Host ""
# big projects are faster inside WSL than on C:, which Linux reads across the Windows boundary
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $distros = (wsl.exe -l -q 2>$null) -replace "`0", '' | Where-Object { $_ -and $_ -notmatch '^docker-desktop' }
  if ($distros) {
    Write-Host "   Tip: big projects are faster in a folder inside WSL ($(@($distros)[0])). From a WSL terminal there:"
    Write-Host '        curl -fsSL https://chorus-cli.web.app/docker.sh | bash'
  }
}

# the port
function PortFree($p) { -not (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
# 4318, or the next free one; open on every address of this computer (the token guards it until Chorus has a login)
$Port = $env:CHORUS_PORT
if (-not $Port) {
  $p = 4318
  while (-not (PortFree $p)) { $p++ }
  $Port = "$p"
}
if ($Port -notmatch '^\d+$') { Fail 'The port must be a number, like 4318.' }
if (-not (PortFree ([int]$Port))) { Fail "Port $Port is in use on this computer. Run this again and choose another." }

Get-Image
Run-Box
Write-Host ""
Write-Host "Installing Chorus ($Channel) in the box; the first start takes a minute..."
Show-Chorus
