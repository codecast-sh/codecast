# Codecast installer script for Windows
# Usage: irm codecast.sh/install.ps1 | iex

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

Write-Host "Platform: windows-$arch"
Write-Host "Install directory: $installDir"

# Create install directory
if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Download binary
Write-Host "Downloading codecast..."
$tempFile = [System.IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile -UseBasicParsing
} catch {
    Write-Error "Failed to download codecast: $_"
    exit 1
}

# Install binary
$targetPath = Join-Path $installDir "codecast.exe"
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

# Verify installation
Write-Host ""
Write-Host "codecast installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Run 'codecast auth' to authenticate and start syncing."
