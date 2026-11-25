# Nexus RMM System Architecture

## Overview

Nexus RMM is a three-tier architecture designed for ultra-low latency remote management and support:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           NEXUS RMM ARCHITECTURE                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌──────────────┐     ┌──────────────────────────────┐     ┌──────────────────┐    │
│  │  WEB CONSOLE │────▶│    RELAY / CONTROL SERVER    │◀───▶│    AGENTS        │    │
│  │  (React/TS)  │     │          (Go)                │     │    (Rust/Go)     │    │
│  └──────────────┘     └──────────────────────────────┘     └──────────────────┘    │
│         │                        │       │       │                    ▲             │
│         │                        ▼       ▼       ▼                    │             │
│         │                 ┌──────────────────────────────┐           │             │
│         │                 │        DATA LAYER            │           │             │
│         └────────────────▶│  PostgreSQL + Redis          │◀──────────┘             │
│                           └──────────────────────────────┘                         │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### 1. Relay / Control Server (Go)
- **Agent Lifecycle**: Enrollment, authentication, certificate management, heartbeats
- **Session Multiplexing**: WebSocket connection pooling, session routing, backpressure
- **NAT Traversal**: STUN/TURN coordination, ICE candidate relay, WebRTC signaling
- **Access Control**: RBAC, MFA, audit logging, session recording
- **API Gateway**: REST/gRPC for web console, webhook integrations
- **State Management**: Agent presence in Redis, persistent state in PostgreSQL

### 2. Cross-Platform Agent (Rust)
- **Platform Abstraction**: Unified API over Windows/Linux/macOS differences
- **Screen Capture**: DXGI Desktop Duplication (Win), PipeWire/X11 (Linux), ScreenCaptureKit (macOS)
- **Input Injection**: Raw scancode injection, multi-monitor coordination
- **Backstage Services**: ConPTY/PTY shells, file transfer, process/service management
- **Self-Update**: Ed25519-signed updates with rollback capability
- **Minimal Footprint**: <10MB RAM, <1% CPU idle, static binary

### 3. Web Admin Console (React/TypeScript)
- **Real-time Dashboard**: Live fleet view, alerts, telemetry charts
- **Remote Desktop Viewer**: HTML5 Canvas + WebCodecs H.264/VP8 decoder
- **Interactive Terminal**: xterm.js with WebSocket PTY streaming
- **File Manager**: Virtual filesystem with drag-drop, chunked transfer
- **Session Recording**: IndexedDB local buffer, server-side archival

---

## Data Flow & Communication Protocols

### 1. Agent Enrollment Flow

```
AGENT                          SERVER                         ADMIN CONSOLE
  │                              │                                │
  ├─ TLS 1.3 (mTLS) ────────────▶│                                │
  │  ClientHello + Agent Cert    │                                │
  │◀─ ServerHello + Server Cert ─┤                                │
  │  (Verify pinned CA)          │                                │
  │                              │                                │
  ├─ ENROLL_REQUEST ────────────▶│                                │
  │  (Ed25519 pubkey, CSR,       │                                │
  │   machine_id, token)         │                                │
  │                              ├─ Validate token ─────────────▶│
  │                              │◀─ Token valid ────────────────┤
  │                              │                                │
  │◀─ ENROLL_CHALLENGE ─────────┤                                │
  │  (32-byte challenge, nonce)  │                                │
  │                              │                                │
  ├─ ENROLL_RESPONSE ────────────▶│                                │
  │  (signed challenge)          │                                │
  │                              │  Verify signature              │
  │                              │  Issue mTLS cert               │
  │                              │  Store agent in DB             │
  │◀─ ENROLL_RESULT ─────────────┤                                │
  │  (agent_id, cert, CA, config)│                                │
  │                              │                                │
  │  TLS handshake with new cert │                                │
  │  (mutual verification)       │                                │
  │                              │                                │
  ├─ HELLO ─────────────────────▶│                                │
  │  (agent_id, ephemeral key)   │                                │
  │◀─ WELCOME ───────────────────┤                                │
  │  (session_id, server key)    │                                │
  │                              │                                │
  ═══════ PERSISTENT WEBSOCKET ═════════════════════════════════════════════════
  │                              │                                │
  ├─ HEARTBEAT (30s) ───────────▶│                                │
  │◀─ HEARTBEAT_ACK ─────────────┤                                │
```

### 2. Session Establishment (Remote Desktop)

