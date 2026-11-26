# Nexus RMM

A modern, cross-platform Remote Monitoring and Management (RMM) solution built with Rust, Go, and React/TypeScript.

## Architecture

```
┌─────────────┐     mTLS WebSocket      ┌─────────────┐
│   Agent     │ ◄──────────────────────► │   Relay     │
│  (Rust)     │   Binary Protobuf       │   (Go)      │
└─────────────┘                         └──────┬──────┘
                                                │
                                                ▼
                                         ┌─────────────┐
                                         │   Web       │
                                         │  Console    │
                                         │ (React/TS)  │
                                         └─────────────┘
```

### Components

| Component | Language | Description |
|-----------|----------|-------------|
| **Agent** | Rust | Lightweight endpoint agent with shell, file, process, screen capture, and PTY support |
| **Relay** | Go | High-performance WebSocket relay server with mTLS authentication |
| **Console** | React/TypeScript | Web-based management dashboard |

### Protocol

- **Transport**: WebSocket over TLS (mTLS)
- **Serialization**: Protocol Buffers (protobuf)
- **Frame Format**: Custom binary protocol with magic bytes, version, flags, message type, session ID, sequence, payload length, and CRC32 checksum
- **Encryption**: X25519 for session keys, Ed25519 for enrollment signatures
- **Compression**: Optional per-frame (flag-based)

## Features

### Agent Capabilities
- **Shell/PTY**: Interactive terminal sessions with resize support
- **File Operations**: List, read, write, hash (SHA256/Blake3)
- **Process Management**: List, kill processes
- **Service Control**: List, start, stop, restart systemd/Windows services
- **Script Execution**: PowerShell, Bash, Python, Batch with streaming output
- **Screen Capture**: Desktop streaming with dirty-rectangle detection
- **Telemetry**: CPU, memory, disk, network, load averages
- **Inventory**: Hardware, OS, packages, users
- **Self-Update**: Ed25519-signed updates with rollback

### Security
- **Mutual TLS**: Certificate-based authentication
- **Ed25519**: Enrollment challenge-response signatures
- **X25519**: Ephemeral session key exchange
- **Agent Identity**: Persistent Ed25519 key pair per agent
- **Enrollment Tokens**: One-time tokens for initial registration

## Quick Start

### Prerequisites

- **Linux Agent**: Rust 1.75+, protobuf-compiler, libssl-dev
- **Windows Agent**: Rust 1.75+ (MSVC toolchain), OpenSSL
- **Relay Server**: Go 1.21+
- **Web Console**: Node.js 18+, pnpm

### Building from Source

```bash
# Clone repository
git clone https://github.com/dzc1ph3r/nexusrmm.git
cd nexusrmm

# Build Rust agent (Linux)
cd agent
cargo build --release
# Binary at: target/release/nexusrmm-agent

# Build Go relay
cd ../server
go build -o relay-server ./cmd/relay

# Build Web console
cd ../web
pnpm install
pnpm build
```

### Deployment Packages

Pre-built deployment packages are available in `deploy-package/`:

```
deploy-package/
├── bin/                    # Pre-built binaries
│   ├── nexus-agent         # Linux x86_64 agent
│   ├── relay               # Linux x86_64 relay
│   └── nexus-relay.exe     # Windows x86_64 relay
├── deploy.ps1              # Windows deployment script
├── deploy-kali.sh          # Kali/WSL deployment script
├── build-agent.ps1         # Windows agent build script
└── README_DEPLOY.md        # Detailed deployment guide
```

## Deployment

### Windows RDP (Domain: rmm.mezfashion.pro)

```powershell
# Run as Administrator
cd deploy-package
.\deploy.ps1 -Domain "rmm.mezfashion.pro" -EnrollmentToken "your-token"
```

This will:
1. Generate mTLS certificates (RSA 4096)
2. Install agent as Windows service via NSSM
3. Configure auto-start and firewall rules
4. Enroll agent with the relay server

### Kali Linux / WSL

```bash
# Run as root or with sudo
cd deploy-package
chmod +x deploy-kali.sh
./deploy-kali.sh --domain rmm.mezfashion.pro --token your-token
```

This will:
1. Install dependencies (Rust, Go, protobuf-compiler)
2. Build or install pre-built binaries
3. Create systemd service
4. Configure mTLS certificates
5. Enroll agent

### Manual Linux Installation

```bash
# Copy binary
sudo cp deploy-package/bin/nexus-agent /usr/local/bin/nexus-agent
sudo chmod +x /usr/local/bin/nexus-agent

# Create config
sudo mkdir -p /etc/nexus-agent
sudo cp deploy-package/config/agent.yaml /etc/nexus-agent/

# Generate certificates
openssl req -x509 -newkey rsa:4096 -keyout /etc/nexus-agent/agent.key \
  -out /etc/nexus-agent/agent.crt -days 365 -nodes -subj "/CN=agent"

# Install systemd service
sudo cp deploy-package/systemd/nexus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-agent
```

