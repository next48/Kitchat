//! Native Kitchat screen-share transport.
//!
//! This module deliberately lives next to the browser voice transport instead of
//! feeding captured frames through Tauri IPC. Video will travel directly from
//! Windows Graphics Capture/DXGI to a hardware encoder and a native WebRTC peer.

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use webrtc::{
    api::{interceptor_registry::register_default_interceptors, media_engine::{MediaEngine, MIME_TYPE_H264}, APIBuilder},
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    peer_connection::{
        configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription,
        RTCPeerConnection,
    },
    interceptor::registry::Registry,
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamConfig {
    pub source_kind: String,
    pub source_id: usize,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub system_audio: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeIceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

#[derive(Debug, Serialize)]
pub struct NativeStreamAnswer {
    pub viewer_id: String,
    pub sdp: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct NativeStreamStatus {
    pub running: bool,
    pub viewers: usize,
    pub phase_one_limit: usize,
    pub media_path: &'static str,
    pub current_fps: u32,
    pub current_bitrate: u32,
    pub captured_frames: u64,
    pub encoded_frames: u64,
    pub encoded_bytes: u64,
    pub dropped_frames: u64,
    pub writer_samples: u64,
    pub writer_bytes: u64,
    pub writer_errors: u64,
    pub h264_sps_frames: u64,
    pub h264_pps_frames: u64,
    pub h264_idr_frames: u64,
    pub h264_last_nal_mask: u64,
    pub last_error: Option<String>,
}

struct NativeStreamPeer {
    connection: Arc<RTCPeerConnection>,
}

pub struct NativeStreamState {
    config: Mutex<Option<NativeStreamConfig>>,
    peers: Mutex<HashMap<String, NativeStreamPeer>>,
    // One encoded H.264 stream is fanned out to every peer. Capture and encoding
    // are intentionally upstream of this track, never WebView/Tauri IPC.
    video_track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
    #[cfg(windows)]
    capture: std::sync::Mutex<Option<windows_capture::capture::CaptureControl<WgcCapture, String>>>,
    captured_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_bytes: Arc<std::sync::atomic::AtomicU64>,
    dropped_frames: Arc<std::sync::atomic::AtomicU64>,
    writer_samples: Arc<std::sync::atomic::AtomicU64>,
    writer_bytes: Arc<std::sync::atomic::AtomicU64>,
    writer_errors: Arc<std::sync::atomic::AtomicU64>,
    h264_sps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_pps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_idr_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_last_nal_mask: Arc<std::sync::atomic::AtomicU64>,
    force_keyframe: Arc<std::sync::atomic::AtomicBool>,
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    encoded_tx: Mutex<Option<tokio::sync::mpsc::Sender<EncodedVideoFrame>>>,
}

impl Default for NativeStreamState {
    fn default() -> Self {
        Self {
            config: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            video_track: Mutex::new(None),
            #[cfg(windows)]
            capture: std::sync::Mutex::new(None),
            captured_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            encoded_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            encoded_bytes: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            dropped_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            writer_samples: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            writer_bytes: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            writer_errors: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            h264_sps_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            h264_pps_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            h264_idr_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            h264_last_nal_mask: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            force_keyframe: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            encoded_tx: Mutex::new(None),
        }
    }
}

struct EncodedVideoFrame {
    annex_b: bytes::Bytes,
    duration: Duration,
}

#[cfg(windows)]
#[derive(Clone)]
struct WgcEncoderFlags {
    fps: u32,
    bitrate: u32,
    captured_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_bytes: Arc<std::sync::atomic::AtomicU64>,
    dropped_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_sps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_pps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_idr_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_last_nal_mask: Arc<std::sync::atomic::AtomicU64>,
    force_keyframe: Arc<std::sync::atomic::AtomicBool>,
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    encoded_tx: tokio::sync::mpsc::Sender<EncodedVideoFrame>,
}

#[cfg(windows)]
struct WgcCapture {
    captured_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_frames: Arc<std::sync::atomic::AtomicU64>,
    encoded_bytes: Arc<std::sync::atomic::AtomicU64>,
    dropped_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_sps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_pps_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_idr_frames: Arc<std::sync::atomic::AtomicU64>,
    h264_last_nal_mask: Arc<std::sync::atomic::AtomicU64>,
    force_keyframe: Arc<std::sync::atomic::AtomicBool>,
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    encoded_tx: tokio::sync::mpsc::Sender<EncodedVideoFrame>,
    encoder: Option<NativeH264Encoder>,
    fps: u32,
    bitrate: u32,
}

#[cfg(windows)]
impl windows_capture::capture::GraphicsCaptureApiHandler for WgcCapture {
    type Flags = WgcEncoderFlags;
    type Error = String;

    fn new(
        ctx: windows_capture::capture::Context<Self::Flags>,
    ) -> Result<Self, Self::Error> {
        Ok(Self {
            captured_frames: ctx.flags.captured_frames,
            encoded_frames: ctx.flags.encoded_frames,
            encoded_bytes: ctx.flags.encoded_bytes,
            dropped_frames: ctx.flags.dropped_frames,
            h264_sps_frames: ctx.flags.h264_sps_frames,
            h264_pps_frames: ctx.flags.h264_pps_frames,
            h264_idr_frames: ctx.flags.h264_idr_frames,
            h264_last_nal_mask: ctx.flags.h264_last_nal_mask,
            force_keyframe: ctx.flags.force_keyframe,
            last_error: ctx.flags.last_error,
            encoded_tx: ctx.flags.encoded_tx,
            encoder: None,
            fps: ctx.flags.fps,
            bitrate: ctx.flags.bitrate,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame,
        _capture_control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // The frame remains a D3D11 texture. Only the compressed Annex-B output
        // leaves the GPU encoder; there is no pixel readback/JPEG/canvas stage.
        let size_changed = self.encoder.as_ref().is_some_and(|encoder| {
            encoder.source_size() != (frame.width(), frame.height())
        });
        if size_changed {
            // Dropping unregisters input/output resources and destroys the old
            // session before a differently sized texture can be submitted.
            self.encoder.take();
            self.force_keyframe.store(true, std::sync::atomic::Ordering::Release);
        }
        if self.encoder.is_none() {
            match NvencD3d11Encoder::new(
                frame.device(), frame.width(), frame.height(), self.fps, self.bitrate,
            ) {
                Ok(encoder) => self.encoder = Some(NativeH264Encoder::Nvenc(encoder)),
                Err(nvenc_error) => {
                    // Hybrid Intel/NVIDIA laptops often expose the WGC texture
                    // on the iGPU, so opening NVENC on that D3D device fails.
                    // Keep the whole pipeline native and fall back to OpenH264
                    // at a laptop-safe 540p15 instead of JPEG/canvas IPC.
                    match AsyncOpenH264Encoder::new(
                        frame.width(), frame.height(), self.bitrate,
                        self.encoded_tx.clone(), Arc::clone(&self.encoded_frames), Arc::clone(&self.encoded_bytes),
                        Arc::clone(&self.dropped_frames), Arc::clone(&self.h264_sps_frames), Arc::clone(&self.h264_pps_frames),
                        Arc::clone(&self.h264_idr_frames), Arc::clone(&self.h264_last_nal_mask), Arc::clone(&self.last_error),
                    ) {
                        Ok(encoder) => {
                            eprintln!("Kitchat: NVENC unavailable ({nvenc_error}); using native OpenH264 fallback");
                            if let Ok(mut slot) = self.last_error.lock() { *slot = None; }
                            self.encoder = Some(NativeH264Encoder::Software(encoder));
                        }
                        Err(software_error) => {
                            let error = format!("NVENC: {nvenc_error}; OpenH264: {software_error}");
                            if let Ok(mut slot) = self.last_error.lock() { *slot = Some(error.clone()); }
                            return Err(error);
                        }
                    }
                }
            }
        }
        let force_idr = self.force_keyframe.swap(false, std::sync::atomic::Ordering::AcqRel);
        let encoder = self.encoder.as_mut().unwrap();
        let frame_duration = Duration::from_secs_f64(1.0 / encoder.output_fps() as f64);
        let annex_b = encoder.encode(frame, force_idr)?;
        if !annex_b.is_empty() {
            let nal_units = annex_b_nal_units(&annex_b);
            let mut nal_mask = 0u64;
            let mut has_sps = false;
            let mut has_pps = false;
            let mut has_idr = false;
            for nal in nal_units {
                if let Some(nal_type) = nal.first().map(|byte| byte & 0x1f) {
                    if nal_type < 64 { nal_mask |= 1u64 << nal_type; }
                    has_sps |= nal_type == 7;
                    has_pps |= nal_type == 8;
                    has_idr |= nal_type == 5;
                }
            }
            self.h264_last_nal_mask.store(nal_mask, std::sync::atomic::Ordering::Relaxed);
            if has_sps { self.h264_sps_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
            if has_pps { self.h264_pps_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
            if has_idr { self.h264_idr_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
            let encoded = EncodedVideoFrame {
                annex_b: bytes::Bytes::from(annex_b),
                duration: frame_duration,
            };
            // Real-time video must never block the WGC callback. Drop a late frame
            // rather than building latency when the network is congested.
            let byte_len = encoded.annex_b.len() as u64;
            match self.encoded_tx.try_send(encoded) {
                Ok(()) => {
                    self.encoded_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    self.encoded_bytes.fetch_add(byte_len, std::sync::atomic::Ordering::Relaxed);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                    self.dropped_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    if let Ok(mut slot) = self.last_error.lock() {
                        *slot = Some("WebRTC video writer остановлен".to_owned());
                    }
                }
            }
        }
        self.captured_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.encoder.take();
        Ok(())
    }
}

#[cfg(windows)]
enum NativeH264Encoder {
    Nvenc(NvencD3d11Encoder),
    Software(AsyncOpenH264Encoder),
}

#[cfg(windows)]
impl NativeH264Encoder {
    fn source_size(&self) -> (u32, u32) {
        match self {
            Self::Nvenc(value) => (value.width, value.height),
            Self::Software(value) => (value.source_width, value.source_height),
        }
    }

    fn output_fps(&self) -> u32 {
        match self { Self::Nvenc(value) => value.fps, Self::Software(value) => value.fps }
    }

    fn encode(&mut self, frame: &mut windows_capture::frame::Frame, force_idr: bool) -> Result<Vec<u8>, String> {
        match self {
            Self::Nvenc(value) => value.encode(frame.as_raw_texture(), force_idr),
            Self::Software(value) => { value.submit(frame, force_idr)?; Ok(Vec::new()) },
        }
    }
}

#[cfg(windows)]
struct SoftwareRawFrame {
    bgra: Vec<u8>,
    force_idr: bool,
}

#[cfg(windows)]
struct AsyncOpenH264Encoder {
    source_width: u32,
    source_height: u32,
    fps: u32,
    last_frame: Option<std::time::Instant>,
    scratch: Vec<u8>,
    tx: std::sync::mpsc::SyncSender<SoftwareRawFrame>,
    dropped_frames: Arc<std::sync::atomic::AtomicU64>,
}

#[cfg(windows)]
impl AsyncOpenH264Encoder {
    #[allow(clippy::too_many_arguments)]
    fn new(
        source_width: u32, source_height: u32, bitrate: u32,
        encoded_tx: tokio::sync::mpsc::Sender<EncodedVideoFrame>,
        encoded_frames: Arc<std::sync::atomic::AtomicU64>, encoded_bytes: Arc<std::sync::atomic::AtomicU64>,
        dropped_frames: Arc<std::sync::atomic::AtomicU64>, h264_sps_frames: Arc<std::sync::atomic::AtomicU64>,
        h264_pps_frames: Arc<std::sync::atomic::AtomicU64>, h264_idr_frames: Arc<std::sync::atomic::AtomicU64>,
        h264_last_nal_mask: Arc<std::sync::atomic::AtomicU64>, last_error: Arc<std::sync::Mutex<Option<String>>>,
    ) -> Result<Self, String> {
        // This path copies WGC's GPU texture to system memory and encodes on the
        // CPU. 720p20 looked fine on a desktop CPU but caused a 3-12 FPS capture
        // loop on Intel/AMD and battery-powered laptops. 540p15 is deliberately
        // chosen as the stable real-time profile; hardware NVENC remains at the
        // quality picked by the user.
        let fps = 15;
        let mut core = OpenH264SoftwareCore::new(source_width, source_height, bitrate, fps)?;
        let queue_drops = Arc::clone(&dropped_frames);
        let (tx, rx) = std::sync::mpsc::sync_channel::<SoftwareRawFrame>(1);
        std::thread::Builder::new().name("kitchat-openh264".into()).spawn(move || {
            while let Ok(frame) = rx.recv() {
                match core.encode_bgra(&frame.bgra, frame.force_idr) {
                    Ok(annex_b) if !annex_b.is_empty() => {
                        let mut mask = 0u64; let mut sps = false; let mut pps = false; let mut idr = false;
                        for nal in annex_b_nal_units(&annex_b) {
                            if let Some(kind) = nal.first().map(|byte| byte & 0x1f) {
                                if kind < 64 { mask |= 1u64 << kind; }
                                sps |= kind == 7; pps |= kind == 8; idr |= kind == 5;
                            }
                        }
                        h264_last_nal_mask.store(mask, std::sync::atomic::Ordering::Relaxed);
                        if sps { h264_sps_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                        if pps { h264_pps_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                        if idr { h264_idr_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                        let len = annex_b.len() as u64;
                        match encoded_tx.try_send(EncodedVideoFrame { annex_b: bytes::Bytes::from(annex_b), duration: Duration::from_millis(1000 / fps as u64) }) {
                            Ok(()) => { encoded_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); encoded_bytes.fetch_add(len, std::sync::atomic::Ordering::Relaxed); }
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => { dropped_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                        }
                    }
                    Ok(_) => {}
                    Err(error) => { if let Ok(mut slot) = last_error.lock() { *slot = Some(format!("OpenH264: {error}")); } }
                }
            }
        }).map_err(|error| error.to_string())?;
        Ok(Self { source_width, source_height, fps, last_frame: None, scratch: Vec::new(), tx, dropped_frames: queue_drops })
    }

    fn submit(&mut self, frame: &mut windows_capture::frame::Frame, force_idr: bool) -> Result<(), String> {
        let now = std::time::Instant::now();
        if !force_idr && self.last_frame.is_some_and(|last| now.duration_since(last) < Duration::from_millis(1000 / self.fps as u64)) { return Ok(()); }
        self.last_frame = Some(now);
        let buffer = frame.buffer().map_err(|error| error.to_string())?;
        let bgra = buffer.as_nopadding_buffer(&mut self.scratch).to_vec();
        // Capacity one is intentional: preserve real-time latency by dropping
        // an old capture instead of queueing seconds of obsolete frames.
        if self.tx.try_send(SoftwareRawFrame { bgra, force_idr }).is_err() {
            self.dropped_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }
}

#[cfg(windows)]
struct OpenH264SoftwareCore {
    encoder: openh264::encoder::Encoder,
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    scaled_bgra: Vec<u8>,
    yuv: openh264::formats::YUVBuffer,
}

#[cfg(windows)]
impl OpenH264SoftwareCore {
    fn new(source_width: u32, source_height: u32, bitrate: u32, fps: u32) -> Result<Self, String> {
        use openh264::{
            OpenH264API,
            encoder::{BitRate, Complexity, EncoderConfig, FrameRate, IntraFramePeriod, Profile, RateControlMode, UsageType},
        };
        // Do not let the software compatibility encoder inherit a 1080p/4K
        // monitor's cost. 960×540 remains clear enough for text while staying
        // within the CPU budget of old integrated-GPU laptops.
        let scale = (960.0 / source_width as f64).min(540.0 / source_height as f64).min(1.0);
        let width = ((source_width as f64 * scale) as u32).max(2) & !1;
        let height = ((source_height as f64 * scale) as u32).max(2) & !1;
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate.min(2_500_000)))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .profile(Profile::Baseline)
            .complexity(Complexity::Low)
            .skip_frames(true)
            // A full H.264 keyframe is much more expensive than a delta frame.
            // New viewers and packet loss still request one through PLI/FIR, so
            // a four-second periodic interval avoids needless CPU spikes.
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps * 4));
        let encoder = openh264::encoder::Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            encoder, source_width, source_height, width, height,
            scaled_bgra: vec![0; width as usize * height as usize * 4],
            yuv: openh264::formats::YUVBuffer::new(width as usize, height as usize),
        })
    }

    fn encode_bgra(&mut self, source: &[u8], force_idr: bool) -> Result<Vec<u8>, String> {
        let sw = self.source_width as usize;
        let sh = self.source_height as usize;
        let dw = self.width as usize;
        let dh = self.height as usize;
        for y in 0..dh {
            let sy = y * sh / dh;
            for x in 0..dw {
                let sx = x * sw / dw;
                let src = (sy * sw + sx) * 4;
                let dst = (y * dw + x) * 4;
                self.scaled_bgra[dst..dst + 4].copy_from_slice(&source[src..src + 4]);
            }
        }
        if force_idr { self.encoder.force_intra_frame(); }
        let bgra = openh264::formats::BgraSliceU8::new(&self.scaled_bgra, (dw, dh));
        // Reuse the large I420 allocation instead of allocating ~1.4 MB for
        // every 720p frame. This removes allocator/GC-like frame-time spikes.
        self.yuv.read_bgra8(bgra);
        let bitstream = self.encoder.encode(&self.yuv).map_err(|error| error.to_string())?;
        let mut output = Vec::new();
        bitstream.write_vec(&mut output);
        Ok(output)
    }
}

/// One encoder instance owns the NVENC session and is independent from every
/// WebRTC peer. This makes later fan-out possible without encoding per viewer.
#[cfg(windows)]
struct NvencD3d11Encoder {
    encoder: nvenc::encoder::Encoder,
    frame_index: usize,
    width: u32,
    height: u32,
    fps: u32,
    parameter_sets: Vec<Vec<u8>>,
}

// NVENC marks its public handle !Send to keep callers from moving a live
// context accidentally. This wrapper is created, used and dropped exclusively
// by windows-capture's single serialized callback thread.
#[cfg(windows)]
unsafe impl Send for NvencD3d11Encoder {}

#[cfg(windows)]
impl NvencD3d11Encoder {
    fn new(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        use nvenc::{
            session::{InitParams, NeedsConfig, Session},
            sys::{
                enums::{NVencBufferFormat, NVencParamsRcMode, NVencTuningInfo},
                guids::{NV_ENC_CODEC_H264_GUID, NV_ENC_H264_PROFILE_BASELINE_GUID, NV_ENC_PRESET_P3_GUID},
            },
        };
        let session: Session<NeedsConfig> = Session::open_dx(device).map_err(|error| format!("{error:?}"))?;
        if !session.get_encode_codecs().map_err(|error| format!("{error:?}"))?.contains(&NV_ENC_CODEC_H264_GUID) {
            return Err("NVENC H.264 не поддерживается этим адаптером".into());
        }
        let (session, mut preset) = session
            .get_encode_preset_config_ex(
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P3_GUID,
                NVencTuningInfo::UltraLowLatency,
            )
            .map_err(|error| format!("{error:?}"))?;
        // Match the WebRTC SDP capability (42e01f / constrained-baseline family).
        // Advertising baseline while sending NVENC's default high profile can produce
        // a black video on stricter Chromium/WebView2 decoders.
        preset.preset_cfg.profile_guid = NV_ENC_H264_PROFILE_BASELINE_GUID;
        preset.preset_cfg.rc_params.rate_control_mode = NVencParamsRcMode::CBR;
        preset.preset_cfg.rc_params.average_bit_rate = bitrate;
        preset.preset_cfg.rc_params.look_ahead_depth = 0;
        preset.preset_cfg.gop_len = fps;
        preset.preset_cfg.frame_interval_p = 1;
        let encoder = session
            .init_encoder(InitParams {
                encode_guid: NV_ENC_CODEC_H264_GUID,
                preset_guid: NV_ENC_PRESET_P3_GUID,
                resolution: [width, height],
                aspect_ratio: [width, height],
                frame_rate: [fps, 1],
                tuning_info: NVencTuningInfo::UltraLowLatency,
                buffer_format: NVencBufferFormat::ARGB,
                encode_config: &mut preset.preset_cfg,
                enable_ptd: true,
                max_encoder_resolution: [width, height],
            })
            .map_err(|error| format!("{error:?}"))?;
        Ok(Self { encoder, frame_index: 0, width, height, fps, parameter_sets: Vec::new() })
    }

    fn encode(
        &mut self,
        texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        force_idr: bool,
    ) -> Result<Vec<u8>, String> {
        use nvenc::sys::enums::{NVencBufferFormat, NVencPicStruct, NVencPicType};
        let resource = self
            .encoder
            .register_resource_dx11(texture, NVencBufferFormat::ARGB, 0)
            .map_err(|error| format!("{error:?}"))?;
        let output = self.encoder.create_bitstream_buffer().map_err(|error| format!("{error:?}"))?;
        self.encoder
            .encode_picture(
                &resource,
                &output,
                self.frame_index,
                self.frame_index as u64,
                NVencBufferFormat::ARGB,
                NVencPicStruct::Frame,
                if force_idr || self.frame_index == 0 || self.frame_index % (self.fps.max(1) as usize) == 0 { NVencPicType::IDR } else { NVencPicType::P },
                None,
            )
            .map_err(|error| format!("{error:?}"))?;
        self.frame_index = self.frame_index.wrapping_add(1);
        let mut data = output.try_lock(true).map_err(|error| format!("{error:?}"))?.as_slice().to_vec();
        let nal_units = annex_b_nal_units(&data);
        let has_sps = nal_units.iter().any(|nal| nal.first().is_some_and(|byte| byte & 0x1f == 7));
        let has_pps = nal_units.iter().any(|nal| nal.first().is_some_and(|byte| byte & 0x1f == 8));
        let has_idr = nal_units.iter().any(|nal| nal.first().is_some_and(|byte| byte & 0x1f == 5));

        // Cache parameter sets independently. Some NVENC driver versions may emit
        // SPS/PPS in separate output packets, so requiring both in the same packet
        // can leave a late-joining WebRTC decoder without configuration.
        for nal in &nal_units {
            let Some(nal_type) = nal.first().map(|byte| byte & 0x1f) else { continue };
            if !matches!(nal_type, 7 | 8) { continue; }
            let mut framed = vec![0, 0, 0, 1];
            framed.extend_from_slice(nal);
            if let Some(slot) = self.parameter_sets.iter_mut().find(|existing| {
                annex_b_nal_units(existing).first().and_then(|item| item.first()).map(|byte| byte & 0x1f) == Some(nal_type)
            }) {
                *slot = framed;
            } else {
                self.parameter_sets.push(framed);
            }
        }

        // WebRTC H.264 receivers joining mid-stream need SPS/PPS immediately before
        // their first IDR. NVENC normally emits parameter sets with IDRs, but make
        // this invariant explicit at the Annex-B boundary as well.
        if has_idr && !(has_sps && has_pps) {
            let cached_has_sps = self.parameter_sets.iter().any(|nal| annex_b_nal_units(nal).first().and_then(|item| item.first()).is_some_and(|byte| byte & 0x1f == 7));
            let cached_has_pps = self.parameter_sets.iter().any(|nal| annex_b_nal_units(nal).first().and_then(|item| item.first()).is_some_and(|byte| byte & 0x1f == 8));
            if cached_has_sps && cached_has_pps {
                let mut framed = self.parameter_sets.concat();
                framed.extend_from_slice(&data);
                data = framed;
            }
        }
        Ok(data)
    }
}

#[cfg(windows)]
fn annex_b_nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        let length = if data[i..].starts_with(&[0, 0, 0, 1]) { 4 }
            else if data[i..].starts_with(&[0, 0, 1]) { 3 }
            else { i += 1; continue };
        starts.push((i, length));
        i += length;
    }
    starts.iter().enumerate().filter_map(|(index, (start, prefix))| {
        let from = start + prefix;
        let to = starts.get(index + 1).map(|(next, _)| *next).unwrap_or(data.len());
        (from < to).then_some(&data[from..to])
    }).collect()
}

#[cfg(windows)]
impl Drop for NvencD3d11Encoder {
    fn drop(&mut self) {
        let _ = self.encoder.end_encode();
    }
}

impl NativeStreamConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.source_kind.as_str(), "window" | "monitor") {
            return Err("Неизвестный источник трансляции".into());
        }
        if !(640..=3840).contains(&self.width) || !(360..=2160).contains(&self.height) {
            return Err("Разрешение трансляции вне поддерживаемого диапазона".into());
        }
        if !matches!(self.fps, 15 | 30 | 60) {
            return Err("Поддерживаются 15, 30 или 60 FPS".into());
        }
        if !(1_000_000..=40_000_000).contains(&self.bitrate) {
            return Err("Битрейт трансляции вне поддерживаемого диапазона".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct NativeStreamCapabilities {
    pub platform: &'static str,
    pub capture: Vec<&'static str>,
    pub encoders: Vec<&'static str>,
    pub transport: &'static str,
    pub system_audio: &'static str,
    pub max_viewers_phase_one: u8,
}

#[tauri::command]
pub fn native_stream_capabilities() -> NativeStreamCapabilities {
    NativeStreamCapabilities {
        platform: if cfg!(windows) { "windows" } else { "unsupported" },
        capture: if cfg!(windows) { vec!["wgc", "dxgi"] } else { vec![] },
        encoders: if cfg!(windows) { vec!["nvenc", "webrtc-compatible-fallback"] } else { vec![] },
        transport: "webrtc-p2p",
        system_audio: if cfg!(windows) { "wasapi-loopback" } else { "unsupported" },
        max_viewers_phase_one: 1,
    }
}

#[tauri::command]
pub fn native_stream_validate(config: NativeStreamConfig) -> Result<(), String> {
    config.validate()
}

#[tauri::command]
pub async fn native_stream_start(
    state: State<'_, NativeStreamState>,
    config: NativeStreamConfig,
) -> Result<(), String> {
    config.validate()?;
    native_stream_stop_capture(&state)?;
    state.captured_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.encoded_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.encoded_bytes.store(0, std::sync::atomic::Ordering::Relaxed);
    state.dropped_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.writer_samples.store(0, std::sync::atomic::Ordering::Relaxed);
    state.writer_bytes.store(0, std::sync::atomic::Ordering::Relaxed);
    state.writer_errors.store(0, std::sync::atomic::Ordering::Relaxed);
    state.h264_sps_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.h264_pps_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.h264_idr_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    state.h264_last_nal_mask.store(0, std::sync::atomic::Ordering::Relaxed);
    state.force_keyframe.store(true, std::sync::atomic::Ordering::Release);
    if let Ok(mut slot) = state.last_error.lock() { *slot = None; }
    native_stream_close_peers(&state).await;
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90_000,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                .to_owned(),
            ..Default::default()
        },
        "kitchat-screen".to_owned(),
        "kitchat-native-stream".to_owned(),
    ));
    let (encoded_tx, mut encoded_rx) = tokio::sync::mpsc::channel::<EncodedVideoFrame>(1);
    let writer_track = Arc::clone(&video_track);
    let writer_samples = Arc::clone(&state.writer_samples);
    let writer_bytes = Arc::clone(&state.writer_bytes);
    let writer_errors = Arc::clone(&state.writer_errors);
    let writer_last_error = Arc::clone(&state.last_error);
    tauri::async_runtime::spawn(async move {
        while let Some(frame) = encoded_rx.recv().await {
            let byte_len = frame.annex_b.len() as u64;
            let sample = webrtc::media::Sample {
                data: frame.annex_b,
                duration: frame.duration,
                ..Default::default()
            };
            match writer_track.write_sample(&sample).await {
                Ok(()) => {
                    writer_samples.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    writer_bytes.fetch_add(byte_len, std::sync::atomic::Ordering::Relaxed);
                }
                Err(error) => {
                    writer_errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if let Ok(mut slot) = writer_last_error.lock() {
                        *slot = Some(format!("WebRTC write_sample: {error}"));
                    }
                    break;
                }
            }
        }
    });
    *state.encoded_tx.lock().await = Some(encoded_tx.clone());
    *state.video_track.lock().await = Some(video_track);
    #[cfg(windows)]
    native_stream_start_capture(&state, &config, encoded_tx)?;
    *state.config.lock().await = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn native_stream_accept_offer(
    state: State<'_, NativeStreamState>,
    viewer_id: String,
    sdp: String,
    ice_servers: Vec<NativeIceServer>,
) -> Result<NativeStreamAnswer, String> {
    if state.config.lock().await.is_none() {
        return Err("Нативная трансляция ещё не запущена".into());
    }
    if viewer_id.trim().is_empty() {
        return Err("Не указан зритель трансляции".into());
    }

    // Multi-viewer mode: one capture/encoder feeds the shared H.264 track,
    // while each viewer gets its own lightweight RTCPeerConnection.
    native_stream_remove_peer_inner(&state, &viewer_id).await;

    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|error| error.to_string())?;
    // webrtc-rs does not install RTP/RTCP interceptors automatically when the
    // API object is built manually. Keep the default interceptor chain so
    // TrackLocalStaticSample gets the normal RTCP/NACK/report pipeline used by
    // browser WebRTC peers.
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)
        .map_err(|error| error.to_string())?;
    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();
    let configuration = RTCConfiguration {
        ice_servers: ice_servers
            .into_iter()
            .map(|server| RTCIceServer {
                urls: server.urls,
                username: server.username,
                credential: server.credential,
            })
            .collect(),
        ..Default::default()
    };
    let connection = Arc::new(
        api.new_peer_connection(configuration)
            .await
            .map_err(|error| error.to_string())?,
    );
    let track = state
        .video_track
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Видеотрек трансляции не подготовлен".to_owned())?;
    let sender = connection
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|error| error.to_string())?;
    // A peer may join long after capture started. Request a fresh IDR so the
    // viewer does not need to wait for the next periodic GOP boundary.
    state.force_keyframe.store(true, std::sync::atomic::Ordering::Release);
    // Reading RTCP is required for PLI/NACK feedback and prevents interceptor
    // buffers from filling. The encoder feedback bridge is attached here next.
    let force_keyframe = Arc::clone(&state.force_keyframe);
    tauri::async_runtime::spawn(async move {
        while let Ok((packets, _)) = sender.read_rtcp().await {
            if packets.iter().any(|packet| {
                packet.as_any().is::<webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication>()
                    || packet.as_any().is::<webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest>()
            }) {
                force_keyframe.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    });

    let offer = RTCSessionDescription::offer(sdp).map_err(|error| error.to_string())?;
    connection
        .set_remote_description(offer)
        .await
        .map_err(|error| error.to_string())?;
    let answer = connection
        .create_answer(None)
        .await
        .map_err(|error| error.to_string())?;
    let mut gathering_complete = connection.gathering_complete_promise().await;
    connection
        .set_local_description(answer)
        .await
        .map_err(|error| error.to_string())?;
    // ICE gathering may stall for several seconds on an unreachable STUN/TURN
    // route. Never block the voice poll/signaling path indefinitely. Host/srflx
    // candidates gathered within this window are enough for the initial answer;
    // TURN remains a fallback when available.
    // TURN gathering is often slower on a different ISP/Wi-Fi network. The old
    // 2.5 s cutoff returned an answer without a usable relay candidate.
    let _ = tokio::time::timeout(Duration::from_millis(5000), gathering_complete.recv()).await;
    let local = connection
        .local_description()
        .await
        .ok_or_else(|| "WebRTC не создал локальное описание".to_owned())?;

    // add_track() happens before SDP negotiation, so an IDR requested there can
    // be consumed while TrackLocalStaticSample is not bound yet. Request it once
    // more after the answer is ready: the first useful frame for the viewer is
    // then independently decodable instead of waiting up to a full GOP.
    state.force_keyframe.store(true, std::sync::atomic::Ordering::Release);

    state.peers.lock().await.insert(
        viewer_id.clone(),
        NativeStreamPeer {
            connection,
        },
    );
    Ok(NativeStreamAnswer {
        viewer_id,
        sdp: local.sdp,
        kind: "answer",
    })
}

#[tauri::command]
pub async fn native_stream_add_ice(
    state: State<'_, NativeStreamState>,
    viewer_id: String,
    candidate: RTCIceCandidateInit,
) -> Result<(), String> {
    let connection = state
        .peers
        .lock()
        .await
        .get(&viewer_id)
        .map(|peer| Arc::clone(&peer.connection))
        .ok_or_else(|| "P2P-сессия зрителя не найдена".to_owned())?;
    connection
        .add_ice_candidate(candidate)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn native_stream_remove_peer(
    state: State<'_, NativeStreamState>,
    viewer_id: String,
) -> Result<(), String> {
    native_stream_remove_peer_inner(&state, &viewer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn native_stream_stop(state: State<'_, NativeStreamState>) -> Result<(), String> {
    native_stream_stop_capture(&state)?;
    native_stream_close_peers(&state).await;
    *state.video_track.lock().await = None;
    *state.encoded_tx.lock().await = None;
    *state.config.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn native_stream_reconfigure(
    state: State<'_, NativeStreamState>,
    fps: u32,
    bitrate: u32,
) -> Result<(), String> {
    let mut config = state.config.lock().await.clone().ok_or("Трансляция не запущена")?;
    config.fps = fps;
    config.bitrate = bitrate;
    config.validate()?;

    let encoded_tx = state.encoded_tx.lock().await.clone().ok_or("Видео-конвейер не запущен")?;
    native_stream_stop_capture(&state)?;
    state.force_keyframe.store(true, std::sync::atomic::Ordering::Relaxed);
    native_stream_start_capture(&state, &config, encoded_tx)?;
    *state.config.lock().await = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn native_stream_status(
    state: State<'_, NativeStreamState>,
) -> Result<NativeStreamStatus, String> {
    let config = state.config.lock().await.clone();
    Ok(NativeStreamStatus {
        running: config.is_some(),
        viewers: state.peers.lock().await.keys().filter(|id| id.as_str() != "__local_preview__").count(),
        phase_one_limit: 0,
        media_path: "native-capture -> hardware-h264 -> webrtc-p2p",
        current_fps: config.as_ref().map(|value| value.fps).unwrap_or(0),
        current_bitrate: config.as_ref().map(|value| value.bitrate).unwrap_or(0),
        captured_frames: state.captured_frames.load(std::sync::atomic::Ordering::Relaxed),
        encoded_frames: state.encoded_frames.load(std::sync::atomic::Ordering::Relaxed),
        encoded_bytes: state.encoded_bytes.load(std::sync::atomic::Ordering::Relaxed),
        dropped_frames: state.dropped_frames.load(std::sync::atomic::Ordering::Relaxed),
        writer_samples: state.writer_samples.load(std::sync::atomic::Ordering::Relaxed),
        writer_bytes: state.writer_bytes.load(std::sync::atomic::Ordering::Relaxed),
        writer_errors: state.writer_errors.load(std::sync::atomic::Ordering::Relaxed),
        h264_sps_frames: state.h264_sps_frames.load(std::sync::atomic::Ordering::Relaxed),
        h264_pps_frames: state.h264_pps_frames.load(std::sync::atomic::Ordering::Relaxed),
        h264_idr_frames: state.h264_idr_frames.load(std::sync::atomic::Ordering::Relaxed),
        h264_last_nal_mask: state.h264_last_nal_mask.load(std::sync::atomic::Ordering::Relaxed),
        last_error: state.last_error.lock().ok().and_then(|value| value.clone()),
    })
}

#[cfg(windows)]
fn native_stream_start_capture(
    state: &NativeStreamState,
    config: &NativeStreamConfig,
    encoded_tx: tokio::sync::mpsc::Sender<EncodedVideoFrame>,
) -> Result<(), String> {
    use std::time::Duration;
    use windows_capture::{
        capture::GraphicsCaptureApiHandler,
        monitor::Monitor,
        settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings},
        window::Window,
    };
    state.captured_frames.store(0, std::sync::atomic::Ordering::Relaxed);
    let interval = MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(1.0 / config.fps as f64));
    let flags = WgcEncoderFlags {
        fps: config.fps,
        bitrate: config.bitrate,
        captured_frames: Arc::clone(&state.captured_frames),
        encoded_frames: Arc::clone(&state.encoded_frames),
        encoded_bytes: Arc::clone(&state.encoded_bytes),
        dropped_frames: Arc::clone(&state.dropped_frames),
        h264_sps_frames: Arc::clone(&state.h264_sps_frames),
        h264_pps_frames: Arc::clone(&state.h264_pps_frames),
        h264_idr_frames: Arc::clone(&state.h264_idr_frames),
        h264_last_nal_mask: Arc::clone(&state.h264_last_nal_mask),
        force_keyframe: Arc::clone(&state.force_keyframe),
        last_error: Arc::clone(&state.last_error),
        encoded_tx,
    };
    let control = if config.source_kind == "window" {
        let source = Window::from_raw_hwnd(config.source_id as *mut std::ffi::c_void);
        if !source.is_valid() { return Err("Выбранное окно больше недоступно".into()); }
        WgcCapture::start_free_threaded(Settings::new(source, CursorCaptureSettings::WithCursor, DrawBorderSettings::WithoutBorder, SecondaryWindowSettings::Include, interval, DirtyRegionSettings::Default, ColorFormat::Bgra8, flags))
    } else {
        let source = Monitor::from_raw_hmonitor(config.source_id as *mut std::ffi::c_void);
        WgcCapture::start_free_threaded(Settings::new(source, CursorCaptureSettings::WithCursor, DrawBorderSettings::WithoutBorder, SecondaryWindowSettings::Default, interval, DirtyRegionSettings::Default, ColorFormat::Bgra8, flags))
    }.map_err(|error| error.to_string())?;
    *state.capture.lock().map_err(|_| "Не удалось сохранить WGC-сессию")? = Some(control);
    Ok(())
}

#[cfg(windows)]
fn native_stream_stop_capture(state: &NativeStreamState) -> Result<(), String> {
    if let Some(control) = state.capture.lock().map_err(|_| "Не удалось остановить WGC-сессию")?.take() {
        control.stop().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn native_stream_start_capture(
    _state: &NativeStreamState,
    _config: &NativeStreamConfig,
    _encoded_tx: tokio::sync::mpsc::Sender<EncodedVideoFrame>,
) -> Result<(), String> {
    Err("Нативная трансляция экрана пока доступна только на Windows".into())
}

#[cfg(not(windows))]
fn native_stream_stop_capture(_state: &NativeStreamState) -> Result<(), String> { Ok(()) }

async fn native_stream_remove_peer_inner(state: &NativeStreamState, viewer_id: &str) {
    let peer = state.peers.lock().await.remove(viewer_id);
    if let Some(peer) = peer {
        let _ = peer.connection.close().await;
    }
}

async fn native_stream_close_peers(state: &NativeStreamState) {
    let peers = state
        .peers
        .lock()
        .await
        .drain()
        .map(|(_, peer)| peer)
        .collect::<Vec<_>>();
    for peer in peers {
        let _ = peer.connection.close().await;
    }
}