```
CONSOLE                        SERVER                          AGENT
  │                              │                                │
  ├─ SESSION_CREATE ────────────▶│                                │
  │  (agent_id, type=DESKTOP)    │                                │
  │                              │                                │
  │                              ├─ SESSION_OFFER ──────────────▶│
  │                              │  (WebRTC offer SDP)            │
  │                              │                                │
  │                              │◀─ SESSION_ANSWER ─────────────┤
  │                              │  (WebRTC answer SDP)           │
  │                              │                                │
  │◀─ SESSION_START ─────────────┤                                │
  │  (session_id, agent_id)      │                                │
  │                              │                                │
  │  ICE candidates ◀───────────▶│◀────────────── ICE ───────────│
  │                              │                                │
  ═══════════ WEBRTC DATA CHANNEL ═════════════════════════════════
  │                              │                                │
  │◀── VIDEO_FRAME (H.264) ──────┤◀──── VIDEO_FRAME (H.264) ─────│
  │◀── CURSOR_UPDATE ────────────┤◀──── CURSOR_UPDATE ───────────│
  │                              │                                │
  │  CONTROL_EVENT ─────────────▶│──── CONTROL_EVENT ────────────▶│
  │  (mouse, keyboard, touch)    │    (injected to OS)            │
```

### 3. Backstage Session (Terminal/File/Process)

```
CONSOLE                        SERVER                          AGENT
  │                              │                                │
  ├─ SESSION_CREATE ────────────▶│                                │
  │  (type=BACKSTAGE, PTY)       │                                │
  │                              │                                │
  │◀─ SESSION_START ─────────────┤                                │
  │                              │                                │
  ═════════ MULTIPLEXED WEBSOCKET ═════════════════════════════════
  │                              │                                │
  ├─ PTY_DATA (stdin) ──────────▶│──── PTY_DATA (stdin) ────────▶│
  │                              │                                │
  │◀─ PTY_DATA (stdout) ─────────┤◀──── PTY_DATA (stdout) ───────│
  │◀─ PTY_DATA (stderr) ─────────┤◀──── PTY_DATA (stderr) ───────│
  │                              │                                │
  ├─ FILE_LIST ─────────────────▶│──── FILE_LIST ────────────────▶│
  │◀─ FILE_LIST_RESP ────────────┤◀──── FILE_LIST_RESP ──────────│
```

---

## NAT Traversal Strategy

### Connection Priority
1. **Direct WebSocket** (if agent has public IP / port forwarding)
2. **WebRTC Data Channels** (UDP, ICE/STUN/TURN)
3. **Relayed WebSocket** (through server - last resort)

### STUN/TURN Integration
```
Server config:
  stun_servers:
    - "stun:stun.l.google.com:19302"
    - "stun:stun.cloudflare.com:3478"
  turn_servers:
    - urls: ["turn:turn.example.com:3478?transport=udp",
             "turn:turn.example.com:3478?transport=tcp"]
      username: "nexusrmm"
      credential: "rotated-daily"
      credential_type: "password"
```

### ICE Candidate Flow
- Agent gathers candidates (host, srflx, relay)
- Console gathers candidates
- Candidates exchanged via `SESSION_ICE` frames through server
- WebRTC connection established directly or via TURN

---

## Security Architecture

### Certificate Hierarchy
```
Root CA (offline, air-gapped)
  │
  ├─ Intermediate CA (online, HSM-backed)
  │    │
  │    ├─ Server TLS Certificate (wildcard: *.nexusrmm.internal)
  │    ├─ Agent Enrollment CA (issues agent certs)
  │    │    ├─ Agent 1 Cert (CN=agent-{id}, OU=tenant-{id})
  │    │    ├─ Agent 2 Cert (CN=agent-{id}, OU=tenant-{id})
  │    │    └─ ...
  │    │
  │    └─ Admin Console CA (issues admin client certs for mTLS)
  │         ├─ Admin 1 Cert
  │         └─ Admin 2 Cert
```

### Key Rotation
- **Ephemeral Session Keys**: X25519, rotated per session (HELLO/WELCOME)
- **Long-term Identity**: Ed25519, generated on enrollment, stored in TPM/Keychain
- **mTLS Certificates**: 90-day validity, auto-renewed 7 days before expiry
- **TURN Credentials**: Rotated daily via signed JWT

### Zero-Trust Principles
1. **Never Trust Network**: All communication encrypted and authenticated
2. **Verify Identity**: Mutual TLS + Ed25519 signatures on every frame
3. **Least Privilege**: Agents only receive commands for authorized sessions
4. **Audit Everything**: Immutable append-only log (Merkle tree) for all actions
5. **Assume Breach**: Session recording, anomaly detection, automatic containment

---

## Data Layer Schema

