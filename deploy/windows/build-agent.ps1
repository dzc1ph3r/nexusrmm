<#
.SYNOPSIS
    Build Nexus RMM Agent for Windows
.DESCRIPTION
    Builds the Rust agent for Windows x64. Run on a machine with Rust toolchain.
#>

param(
    [string]$OutputPath = "C:\NexusRMM\agent\dist\nexus-agent.exe"
)

Write-Host "Building Nexus RMM Agent for Windows..." -ForegroundColor Cyan

# Check Rust
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "Rust/Cargo not found. Install from https://rustup.rs"
    exit 1
}

# Ensure target is installed
rustup target add x86_64-pc-windows-msvc 2>$null

# Build
Set-Location "$PSScriptRoot\..\agent"
$env:RUSTFLAGS = "-C target-cpu=native -C link-arg=/SUBSYSTEM:CONSOLE"
cargo build --release --target x86_64-pc-windows-msvc

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed"
    exit 1
}

# Copy to output
$src = "$PSScriptRoot\..\agent\target\x86_64-pc-windows-msvc\release\nexus-agent.exe"
$dstDir = Split-Path $OutputPath -Parent
if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
Copy-Item $src -Destination $OutputPath -Force

Write-Host "Agent built successfully: $OutputPath" -ForegroundColor Green
Write-Host "File size: $([math]::Round((Get-Item $OutputPath).Length / 1MB, 1)) MB" -ForegroundColor Cyan
