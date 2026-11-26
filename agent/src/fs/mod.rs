//! File system operations with chunked transfer and integrity verification

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use blake3;
use sha2::{Sha256, Sha512, Digest};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt, AsyncSeekExt};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::os::{OSInterface, FileEntry};

#[derive(Debug, Clone)]
pub struct FsConfig {
    pub max_chunk_size: usize,
    pub allowed_paths: Vec<PathBuf>, // Whitelist of allowed paths
    pub blocked_paths: Vec<PathBuf>, // Blacklist of blocked paths
    pub require_elevation: bool,     // Require admin/root for sensitive paths
}

impl Default for FsConfig {
    fn default() -> Self {
        Self {
            max_chunk_size: 1024 * 1024, // 1MB
            allowed_paths: vec![],
            blocked_paths: vec![
                PathBuf::from("/etc/shadow"),
                PathBuf::from("/etc/sudoers"),
                PathBuf::from("C:\\Windows\\System32\\config"),
                PathBuf::from("C:\\Windows\\System32\\drivers\\etc\\hosts"),
            ],
            require_elevation: true,
        }
    }
}

pub struct FileManager {
    config: FsConfig,
    os: Arc<dyn OSInterface>,
    active_transfers: Mutex<HashMap<String, FileTransfer>>,
}

#[derive(Debug, Clone)]
pub struct FileTransfer {
    pub transfer_id: String,
    pub path: PathBuf,
    pub total_size: u64,
    pub transferred: u64,
    pub is_upload: bool,
    pub sha256: Sha256,
    pub started_at: std::time::Instant,
}

impl FileManager {
    pub fn new(os: Arc<dyn OSInterface>, config: FsConfig) -> Self {
        Self {
            config,
            os,
            active_transfers: Mutex::new(HashMap::new()),
        }
    }

    pub fn validate_path(&self, path: &Path) -> Result<()> {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // Check blocked paths
        for blocked in &self.config.blocked_paths {
            if path.starts_with(blocked) {
                return Err(anyhow::anyhow!("Path is blocked: {}", path.display()));
            }
        }

        // If allowed paths specified, check against whitelist
        if !self.config.allowed_paths.is_empty() {
            let allowed = self.config.allowed_paths.iter().any(|p| path.starts_with(p));
            if !allowed {
                return Err(anyhow::anyhow!("Path not in allowed list: {}", path.display()));
            }
        }

        Ok(())
    }

    pub async fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>> {
        let path = Path::new(path);
        self.validate_path(path)?;
        self.os.list_files(path.to_str().unwrap()).await
    }

