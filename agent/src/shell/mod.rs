//! Script execution engine with real-time stdout/stderr streaming

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use tokio::process::Command;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::os::{OSInterface, PtyHandle};
use crate::proto::rmm::v1::{ScriptLanguage, ScriptOutput, ScriptStream};

#[derive(Debug, Clone)]
pub struct ShellConfig {
    pub default_timeout_sec: u64,
    pub max_output_size: usize,
    pub allowed_commands: Vec<String>, // Whitelist if needed
    pub blocked_commands: Vec<String>,
    pub working_directory: Option<PathBuf>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            default_timeout_sec: 300, // 5 minutes
            max_output_size: 1024 * 1024, // 1MB
            allowed_commands: vec![],
            blocked_commands: vec![
                "rm -rf /".to_string(),
                ":(){ :|:& };:".to_string(), // Fork bomb
                "dd if=/dev/zero".to_string(),
            ],
            working_directory: None,
        }
    }
}

pub struct ScriptEngine {
    config: ShellConfig,
    os: Arc<dyn OSInterface>,
    running_scripts: HashMap<String, RunningScript>,
}

#[derive(Debug)]
struct RunningScript {
    id: String,
    child: tokio::process::Child,
    stdout_tx: mpsc::Sender<ScriptOutput>,
    stderr_tx: mpsc::Sender<ScriptOutput>,
    start_time: std::time::Instant,
}

impl ScriptEngine {
    pub fn new(os: Arc<dyn OSInterface>, config: ShellConfig) -> Self {
        Self {
            config,
            os,
            running_scripts: HashMap::new(),
        }
    }

    pub async fn execute_script(
        &mut self,
        script_id: String,
        language: ScriptLanguage,
        script: String,
        env: HashMap<String, String>,
        timeout_sec: u64,
        elevated: bool,
        stdout_tx: mpsc::Sender<ScriptOutput>,
        stderr_tx: mpsc::Sender<ScriptOutput>,
    ) -> Result<i32> {
        // Validate script
        self.validate_script(&script)?;

        // Prepare command based on language
        let (cmd, args) = self.prepare_command(language, &script)?;

        let mut command = Command::new(cmd);
        command.args(args);

        // Set environment
        for (k, v) in env {
            command.env(k, v);
        }

        // Set working directory
        if let Some(cwd) = &self.config.working_directory {
            command.current_dir(cwd);
        }

        // Configure stdio
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Handle elevation
        if elevated {
            #[cfg(target_os = "windows")]
            {
                // On Windows, use runas or scheduled task
                // This is simplified - real implementation would use UAC
            }
            #[cfg(target_os = "linux")]
            {
                // On Linux, use sudo or pkexec
                command.arg("sudo").arg("-n"); // Non-interactive
            }
            #[cfg(target_os = "macos")]
            {
                // On macOS, use osascript with admin privileges
            }
        }

        // Spawn process
        let mut child = command.spawn()
            .context("Failed to spawn script process")?;

        let pid = child.id().unwrap_or(0);
        info!("Started script {} (PID: {})", script_id, pid);

        // Take stdout/stderr
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Track running script
        let running = RunningScript {
            id: script_id.clone(),
            child: child,
            stdout_tx: stdout_tx.clone(),
            stderr_tx: stderr_tx.clone(),
            start_time: std::time::Instant::now(),
        };

        // Spawn output readers
        let script_id_clone = script_id.clone();
        let stdout_tx_clone = stdout_tx.clone();
        tokio::spawn(async move {
            Self::read_output(stdout, stdout_tx_clone, ScriptStream::ScriptStdout, script_id_clone).await;
        });

        let script_id_clone = script_id.clone();
        let stderr_tx_clone = stderr_tx.clone();
        tokio::spawn(async move {
            Self::read_output(stderr, stderr_tx_clone, ScriptStream::ScriptStderr, script_id_clone).await;
        });

        // Wait for completion with timeout
        let result = timeout(Duration::from_secs(timeout_sec), async {
            self.running_scripts.insert(script_id.clone(), running);
            let mut child = self.running_scripts.remove(&script_id).unwrap().child;
            child.wait().await
        }).await;

        match result {
            Ok(Ok(status)) => {
                let exit_code = status.code().unwrap_or(-1);
                info!("Script {} exited with code {}", script_id, exit_code);

                // Send final result
                let _ = stdout_tx.send(ScriptOutput {
                    session_id: String::new(),
                    stream: ScriptStream::ScriptStdout as i32,
                    data: format!("\n[Exit code: {}]\n", exit_code).into_bytes(),
                }).await;

                Ok(exit_code)
            }
            Ok(Err(e)) => {
                warn!("Script {} failed: {}", script_id, e);
                Err(e.into())
            }
            Err(_) => {
                // Timeout - kill process
                warn!("Script {} timed out, killing", script_id);
                if let Some(mut running) = self.running_scripts.remove(&script_id) {
                    let _ = running.child.kill().await;
                }
                Err(anyhow::anyhow!("Script execution timed out"))
            }
        }
    }

