#[cfg(windows)]
use base64::Engine;
#[cfg(windows)]
use flexaudio_core::{
    backend::{CaptureBackend, RawSink},
    raw_ring,
    types::ProcessMode,
};
#[cfg(windows)]
use flexaudio_os_windows::WasapiProcessBackend;
#[cfg(windows)]
use serde::Serialize;
#[cfg(windows)]
use sysinfo::{Pid, System};
#[cfg(windows)]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};
#[cfg(windows)]
use tauri::ipc::Channel;

#[cfg(windows)]
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProcessAudioEvent {
    Pcm {
        source: &'static str,
        sample_rate: u32,
        channels: u16,
        samples_base64: String,
    },
    Info {
        excluded_pid: u32,
        excluded_process: String,
    },
}

#[cfg(windows)]
fn is_descendant_of(system: &System, mut pid: Pid, ancestor: Pid) -> bool {
    // Guard against malformed/cyclic process information.
    for _ in 0..64 {
        let Some(process) = system.process(pid) else { return false; };
        let Some(parent) = process.parent() else { return false; };
        if parent == ancestor { return true; }
        if parent == pid { return false; }
        pid = parent;
    }
    false
}

#[cfg(windows)]
fn webview_audio_tree_root() -> Option<(u32, String)> {
    // WebView2 renders/plays the remote voice in msedgewebview2.exe, not in the
    // Tauri host process. Excluding the host PID therefore does NOT necessarily
    // remove call audio from WASAPI loopback. Find the WebView2 process tree
    // belonging to this Kitchat instance and exclude that whole tree instead.
    let mut system = System::new_all();
    system.refresh_all();
    let host = Pid::from_u32(std::process::id());

    let mut candidates: Vec<Pid> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let name = process.name().to_string_lossy();
            if name.eq_ignore_ascii_case("msedgewebview2.exe") && is_descendant_of(&system, *pid, host) {
                Some(*pid)
            } else {
                None
            }
        })
        .collect();

    // Prefer the highest WebView2 process in the tree. Excluding it also
    // excludes renderer/audio/GPU descendants where HTMLMediaElement audio is
    // actually rendered.
    candidates.sort_by_key(|pid| {
        let mut depth = 0usize;
        let mut cursor = *pid;
        for _ in 0..64 {
            let Some(process) = system.process(cursor) else { break; };
            let Some(parent) = process.parent() else { break; };
            depth += 1;
            if parent == host { break; }
            cursor = parent;
        }
        depth
    });
    let pid = *candidates.first()?;
    let name = system
        .process(pid)
        .map(|process| process.name().to_string_lossy().into_owned())
        .unwrap_or_else(|| "msedgewebview2.exe".into());
    Some((pid.as_u32(), name))
}

#[cfg(windows)]
struct ProcessAudioSession {
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

#[cfg(windows)]
#[derive(Default)]
pub struct ProcessAudioState(Mutex<Option<ProcessAudioSession>>);

#[cfg(windows)]
#[tauri::command]
pub fn process_audio_start(
    state: tauri::State<'_, ProcessAudioState>,
    channel: Channel<ProcessAudioEvent>,
) -> Result<(), String> {
    let mut session = state.0.lock().map_err(|_| "Блокировка аудиозахвата повреждена")?;
    if session.is_some() {
        return Err("Захват системного звука уже запущен".into());
    }

    // Remote call audio is rendered by WebView2 child processes. Excluding the
    // Tauri host PID alone lets those voices leak back into the screen-share
    // loopback, so viewers hear themselves. Exclude the WebView2 browser tree
    // that owns all Kitchat media playback instead.
    let (excluded_pid, excluded_process) = webview_audio_tree_root()
        .ok_or_else(|| "Не найден процесс WebView2 Kitchat для исключения голоса из трансляции".to_owned())?;
    let mut backend = WasapiProcessBackend::new(excluded_pid, ProcessMode::Exclude);
    let (sample_rate, channels) = backend.native_format();
    let capacity = sample_rate as usize * channels as usize * 2;
    let (producer, mut consumer) = raw_ring(capacity);
    backend
        .start(RawSink::new(producer, sample_rate, channels))
        .map_err(|error| format!("WASAPI process loopback: {error}"))?;

    let _ = channel.send(ProcessAudioEvent::Info {
        excluded_pid,
        excluded_process,
    });

    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker = std::thread::Builder::new()
        .name("kitchat-process-audio".into())
        .spawn(move || {
            let samples_per_packet = (sample_rate as usize / 50) * channels as usize; // 20 ms
            let mut pcm = vec![0.0f32; samples_per_packet];
            while !worker_stop.load(Ordering::Acquire) {
                if consumer.available() < samples_per_packet {
                    std::thread::sleep(Duration::from_millis(3));
                    continue;
                }
                let count = consumer.pop_slice(&mut pcm);
                if count == 0 {
                    continue;
                }
                let mut bytes = Vec::with_capacity(count * 2);
                for &sample in &pcm[..count] {
                    let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
                if channel
                    .send(ProcessAudioEvent::Pcm {
                        source: "loopback",
                        sample_rate,
                        channels,
                        samples_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    })
                    .is_err()
                {
                    break;
                }
            }
            backend.stop();
        })
        .map_err(|error| format!("Не удалось запустить поток системного звука: {error}"))?;

    *session = Some(ProcessAudioSession { stop, worker });
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn process_audio_stop(state: tauri::State<'_, ProcessAudioState>) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .map_err(|_| "Блокировка аудиозахвата повреждена")?
        .take();
    if let Some(session) = session {
        session.stop.store(true, Ordering::Release);
        let _ = session.worker.join();
    }
    Ok(())
}

#[cfg(not(windows))]
#[derive(Default)]
pub struct ProcessAudioState;

#[cfg(not(windows))]
#[tauri::command]
pub fn process_audio_start() -> Result<(), String> {
    Err("Исключение процесса из системного звука доступно только на Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn process_audio_stop() -> Result<(), String> {
    Ok(())
}