### PostgreSQL Tables
```sql
-- Tenants (multi-tenancy)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) UNIQUE,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users (admins/techs)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,  -- Argon2id
    totp_secret VARCHAR(255),
    webauthn_credentials JSONB,
    role VARCHAR(50) NOT NULL,  -- 'owner', 'admin', 'tech', 'viewer'
    scopes TEXT[] DEFAULT '{}',
    disabled BOOLEAN DEFAULT FALSE,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agents (endpoints)
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    agent_id VARCHAR(64) UNIQUE NOT NULL,  -- Short ID for display
    ed25519_pubkey BYTEA NOT NULL,         -- 32 bytes
    cert_serial VARCHAR(64),               -- mTLS cert serial
    cert_expires_at TIMESTAMPTZ,
    hostname VARCHAR(255),
    os VARCHAR(50),
    arch VARCHAR(20),
    machine_id VARCHAR(128),               -- Unique hardware ID
    tags JSONB DEFAULT '{}',
    group_id UUID,
    status VARCHAR(20) DEFAULT 'offline',  -- 'online', 'offline', 'busy', 'unauthorized'
    last_seen TIMESTAMPTZ,
    enrolled_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    agent_id UUID REFERENCES agents(id),
    user_id UUID REFERENCES users(id),
    session_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',  -- 'active', 'ended', 'failed'
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    recording_path VARCHAR(512),
    metadata JSONB DEFAULT '{}'
);

-- Audit Log (append-only, Merkle tree)
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    user_id UUID REFERENCES users(id),
    agent_id UUID REFERENCES agents(id),
    session_id UUID REFERENCES sessions(id),
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(100),
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    prev_hash BYTEA NOT NULL,      -- Hash of previous entry
    entry_hash BYTEA NOT NULL,     -- Hash of this entry
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enrollment Tokens
CREATE TABLE enrollment_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    token VARCHAR(64) UNIQUE NOT NULL,
    label VARCHAR(255),
    scopes TEXT[] DEFAULT '{}',
    max_uses INT DEFAULT 1,
    used_count INT DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Redis Keys
```
# Agent presence (TTL = heartbeat_interval * 3)
agent:presence:{agent_id} = JSON{status, last_heartbeat, session_id?, metadata}

# Session routing
session:route:{session_id} = {agent_ws_conn_id, console_ws_conn_id}

# Rate limiting
ratelimit:enroll:{ip} = count (TTL 1h)
ratelimit:login:{ip} = count (TTL 15m)
ratelimit:api:{user_id} = count (TTL 1m)

# Pub/Sub for real-time events
channel:agent:{agent_id}      # Agent-specific events
channel:tenant:{tenant_id}    # Tenant-wide events
channel:session:{session_id}  # Session events
```

---

## Scalability Considerations

### Horizontal Scaling
- **Stateless Relay Servers**: Multiple instances behind load balancer
- **Redis Cluster**: For presence, routing, pub/sub
- **PostgreSQL**: Read replicas for queries, primary for writes
- **WebSocket Affinity**: Consistent hashing or sticky sessions for WebSocket connections

### Connection Handling
- **Target**: 100,000 concurrent agents per server instance
- **WebSocket Pool**: Goroutine per connection, bounded channels for backpressure
- **Frame Processing**: Lock-free ring buffers, batch processing
- **Memory**: Pre-allocated frame buffers, object pooling

### Bandwidth Optimization
- **Video**: Adaptive bitrate (100kbps - 10Mbps), hardware encoding (NVENC/QuickSync/VAAPI)
- **Delta Compression**: Dirty rectangle tracking, only transmit changes
- **Frame Dropping**: Prioritize keyframes, drop intermediate frames under congestion
- **QoS**: DSCP marking for WebRTC traffic

---

## Deployment Architecture

```
                         ┌─────────────────┐
                         │   Load Balancer │  (TCP/443, UDP/3478)
                         │   (HAProxy/     │
                         │    NGINX/Envoy) │
                         └────────┬────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        ┌──────────┐        ┌──────────┐        ┌──────────┐
        │ Relay #1 │        │ Relay #2 │        │ Relay #N │
        │  (Go)    │        │  (Go)    │        │  (Go)    │
        └────┬─────┘        └────┬─────┘        └────┬─────┘
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐        ┌──────────┐        ┌──────────┐
        │PostgreSQL│        │  Redis   │        │  TURN    │
        │ Primary  │        │ Cluster  │        │ Servers  │
        └──────────┘        └──────────┘        └──────────┘
```

---

## Next Implementation Steps

1. **Protocol Code Generation**: Generate Go/Rust bindings from protobuf
2. **Server Core**: mTLS listener, WebSocket handler, frame multiplexer
3. **Agent Core**: Enrollment handshake, persistent WebSocket, heartbeat loop
4. **Certificate Authority**: Offline root, online intermediate, automated issuance
5. **Session Manager**: WebRTC signaling, session lifecycle, recording
6. **Web Console**: Real-time dashboard, Canvas/WebCodecs viewer, xterm.js terminal
7. **Platform Modules**: Screen capture, input injection, file/process/service APIs