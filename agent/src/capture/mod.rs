//! Screen capture pipeline with dirty-rectangle detection and encoding

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::os::{OSInterface, CaptureSession, VideoFrame, VideoFormat, Rect};

#[derive(Debug, Clone)]
pub struct CaptureConfig {
    pub target_fps: u32,
    pub max_bitrate_kbps: u32,
    pub codec: VideoCodec,
    pub quality: u8, // 1-100
    pub enable_dirty_rects: bool,
    pub keyframe_interval_sec: u32,
}

#[derive(Debug, Clone, Copy)]
pub enum VideoCodec {
    H264,
    VP8,
    VP9,
    WebP,
    AV1,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            target_fps: 30,
            max_bitrate_kbps: 2000,
            codec: VideoCodec::H264,
            quality: 75,
            enable_dirty_rects: true,
            keyframe_interval_sec: 2,
        }
    }
}

pub struct CapturePipeline {
    config: CaptureConfig,
    session: Option<CaptureSession>,
    frame_tx: Option<mpsc::Sender<EncodedFrame>>,
    last_frame: Option<Vec<u8>>,
    last_keyframe: Instant,
    frame_count: u64,
}

#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub is_keyframe: bool,
    pub codec: VideoCodec,
    pub timestamp: Instant,
    pub dirty_rects: Vec<Rect>,
    pub sequence: u64,
}

impl CapturePipeline {
    pub fn new(config: CaptureConfig) -> Self {
        Self {
            config,
            session: None,
            frame_tx: None,
            last_frame: None,
            last_keyframe: Instant::now(),
            frame_count: 0,
        }
    }

    pub async fn start(&mut self, os: Arc<dyn OSInterface>, frame_tx: mpsc::Sender<EncodedFrame>) -> Result<()> {
        let session = os.start_capture().await?;
        self.session = Some(session);
        self.frame_tx = Some(frame_tx);

        info!("Capture pipeline started: {}x{} @ {}fps",
            self.session.as_ref().unwrap().width,
            self.session.as_ref().unwrap().height,
            self.config.target_fps);

        self.run_capture_loop().await
    }

    pub async fn stop(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            // Stop the capture session
            // The session will be dropped, closing the channel
        }

        if let Some(os) = self.get_os() {
            os.stop_capture().await?;
        }

        info!("Capture pipeline stopped");
        Ok(())
    }

    fn get_os(&self) -> Option<Arc<dyn OSInterface>> {
        None // Would be passed in or stored
    }

    async fn run_capture_loop(&mut self) -> Result<()> {
        let session = self.session.as_mut().unwrap();
        let frame_tx = self.frame_tx.as_ref().unwrap();
        let frame_interval = Duration::from_millis(1000 / self.config.target_fps as u64);

        let mut frame_rx = std::mem::take(&mut session.frame_rx);

        while let Some(raw_frame) = frame_rx.recv().await {
            let start = Instant::now();

            // Detect dirty rectangles
            let dirty_rects = if self.config.enable_dirty_rects {
                self.detect_dirty_rects(&raw_frame).await
            } else {
                vec![Rect { x: 0, y: 0, width: raw_frame.width, height: raw_frame.height }]
            };

            // Determine if keyframe needed
            let force_keyframe = self.last_frame.is_none()
                || self.last_keyframe.elapsed() >= Duration::from_secs(self.config.keyframe_interval_sec as u64)
                || dirty_rects.is_empty();

            // Encode frame
            let encoded = self.encode_frame(&raw_frame, dirty_rects, force_keyframe).await?;

            // Send encoded frame
            if frame_tx.send(encoded).await.is_err() {
                break;
            }

            self.frame_count += 1;
            if force_keyframe {
                self.last_keyframe = Instant::now();
            }

            // Throttle to target FPS
            let elapsed = start.elapsed();
            if elapsed < frame_interval {
                tokio::time::sleep(frame_interval - elapsed).await;
            }
        }

        Ok(())
    }

    async fn detect_dirty_rects(&mut self, current: &VideoFrame) -> Vec<Rect> {
        let mut rects = Vec::new();

        if let Some(last) = &self.last_frame {
            // Simple diff detection - in production use more sophisticated algorithm
            // This is a placeholder - real implementation would compare pixel data
            if current.data.len() == last.len() {
                // Find differing regions
                // For now, return full frame
                rects.push(Rect { x: 0, y: 0, width: current.width, height: current.height });
            }
        } else {
            // First frame - full frame is dirty
            rects.push(Rect { x: 0, y: 0, width: current.width, height: current.height });
        }

        self.last_frame = Some(current.data.clone());
        rects
    }

    async fn encode_frame(&self, frame: &VideoFrame, dirty_rects: Vec<Rect>, force_keyframe: bool) -> Result<EncodedFrame> {
        // In production, use hardware encoding:
        // - Windows: NVENC/QuickSync via Media Foundation
        // - Linux: VAAPI/nvencode
        // - macOS: VideoToolbox
        // For now, return raw frame data as "encoded"

        Ok(EncodedFrame {
            data: frame.data.clone(),
            width: frame.width,
            height: frame.height,
            is_keyframe: force_keyframe,
            codec: self.config.codec,
            timestamp: Instant::now(),
            dirty_rects,
            sequence: self.frame_count,
        })
    }
}

// Hardware encoder trait for platform-specific implementations
#[async_trait]
pub trait HardwareEncoder: Send + Sync {
    async fn encode(&mut self, frame: &VideoFrame, force_keyframe: bool) -> Result<Vec<u8>>;
    async fn flush(&mut self) -> Result<Vec<u8>>;
    fn config(&self) -> &CaptureConfig;
}

// Software fallback encoder
pub struct SoftwareEncoder {
    config: CaptureConfig,
}

impl SoftwareEncoder {
    pub fn new(config: CaptureConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl HardwareEncoder for SoftwareEncoder {
    async fn encode(&mut self, frame: &VideoFrame, force_keyframe: bool) -> Result<Vec<u8>> {
        // Simple WebP encoding as fallback
        // Real implementation would use image crate with WebP encoder
        Ok(frame.data.clone())
    }

    async fn flush(&mut self) -> Result<Vec<u8>> {
        Ok(vec![])
    }

    fn config(&self) -> &CaptureConfig {
        &self.config
    }
}