# Codecast installer script for Windows.
#
# codecast runs inside WSL (Windows Subsystem for Linux) on Windows. This
# script gets WSL ready and runs the Linux installer inside it. It also
# removes the pieces of an old native Windows install (binary, auto-start
# task), which never worked correctly.
#
# Usage (install only):
#   irm codecast.sh/install.ps1 | iex
#
# Usage (install AND link this device with a setup token from Settings -> CLI):
#   $env:CODECAST_SETUP_TOKEN="<token>"; irm codecast.sh/install.ps1 | iex
#
# A token is passed via env var rather than an argument because `irm | iex`
# evaluates the script text and cannot forward positional parameters.

$ErrorActionPreference = "Stop"

$setupToken = $env:CODECAST_SETUP_TOKEN

Write-Host "codecast on Windows runs inside WSL (Windows Subsystem for Linux)."
Write-Host ""

# --- 1. Remove a legacy native install (harmful: it spawned console windows) ---

& schtasks.exe /Delete /TN CodecastDaemon /F 2>$null | Out-Null
Get-Process codecast -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$legacyDir = "$env:LOCALAPPDATA\codecast"
if (Test-Path (Join-Path $legacyDir "codecast.exe")) {
    Write-Host "Removing old native Windows install from $legacyDir..."
    try {
        Remove-Item -Recurse -Force $legacyDir
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -like "*$legacyDir*") {
            $cleaned = ($userPath -split ";" | Where-Object { $_ -and $_ -ne $legacyDir }) -join ";"
            [Environment]::SetEnvironmentVariable("Path", $cleaned, "User")
        }
    } catch {
        Write-Host "Could not fully remove $legacyDir — you can delete it manually."
    }
}

# --- 2. Make sure WSL has a working distro ---

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
    Write-Host "WSL is not available on this Windows version." -ForegroundColor Yellow
    Write-Host "codecast needs Windows 10 (2004+) or Windows 11."
    exit 1
}

# `wsl -- true` boots the default distro if one exists; a nonzero exit means
# no distro is installed yet (or WSL itself needs the one-time install).
& wsl.exe -- true 2>$null | Out-Null
$hasDistro = ($LASTEXITCODE -eq 0)

if (-not $hasDistro) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        Write-Host "Installing WSL with Ubuntu (one time; this can take a few minutes)..."
        & wsl.exe --install -d Ubuntu
        Write-Host ""
        Write-Host "WSL install started." -ForegroundColor Green
        Write-Host "Restart Windows to finish WSL setup, open Ubuntu once to create your"
        Write-Host "Linux user, then run this installer again:"
    } else {
        Write-Host "WSL is not set up yet. One manual step (needs Administrator):" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  1. Open PowerShell as Administrator and run:  wsl --install"
        Write-Host "  2. Restart Windows, then open Ubuntu once to create your Linux user."
        Write-Host "  3. Run this installer again:"
    }
    Write-Host ""
    if ($setupToken) {
        Write-Host '     $env:CODECAST_SETUP_TOKEN="<token>"; irm codecast.sh/install.ps1 | iex'
    } else {
        Write-Host "     irm codecast.sh/install.ps1 | iex"
    }
    exit 1
}

# --- 3. Run the Linux installer inside WSL ---

# Ubuntu ships curl; for a minimal distro without curl or wget, try to add
# curl via apt as root. Best effort — install.sh gives a clear error if a
# download tool is still missing.
& wsl.exe -- sh -c "command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing curl inside WSL..."
    & wsl.exe -u root -- sh -c "apt-get update -qq && apt-get install -y -qq curl" 2>$null
}

Write-Host "Installing codecast inside WSL..."
Write-Host ""

if ($setupToken) {
    & wsl.exe -- sh -c "curl -fsSL https://codecast.sh/install | sh -s -- '$setupToken'"
} else {
    & wsl.exe -- sh -c "curl -fsSL https://codecast.sh/install | sh"
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Install inside WSL failed (exit $LASTEXITCODE)." -ForegroundColor Yellow
    Write-Host "Open your WSL terminal (run: wsl) and try:  curl -fsSL codecast.sh/install | sh"
    exit 1
}

Write-Host ""
Write-Host "codecast is installed inside WSL." -ForegroundColor Green
Write-Host "Open a WSL terminal (run: wsl) and use 'cast' from there."
if (-not $setupToken) {
    Write-Host "Then run 'cast auth' to authenticate and start syncing."
}
