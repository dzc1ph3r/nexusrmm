<# 
.SYNOPSIS
    Nexus RMM Deployment Script for Windows RDP Server
.DESCRIPTION
    Deploys the Nexus RMM Relay Server, Web Console, and prepares Agent for distribution
.NOTES
    Domain: mezfashion.pro
    Requires: Administrator privileges
    Optional: Go 1.21+ (for building relay), Node.js 18+ (for web), Rust 1.70+ (for agent)
#>

param(
    [string]$Domain = "mezfashion.pro",
    [string]$InstallPath = "C:\NexusRMM",
    [string]$CertPath = "C:\NexusRMM\certs",
    [string]$DBHost = "localhost",
    [string]$DBPort = "5432",
    [string]$DBName = "nexusrmm",
    [string]$DBUser = "nexusrmm",
    [string]$DBPassword = "",
    [string]$RedisHost = "localhost",
    [string]$RedisPort = "6379",
    [switch]$SkipBuild,
    [switch]$SkipCertGen
)

$ErrorActionPreference = "Stop"

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "Nexus RMM Deployment for $Domain" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script requires Administrator privileges. Run PowerShell as Administrator."
    exit 1
}

# Create directory structure
Write-Host "`n[1/8] Creating directory structure..." -ForegroundColor Yellow
$dirs = @(
    "$InstallPath\bin",
    "$InstallPath\web",
    "$InstallPath\certs",
    "$InstallPath\logs",
    "$InstallPath\config",
    "$CertPath",
    "$InstallPath\agent\dist"
)
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# Install NSSM for service management
Write-Host "`n[2/8] Installing NSSM..." -ForegroundColor Yellow
$nssmPath = "$InstallPath\bin\nssm.exe"
if (-not (Test-Path $nssmPath)) {
    $nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
    $tempZip = "$env:TEMP\nssm.zip"
    try {
        Write-Host "Downloading NSSM from $nssmUrl..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $nssmUrl -OutFile $tempZip -UseBasicParsing -TimeoutSec 60
        Expand-Archive -Path $tempZip -DestinationPath "$env:TEMP\nssm" -Force
        Copy-Item "$env:TEMP\nssm\nssm-2.24\win64\nssm.exe" -Destination $nssmPath -Force
        Write-Host "NSSM installed to $nssmPath" -ForegroundColor Green
    }
    catch {
        Write-Warning "Failed to download NSSM automatically. Please install manually:"
        Write-Host "  1. Download from https://nssm.cc/download" -ForegroundColor Yellow
        Write-Host "  2. Extract nssm.exe to $nssmPath" -ForegroundColor Yellow
        Write-Host "  Continuing without NSSM - you'll need to install service manually later." -ForegroundColor Yellow
    }
    finally {
        if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
        if (Test-Path "$env:TEMP\nssm") { Remove-Item "$env:TEMP\nssm" -Recurse -Force }
    }
}

# Build or copy Relay Server
Write-Host "`n[3/8] Setting up Relay Server..." -ForegroundColor Yellow
$relayExe = "$InstallPath\bin\nexus-relay.exe"

if (-not $SkipBuild) {
    # Check if Go is available
    $goAvailable = Get-Command go -ErrorAction SilentlyContinue
    if ($goAvailable) {
        Write-Host "Go found: $($goAvailable.Source). Building Relay Server..." -ForegroundColor Cyan
        Set-Location "$PSScriptRoot\server"
        $env:CGO_ENABLED = "0"
        $env:GOOS = "windows"
        $env:GOARCH = "amd64"
        go build -o "$relayExe" ./cmd/relay
        if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }
        Write-Host "Relay server built to $relayExe" -ForegroundColor Green
    }
    else {
        Write-Warning "Go not found in PATH. Cannot build from source."
        Write-Host "  Options:" -ForegroundColor Yellow
        Write-Host "    1. Install Go from https://golang.org/dl/ and re-run with -SkipBuild:\$false" -ForegroundColor Yellow
        Write-Host "    2. Copy pre-built nexus-relay.exe to $relayExe manually" -ForegroundColor Yellow
        Write-Host "    3. Re-run with -SkipBuild:\$true if binary already exists" -ForegroundColor Yellow
        if (-not (Test-Path $relayExe)) {
            Write-Error "Relay binary not found at $relayExe and Go not available to build."
            exit 1
        }
        Write-Host "Using existing binary at $relayExe" -ForegroundColor Yellow
    }
}
else {
    Write-Host "Skipping build (using existing binary)" -ForegroundColor Yellow
    if (-not (Test-Path $relayExe)) {
        Write-Error "Relay binary not found at $relayExe"
        Write-Error "Either build it first (remove -SkipBuild) or copy pre-built binary there."
        exit 1
    }
}

