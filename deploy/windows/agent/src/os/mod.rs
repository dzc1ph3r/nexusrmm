//! Platform-specific OS abstractions for screen capture, input injection, etc.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

pub use crate::os::windows::WindowsOS;
pub use crate::os::linux::LinuxOS;
pub use crate::os::macos::MacOS;

use anyhow::Result;
use async_trait::async_trait;

#[async_trait]
pub trait OSInterface: Send + Sync {
    // Screen capture
    async fn start_capture(&mut self) -> Result<CaptureSession>;
    async fn stop_capture(&mut self) -> Result<()>;

    // Input injection
    async fn inject_mouse_move(&self, x: i32, y: i32) -> Result<()>;
    async fn inject_mouse_click(&self, x: i32, y: i32, button: MouseButton, down: bool) -> Result<()>;
    async fn inject_mouse_wheel(&self, x: i32, y: i32, delta_x: i32, delta_y: i32) -> Result<()>;
    async fn inject_key(&self, key_code: u32, down: bool) -> Result<()>;
    async fn inject_text(&self, text: &str) -> Result<()>;

    // Clipboard
    async fn get_clipboard(&self) -> Result<String>;
    async fn set_clipboard(&self, text: &str) -> Result<()>;

    // File system
    async fn list_files(&self, path: &str) -> Result<Vec<FileEntry>>;
    async fn read_file(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>>;
    async fn write_file(&self, path: &str, offset: u64, data: &[u8]) -> Result<u32>;

    // Process management
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>>;
    async fn kill_process(&self, pid: u32, signal: i32) -> Result<()>;

    // Service management
    async fn list_services(&self) -> Result<Vec<ServiceInfo>>;
    async fn control_service(&self, name: &str, action: ServiceAction) -> Result<()>;

    // Shell/PTY
    async fn spawn_pty(&self, cols: u32, rows: u32, shell: Option<String>) -> Result<PtyHandle>;

    // System info
    fn get_machine_id(&self) -> Result<String>;
    fn get_hostname(&self) -> Result<String>;
}

pub struct CaptureSession {
    pub width: u32,
    pub height: u32,
    pub frame_rx: tokio::sync::mpsc::Receiver<VideoFrame>,
}

pub struct VideoFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: VideoFormat,
    pub timestamp: std::time::SystemTime,
    pub dirty_rects: Vec<Rect>,
}

pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy)]
pub enum VideoFormat {
    RGBA,
    BGRA,
    NV12,
    YUY2,
}

#[derive(Debug, Clone, Copy)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: std::time::SystemTime,
    pub permissions: String,
}

#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub exe: String,
    pub cmdline: Vec<String>,
    pub username: String,
    pub cpu_percent: f32,
    pub memory_rss: u64,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct ServiceInfo {
    pub name: String,
    pub display_name: String,
    pub status: ServiceStatus,
    pub start_type: ServiceStartType,
}

#[derive(Debug, Clone, Copy)]
pub enum ServiceStatus {
    Stopped,
    Running,
    Paused,
    StartPending,
    StopPending,
}

#[derive(Debug, Clone, Copy)]
pub enum ServiceStartType {
    Automatic,
    Manual,
    Disabled,
}

#[derive(Debug, Clone, Copy)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Pause,
    Continue,
}

pub struct PtyHandle {
    pub stdin_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub stdout_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    pub stderr_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    pub resize_tx: tokio::sync::mpsc::Sender<(u32, u32)>,
    pub close_tx: tokio::sync::oneshot::Sender<()>,
}

// Factory function
pub fn create_os_interface() -> Box<dyn OSInterface> {
    #[cfg(target_os = "windows")]
    return Box::new(WindowsOS::new());

    #[cfg(target_os = "linux")]
    return Box::new(LinuxOS::new());

    #[cfg(target_os = "macos")]
    return Box::new(MacOS::new());

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    compile_error!("Unsupported platform");
}