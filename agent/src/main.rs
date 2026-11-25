//! Nexus RMM Agent - Cross-platform endpoint agent for remote monitoring and management

mod enroll;
mod transport;
mod capture;
mod input;
mod clipboard;
mod fs;
mod shell;
mod telemetry;
mod update;
mod os;
mod proto;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use config::{Config, File, Environment};
use tracing::{info, error, warn};
use tracing_subscriber::{EnvFilter, fmt::format::FmtSpan};

use crate::enroll::{EnrollmentManager, AgentIdentity};
use crate::transport::{Transport, TransportConfig, SessionManager};
use crate::telemetry::TelemetryCollector;
use crate::update::UpdateManager;

#[derive(Parser, Debug)]
#[command(name = "nexus-agent", version, about = "Nexus RMM Agent")]
struct Args {
    /// Configuration file path
    #[arg(short, long, default_value = "/etc/nexusrmm/agent.toml")]
    config: String,

    /// Run in foreground (don't daemonize)
    #[arg(short, long)]
    foreground: bool,

    /// Enroll with server using token
    #[arg(long)]
    enroll_token: Option<String>,

    /// Server URL (overrides config)
    #[arg(long)]
    server_url: Option<String>,

    /// Log level
    #[arg(short, long, default_value = "info")]
    log_level: String,
}

#[derive(Debug, serde::Deserialize)]
struct AgentConfig {
    server: ServerConfig,
    agent: AgentSettings,
    enrollment: EnrollmentConfig,
    telemetry: TelemetryConfig,
    update: UpdateConfig,
}

#[derive(Debug, serde::Deserialize)]
struct ServerConfig {
    url: String,
    ca_cert_path: Option<String>,
    verify_hostname: bool,
}

#[derive(Debug, serde::Deserialize)]
struct AgentSettings {
    id_path: String,
    heartbeat_interval_sec: u64,
    telemetry_interval_sec: u64,
    inventory_interval_sec: u64,
    max_missed_heartbeats: u32,
}

#[derive(Debug, serde::Deserialize)]
struct EnrollmentConfig {
    token: Option<String>,
    retry_interval_sec: u64,
    max_retries: u32,
}

#[derive(Debug, serde::Deserialize)]
struct TelemetryConfig {
    enabled: bool,
    include_processes: bool,
    include_network: bool,
    include_disks: bool,
}

#[derive(Debug, serde::Deserialize)]
struct UpdateConfig {
    enabled: bool,
    check_interval_sec: u64,
    base_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    init_logging(&args.log_level)?;

    info!("Starting Nexus RMM Agent v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let config = load_config(&args.config, &args)?;

    // Load or generate agent identity
    let identity = AgentIdentity::load_or_create(&config.agent.id_path)
        .context("Failed to load agent identity")?;

    info!("Agent ID: {}", identity.agent_id);

    // Create transport
    let transport_config = TransportConfig {
        server_url: args.server_url.unwrap_or(config.server.url),
        ca_cert_path: config.server.ca_cert_path,
        verify_hostname: config.server.verify_hostname,
        heartbeat_interval: Duration::from_secs(config.agent.heartbeat_interval_sec),
        max_missed_heartbeats: config.agent.max_missed_heartbeats,
        agent_identity: identity.clone(),
    };

    let mut transport = Transport::new(transport_config).await?;

    // Create enrollment manager
    let enrollment = EnrollmentManager::new(
        transport.clone(),
        identity.clone(),
        config.enrollment.token.clone(),
    );

    // Create telemetry collector
    let telemetry = TelemetryCollector::new(config.telemetry);

    // Create update manager
    let update_mgr = UpdateManager::new(config.update);

    // Create session manager
    let session_mgr = SessionManager::new(transport.clone());

    // Start enrollment if needed
    if !identity.is_enrolled() {
        info!("Agent not enrolled, starting enrollment...");
        if let Err(e) = enrollment.enroll().await {
            error!("Enrollment failed: {}", e);
            // Retry logic
            enrollment.retry_enroll().await?;
        }
        identity.save(&config.agent.id_path)?;
    }

    // Connect to server
    info!("Connecting to server...");
    transport.connect().await?;

    // Start heartbeat loop
    let heartbeat_handle = transport.start_heartbeat_loop().await?;

    // Start telemetry loop
    let telemetry_handle = telemetry.start_loop(transport.clone(), Duration::from_secs(config.agent.telemetry_interval_sec)).await?;

    // Start inventory loop
    let inventory_handle = telemetry.start_inventory_loop(transport.clone(), Duration::from_secs(config.agent.inventory_interval_sec)).await?;

    // Start update check loop
    let update_handle = update_mgr.start_loop(transport.clone()).await?;

    // Wait for shutdown signal
    tokio::signal::ctrl_c().await?;

    info!("Shutdown signal received, stopping...");

    // Stop all loops
    heartbeat_handle.abort();
    telemetry_handle.abort();
    inventory_handle.abort();
    update_handle.abort();

    // Graceful disconnect
    transport.disconnect().await?;

    info!("Agent stopped");
    Ok(())
}

fn init_logging(level: &str) -> Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(level));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_span_events(FmtSpan::CLOSE)
        .json()
        .init();

    Ok(())
}

fn load_config(path: &str, args: &Args) -> Result<AgentConfig> {
    let mut builder = Config::builder()
        .add_source(File::with_name(path).required(false))
        .add_source(Environment::with_prefix("NEXUS_AGENT"));

    // Override with command line args
    if let Some(token) = &args.enroll_token {
        builder = builder.set_override("enrollment.token", token)?;
    }

    let config = builder.build()?;
    config.try_deserialize().context("Failed to parse config")
}