    async fn read_output(
        mut reader: impl AsyncReadExt + Unpin,
        tx: mpsc::Sender<ScriptOutput>,
        stream: ScriptStream,
        script_id: String,
    ) {
        let mut buffer = vec![0u8; 4096];
        let mut total_read = 0usize;

        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    total_read += n;
                    if total_read > 1024 * 1024 { // Max 1MB per stream
                        break;
                    }

                    let output = ScriptOutput {
                        session_id: script_id.clone(),
                        stream: stream as i32,
                        data: buffer[..n].to_vec(),
                    };

                    if tx.send(output).await.is_err() {
                        break; // Channel closed
                    }
                }
                Err(e) => {
                    debug!("Output read error: {}", e);
                    break;
                }
            }
        }
    }

    fn validate_script(&self, script: &str) -> Result<()> {
        // Check for blocked commands
        for blocked in &self.config.blocked_commands {
            if script.contains(blocked) {
                return Err(anyhow::anyhow!("Script contains blocked command: {}", blocked));
            }
        }

        // If allowed commands specified, ensure script only uses them
        if !self.config.allowed_commands.is_empty() {
            // Simplified check - in production, parse script properly
        }

        Ok(())
    }

    fn prepare_command(&self, language: ScriptLanguage, script: &str) -> Result<(String, Vec<String>)> {
        match language {
            ScriptLanguage::ScriptBash => Ok(("/bin/bash".to_string(), vec!["-c".to_string(), script.to_string()])),
            ScriptLanguage::ScriptSh => Ok(("/bin/sh".to_string(), vec!["-c".to_string(), script.to_string()])),
            ScriptLanguage::ScriptPowershell => {
                if cfg!(target_os = "windows") {
                    Ok(("powershell.exe".to_string(), vec!["-Command".to_string(), script.to_string()]))
                } else {
                    Ok(("pwsh".to_string(), vec!["-Command".to_string(), script.to_string()]))
                }
            }
            ScriptLanguage::ScriptPython => Ok(("python3".to_string(), vec!["-c".to_string(), script.to_string()])),
            ScriptLanguage::ScriptCmd => {
                if cfg!(target_os = "windows") {
                    Ok(("cmd.exe".to_string(), vec!["/C".to_string(), script.to_string()]))
                } else {
                    Err(anyhow::anyhow!("CMD scripts only supported on Windows"))
                }
            }
        }
    }

    pub async fn kill_script(&mut self, script_id: &str) -> Result<()> {
        if let Some(mut running) = self.running_scripts.remove(script_id) {
            running.child.kill().await?;
            info!("Killed script {}", script_id);
        }
        Ok(())
    }

    pub fn list_running(&self) -> Vec<String> {
        self.running_scripts.keys().cloned().collect()
    }
}

// Interactive PTY session for terminal emulation
#[derive(Clone)]
pub struct PtySession {
    handle: Arc<PtyHandle>,
    cols: u32,
    rows: u32,
}

impl PtySession {
    pub fn new(handle: PtyHandle, cols: u32, rows: u32) -> Self {
        Self { handle: Arc::new(handle), cols, rows }
    }

    pub async fn write_stdin(&self, data: &[u8]) -> Result<()> {
        self.handle.stdin_tx.send(data.to_vec()).await
            .map_err(|_| anyhow::anyhow!("PTY stdin channel closed"))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.handle.resize_tx.send((cols, rows)).await
            .map_err(|_| anyhow::anyhow!("PTY resize channel closed"))
    }

    pub async fn close(&self) -> Result<()> {
        // close_tx is Option<oneshot::Sender<()>> - we need to take it
        if let Some(tx) = self.handle.close_tx.lock().await.take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    pub fn stdout_receiver(&self) -> mpsc::Receiver<Vec<u8>> {
        // This would need to be cloned from the handle
        // Simplified for now
        mpsc::channel(100).1
    }

    pub fn stderr_receiver(&self) -> mpsc::Receiver<Vec<u8>> {
        mpsc::channel(100).1
    }
}

// PTY manager for creating and managing terminal sessions
pub struct PtyManager {
    os: Arc<dyn OSInterface>,
    sessions: HashMap<String, Arc<PtySession>>,
}

impl PtyManager {
    pub fn new(os: Arc<dyn OSInterface>) -> Self {
        Self {
            os,
            sessions: HashMap::new(),
        }
    }

    pub async fn create_session(&mut self, session_id: String, cols: u32, rows: u32, shell: Option<String>) -> Result<Arc<PtySession>> {
        let handle = self.os.spawn_pty(cols, rows, shell).await?;
        let session = Arc::new(PtySession::new(handle, cols, rows));
        self.sessions.insert(session_id, session.clone());
        Ok(session)
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<PtySession>> {
        self.sessions.get(session_id).cloned()
    }

    pub async fn close_session(&mut self, session_id: &str) -> Result<()> {
        if let Some(session) = self.sessions.remove(session_id) {
            session.close().await?;
        }
        Ok(())
    }
}