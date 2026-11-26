//! Input injection handling with coordinate transformation and event batching

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{debug, info};

use crate::os::{OSInterface, MouseButton};

#[derive(Debug, Clone)]
pub struct InputConfig {
    pub batch_interval_ms: u64,
    pub max_batch_size: usize,
    pub coordinate_scale: f32, // For high-DPI displays
}

impl Default for InputConfig {
    fn default() -> Self {
        Self {
            batch_interval_ms: 5,
            max_batch_size: 50,
            coordinate_scale: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum InputEvent {
    MouseMove { x: i32, y: i32 },
    MouseDown { x: i32, y: i32, button: MouseButton },
    MouseUp { x: i32, y: i32, button: MouseButton },
    MouseWheel { x: i32, y: i32, delta_x: i32, delta_y: i32 },
    KeyDown { key_code: u32 },
    KeyUp { key_code: u32 },
    Text { text: String },
    Clipboard { text: String },
}

pub struct InputManager {
    config: InputConfig,
    os: Arc<dyn OSInterface>,
    event_queue: VecDeque<InputEvent>,
    last_flush: Instant,
    mouse_position: (i32, i32),
}

impl InputManager {
    pub fn new(os: Arc<dyn OSInterface>, config: InputConfig) -> Self {
        Self {
            config,
            os,
            event_queue: VecDeque::new(),
            last_flush: Instant::now(),
            mouse_position: (0, 0),
        }
    }

    pub fn push_event(&mut self, event: InputEvent) {
        // Update mouse position for move events before moving
        if let InputEvent::MouseMove { x, y } = &event {
            self.mouse_position = (*x, *y);
        }

        self.event_queue.push_back(event);

        // Flush if batch is full or interval elapsed
        if self.event_queue.len() >= self.config.max_batch_size
            || self.last_flush.elapsed() >= Duration::from_millis(self.config.batch_interval_ms) {
            self.flush().ok();
        }
    }

    pub fn flush(&mut self) -> Result<()> {
        let events: Vec<InputEvent> = self.event_queue.drain(..).collect();

        for event in events {
            self.process_event(event)?;
        }

        self.last_flush = Instant::now();
        Ok(())
    }

    fn process_event(&self, event: InputEvent) -> Result<()> {
        match event {
            InputEvent::MouseMove { x, y } => {
                let scaled_x = (x as f32 * self.config.coordinate_scale) as i32;
                let scaled_y = (y as f32 * self.config.coordinate_scale) as i32;
                // Fire and forget - don't block on injection
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_mouse_move(scaled_x, scaled_y).await {
                        debug!("Mouse move injection failed: {}", e);
                    }
                });
            }
            InputEvent::MouseDown { x, y, button } => {
                let scaled_x = (x as f32 * self.config.coordinate_scale) as i32;
                let scaled_y = (y as f32 * self.config.coordinate_scale) as i32;
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_mouse_click(scaled_x, scaled_y, button, true).await {
                        debug!("Mouse down injection failed: {}", e);
                    }
                });
            }
            InputEvent::MouseUp { x, y, button } => {
                let scaled_x = (x as f32 * self.config.coordinate_scale) as i32;
                let scaled_y = (y as f32 * self.config.coordinate_scale) as i32;
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_mouse_click(scaled_x, scaled_y, button, false).await {
                        debug!("Mouse up injection failed: {}", e);
                    }
                });
            }
            InputEvent::MouseWheel { x, y, delta_x, delta_y } => {
                let scaled_x = (x as f32 * self.config.coordinate_scale) as i32;
                let scaled_y = (y as f32 * self.config.coordinate_scale) as i32;
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_mouse_wheel(scaled_x, scaled_y, delta_x, delta_y).await {
                        debug!("Mouse wheel injection failed: {}", e);
                    }
                });
            }
            InputEvent::KeyDown { key_code } => {
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_key(key_code, true).await {
                        debug!("Key down injection failed: {}", e);
                    }
                });
            }
            InputEvent::KeyUp { key_code } => {
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_key(key_code, false).await {
                        debug!("Key up injection failed: {}", e);
                    }
                });
            }
            InputEvent::Text { text } => {
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.inject_text(&text).await {
                        debug!("Text injection failed: {}", e);
                    }
                });
            }
            InputEvent::Clipboard { text } => {
                let os = self.os.clone();
                tokio::spawn(async move {
                    if let Err(e) = os.set_clipboard(&text).await {
                        debug!("Clipboard set failed: {}", e);
                    }
                });
            }
        }
        Ok(())
    }

    pub fn get_mouse_position(&self) -> (i32, i32) {
        self.mouse_position
    }

    pub fn set_coordinate_scale(&mut self, scale: f32) {
        self.config.coordinate_scale = scale;
    }
}

// High-level input API for session handling
pub struct SessionInputHandler {
    manager: InputManager,
    display_bounds: (u32, u32), // width, height
}

impl SessionInputHandler {
    pub fn new(os: Arc<dyn OSInterface>, config: InputConfig, display_bounds: (u32, u32)) -> Self {
        Self {
            manager: InputManager::new(os, config),
            display_bounds,
        }
    }

    pub fn handle_mouse_move(&mut self, x: f32, y: f32) {
        // Convert normalized coordinates (0-1) to screen coordinates
        let screen_x = (x * self.display_bounds.0 as f32) as i32;
        let screen_y = (y * self.display_bounds.1 as f32) as i32;
        self.manager.push_event(InputEvent::MouseMove { x: screen_x, y: screen_y });
    }

    pub fn handle_mouse_down(&mut self, x: f32, y: f32, button: MouseButton) {
        let screen_x = (x * self.display_bounds.0 as f32) as i32;
        let screen_y = (y * self.display_bounds.1 as f32) as i32;
        self.manager.push_event(InputEvent::MouseDown { x: screen_x, y: screen_y, button });
    }

    pub fn handle_mouse_up(&mut self, x: f32, y: f32, button: MouseButton) {
        let screen_x = (x * self.display_bounds.0 as f32) as i32;
        let screen_y = (y * self.display_bounds.1 as f32) as i32;
        self.manager.push_event(InputEvent::MouseUp { x: screen_x, y: screen_y, button });
    }

    pub fn handle_mouse_wheel(&mut self, x: f32, y: f32, delta_x: f32, delta_y: f32) {
        let screen_x = (x * self.display_bounds.0 as f32) as i32;
        let screen_y = (y * self.display_bounds.1 as f32) as i32;
        self.manager.push_event(InputEvent::MouseWheel {
            x: screen_x, y: screen_y,
            delta_x: delta_x as i32, delta_y: delta_y as i32
        });
    }

    pub fn handle_key_down(&mut self, key_code: u32) {
        self.manager.push_event(InputEvent::KeyDown { key_code });
    }

    pub fn handle_key_up(&mut self, key_code: u32) {
        self.manager.push_event(InputEvent::KeyUp { key_code });
    }

    pub fn handle_text(&mut self, text: String) {
        self.manager.push_event(InputEvent::Text { text });
    }

    pub fn handle_clipboard(&mut self, text: String) {
        self.manager.push_event(InputEvent::Clipboard { text });
    }

    pub fn flush(&mut self) -> Result<()> {
        self.manager.flush()
    }
}