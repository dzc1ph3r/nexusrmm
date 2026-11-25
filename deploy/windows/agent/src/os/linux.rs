//! Linux OS implementation using X11, PipeWire, and standard Linux APIs

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use tokio::sync::mpsc;
use tokio::process::Command;

use crate::os::{
    OSInterface, CaptureSession, VideoFrame, VideoFormat, Rect,
    MouseButton, FileEntry, ProcessInfo, ServiceInfo,
    ServiceStatus, ServiceStartType, ServiceAction, PtyHandle,
};

pub struct LinuxOS {
    // PipeWire/X11 capture state
    capture_active: bool,
}

impl LinuxOS {
    pub fn new() -> Self {
        Self {
            capture_active: false,
        }
    }
}

#[async_trait]
impl OSInterface for LinuxOS {
    async fn start_capture(&mut self) -> Result<CaptureSession> {
        // Use PipeWire for screen capture on modern Linux (Wayland/X11)
        // This is a simplified implementation - production would use:
        // - PipeWire via libpipewire for Wayland
        // - X11 XDamage/XShm for X11
        // - DRM/KMS for direct KMS capture

        self.capture_active = true;
        let (tx, rx) = mpsc::channel(10);

        // Get screen dimensions
        let (width, height) = get_screen_size().await?;

        // Spawn capture loop using PipeWire
        tokio::spawn(async move {
            // In production, use:
            // - pipewire crate for Rust bindings
            // - Or shell out to `wf-recorder` / `grim` / `pipewire` CLI
            // For now, simulate frame capture
            loop {
                if !std::sync::atomic::AtomicBool::new(false).load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }

                tokio::time::sleep(std::time::Duration::from_millis(33)).await; // ~30fps

                let frame = VideoFrame {
                    data: vec![],
                    width,
                    height,
                    format: VideoFormat::RGBA,
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
        // Use xdotool or libinput for injection
        let output = Command::new("xdotool")
            .args(["mousemove", &x.to_string(), &y.to_string()])
            .output()
            .await?;

        if !output.status.success() {
            // Fallback: use uinput or libinput directly
            use uinput::UInput;
        }
        Ok(())
    }

    async fn inject_mouse_click(&self, x: i32, y: i32, button: MouseButton, down: bool) -> Result<()> {
        self.inject_mouse_move(x, y).await?;

        let btn = match button {
            MouseButton::Left => 1,
            MouseButton::Right => 3,
            MouseButton::Middle => 2,
            MouseButton::X1 => 8,
            MouseButton::X2 => 9,
        };

        let action = if down { "mousedown" } else { "mouseup" };

        Command::new("xdotool")
            .args([action, &btn.to_string()])
            .output()
            .await?;

        Ok(())
    }

    async fn inject_mouse_wheel(&self, _x: i32, _y: i32, delta_x: i32, delta_y: i32) -> Result<()> {
        // xdotool click 4/5 for vertical, 6/7 for horizontal
        if delta_y > 0 {
            Command::new("xdotool").args(["click", "4"]).output().await?;
        } else if delta_y < 0 {
            Command::new("xdotool").args(["click", "5"]).output().await?;
        }
        if delta_x > 0 {
            Command::new("xdotool").args(["click", "7"]).output().await?;
        } else if delta_x < 0 {
            Command::new("xdotool").args(["click", "6"]).output().await?;
        }
        Ok(())
    }

    async fn inject_key(&self, key_code: u32, down: bool) -> Result<()> {
        // Convert key_code to X11 keysym or use xdotool
        let key_name = keycode_to_keysym(key_code);

        let action = if down { "keydown" } else { "keyup" };

        Command::new("xdotool")
            .args([action, &key_name])
            .output()
            .await?;
        Ok(())
    }

    async fn inject_text(&self, text: &str) -> Result<()> {
        Command::new("xdotool")
            .args(["type", "--clearmodifiers", text])
            .output()
            .await?;
        Ok(())
    }

    async fn get_clipboard(&self) -> Result<String> {
        // Try wayland clipboard first, then X11
        let output = Command::new("wl-paste")
            .output()
            .await;

        if let Ok(out) = output {
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).to_string());
            }
        }

        // Fallback to X11
        let output = Command::new("xclip")
            .args(["-o", "-selection", "clipboard"])
            .output()
            .await?;

        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    async fn set_clipboard(&self, text: &str) -> Result<()> {
        // Try wayland first
        let mut child = Command::new("wl-copy")
            .stdin(std::process::Stdio::piped())
            .spawn()?;

        if let Some(stdin) = child.stdin.as_mut() {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(text.as_bytes()).await?;
        }

        let result = child.wait().await;

        if result.is_err() || !result.unwrap().success() {
            // Fallback to X11
            Command::new("xclip")
                .args(["-i", "-selection", "clipboard"])
                .stdin(std::process::Stdio::piped())
                .spawn()?
                .stdin
                .as_mut()
                .unwrap()
                .write_all(text.as_bytes())
                .await?;
        }

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
        let mut processes = Vec::new();

        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();

            if let Ok(pid) = name.parse::<u32>() {
                if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", pid)) {
                    let fields: Vec<&str> = stat.split_whitespace().collect();
                    if fields.len() > 22 {
                        let ppid = fields[3].parse::<u32>().unwrap_or(0);
                        let comm = fields[1].trim_matches(|c| c == '(' || c == ')').to_string();

                        // Get memory info
                        let mut memory_rss = 0u64;
                        if let Ok(status) = std::fs::read_to_string(format!("/proc/{}/status", pid)) {
                            for line in status.lines() {
                                if line.starts_with("VmRSS:") {
                                    memory_rss = line.split_whitespace().nth(1).unwrap_or("0").parse::<u64>().unwrap_or(0) * 1024;
                                    break;
                                }
                            }
                        }

                        processes.push(ProcessInfo {
                            pid,
                            ppid,
                            name: comm,
                            exe: std::fs::read_link(format!("/proc/{}/exe", pid))
                                .ok()
                                .and_then(|p| p.to_str().map(|s| s.to_string()))
                                .unwrap_or_default(),
                            cmdline: std::fs::read_to_string(format!("/proc/{}/cmdline", pid))
                                .ok()
                                .map(|s| s.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
                                .unwrap_or_default(),
                            username: get_process_user(pid).await.unwrap_or_default(),
                            cpu_percent: 0.0, // Would need sampling
                            memory_rss,
                            status: fields[2].to_string(),
                        });
                    }
                }
            }
        }

        Ok(processes)
    }

