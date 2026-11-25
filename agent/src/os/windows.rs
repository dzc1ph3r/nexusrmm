//! Windows OS implementation using Win32 APIs

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use tokio::sync::mpsc;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::Registry::*;
use windows::Win32::Storage::FileSystem::*;

use crate::os::{
    OSInterface, CaptureSession, VideoFrame, VideoFormat, Rect,
    MouseButton, FileEntry, ProcessInfo, ServiceInfo,
    ServiceStatus, ServiceStartType, ServiceAction, PtyHandle,
};

pub struct WindowsOS {
    // DXGI Desktop Duplication resources
    duplication: Option<IDXGIOutputDuplication>,
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
}

impl WindowsOS {
    pub fn new() -> Self {
        Self {
            duplication: None,
            device: None,
            context: None,
        }
    }

    fn init_dxgi(&mut self) -> Result<()> {
        // Create D3D11 device
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut feature_level = D3D_FEATURE_LEVEL_11_0;

        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )?;
        }

        self.device = device;
        self.context = context;

        // Get DXGI output for desktop duplication
        let device = self.device.as_ref().unwrap();
        let dxgi_device: IDXGIDevice = device.cast()?;
        let dxgi_adapter = dxgi_device.GetAdapter()?;
        let dxgi_output = dxgi_adapter.EnumOutputs(0)?;

        let duplication = unsafe {
            dxgi_output.DuplicateOutput(device)?
        };

        self.duplication = Some(duplication);
        Ok(())
    }
}

