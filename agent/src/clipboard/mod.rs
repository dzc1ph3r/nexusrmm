//! Clipboard synchronization between agent and console

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio::time::interval;
use tracing::{debug, info};

use crate::os::OSInterface;

#[derive(Debug, Clone)]
pub struct ClipboardConfig {
    pub poll_interval_ms: u64,
    pub max_size_bytes: usize,
}

impl Default for ClipboardConfig {
    fn default() -> Self {
        Self {
            poll_interval_ms: 500,
            max_size_bytes: 1024 * 1024, // 1MB
        }
    }
}

pub struct ClipboardManager {
    config: ClipboardConfig,
    os: Arc<dyn OSInterface>,
    last_content: String,
    last_hash: u64,
    tx: mpsc::Sender<ClipboardEvent>,
}

#[derive(Debug, Clone)]
pub enum ClipboardEvent {
    ContentChanged(String),
    Error(String),
}

impl ClipboardManager {
    pub fn new(os: Arc<dyn OSInterface>, config: ClipboardConfig, tx: mpsc::Sender<ClipboardEvent>) -> Self {
        Self {
            config,
            os,
            last_content: String::new(),
            last_hash: 0,
            tx,
        }
    }

    pub async fn start_polling(&mut self) -> Result<()> {
        let mut ticker = interval(Duration::from_millis(self.config.poll_interval_ms));

        loop {
            ticker.tick().await;

            match self.os.get_clipboard().await {
                Ok(content) => {
                    let hash = self.hash_content(&content);
                    if hash != self.last_hash && !content.is_empty() {
                        // Only send if content actually changed and isn't empty
                        if content.len() <= self.config.max_size_bytes {
                            self.last_content = content.clone();
                            self.last_hash = hash;

                            if let Err(e) = self.tx.send(ClipboardEvent::ContentChanged(content)).await {
                                debug!("Clipboard channel closed: {}", e);
                                break Ok(());
                            }
                        }
                    }
                }
                Err(e) => {
                    debug!("Clipboard read failed: {}", e);
                }
            }
        }
    }

    pub async fn set_content(&mut self, content: String) -> Result<()> {
        if content.len() > self.config.max_size_bytes {
            return Err(anyhow::anyhow!("Clipboard content too large"));
        }

        self.os.set_clipboard(&content).await?;
        self.last_hash = self.hash_content(&content);
        Ok(())
    }

    fn hash_content(&self, content: &str) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        hasher.finish()
    }
}

// Clipboard sync for remote sessions
pub struct SessionClipboardSync {
    manager: ClipboardManager,
    remote_content: String,
    local_echo: bool,
}

impl SessionClipboardSync {
    pub fn new(os: Arc<dyn OSInterface>, config: ClipboardConfig) -> (Self, mpsc::Receiver<ClipboardEvent>) {
        let (tx, rx) = mpsc::channel(100);
        let manager = ClipboardManager::new(os, config, tx);

        let sync = Self {
            manager,
            remote_content: String::new(),
            local_echo: false,
        };

        (sync, rx)
    }

    pub async fn start(&mut self) -> Result<()> {
        self.manager.start_polling().await
    }

    pub async fn handle_remote_clipboard(&mut self, content: String) {
        if content != self.remote_content {
            self.remote_content = content.clone();
            self.local_echo = true;
            if let Err(e) = self.manager.set_content(content).await {
                debug!("Failed to set remote clipboard: {}", e);
            }
            self.local_echo = false;
        }
    }

    pub async fn handle_local_change(&mut self, content: String) {
        if !self.local_echo && content != self.remote_content {
            // Send to remote
            self.remote_content = content;
            // Would send via transport here
        }
    }
}