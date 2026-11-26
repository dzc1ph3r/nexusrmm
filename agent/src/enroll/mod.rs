//! Agent enrollment and mTLS/Ed25519 handshake implementation

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn, error, debug};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::proto::rmm::v1::{EnrollRequest, EnrollResponse, EnrollChallenge, EnrollResult, Hello, Welcome};
use crate::transport::{Transport, Frame, FrameType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentIdentity {
    pub agent_id: String,
    pub signing_key: Vec<u8>,      // Ed25519 private key (32 bytes)
    pub verifying_key: Vec<u8>,    // Ed25519 public key (32 bytes)
    pub enrolled: bool,
    pub tenant_id: Option<String>,
    pub cert_der: Option<Vec<u8>>,
    pub ca_cert_der: Option<Vec<u8>>,
    pub cert_expires_at: Option<u64>,
    pub server_config: Option<AgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub heartbeat_interval_sec: u64,
    pub telemetry_interval_sec: u64,
    pub inventory_interval_sec: u64,
    pub log_level: String,
    pub auto_update: bool,
    pub update_url: String,
}

impl AgentIdentity {
    pub fn new() -> Result<Self> {
        // Generate random 32 bytes for the signing key
        let mut key_bytes = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key_bytes);
        let signing_key = SigningKey::from_bytes(&key_bytes);
        let verifying_key = signing_key.verifying_key();

        Ok(Self {
            agent_id: format!("agt_{}", hex::encode(rand::random::<[u8; 12]>())),
            signing_key: signing_key.to_bytes().to_vec(),
            verifying_key: verifying_key.to_bytes().to_vec(),
            enrolled: false,
            tenant_id: None,
            cert_der: None,
            ca_cert_der: None,
            cert_expires_at: None,
            server_config: None,
        })
    }

    pub fn load_or_create(path: &str) -> Result<Self> {
        let path = Path::new(path);
        if path.exists() {
            let data = fs::read_to_string(path)?;
            let identity: AgentIdentity = serde_json::from_str(&data)?;
            Ok(identity)
        } else {
            let identity = Self::new()?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            identity.save(path)?;
            Ok(identity)
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let data = serde_json::to_string_pretty(self)?;
        fs::write(path, data)?;
        Ok(())
    }

    pub fn is_enrolled(&self) -> bool {
        self.enrolled
    }

    pub fn signing_key(&self) -> Result<SigningKey> {
        let bytes: [u8; 32] = self.signing_key.as_slice().try_into()
            .context("Invalid signing key length")?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    pub fn verifying_key(&self) -> Result<VerifyingKey> {
        let bytes: [u8; 32] = self.verifying_key.as_slice().try_into()
            .context("Invalid verifying key length")?;
        Ok(VerifyingKey::from_bytes(&bytes)?)
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
        let key = self.signing_key()?;
        let signature = key.sign(message);
        Ok(signature.to_bytes().to_vec())
    }

    pub fn verify(&self, message: &[u8], signature: &[u8]) -> Result<bool> {
        let key = self.verifying_key()?;
        let sig = Signature::from_bytes(signature.try_into()?);
        Ok(key.verify(message, &sig).is_ok())
    }
}

pub struct EnrollmentManager {
    transport: Arc<Transport>,
    identity: Arc<Mutex<AgentIdentity>>,
    enrollment_token: Option<String>,
    retry_interval: Duration,
    max_retries: u32,
}

impl EnrollmentManager {
    pub fn new(transport: Transport, identity: AgentIdentity, token: Option<String>) -> Self {
        Self {
            transport: Arc::new(transport),
            identity: Arc::new(Mutex::new(identity)),
            enrollment_token: token,
            retry_interval: Duration::from_secs(30),
            max_retries: 10,
        }
    }

    pub async fn enroll(&self) -> Result<()> {
        let mut retries = 0;

        loop {
            match self.attempt_enrollment().await {
                Ok(_) => {
                    info!("Enrollment successful");
                    return Ok(());
                }
                Err(e) => {
                    retries += 1;
                    if retries >= self.max_retries {
                        bail!("Max enrollment retries exceeded: {}", e);
                    }
                    warn!("Enrollment attempt {} failed: {}. Retrying in {:?}...", retries, e, self.retry_interval);
                    tokio::time::sleep(self.retry_interval).await;
                }
            }
        }
    }

    async fn attempt_enrollment(&self) -> Result<()> {
        let identity = self.identity.lock().await;

        // Build enrollment request
        let request = EnrollRequest {
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: hostname::get()?.to_string_lossy().to_string(),
            machine_id: get_machine_id()?,
            ed25519_pubkey: identity.verifying_key.clone(),
            csr_der: vec![], // TODO: Generate CSR for mTLS cert
            tags: std::collections::HashMap::new(),
            enrollment_token: self.enrollment_token.clone().unwrap_or_default(),
        };

        drop(identity);

        // Send enrollment request
        let challenge = self.send_enroll_request(request).await?;

        // Sign challenge and send response
        let response = self.create_enroll_response(challenge).await?;

        // Send response and get result
        let result = self.send_enroll_response(response).await?;

        // Process result
        self.process_enroll_result(result).await?;

        Ok(())
    }

    async fn send_enroll_request(&self, request: EnrollRequest) -> Result<EnrollChallenge> {
        let frame = Frame::new(FrameType::EnrollRequest, 0, &request)?;
        let response_frame = self.transport.send_request(frame).await?;

        match response_frame.header.msg_type {
            FrameType::EnrollChallenge => {
                let challenge: EnrollChallenge = response_frame.decode_payload()?;
                Ok(challenge)
            }
            FrameType::Error => {
                let err = response_frame.decode_payload::<crate::proto::rmm::v1::Error>()?;
                bail!("Enrollment request failed: {}", err.message)
            }
            _ => bail!("Unexpected response type: {:?}", response_frame.header.msg_type),
        }
    }

    async fn create_enroll_response(&self, challenge: EnrollChallenge) -> Result<EnrollResponse> {
        let identity = self.identity.lock().await;

        // Verify challenge hasn't expired
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
        if challenge.expires_at > 0 && now > challenge.expires_at as u64 {
            bail!("Challenge expired");
        }

        // Sign challenge + server_nonce
        let mut message = Vec::new();
        message.extend_from_slice(&challenge.challenge);
        message.extend_from_slice(challenge.server_nonce.as_bytes());

        let signature = identity.sign(&message)?;

        let agent_nonce = hex::encode(rand::random::<[u8; 16]>());

        Ok(EnrollResponse {
            challenge: challenge.challenge,
            signature,
            agent_nonce,
        })
    }

    async fn send_enroll_response(&self, response: EnrollResponse) -> Result<EnrollResult> {
        let frame = Frame::new(FrameType::EnrollResponse, 0, &response)?;
        let response_frame = self.transport.send_request(frame).await?;

        match response_frame.header.msg_type {
            FrameType::EnrollResult => {
                let result: EnrollResult = response_frame.decode_payload()?;
                Ok(result)
            }
            FrameType::Error => {
                let err = response_frame.decode_payload::<crate::proto::rmm::v1::Error>()?;
                bail!("Enrollment response failed: {}", err.message)
            }
            _ => bail!("Unexpected response type: {:?}", response_frame.header.msg_type),
        }
    }

    async fn process_enroll_result(&self, result: EnrollResult) -> Result<()> {
        if !result.success {
            bail!("Enrollment failed: {}", result.error);
        }

        let mut identity = self.identity.lock().await;
        identity.agent_id = result.agent_id;
        identity.enrolled = true;
        identity.cert_der = Some(result.cert_der);
        identity.ca_cert_der = Some(result.ca_cert_der);
        identity.cert_expires_at = Some(result.cert_expires_at as u64);

        if !result.config.is_empty() {
            let config_map = result.config;
            identity.server_config = Some(AgentConfig {
                heartbeat_interval_sec: config_map.get("heartbeat_interval_sec")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(30),
                telemetry_interval_sec: config_map.get("telemetry_interval_sec")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60),
                inventory_interval_sec: config_map.get("inventory_interval_sec")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(3600),
                log_level: config_map.get("log_level").cloned().unwrap_or_else(|| "info".to_string()),
                auto_update: config_map.get("auto_update").and_then(|v| v.parse().ok()).unwrap_or(true),
                update_url: config_map.get("update_url").cloned().unwrap_or_default(),
            });
        }

        info!("Agent enrolled with ID: {}", identity.agent_id);
        Ok(())
    }

    pub async fn retry_enroll(&self) -> Result<()> {
        self.enroll().await
    }

    pub async fn send_hello(&self, session_pubkey: &[u8]) -> Result<Welcome> {
        let identity = self.identity.lock().await;

        let hello = Hello {
            agent_id: identity.agent_id.clone(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: hostname::get()?.to_string_lossy().to_string(),
            machine_id: get_machine_id()?,
            ed25519_pubkey: identity.verifying_key.clone(),
            session_pubkey: session_pubkey.to_vec(),
            signature: vec![], // Will be filled below
            timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64,
        };

        // Sign hello payload
        let mut payload = Vec::new();
        payload.extend_from_slice(hello.agent_id.as_bytes());
        payload.extend_from_slice(hello.agent_version.as_bytes());
        payload.extend_from_slice(hello.os.as_bytes());
        payload.extend_from_slice(hello.arch.as_bytes());
        payload.extend_from_slice(hello.hostname.as_bytes());
        payload.extend_from_slice(hello.machine_id.as_bytes());
        payload.extend_from_slice(&hello.ed25519_pubkey);
        payload.extend_from_slice(&hello.session_pubkey);
        payload.extend_from_slice(&hello.timestamp.to_be_bytes());

        let signature = identity.sign(&payload)?;
        drop(identity);

        let mut hello = hello;
        hello.signature = signature;

        let frame = Frame::new(FrameType::Hello, 0, &hello)?;
        let response_frame = self.transport.send_request(frame).await?;

        match response_frame.header.msg_type {
            FrameType::Welcome => {
                let welcome: Welcome = response_frame.decode_payload()?;
                Ok(welcome)
            }
            FrameType::Error => {
                let err = response_frame.decode_payload::<crate::proto::rmm::v1::Error>()?;
                bail!("Hello failed: {}", err.message)
            }
            _ => bail!("Unexpected response type: {:?}", response_frame.header.msg_type),
        }
    }
}

fn get_machine_id() -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = fs::read_to_string("/etc/machine-id") {
            return Ok(id.trim().to_string());
        }
        if let Ok(id) = fs::read_to_string("/var/lib/dbus/machine-id") {
            return Ok(id.trim().to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Registry::*;
        use std::ptr;

        unsafe {
            let mut key = HKEY::default();
            let result = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Cryptography"),
                0,
                KEY_READ,
                &mut key,
            );
            if result == ERROR_SUCCESS {
                let mut buffer = [0u16; 256];
                let mut size = (buffer.len() * 2) as u32;
                let result = RegGetValueW(
                    key,
                    None,
                    w!("MachineGuid"),
                    RRF_RT_REG_SZ,
                    None,
                    buffer.as_mut_ptr() as *mut _,
                    &mut size,
                );
                RegCloseKey(key);
                if result == ERROR_SUCCESS {
                    let guid = String::from_utf16_lossy(&buffer[..(size as usize / 2)]);
                    return Ok(guid.trim_end_matches('\0').to_string());
                }
            }
        }
    }

    // Fallback: generate from hostname + MAC
    let hostname = hostname::get()?.to_string_lossy().to_string();
    Ok(format!("{}-fallback", hostname))
}