#[async_trait]
impl OSInterface for WindowsOS {
    async fn start_capture(&mut self) -> Result<CaptureSession> {
        self.init_dxgi()?;

        let duplication = self.duplication.as_ref().unwrap().clone();
        let (tx, rx) = mpsc::channel(10);

        // Get desktop dimensions
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) } as u32;
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) } as u32;

        // Spawn capture loop
        tokio::spawn(async move {
            loop {
                // Acquire next frame
                let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;

                let hr = unsafe {
                    duplication.AcquireNextFrame(
                        5000, // 5 second timeout
                        &mut frame_info,
                        &mut resource,
                    )
                };

                if hr.is_ok() {
                    if let Some(resource) = resource {
                        // Process frame (convert to RGBA)
                        let texture: ID3D11Texture2D = resource.cast().unwrap();
                        // TODO: Copy texture to staging, map, convert to RGBA

                        let frame = VideoFrame {
                            data: vec![], // Filled after conversion
                            width,
                            height,
                            format: VideoFormat::BGRA,
                            timestamp: std::time::SystemTime::now(),
                            dirty_rects: vec![],
                        };

                        if tx.send(frame).await.is_err() {
                            break;
                        }

                        // Release frame
                        unsafe {
                            duplication.ReleaseFrame().ok();
                        }
                    }
                } else if hr == DXGI_ERROR_WAIT_TIMEOUT {
                    continue;
                } else {
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
        self.duplication = None;
        self.device = None;
        self.context = None;
        Ok(())
    }

    async fn inject_mouse_move(&self, x: i32, y: i32) -> Result<()> {
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };

        let abs_x = (x as f32 / width as f32 * 65535.0) as i32;
        let abs_y = (y as f32 / height as f32 * 65535.0) as i32;

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: abs_x,
                    dy: abs_y,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    async fn inject_mouse_click(&self, x: i32, y: i32, button: MouseButton, down: bool) -> Result<()> {
        self.inject_mouse_move(x, y).await?;

        let (down_flag, up_flag) = match button {
            MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            MouseButton::X1 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
            MouseButton::X2 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
        };

        let flag = if down { down_flag } else { up_flag };

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: if button == MouseButton::X1 { 1 } else if button == MouseButton::X2 { 2 } else { 0 },
                    dwFlags: flag | MOUSEEVENTF_ABSOLUTE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    async fn inject_mouse_wheel(&self, _x: i32, _y: i32, delta_x: i32, delta_y: i32) -> Result<()> {
        let mut inputs = Vec::new();

        if delta_y != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: delta_y as u32,
                        dwFlags: MOUSEEVENTF_WHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        if delta_x != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: delta_x as u32,
                        dwFlags: MOUSEEVENTF_HWHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    async fn inject_key(&self, key_code: u32, down: bool) -> Result<()> {
        let flag = if down { 0 } else { KEYEVENTF_KEYUP };

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key_code as u16,
                    wScan: 0,
                    dwFlags: flag,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    async fn inject_text(&self, text: &str) -> Result<()> {
        for ch in text.chars() {
            // Use SendInput with Unicode flag
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: ch as u16,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            unsafe {
                SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            }

            // Key up
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: ch as u16,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            unsafe {
                SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            }
        }
        Ok(())
    }

    async fn get_clipboard(&self) -> Result<String> {
        unsafe {
            if OpenClipboard(HWND::default()).is_err() {
                return Ok(String::new());
            }

            let result = if IsClipboardFormatAvailable(CF_UNICODETEXT).as_bool() {
                let handle = GetClipboardData(CF_UNICODETEXT);
                if handle.0.is_null() {
                    String::new()
                } else {
                    let ptr = GlobalLock(handle) as *const u16;
                    let len = (GlobalSize(handle) / 2) as usize;
                    let slice = std::slice::from_raw_parts(ptr, len);
                    String::from_utf16_lossy(slice)
                }
            } else {
                String::new()
            };

            CloseClipboard().ok();
            GlobalUnlock(handle).ok();
            Ok(result)
        }
    }

    async fn set_clipboard(&self, text: &str) -> Result<()> {
        unsafe {
            if OpenClipboard(HWND::default()).is_err() {
                return Ok(());
            }

            EmptyClipboard().ok();

            let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let size = wide.len() * 2;
            let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_DDESHARE, size);
            let ptr = GlobalLock(handle) as *mut u16;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            GlobalUnlock(handle).ok();
            SetClipboardData(CF_UNICODETEXT, HANDLE(handle)).ok();

            CloseClipboard().ok();
        }
        Ok(())
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        let search_path = format!("{}/*", path);

        let wide: Vec<u16> = search_path.encode_utf16().chain(Some(0)).collect();

        let mut find_data: WIN32_FIND_DATAW = Default::default();
        let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut find_data) };

        if handle != INVALID_HANDLE_VALUE {
            loop {
                let name = String::from_utf16_lossy(&find_data.cFileName)
                    .trim_end_matches('\0')
                    .to_string();

                if name != "." && name != ".." {
                    let full_path = PathBuf::from(path).join(&name);
                    let is_dir = (find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0;

                    let size = ((find_data.nFileSizeHigh as u64) << 32) | find_data.nFileSizeLow as u64;

                    entries.push(FileEntry {
                        name,
                        path: full_path.to_string_lossy().to_string(),
                        is_dir,
                        size,
                        modified: std::time::SystemTime::now(), // TODO: Convert FILETIME
                        permissions: String::new(),
                    });
                }

                if unsafe { FindNextFileW(handle, &mut find_data) }.is_err() {
                    break;
                }
            }
            unsafe { FindClose(handle).ok(); }
        }

        Ok(entries)
    }

    async fn read_file(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>> {
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ.0,
                FILE_SHARE_READ,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )?
        };

        let mut buffer = vec![0u8; length as usize];
        let mut bytes_read = 0u32;

        // Set file pointer
        let mut offset_high = (offset >> 32) as u32;
        let offset_low = offset as u32;
        unsafe {
            SetFilePointer(handle, offset_low, Some(&mut offset_high), FILE_BEGIN);
            ReadFile(handle, Some(&mut buffer), Some(&mut bytes_read), None)?;
        }

        unsafe { CloseHandle(handle).ok(); }
        buffer.truncate(bytes_read as usize);
        Ok(buffer)
    }

    async fn write_file(&self, path: &str, offset: u64, data: &[u8]) -> Result<u32> {
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_WRITE.0,
                FILE_SHARE_READ,
                None,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )?
        };

        let mut offset_high = (offset >> 32) as u32;
        let offset_low = offset as u32;
        unsafe {
            SetFilePointer(handle, offset_low, Some(&mut offset_high), FILE_BEGIN);
        }

        let mut bytes_written = 0u32;
        unsafe {
            WriteFile(handle, Some(data), Some(&mut bytes_written), None)?;
        }

        unsafe { CloseHandle(handle).ok(); }
        Ok(bytes_written)
    }

    async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        // Use Windows API to enumerate processes
        // This is a simplified version - real implementation would use ToolHelp32Snapshot
        Ok(vec![])
    }

    async fn kill_process(&self, pid: u32, signal: i32) -> Result<()> {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid)? };
        unsafe { TerminateProcess(handle, signal as u32).ok(); }
        unsafe { CloseHandle(handle).ok(); }
        Ok(())
    }

    async fn list_services(&self) -> Result<Vec<ServiceInfo>> {
        // Use Windows Service Control Manager
        Ok(vec![])
    }

    async fn control_service(&self, _name: &str, _action: ServiceAction) -> Result<()> {
        Ok(())
    }

    async fn spawn_pty(&self, _cols: u32, _rows: u32, _shell: Option<String>) -> Result<PtyHandle> {
        // Use ConPTY on Windows 10+
        Ok(PtyHandle {
            stdin_tx: tokio::sync::mpsc::channel(100).0,
            stdout_rx: tokio::sync::mpsc::channel(100).1,
            stderr_rx: tokio::sync::mpsc::channel(100).1,
            resize_tx: tokio::sync::mpsc::channel(10).0,
            close_tx: tokio::sync::oneshot::channel().0,
        })
    }

    fn get_machine_id(&self) -> Result<String> {
        let wide_key: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography".encode_utf16().chain(Some(0)).collect();
        let wide_value: Vec<u16> = "MachineGuid".encode_utf16().chain(Some(0)).collect();

        let mut key = HKEY::default();
        let result = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                wide_key.as_ptr(),
                0,
                KEY_READ,
                &mut key,
            )
        };

        if result == ERROR_SUCCESS {
            let mut buffer = [0u16; 256];
            let mut size = (buffer.len() * 2) as u32;
            let result = unsafe {
                RegGetValueW(
                    key,
                    None,
                    wide_value.as_ptr(),
                    RRF_RT_REG_SZ,
                    None,
                    buffer.as_mut_ptr() as *mut _,
                    &mut size,
                )
            };
            unsafe { RegCloseKey(key).ok(); }

            if result == ERROR_SUCCESS {
                let guid = String::from_utf16_lossy(&buffer[..(size as usize / 2)]);
                return Ok(guid.trim_end_matches('\0').to_string());
            }
        }

        Ok("unknown".to_string())
    }

    fn get_hostname(&self) -> Result<String> {
        Ok(hostname::get()?.to_string_lossy().to_string())
    }
}

impl Default for WindowsOS {
    fn default() -> Self {
        Self::new()
    }
}