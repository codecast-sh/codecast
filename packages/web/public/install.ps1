# Codecast installer script for Windows
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

Write-Host "Installing codecast..."

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

if ($arch -ne "x64") {
    Write-Error "Error: Only 64-bit Windows is supported"
    exit 1
}

$downloadHost = "https://dl.codecast.sh"
$binaryName = "codecast-windows-x64.exe"
$installDir = "$env:LOCALAPPDATA\codecast"
$downloadUrl = "$downloadHost/$binaryName"
$targetPath = Join-Path $installDir "codecast.exe"
$setupToken = $env:CODECAST_SETUP_TOKEN

Write-Host "Platform: windows-$arch"
Write-Host "Install directory: $installDir"

# Create install directory
if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Download binary. Invoke-WebRequest shows a progress bar by default, so the
# ~70MB download doesn't look frozen.
Write-Host "Downloading codecast..."
$tempFile = [System.IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile -UseBasicParsing
} catch {
    Write-Error "Failed to download codecast: $_"
    exit 1
}

# Stop a running daemon before replacing the binary it's executing from.
if (Test-Path $targetPath) {
    try {
        Write-Host "Stopping running daemon..."
        & $targetPath stop *> $null
        # Windows locks a running .exe; give it a moment to release before we
        # overwrite, or Move-Item fails with "file in use".
        Start-Sleep -Seconds 1
    } catch {
        # No daemon running, or it couldn't be stopped — safe to continue.
    }
}

# Install binary
Write-Host "Installing to $targetPath..."
Move-Item -Path $tempFile -Destination $targetPath -Force

# Add to PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    Write-Host ""
    Write-Host "Adding $installDir to PATH..."
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    $env:Path = "$env:Path;$installDir"
    Write-Host "PATH updated. You may need to restart your terminal."
}

Write-Host ""
Write-Host "codecast installed successfully!" -ForegroundColor Green
Write-Host ""

if ($setupToken) {
    # Token path: links this device without the browser callback flow.
    Write-Host "Linking device..."
    & $targetPath login $setupToken
} else {
    Write-Host "Run 'codecast auth' to authenticate and start syncing."
    Write-Host "Or generate a token at codecast.sh/settings/cli and run 'codecast login <token>'."
}