# Copy Web Console
Write-Host "`n[4/8] Copying Web Console..." -ForegroundColor Yellow
$webSrc = "$PSScriptRoot\web"
$webDst = "$InstallPath\web"
if (Test-Path "$webSrc\index.html") {
    Copy-Item "$webSrc\*" -Destination $webDst -Recurse -Force
    Write-Host "Web console copied to $webDst" -ForegroundColor Green
}
else {
    Write-Warning "Web console build not found at $webSrc."
    Write-Warning "Run 'npm run build' in the web directory first, or copy built assets manually."
}

# Generate certificates
Write-Host "`n[5/8] Generating mTLS Certificates..." -ForegroundColor Yellow
if (-not $SkipCertGen) {
    $caKey = "$CertPath\ca.key"
    $caCert = "$CertPath\ca.crt"
    $serverKey = "$CertPath\server.key"
    $serverCert = "$CertPath\server.crt"
    
    # Check for openssl
    $openssl = Get-Command openssl -ErrorAction SilentlyContinue
    if (-not $openssl) {
        Write-Warning "OpenSSL not found in PATH. Cannot generate certificates automatically."
        Write-Host "  Please install OpenSSL (e.g., via Git for Windows or Win32OpenSSL) and re-run, or generate certs manually." -ForegroundColor Yellow
        Write-Host "  Skipping certificate generation." -ForegroundColor Yellow
    }
    else {
        Write-Host "Using OpenSSL: $($openssl.Source)" -ForegroundColor Cyan
        
        if (-not (Test-Path $caKey)) {
            Write-Host "Generating CA certificate..." -ForegroundColor Cyan
            & $openssl req -x509 -newkey ed25519 -keyout $caKey -out $caCert -days 3650 -nodes `
                -subj "/CN=Nexus RMM Root CA/O=Nexus RMM" 2>$null
            Write-Host "CA generated" -ForegroundColor Green
        }
        
        if (-not (Test-Path $serverKey)) {
            Write-Host "Generating server certificate..." -ForegroundColor Cyan
            $sanFile = "$env:TEMP\san.cnf"
            @"
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = relay.$Domain
O = Nexus RMM

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = relay.$Domain
DNS.2 = $Domain
DNS.3 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
"@ | Set-Content $sanFile
            
            & $openssl req -newkey ed25519 -keyout $serverKey -out "$env:TEMP\server.csr" -nodes `
                -subj "/CN=relay.$Domain/O=Nexus RMM" -config $sanFile 2>$null
            & $openssl x509 -req -in "$env:TEMP\server.csr" -CA $caCert -CAkey $caKey -CAcreateserial `
                -out $serverCert -days 825 -extensions v3_req -extfile $sanFile 2>$null
            Write-Host "Server certificate generated for relay.$Domain" -ForegroundColor Green
            Remove-Item $sanFile, "$env:TEMP\server.csr" -Force -ErrorAction SilentlyContinue
        }
    }
}

# Create config.yaml
Write-Host "`n[6/8] Creating configuration..." -ForegroundColor Yellow
$config = @"
server:
  host: "0.0.0.0"
  port: 8443
  websocket_path: "/ws"
  read_timeout: "30s"
  write_timeout: "30s"
  idle_timeout: "120s"
  max_frame_size: 16777216

tls:
  cert_file: "$CertPath\server.crt"
  key_file: "$CertPath\server.key"
  ca_file: "$CertPath\ca.crt"
  client_auth: "require_and_verify"

database:
  host: "$DBHost"
  port: $DBPort
  name: "$DBName"
  user: "$DBUser"
  password: "$DBPassword"
  max_conns: 20
  sslmode: "disable"

redis:
  host: "$RedisHost"
  port: $RedisPort
  password: ""
  db: 0
  pool_size: 10

agent:
  heartbeat_interval: "30s"
  max_missed_heartbeats: 3
  enrollment_token_ttl: "24h"
  max_token_uses: 100

logging:
  level: "info"
  format: "json"
  output: "$InstallPath\logs\relay.log"
"@

$configPath = "$InstallPath\config\config.yaml"
$config | Set-Content $configPath
Write-Host "Configuration written to $configPath" -ForegroundColor Green

# Install as Windows Service via NSSM
Write-Host "`n[7/8] Installing Windows Service..." -ForegroundColor Yellow
$svcName = "NexusRMM-Relay"
$svcDesc = "Nexus RMM Relay Server - WebSocket mTLS endpoint for agent communication"
$exePath = "$InstallPath\bin\nexus-relay.exe"
$args = "--config $InstallPath\config\config.yaml"

if (Test-Path $nssmPath) {
    if (Get-Service $svcName -ErrorAction SilentlyContinue) {
        Write-Host "Service $svcName already exists. Stopping and removing..." -ForegroundColor Yellow
        Stop-Service $svcName -Force -ErrorAction SilentlyContinue
        & $nssmPath remove $svcName confirm 2>$null
        Start-Sleep 2
    }

    & $nssmPath install $svcName $exePath $args
    & $nssmPath set $svcName Description $svcDesc
    & $nssmPath set $svcName AppDirectory $InstallPath\bin
    & $nssmPath set $svcName AppStdout "$InstallPath\logs\relay-stdout.log"
    & $nssmPath set $svcName AppStderr "$InstallPath\logs\relay-stderr.log"
    & $nssmPath set $svcName AppRotateFiles 1
    & $nssmPath set $svcName AppRotateBytes 10485760
    & $nssmPath set $svcName Start SERVICE_AUTO_START
    & $nssmPath set $svcName AppRestartDelay 5000
    Write-Host "Service $svcName installed via NSSM" -ForegroundColor Green
}
else {
    Write-Warning "NSSM not available. You'll need to install the service manually:"
    $scCreate = 'sc.exe create {0} binPath= "{1} {2}" start= auto' -f $svcName, $exePath, $args
    $scDesc = 'sc.exe description {0} "{1}"' -f $svcName, $svcDesc
    Write-Host "  $scCreate" -ForegroundColor Yellow
    Write-Host "  $scDesc" -ForegroundColor Yellow
}

# Firewall rules
Write-Host "`n[8/8] Configuring Firewall..." -ForegroundColor Yellow
$fwRuleName = "Nexus RMM Relay Server"
if (-not (Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwRuleName -Direction Inbound -Protocol TCP `
        -LocalPort 8443 -Action Allow -Profile Any -Enabled True
    Write-Host "Firewall rule created for port 8443" -ForegroundColor Green
}
else {
    Write-Host "Firewall rule already exists" -ForegroundColor Yellow
}

# DNS reminder - use single-quoted heredoc to avoid variable interpolation
Write-Host "`n===========================================" -ForegroundColor Cyan
Write-Host "DEPLOYMENT COMPLETE" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan

$dnsMsg = @'
NEXT STEPS (MANUAL):

1. DNS CONFIGURATION:
   Add these DNS records for YOUR_DOMAIN:
     A     relay           -> <RDP_SERVER_PUBLIC_IP>
     A     @               -> <RDP_SERVER_PUBLIC_IP>
   (Or use your DNS provider's web interface)

2. DATABASE SETUP:
   Install PostgreSQL 15+ and create database:
     CREATE DATABASE nexusrmm;
     CREATE USER nexusrmm WITH ENCRYPTED PASSWORD 'your_password';
     GRANT ALL PRIVILEGES ON DATABASE nexusrmm TO nexusrmm;
   
   Run migrations from server/migrations/ (if available)

3. REDIS SETUP:
   Install Redis (Memurai on Windows or WSL2 Redis)
   Default: localhost:6379

4. INSTALL OPENSSL (for certificates):
   Option A: Install Git for Windows (includes openssl)
     https://git-scm.com/download/win
   Option B: Install Win32OpenSSL
     https://slproweb.com/products/Win32OpenSSL.html
   Then re-run: .\deploy.ps1 -SkipBuild -SkipCertGen:$false

5. START SERVICE:
   net start NexusRMM-Relay
   # Or: Start-Service NexusRMM-Relay

6. VERIFY:
   curl -k https://relay.YOUR_DOMAIN:8443/health
   # Should return: {"status":"ok"}

7. BUILD AGENT (on build machine with Rust):
   cd agent
   cargo build --release --target x86_64-pc-windows-msvc
   # Binary at: agent/target/x86_64-pc-windows-msvc/release/nexus-agent.exe

8. CREATE ENROLLMENT TOKEN:
   After service starts, use API to create tokens:
   curl -k -X POST https://relay.YOUR_DOMAIN:8443/enroll/token \
     -H "Content-Type: application/json" \
     -d '{"tenant_id": "default", "max_uses": 10}'

9. INSTALL AGENT ON TARGET MACHINES:
   .\nexus-agent.exe enroll --server relay.YOUR_DOMAIN:8443 --token <TOKEN>

10. NGINX REVERSE PROXY (optional, for web console on 443):
    Install nginx, configure:
      server {
          listen 443 ssl;
          server_name YOUR_DOMAIN;
          ssl_certificate CERT_PATH\server.crt;
          ssl_certificate_key CERT_PATH\server.key;
          
          location / {
              proxy_pass http://localhost:3000;  # Web console dev server
              proxy_http_version 1.1;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection "upgrade";
          }
          
          location /ws {
              proxy_pass https://localhost:8443;
              proxy_http_version 1.1;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection "upgrade";
          }
      }

FILES CREATED:
  INSTALL_PATH\bin\nexus-relay.exe       - Relay server binary
  INSTALL_PATH\config\config.yaml        - Server configuration
  CERT_PATH\ca.crt / ca.key              - CA certificate
  CERT_PATH\server.crt / server.key      - Server certificate
  INSTALL_PATH\web\                      - Web console assets
  Service: NexusRMM-Relay                - Windows service (auto-start)
'@

# Replace placeholders
$dnsMsg = $dnsMsg -replace 'YOUR_DOMAIN', $Domain
$dnsMsg = $dnsMsg -replace 'INSTALL_PATH', $InstallPath
$dnsMsg = $dnsMsg -replace 'CERT_PATH', $CertPath

Write-Host $dnsMsg
