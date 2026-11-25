#!/bin/bash
# Nexus RMM Deployment for Kali Linux / WSL
# Usage: sudo ./deploy-kali.sh -d rmm.mezfashion.pro -p "LogMeIn16!@"

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
DOMAIN="rmm.mezfashion.pro"
DB_PASSWORD="LogMeIn16!@"
INSTALL_PATH="/opt/nexusrmm"
SERVICE_USER="nexusrmm"
GO_VERSION="1.23.0"
RUST_VERSION="stable"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--domain)
            DOMAIN="$2"
            shift 2
            ;;
        -p|--db-password)
            DB_PASSWORD="$2"
            shift 2
            ;;
        -i|--install-path)
            INSTALL_PATH="$2"
            shift 2
            ;;
        -u|--service-user)
            SERVICE_USER="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -d, --domain DOMAIN          Domain name (default: rmm.mezfashion.pro)"
            echo "  -p, --db-password PASSWORD   Database password (default: LogMeIn16!@)"
            echo "  -i, --install-path PATH      Install path (default: /opt/nexusrmm)"
            echo "  -u, --service-user USER      Service user (default: nexusrmm)"
            echo "  -h, --help                   Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}This script must be run as root (use sudo)${NC}"
    exit 1
fi

echo -e "${CYAN}===========================================${NC}"
echo -e "${CYAN}Nexus RMM Deployment for ${DOMAIN}${NC}"
echo -e "${CYAN}===========================================${NC}"

