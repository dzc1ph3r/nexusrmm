//! macOS OS implementation using ScreenCaptureKit, CGEvent, and standard macOS APIs

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio::process::Command;

use crate::os::{
    OSInterface, CaptureSession, VideoFrame, VideoFormat, Rect,
    MouseButton, FileEntry, ProcessInfo, ServiceInfo,
    ServiceStatus, ServiceStartType, ServiceAction, PtyHandle,
};

pub struct MacOS {
    capture_active: bool,
}

impl MacOS {
    pub fn new() -> Self {
        Self {
            capture_active: false,
        }
    }
}

#[async_trait]
impl OSInterface for MacOS {
    async fn start_capture(&mut self) -> Result<CaptureSession> {
        // Use ScreenCaptureKit for macOS screen capture
        // This requires macOS 12.3+ and proper entitlements

        self.capture_active = true;
        let (tx, rx) = mpsc::channel(10);

        // Get screen dimensions
        let output = Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-json"])
            .output()
            .await?;

        let (width, height) = parse_screen_size(&output.stdout).await?;

        // Spawn capture loop using ScreenCaptureKit via Swift helper
        // For now, simulate
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(33)).await;

                let frame = VideoFrame {
                    data: vec![],
                    width,
                    height,
                    format: VideoFormat::BGRA,
                    timestamp: std::time::SystemTime::now(),
                    dirty_rects: vec![],
                };

                if tx.send(frame).await.is_err() {
                    break;
                }
            }
        });

        Ok(CaptureSession {
            width,
            height,
            frame_rx: rx,
        })
    }

    async fn stop_capture(&mut self) -> Result<()> {
        self.capture_active = false;
        Ok(())
    }

    async fn inject_mouse_move(&self, x: i32, y: i32) -> Result<()> {
        // Use CGEvent for mouse movement
        let script = format!(
            r#"osascript -e 'tell application "System Events" to set position of mouse to {{x:{}, y:{}}}'"#,
            x, y
        );
        Command::new("sh").args(["-c", &script]).output().await?;
        Ok(())
    }

    async fn inject_mouse_click(&self, x: i32, y: i32, button: MouseButton, down: bool) -> Result<()> {
        self.inject_mouse_move(x, y).await?;

        let btn = match button {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
            _ => "left",
        };

        let action = if down { "down" } else { "up" };

        let script = format!(
            r#"osascript -e 'tell application "System Events" to {} click at {{x:{}, y:{}}}'"#,
            action, x, y
        );
        Command::new("sh").args(["-c", &script]).output().await?;
        Ok(())
    }

    async fn inject_mouse_wheel(&self, _x: i32, _y: i32, delta_x: i32, delta_y: i32) -> Result<()> {
        // Use osascript for scroll
        let script = format!(
            r#"osascript -e 'tell application "System Events" to scroll ({{horizontal:{}, vertical:{}}})'"#,
            delta_x, delta_y
        );
        Command::new("sh").args(["-c", &script]).output().await?;
        Ok(())
    }

    async fn inject_key(&self, key_code: u32, down: bool) -> Result<()> {
        let key_name = keycode_to_macos_key(key_code);
        let action = if down { "key down" } else { "key up" };

        let script = format!(
            r#"osascript -e 'tell application "System Events" to {} "{}'"#,
            action, key_name
        );
        Command::new("sh").args(["-c", &script]).output().await?;
        Ok(())
    }

    async fn inject_text(&self, text: &str) -> Result<()> {
        // Escape text for osascript
        let escaped = text.replace('"', "\\\"").replace('\n', "\\n");
        let script = format!(
            r#"osascript -e 'tell application "System Events" to keystroke "{}'"#,
            escaped
        );
        Command::new("sh").args(["-c", &script]).output().await?;
        Ok(())
    }

    async fn get_clipboard(&self) -> Result<String> {
        let output = Command::new("pbpaste").output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn set_clipboard(&self, text: &str) -> Result<()> {
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()?;

        if let Some(stdin) = child.stdin.as_mut() {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(text.as_bytes()).await?;
        }
        child.wait().await?;
        Ok(())
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        let mut dir = tokio::fs::read_dir(path).await?;

        while let Some(entry) = dir.next_entry().await? {
            let metadata = entry.metadata().await?;
            let name = entry.file_name().to_string_lossy().to_string();

            entries.push(FileEntry {
                name: name.clone(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                modified: metadata.modified()?.into(),
                permissions: format!("{:o}", metadata.permissions().mode() & 0o777),
            });
        }

        Ok(entries)
    }

    async fn read_file(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = tokio::fs::File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        let mut buffer = vec![0u8; length as usize];
        let n = file.read(&mut buffer).await?;
        buffer.truncate(n);
        Ok(buffer)
    }

    async fn write_file(&self, path: &str, offset: u64, data: &[u8]) -> Result<u32> {
        use tokio::io::{AsyncWriteExt, AsyncSeekExt};
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(path)
            .await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        file.write_all(data).await?;
        Ok(data.len() as u32)
    }

    async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        let output = Command::new("ps")
            .args(["-eo", "pid,ppid,comm,args,user,%cpu,rss,state"])
            .output()
            .await?;

        let mut processes = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 8 {
                processes.push(ProcessInfo {
                    pid: parts[0].parse()?,
                    ppid: parts[1].parse()?,
                    name: parts[2].to_string(),
                    exe: String::new(),
                    cmdline: parts[3..].iter().map(|s| s.to_string()).collect(),
                    username: parts[6].to_string(),
                    cpu_percent: parts[5].parse().unwrap_or(0.0),
                    memory_rss: parts[7].parse::<u64>().unwrap_or(0) * 1024,
                    status: parts[8].to_string(),
                });
            }
        }
        Ok(processes)
    }

    async fn kill_process(&self, pid: u32, signal: i32) -> Result<()> {
        let sig_name = match signal {
            9 => "KILL",
            15 => "TERM",
            2 => "INT",
            _ => "TERM",
        };
        Command::new("kill").args([&format!("-{}", sig_name), &pid.to_string()]).output().await?;
        Ok(())
    }

    async fn list_services(&self) -> Result<Vec<ServiceInfo>> {
        // macOS uses launchd - list with launchctl
        let output = Command::new("launchctl").args(["list"]).output().await?;
        let mut services = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                services.push(ServiceInfo {
                    name: parts[2].to_string(),
                    display_name: parts[2].to_string(),
                    status: if parts[0] != "-" { ServiceStatus::Running } else { ServiceStatus::Stopped },
                    start_type: ServiceStartType::Automatic,
                });
            }
        }
        Ok(services)
    }

    async fn control_service(&self, name: &str, action: ServiceAction) -> Result<()> {
        let action_str = match action {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
            _ => "start",
        };
        Command::new("launchctl").args([action_str, name]).output().await?;
        Ok(())
    }

    async fn spawn_pty(&self, cols: u32, rows: u32, shell: Option<String>) -> Result<PtyHandle> {
        use tokio::process::Command;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let shell = shell.unwrap_or_else(|| "/bin/zsh".to_string());

        let mut child = Command::new(shell)
            .arg("-i")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (stdin_tx, mut stdin_rx) = mpsc::channel(100);
        let (stdout_tx, stdout_rx) = mpsc::channel(100);
        let (stderr_tx, stderr_rx) = mpsc::channel(100);
        let (resize_tx, _resize_rx) = mpsc::channel(10);
        let (close_tx, close_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(data) = stdin_rx.recv().await {
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        let mut stdout = stdout;
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if stdout_tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut stderr = stderr;
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if stderr_tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        tokio::spawn(async move {
            close_rx.await.ok();
            let _ = child.kill().await;
        });

        Ok(PtyHandle {
            stdin_tx,
            stdout_rx,
            stderr_rx,
            resize_tx,
            close_tx: tokio::sync::Mutex::new(Some(close_tx)),
        })
    }

    fn get_machine_id(&self) -> Result<String> {
        // macOS uses IOPlatformUUID
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .await?;

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if line.contains("IOPlatformUUID") {
                if let Some(uuid) = line.split('"').nth(3) {
                    return Ok(uuid.to_string());
                }
            }
        }
        Ok("unknown".to_string())
    }

    fn get_hostname(&self) -> Result<String> {
        Ok(hostname::get()?.to_string_lossy().to_string())
    }
}

