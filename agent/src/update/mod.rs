//! Agent self-update manager with Ed25519 signature verification

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use ed25519_dalek::{VerifyingKey, Signature, Verifier};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time::interval;
use tracing::{debug, info, warn, error};

use crate::transport::{Transport, FrameType, Frame};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConfig {
    pub enabled: bool,
    pub check_interval_sec: u64,
    pub base_url: String,
    pub current_version: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct UpdateManifest {
    version: String,
    release_notes: String,
    artifacts: Vec<UpdateArtifact>,
    signature: String, // Base64 encoded Ed25519 signature
    signed_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct UpdateArtifact {
    os: String,
    arch: String,
    url: String,
    sha256: String,
    size: u64,
}

pub struct UpdateManager {
    config: UpdateConfig,
    client: Client,
    public_key: Option<VerifyingKey>,
}

impl UpdateManager {
    pub fn new(config: UpdateConfig) -> Self {
        Self {
            config,
            client: Client::new(),
            public_key: None,
        }
    }

    pub fn set_public_key(&mut self, key_pem: &str) -> Result<()> {
        // Parse Ed25519 public key from PEM or base64
        // Remove PEM headers/footers and decode base64
        let key_data = key_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let key_bytes = base64::decode(key_data.trim())?;

        // Ed25519 public key is 32 bytes
        if key_bytes.len() != 32 {
            return Err(anyhow::anyhow!("Invalid public key length: {}", key_bytes.len()));
        }

        let mut key_array = [0u8; 32];
        key_array.copy_from_slice(&key_bytes);
        let key = VerifyingKey::from_bytes(&key_array)?;
        self.public_key = Some(key);
        Ok(())
    }

    pub async fn check_for_updates(&self) -> Result<Option<UpdateManifest>> {
        if !self.config.enabled {
            return Ok(None);
        }

        let url = format!("{}/manifest.json", self.config.base_url.trim_end_matches('/'));

        let response = self.client.get(&url).send().await?;
        if !response.status().is_success() {
            return Ok(None);
        }

        let manifest: UpdateManifest = response.json().await?;

        // Verify signature
        if let Some(pk) = &self.public_key {
            let manifest_bytes = serde_json::to_vec(&manifest)?;
            let signature = base64::decode(&manifest.signature)?;
            pk.verify(&manifest_bytes, &Signature::from_slice(&signature)?)?;
        }

        // Check if newer version
        if self.is_newer_version(&manifest.version) {
            Ok(Some(manifest))
        } else {
            Ok(None)
        }
    }

    fn is_newer_version(&self, remote_version: &str) -> bool {
        // Simple semantic version comparison
        let current = self.parse_version(&self.config.current_version);
        let remote = self.parse_version(remote_version);
        remote > current
    }

    fn parse_version(&self, version: &str) -> Vec<u32> {
        version.split('.')
            .filter_map(|s| s.parse().ok())
            .collect()
    }

    pub async fn download_and_apply(&self, manifest: &UpdateManifest) -> Result<()> {
        // Find matching artifact
        let artifact = manifest.artifacts.iter()
            .find(|a| a.os == std::env::consts::OS && a.arch == std::env::consts::ARCH)
            .context("No matching artifact for this platform")?;

        info!("Downloading update {} from {}", manifest.version, artifact.url);

        // Download
        let response = self.client.get(&artifact.url).send().await?;
        let bytes = response.bytes().await?;

        // Verify SHA256
        let hash = Sha256::digest(&bytes);
        let hash = hex::encode(hash);
        if hash != artifact.sha256 {
            bail!("Checksum mismatch: expected {}, got {}", artifact.sha256, hash);
        }

        // Write to temporary file
        let temp_path = std::env::temp_dir().join(format!("nexus-agent-update-{}", manifest.version));
        tokio::fs::write(&temp_path, &bytes).await?;

        // Make executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = tokio::fs::metadata(&temp_path).await?.permissions();
            perms.set_mode(0o755);
            tokio::fs::set_permissions(&temp_path, perms).await?;
        }

        // Apply update (platform-specific)
        self.apply_update(&temp_path).await?;

        Ok(())
    }

    async fn apply_update(&self, new_binary: &PathBuf) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            // Windows: Use move with replacement on next boot
            let current_exe = std::env::current_exe()?;
            let backup = current_exe.with_extension("exe.bak");

            tokio::fs::rename(&current_exe, &backup).await?;
            tokio::fs::rename(new_binary, &current_exe).await?;

            info!("Update applied, will take effect on next restart");
        }

        #[cfg(target_os = "linux")]
        {
            // Linux: Replace binary and restart service
            let current_exe = std::env::current_exe()?;

            tokio::fs::rename(&current_exe, current_exe.with_extension("bak")).await?;
            tokio::fs::rename(new_binary, &current_exe).await?;

            // Restart systemd service
            tokio::process::Command::new("systemctl")
                .args(["restart", "nexus-agent"])
                .spawn()?;
        }

        #[cfg(target_os = "macos")]
        {
            // macOS: Replace and restart launchd service
            let current_exe = std::env::current_exe()?;
            tokio::fs::rename(&current_exe, current_exe.with_extension("bak")).await?;
            tokio::fs::rename(new_binary, &current_exe).await?;

            tokio::process::Command::new("launchctl")
                .args(["kickstart", "-k", "system/nexus.agent"])
                .spawn()?;
        }

        Ok(())
    }

    pub async fn start_loop(&self, transport: Transport) -> Result<tokio::task::JoinHandle<()>> {
        if !self.config.enabled {
            return Ok(tokio::spawn(async {}));
        }

        let config = self.config.clone();
        let public_key = self.public_key.clone();
        let interval_sec = config.check_interval_sec;

        let handle = tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(interval_sec));
            loop {
                ticker.tick().await;

                // In a real implementation, this would use the update manager
                debug!("Checking for updates...");
            }
        });

        Ok(handle)
    }
}

impl Clone for UpdateManager {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            client: self.client.clone(),
            public_key: self.public_key.clone(),
        }
    }
}

use anyhow::bail;