    pub async fn read_file_chunk(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>> {
        let path = Path::new(path);
        self.validate_path(path)?;

        let len = length.min(self.config.max_chunk_size as u32) as usize;
        self.os.read_file(path.to_str().unwrap(), offset, len as u32).await
    }

    pub async fn write_file_chunk(&self, path: &str, offset: u64, data: &[u8]) -> Result<u32> {
        let path = Path::new(path);
        self.validate_path(path)?;

        if data.len() > self.config.max_chunk_size {
            return Err(anyhow::anyhow!("Chunk too large"));
        }

        self.os.write_file(path.to_str().unwrap(), offset, data).await
    }

    pub async fn compute_hash(&self, path: &str, algorithm: HashAlgorithm) -> Result<Vec<u8>> {
        let path = Path::new(path);
        self.validate_path(path)?;

        let mut file = fs::File::open(path).await?;
        let mut buffer = vec![0u8; 64 * 1024];

        match algorithm {
            HashAlgorithm::SHA256 => {
                let mut hasher = Sha256::new();
                loop {
                    let n = file.read(&mut buffer).await?;
                    if n == 0 { break; }
                    hasher.update(&buffer[..n]);
                }
                Ok(hasher.finalize().to_vec())
            }
            HashAlgorithm::SHA512 => {
                let mut hasher = Sha512::new();
                loop {
                    let n = file.read(&mut buffer).await?;
                    if n == 0 { break; }
                    hasher.update(&buffer[..n]);
                }
                Ok(hasher.finalize().to_vec())
            }
            HashAlgorithm::BLAKE3 => {
                let mut hasher = blake3::Hasher::new();
                loop {
                    let n = file.read(&mut buffer).await?;
                    if n == 0 { break; }
                    hasher.update(&buffer[..n]);
                }
                Ok(hasher.finalize().as_bytes().to_vec())
            }
        }
    }

    pub async fn start_transfer(&self, transfer_id: String, path: PathBuf, total_size: u64, is_upload: bool) -> Result<FileTransfer> {
        let transfer = FileTransfer {
            transfer_id: transfer_id.clone(),
            path,
            total_size,
            transferred: 0,
            is_upload,
            sha256: Sha256::new(),
            started_at: std::time::Instant::now(),
        };

        self.active_transfers.lock().await.insert(transfer_id, transfer.clone());
        Ok(transfer)
    }

    pub async fn update_transfer(&self, transfer_id: &str, chunk: &[u8]) -> Result<u64> {
        let mut transfers = self.active_transfers.lock().await;
        let transfer = transfers.get_mut(transfer_id)
            .ok_or_else(|| anyhow::anyhow!("Transfer not found"))?;

        transfer.sha256.update(chunk);
        transfer.transferred += chunk.len() as u64;

        Ok(transfer.transferred)
    }

    pub async fn finish_transfer(&self, transfer_id: &str) -> Result<FileTransfer> {
        let mut transfers = self.active_transfers.lock().await;
        let transfer = transfers.remove(transfer_id)
            .ok_or_else(|| anyhow::anyhow!("Transfer not found"))?;

        Ok(transfer)
    }

    pub async fn get_transfer(&self, transfer_id: &str) -> Option<FileTransfer> {
        let transfers = self.active_transfers.lock().await;
        transfers.get(transfer_id).cloned()
    }
}

#[derive(Debug, Clone, Copy)]
pub enum HashAlgorithm {
    SHA256,
    SHA512,
    BLAKE3,
}

// Chunked file transfer for large files
pub struct ChunkedTransfer {
    manager: Arc<FileManager>,
    transfer_id: String,
    path: PathBuf,
    chunk_size: usize,
}

impl ChunkedTransfer {
    pub fn new(manager: Arc<FileManager>, transfer_id: String, path: PathBuf, chunk_size: usize) -> Self {
        Self { manager, transfer_id, path, chunk_size }
    }

    pub async fn upload(&self, mut reader: impl AsyncReadExt + Unpin, total_size: u64) -> Result<Vec<u8>> {
        self.manager.start_transfer(self.transfer_id.clone(), self.path.clone(), total_size, true).await?;

        let mut buffer = vec![0u8; self.chunk_size];
        let mut uploaded = 0u64;

        loop {
            let n = reader.read(&mut buffer).await?;
            if n == 0 { break; }

            let chunk = &buffer[..n];
            self.manager.update_transfer(&self.transfer_id, chunk).await?;

            // Write chunk to disk
            self.manager.write_file_chunk(
                self.path.to_str().unwrap(),
                uploaded,
                chunk
            ).await?;

            uploaded += n as u64;
        }

        let transfer = self.manager.finish_transfer(&self.transfer_id).await?;
        let hash = transfer.sha256.clone().finalize().to_vec();

        Ok(hash)
    }

    pub async fn download(&self, mut writer: impl AsyncWriteExt + Unpin, offset: u64, length: u64) -> Result<()> {
        let mut remaining = length;
        let mut current_offset = offset;

        while remaining > 0 {
            let chunk_size = (remaining as usize).min(self.chunk_size);
            let chunk = self.manager.read_file_chunk(
                self.path.to_str().unwrap(),
                current_offset,
                chunk_size as u32
            ).await?;

            writer.write_all(&chunk).await?;

            current_offset += chunk.len() as u64;
            remaining -= chunk.len() as u64;
        }

        Ok(())
    }
}