# Helper functions
log_info() { echo -e "${CYAN}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Detect package manager
if command -v apt-get &> /dev/null; then
    PKG_MGR="apt-get"
    PKG_UPDATE="apt-get update"
    PKG_INSTALL="apt-get install -y"
elif command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
    PKG_UPDATE="dnf check-update"
    PKG_INSTALL="dnf install -y"
elif command -v pacman &> /dev/null; then
    PKG_MGR="pacman"
    PKG_UPDATE="pacman -Sy"
    PKG_INSTALL="pacman -S --noconfirm"
else
    log_error "Unsupported package manager"
    exit 1
fi

# Step 1: Update system and install dependencies
log_info "[1/10] Installing system dependencies..."
$PKG_UPDATE
$PKG_INSTALL curl wget git build-essential pkg-config libssl-dev \
    postgresql postgresql-contrib redis-server \
    ca-certificates gnupg lsb-release 2>/dev/null || true

# Kali/WSL specific packages
$PKG_INSTALL libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf 2>/dev/null || true

# Step 2: Install Rust
log_info "[2/10] Installing Rust toolchain..."
if ! command -v cargo &> /dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain $RUST_VERSION
    source "$HOME/.cargo/env"
    export PATH="$HOME/.cargo/bin:$PATH"
else
    log_success "Rust already installed"
fi
source "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"

# Add Linux target
rustup target add x86_64-unknown-linux-gnu

# Step 3: Install Go
log_info "[3/10] Installing Go $GO_VERSION..."
if ! command -v go &> /dev/null || [[ "$(go version | grep -oE '[0-9]+\.[0-9]+')" != "1.23" ]]; then
    cd /tmp
    wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
    export PATH=$PATH:/usr/local/go/bin
    echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile
else
    log_success "Go already installed"
fi
export PATH=$PATH:/usr/local/go/bin

# Step 4: Install Node.js for web console
log_info "[4/10] Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    $PKG_INSTALL nodejs
else
    log_success "Node.js already installed"
fi

# Step 5: Create service user
log_info "[5/10] Creating service user..."
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd -r -s /bin/bash -d "$INSTALL_PATH" -m "$SERVICE_USER"
    log_success "Created user $SERVICE_USER"
else
    log_success "User $SERVICE_USER already exists"
fi

# Step 6: Create directory structure
log_info "[6/10] Creating directory structure..."
mkdir -p "$INSTALL_PATH"/{bin,certs,config,logs,web,agent}
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_PATH"

# Get script directory (absolute path) - with debugging
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CWD="$(pwd)"

# DEBUG: Show what we're detecting
log_info "DEBUG: BASH_SOURCE[0]=${BASH_SOURCE[0]}"
log_info "DEBUG: SCRIPT_DIR=$SCRIPT_DIR"
log_info "DEBUG: CWD=$CWD"

# Find source directories - try multiple locations
find_source_dir() {
    local name=$1
    # 1. Script directory (where the script file actually is)
    if [[ -d "$SCRIPT_DIR/$name" ]]; then
        echo "$SCRIPT_DIR/$name"
        return
    fi
    # 2. Current working directory
    if [[ -d "$CWD/$name" ]]; then
        echo "$CWD/$name"
        return
    fi
    # 3. Parent of script dir (if script is in deploy-package/deploy-kali.sh)
    if [[ -d "$SCRIPT_DIR/../$name" ]]; then
        echo "$SCRIPT_DIR/../$name"
        return
    fi
    # 4. Parent of cwd
    if [[ -d "$CWD/../$name" ]]; then
        echo "$CWD/../$name"
        return
    fi
    # 5. Common extraction paths
    for base in "/opt/nexusrmm/deploy-package" "/opt/nexusrmm" "$HOME/nexusrmm/deploy-package" "$HOME/nexusrmm" "/tmp/nexusrmm/deploy-package"; do
        if [[ -d "$base/$name" ]]; then
            echo "$base/$name"
            return
        fi
    done
    echo ""
}

SERVER_DIR=$(find_source_dir "server")
AGENT_DIR=$(find_source_dir "agent")
WEB_SOURCE_DIR=$(find_source_dir "web-source")

# Verify source directories exist
for dir_var in "SERVER_DIR:server" "AGENT_DIR:agent" "WEB_SOURCE_DIR:web-source"; do
    dir="${dir_var%%:*}"
    name="${dir_var##*:}"
    val="${!dir}"
    if [[ -z "$val" ]]; then
        log_error "Source directory not found: $name"
        log_error "SCRIPT_DIR: $SCRIPT_DIR"
        log_error "CWD: $CWD"
        log_error "Run from deploy-package directory, or extract zip to /opt/nexusrmm"
        exit 1
    fi
done

log_info "Using source directories:"
log_info "  Server:     $SERVER_DIR"
log_info "  Agent:      $AGENT_DIR"
log_info "  Web Source: $WEB_SOURCE_DIR"

# Step 7: Build Relay Server (Go)
log_info "[7/10] Building Relay Server..."
cd "$SERVER_DIR"
export GOPATH="$INSTALL_PATH/go"
export PATH=$PATH:$GOPATH/bin
go mod download
CGO_ENABLED=0 go build -ldflags="-s -w" -o "$INSTALL_PATH/bin/nexus-relay" ./cmd/relay
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_PATH/bin/nexus-relay"
log_success "Relay server built to $INSTALL_PATH/bin/nexus-relay"

# Step 8: Build Agent (Rust)
log_info "[8/10] Building Linux Agent..."
cd "$AGENT_DIR"
sudo -u "$SERVICE_USER" bash -c "
    source \$HOME/.cargo/env
    export PATH=\$HOME/.cargo/bin:\$PATH
    cargo build --release --target x86_64-unknown-linux-gnu
"
mkdir -p "$INSTALL_PATH/agent/dist"
cp "target/x86_64-unknown-linux-gnu/release/nexus-agent" "$INSTALL_PATH/agent/dist/nexus-agent"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_PATH/agent/dist/nexus-agent"
log_success "Agent built to $INSTALL_PATH/agent/dist/nexus-agent"

# Step 9: Build Web Console
log_info "[9/10] Building Web Console..."
cd "$WEB_SOURCE_DIR"
npm ci
npm run build
cp -r dist/* "$INSTALL_PATH/web/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_PATH/web"
log_success "Web console built to $INSTALL_PATH/web"

# Step 10: Generate mTLS Certificates
log_info "[10/10] Generating mTLS certificates..."
CERT_DIR="$INSTALL_PATH/certs"
mkdir -p "$CERT_DIR"

# CA config
cat > "$CERT_DIR/ca.cnf" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
CN = Nexus RMM Root CA
O = Nexus RMM

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
EOF

# Generate CA
openssl req -x509 -newkey rsa:4096 -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
    -days 3650 -nodes -subj "/CN=Nexus RMM Root CA/O=Nexus RMM" -config "$CERT_DIR/ca.cnf"

# Server config
cat > "$CERT_DIR/server.cnf" <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = relay.$DOMAIN
O = Nexus RMM

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = relay.$DOMAIN
DNS.2 = $DOMAIN
DNS.3 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# Generate server cert
openssl req -newkey rsa:4096 -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
    -nodes -subj "/CN=relay.$DOMAIN/O=Nexus RMM" -config "$CERT_DIR/server.cnf"
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
    -CAcreateserial -out "$CERT_DIR/server.crt" -days 825 -extensions v3_req -extfile "$CERT_DIR/server.cnf"

# Cleanup
rm -f "$CERT_DIR/ca.cnf" "$CERT_DIR/server.cnf" "$CERT_DIR/server.csr" "$CERT_DIR/ca.srl"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CERT_DIR"
chmod 600 "$CERT_DIR"/*.key
log_success "Certificates generated in $CERT_DIR"

# Step 11: Create configuration
log_info "Creating configuration..."
cat > "$INSTALL_PATH/config/config.yaml" <<EOF
server:
  host: "0.0.0.0"
  port: 8443
  websocket_path: "/ws"
  read_timeout: "30s"
  write_timeout: "30s"
  idle_timeout: "120s"
  max_frame_size: 16777216

tls:
  cert_file: "$CERT_DIR/server.crt"
  key_file: "$CERT_DIR/server.key"
  ca_file: "$CERT_DIR/ca.crt"
  client_auth: "require_and_verify"

database:
  host: "localhost"
  port: 5432
  name: "nexusrmm"
  user: "nexusrmm"
  password: "$DB_PASSWORD"
  max_conns: 20
  sslmode: "disable"

redis:
  host: "localhost"
  port: 6379
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
  output: "$INSTALL_PATH/logs/relay.log"
EOF

chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_PATH/config/config.yaml"
chmod 600 "$INSTALL_PATH/config/config.yaml"
log_success "Configuration written to $INSTALL_PATH/config/config.yaml"

# Step 12: Setup PostgreSQL
log_info "Setting up PostgreSQL database..."
systemctl start postgresql
systemctl enable postgresql

sudo -u postgres psql <<EOF
CREATE USER nexusrmm WITH ENCRYPTED PASSWORD '$DB_PASSWORD';
CREATE DATABASE nexusrmm OWNER nexusrmm;
GRANT ALL PRIVILEGES ON DATABASE nexusrmm TO nexusrmm;
EOF

# Run migrations if they exist
if [ -d "$SERVER_DIR/migrations" ]; then
    cd "$SERVER_DIR"
    for migration in migrations/*.sql; do
        if [ -f "$migration" ]; then
            sudo -u postgres psql -d nexusrmm -f "$migration"
        fi
    done
fi

log_success "PostgreSQL database configured"

# Step 13: Setup Redis
log_info "Setting up Redis..."
systemctl start redis-server
systemctl enable redis-server
log_success "Redis configured"

# Step 14: Create systemd services
log_info "Creating systemd services..."

# Relay service
cat > /etc/systemd/system/nexus-relay.service <<EOF
[Unit]
Description=Nexus RMM Relay Server
After=network.target postgresql.service redis-server.service
Wants=postgresql.service redis-server.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_PATH
ExecStart=$INSTALL_PATH/bin/nexus-relay --config $INSTALL_PATH/config/config.yaml
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexus-relay
Environment=PATH=/usr/local/go/bin:/usr/bin:/bin
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# Agent service (template)
cat > /etc/systemd/system/nexus-agent@.service <<EOF
[Unit]
Description=Nexus RMM Agent (%i)
After=network.target

[Service]
Type=simple
User=root
ExecStart=$INSTALL_PATH/agent/dist/nexus-agent --config $INSTALL_PATH/config/agent-%i.yaml
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexus-agent-%i

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nexus-relay
log_success "Systemd services created"

# Step 15: Start services
log_info "Starting services..."
systemctl start nexus-relay
sleep 3
if systemctl is-active --quiet nexus-relay; then
    log_success "Nexus Relay started successfully"
else
    log_error "Nexus Relay failed to start"
    journalctl -u nexus-relay -n 50 --no-pager
    exit 1
fi

# Summary
echo -e "${CYAN}===========================================${NC}"
echo -e "${CYAN}Deployment Complete!${NC}"
echo -e "${CYAN}===========================================${NC}"
echo -e "Domain:         ${DOMAIN}"
echo -e "Install Path:   ${INSTALL_PATH}"
echo -e "Service User:   ${SERVICE_USER}"
echo -e "Relay Binary:   ${INSTALL_PATH}/bin/nexus-relay"
echo -e "Agent Binary:   ${INSTALL_PATH}/agent/dist/nexus-agent"
echo -e "Web Console:    ${INSTALL_PATH}/web"
echo -e "Config:         ${INSTALL_PATH}/config/config.yaml"
echo -e "Certificates:   ${INSTALL_PATH}/certs/"
echo -e "Logs:           ${INSTALL_PATH}/logs/"
echo ""
echo -e "Service Commands:"
echo -e "  Start:   sudo systemctl start nexus-relay"
echo -e "  Stop:    sudo systemctl stop nexus-relay"
echo -e "  Status:  sudo systemctl status nexus-relay"
echo -e "  Logs:    sudo journalctl -u nexus-relay -f"
echo ""
echo -e "Web Console: https://${DOMAIN}:8443 (or https://localhost:8443)"
echo -e "Default Admin: admin / admin"
echo ""
echo -e "To enroll an agent:"
echo -e "  1. Create token via web console or API"
echo -e "  2. Run: sudo ${INSTALL_PATH}/agent/dist/nexus-agent --enroll --token <TOKEN> --server ${DOMAIN}:8443"
echo -e "  3. Install as service: sudo systemctl enable --now nexus-agent@<agent-id>"
echo -e "${CYAN}===========================================${NC}"