    async fn kill_process(&self, pid: u32, signal: i32) -> Result<()> {
        signal::kill(Pid::from_raw(pid as i32), Signal::try_from(signal).unwrap_or(Signal::SIGTERM))?;
        Ok(())
    }

    async fn list_services(&self) -> Result<Vec<ServiceInfo>> {
        // Parse systemctl output
        let output = Command::new("systemctl")
            .args(["list-units", "--type=service", "--no-legend", "--no-pager"])
            .output()
            .await?;

        let mut services = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                services.push(ServiceInfo {
                    name: parts[0].to_string(),
                    display_name: parts[0].to_string(),
                    status: match parts[2] {
                        "active" => ServiceStatus::Running,
                        "inactive" => ServiceStatus::Stopped,
                        "activating" => ServiceStatus::StartPending,
                        "deactivating" => ServiceStatus::StopPending,
                        _ => ServiceStatus::Stopped,
                    },
                    start_type: ServiceStartType::Manual, // Would need systemctl is-enabled
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
            ServiceAction::Pause => "pause",
            ServiceAction::Continue => "continue",
        };

        Command::new("systemctl")
            .args([action_str, name])
            .output()
            .await?;
        Ok(())
    }

    async fn spawn_pty(&self, cols: u32, rows: u32, shell: Option<String>) -> Result<PtyHandle> {
        use tokio::process::Command;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let shell = shell.unwrap_or_else(|| "/bin/bash".to_string());

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

        // Stdin writer
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(data) = stdin_rx.recv().await {
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        // Stdout reader
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

        // Stderr reader
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

        // Close handler
        tokio::spawn(async move {
            close_rx.await.ok();
            let _ = child.kill().await;
        });

        Ok(PtyHandle {
            stdin_tx,
            stdout_rx,
            stderr_rx,
            resize_tx,
            close_tx,
        })
    }

    fn get_machine_id(&self) -> Result<String> {
        std::fs::read_to_string("/etc/machine-id")
            .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
            .map(|s| s.trim().to_string())
            .context("Failed to read machine-id")
    }

    fn get_hostname(&self) -> Result<String> {
        Ok(hostname::get()?.to_string_lossy().to_string())
    }
}

impl Default for LinuxOS {
    fn default() -> Self {
        Self::new()
    }
}

async fn get_screen_size() -> Result<(u32, u32)> {
    // Try X11 first
    let output = Command::new("xrandr")
        .args(["--current"])
        .output()
        .await?;

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.contains(" connected primary") || line.contains(" connected ") {
            if let Some(res) = line.split_whitespace().nth(3) {
                if let Some((w, h)) = res.split_once('x') {
                    return Ok((w.parse()?, h.split('+').next().unwrap().parse()?));
                }
            }
        }
    }

    // Fallback
    Ok((1920, 1080))
}

fn keycode_to_keysym(key_code: u32) -> String {
    // Map common key codes to xdotool key names
    match key_code {
        0x08 => "BackSpace".to_string(),
        0x09 => "Tab".to_string(),
        0x0D => "Return".to_string(),
        0x1B => "Escape".to_string(),
        0x20 => "space".to_string(),
        0x25 => "Left".to_string(),
        0x26 => "Up".to_string(),
        0x27 => "Right".to_string(),
        0x28 => "Down".to_string(),
        0x70..=0x87 => format!("F{}", key_code - 0x70 + 1),
        _ if key_code >= 0x41 && key_code <= 0x5A => {
            // A-Z
            char::from_u32(key_code).unwrap().to_lowercase().to_string()
        }
        _ if key_code >= 0x30 && key_code <= 0x39 => {
            // 0-9
            char::from_u32(key_code).unwrap().to_string()
        }
        _ => format!("0x{:x}", key_code),
    }
}

async fn get_process_user(pid: u32) -> Result<String> {
    let output = Command::new("ps")
        .args(["-o", "user=", "-p", &pid.to_string()])
        .output()
        .await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}