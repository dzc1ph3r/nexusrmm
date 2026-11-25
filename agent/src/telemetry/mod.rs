//! Telemetry collection for system metrics and inventory

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use prost::Message;
use sysinfo::System;
use tokio::sync::Mutex;
use tokio::time::interval;
use tracing::{debug, info, warn};

use crate::proto::rmm::v1::{Telemetry, DiskInfo, NetworkInfo, Inventory, HardwareInfo, OsInfo, PackageInfo, UserInfo};
use crate::transport::{Transport, FrameType, Frame};

pub struct TelemetryCollector {
    config: TelemetryConfig,
    system: Arc<Mutex<System>>,
}

#[derive(Debug, Clone)]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub include_processes: bool,
    pub include_network: bool,
    pub include_disks: bool,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            include_processes: true,
            include_network: true,
            include_disks: true,
        }
    }
}

impl TelemetryCollector {
    pub fn new(config: TelemetryConfig) -> Self {
        let mut system = System::new_all();
        system.refresh_all();

        Self {
            config,
            system: Arc::new(tokio::sync::Mutex::new(system)),
        }
    }

    pub async fn collect(&self) -> Result<Telemetry> {
        let mut system = self.system.lock().await;
        system.refresh_cpu_all();
        system.refresh_memory();

        if self.config.include_disks {
            system.refresh_disks();
        }
        if self.config.include_network {
            system.refresh_networks();
        }

        let cpu_percent = system.global_cpu_usage();
        let memory_total = system.total_memory();
        let memory_used = system.used_memory();
        let memory_available = memory_total - memory_used;

        let disks = if self.config.include_disks {
            system.disks().iter().map(|disk| DiskInfo {
                device: disk.name().to_string_lossy().to_string(),
                mount_point: disk.mount_point().to_string_lossy().to_string(),
                fstype: disk.file_system().to_string_lossy().to_string(),
                total: disk.total_space() as i64,
                used: (disk.total_space() - disk.available_space()) as i64,
                free: disk.available_space() as i64,
            }).collect()
        } else {
            vec![]
        };

        let networks = if self.config.include_network {
            system.networks().iter().map(|(name, data)| NetworkInfo {
                interface_name: name.to_string(),
                ipv4: String::new(), // Would need additional parsing
                ipv6: String::new(),
                bytes_sent: data.transmitted() as i64,
                bytes_recv: data.received() as i64,
                packets_sent: data.packets_transmitted() as i64,
                packets_recv: data.packets_received() as i64,
                is_up: true,
            }).collect()
        } else {
            vec![]
        };

        let (load_1, load_5, load_15) = system.load_average();

        Ok(Telemetry {
            cpu_percent: cpu_percent as f32,
            memory_total: memory_total as i64,
            memory_used: memory_used as i64,
            memory_available: memory_available as i64,
            disks,
            networks,
            load_avg_1m: load_1 as f32,
            load_avg_5m: load_5 as f32,
            load_avg_15m: load_15 as f32,
            uptime_seconds: System::uptime() as i64,
            process_count: system.processes().len() as i32,
            thread_count: 0, // Would need to sum threads
            custom: HashMap::new(),
        })
    }

    pub async fn collect_inventory(&self) -> Result<Inventory> {
        let system = self.system.lock().await;

        let hardware = HardwareInfo {
            manufacturer: String::new(), // Would need platform-specific code
            model: String::new(),
            serial: String::new(),
            cpu_vendor: system.cpus().first().map(|c| c.vendor_id().to_string()).unwrap_or_default(),
            cpu_model: system.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
            cpu_cores: system.physical_core_count().unwrap_or(0) as i32,
            cpu_threads: system.cpus().len() as i32,
            memory_total: system.total_memory() as i64,
            disks: vec![],
            networks: vec![],
            gpu_info: String::new(),
            virtualization: false,
            chassis_type: String::new(),
        };

        let os = OsInfo {
            name: std::env::consts::OS.to_string(),
            version: String::new(),
            build: String::new(),
            arch: std::env::consts::ARCH.to_string(),
            kernel_version: String::new(),
            is_container: false,
        };

        Ok(Inventory {
            agent_id: String::new(), // Filled by caller
            hardware: Some(hardware),
            os: Some(os),
            packages: vec![],
            users: vec![],
            collected_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        })
    }

    pub async fn start_loop(
        &self,
        transport: Transport,
        interval_duration: Duration,
    ) -> Result<tokio::task::JoinHandle<()>> {
        let collector = self.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = interval(interval_duration);
            loop {
                ticker.tick().await;

                match collector.collect().await {
                    Ok(telemetry) => {
                        if let Err(e) = transport.send_notification(FrameType::Telemetry, telemetry.encode_to_vec()).await {
                            warn!("Failed to send telemetry: {}", e);
                        }
                    }
                    Err(e) => {
                        warn!("Telemetry collection failed: {}", e);
                    }
                }
            }
        });
        Ok(handle)
    }

    pub async fn start_inventory_loop(
        &self,
        transport: Transport,
        interval_duration: Duration,
    ) -> Result<tokio::task::JoinHandle<()>> {
        let collector = self.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = interval(interval_duration);
            loop {
                ticker.tick().await;

                match collector.collect_inventory().await {
                    Ok(inventory) => {
                        if let Err(e) = transport.send_notification(FrameType::Inventory, inventory.encode_to_vec()).await {
                            warn!("Failed to send inventory: {}", e);
                        }
                    }
                    Err(e) => {
                        warn!("Inventory collection failed: {}", e);
                    }
                }
            }
        });
        Ok(handle)
    }
}

impl Clone for TelemetryCollector {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            system: self.system.clone(),
        }
    }
}