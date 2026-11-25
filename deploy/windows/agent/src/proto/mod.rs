//! Generated protobuf types and serialization helpers

pub mod rmm {
    pub mod v1 {
        include!(concat!(env!("OUT_DIR"), "/rmm.v1.rs"));
    }
}

use crate::proto::rmm::v1::*;
use prost::Message;

pub trait FrameExt {
    fn encode_to_vec(&self) -> Vec<u8>;
    fn decode<T: Message + Default>(data: &[u8]) -> anyhow::Result<T>;
}

impl FrameExt for dyn Message {
    fn encode_to_vec(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        self.encode(&mut buf).unwrap();
        buf
    }

    fn decode<T: Message + Default>(data: &[u8]) -> anyhow::Result<T> {
        T::decode(data).map_err(Into::into)
    }
}

// Re-export commonly used types
pub use rmm::v1::{
    FrameType, Hello, Welcome, EnrollRequest, EnrollChallenge, EnrollResponse, EnrollResult,
    Heartbeat, HeartbeatAck, RekeyRequest, RekeyAck, Disconnect, DisconnectReason, Error, ErrorCode,
    SessionCreateRequest, SessionJoinRequest, SessionOffer, SessionAnswer, SessionIce,
    SessionStart, SessionEnd, SessionControl, ControlEvent, SessionType,
    VideoFrame, VideoConfig, CursorUpdate, DisplayInfo, Display, VideoCodec, Rect,
    PtyData, PtyResize, PtyStream,
    FileListRequest, FileListResponse, FileEntry, FileReadRequest, FileReadResponse,
    FileWriteRequest, FileWriteResponse, FileHashRequest, FileHashResponse, HashAlgorithm,
    ProcListRequest, ProcListResponse, ProcessInfo, ThreadInfo, ProcKillRequest, ProcKillResponse,
    ServiceListRequest, ServiceListResponse, ServiceInfo, ServiceStatus, ServiceStartType,
    ServiceControlRequest, ServiceControlResponse, ServiceAction,
    ScriptExecRequest, ScriptOutput, ScriptResult, ScriptLanguage, ScriptStream,
    Telemetry, DiskInfo, NetworkInfo,
    Inventory, HardwareInfo, OSInfo, PackageInfo, UserInfo,
    AgentConfig,
};