impl Default for MacOS {
    fn default() -> Self {
        Self::new()
    }
}

async fn parse_screen_size(data: &[u8]) -> Result<(u32, u32)> {
    // Parse system_profiler JSON output for screen resolution
    // Simplified - in production use proper JSON parsing
    Ok((1920, 1080))
}

fn keycode_to_macos_key(key_code: u32) -> String {
    match key_code {
        0x33 => "delete".to_string(),      // Backspace
        0x30 => "tab".to_string(),
        0x24 => "return".to_string(),
        0x35 => "escape".to_string(),
        0x31 => "space".to_string(),
        0x7B => "left".to_string(),
        0x7C => "right".to_string(),
        0x7D => "down".to_string(),
        0x7E => "up".to_string(),
        0x7A => "f1".to_string(),
        // ... more mappings
        _ if key_code >= 0x00 && key_code <= 0x1F => {
            // Letter keys
            let letters = [
                "a", "s", "d", "f", "h", "g", "z", "x", "c", "v",
                "", "b", "q", "w", "e", "r", "y", "t", "", "o",
                "u", "", "i", "p", "", "l", "j", "'", "k", ";",
                "\\", ",", "/", "n", "m", ".",
            ];
            if key_code < letters.len() as u32 {
                return letters[key_code as usize].to_string();
            }
            format!("0x{:x}", key_code)
        }
        _ => format!("0x{:x}", key_code),
    }
}