## Configuration

### Agent Config (`/etc/nexus-agent/agent.yaml`)

```yaml
server:
  url: "wss://rmm.mezfashion.pro:8443"
  verify_hostname: true
  ca_cert: "/etc/nexus-agent/ca.crt"

identity:
  path: "/etc/nexus-agent/identity.json"

telemetry:
  enabled: true
  interval_sec: 60
  include_processes: true
  include_network: true
  include_disks: true

inventory:
  enabled: true
  interval_sec: 3600

update:
  enabled: true
  check_interval_sec: 86400
  base_url: "https://updates.mezfashion.pro"
  current_version: "0.1.0"

logging:
  level: "info"
  file: "/var/log/nexus-agent.log"
```

### Relay Config

```yaml
server:
  listen: "0.0.0.0:8443"
  cert_file: "/etc/nexus-relay/server.crt"
  key_file: "/etc/nexus-relay/server.key"
  ca_file: "/etc/nexus-relay/ca.crt"

database:
  path: "/var/lib/nexus-relay/relay.db"

enrollment:
  token_expiry_hours: 24
  default_tenant: "default"

limits:
  max_agents: 10000
  max_sessions_per_agent: 10
  message_size_limit_mb: 16
```

## API / Protocol

### Frame Structure

```
Magic (3) | Ver (1) | Flags (1) | MsgType (2) | SessionID (8) | SeqNum (4) | PayloadLen (4) | Payload (N) | CRC32 (4)
```

### Message Types

| Category | Types |
|----------|-------|
| Handshake | Hello, Welcome, EnrollRequest/Challenge/Response/Result |
| Session | SessionCreate/Join/Offer/Answer/ICE/Start/End/Control |
| Heartbeat | Heartbeat, HeartbeatAck, Rekey, RekeyAck |
| Remote Control | VideoFrame/Keyframe/Config, CursorUpdate, DisplayInfo |
| PTY | PtyData, PtyResize, PtyClose |
| Files | FileList/Resp, FileRead/Resp, FileWrite/Resp, FileHash/Resp, FileTransfer |
| Processes | ProcList/Resp, ProcKill/Resp |
| Services | ServiceList/Resp, ServiceControl/Resp |
| Scripts | ScriptExec, ScriptOutput, ScriptResult |
| Telemetry | Telemetry, Inventory |
| Errors | Error, Disconnect |

## Development

### Project Structure

```
nexusrmm/
├── agent/                  # Rust agent
│   ├── src/
│   │   ├── capture/        # Screen capture pipeline
│   │   ├── clipboard/      # Clipboard sync
│   │   ├── enroll/         # Enrollment & mTLS
│   │   ├── fs/             # File operations
│   │   ├── input/          # Keyboard/mouse injection
│   │   ├── os/             # OS abstraction (Linux/Windows/macOS)
│   │   ├── proto/          # Protobuf definitions
│   │   ├── shell/          # PTY & script execution
│   │   ├── telemetry/      # System metrics collection
│   │   ├── transport/      # WebSocket transport
│   │   └── update/         # Self-update manager
│   └── Cargo.toml
├── server/                 # Go relay
│   ├── cmd/relay/          # Main entry point
│   ├── internal/
│   │   ├── auth/           # mTLS & enrollment
│   │   ├── database/       # SQLite storage
│   │   ├── protocol/       # Frame handling
│   │   └── session/        # Session management
│   └── go.mod
├── web/                    # React console
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── api/
│   └── package.json
├── proto/                  # Shared protobuf definitions
│   └── rmm/v1/
│       ├── agent.proto
│       ├── frames.proto
│       └── types.proto
├── deploy-package/         # Deployment artifacts
└── scripts/                # Build/CI scripts
```

### Regenerating Protobuf

```bash
# Rust
cd agent
cargo build  # Includes prost-build via build.rs

# Go
cd server
go generate ./...  # Runs protoc-go

# TypeScript (for web console)
cd web
pnpm run proto:generate
```

## Security Considerations

- All communication is encrypted via mTLS
- Agent identity keys never leave the endpoint
- Enrollment uses challenge-response with Ed25519
- Session keys are ephemeral X25519 (forward secrecy)
- Frame checksums prevent corruption/tampering
- Maximum frame size: 16MB (configurable)
- Rate limiting on relay server

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `cargo test` (agent), `go test ./...` (server), `pnpm test` (web)
5. Submit a PR

## Support

- Issues: [GitHub Issues](https://github.com/dzc1ph3r/nexusrmm/issues)
- Documentation: [Wiki](https://github.com/dzc1ph3r/nexusrmm/wiki)