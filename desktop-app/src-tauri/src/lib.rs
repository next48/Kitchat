mod native_stream;
mod process_audio;

#[tauri::command]
async fn download_attachment(
    app: tauri::AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    use tauri::Manager;

    if !url.starts_with("https://oliverkitchen.ru/") {
        return Err("Скачивание разрешено только с сервера Kitchat".into());
    }
    let response = reqwest::Client::new().get(&url).send().await
        .map_err(|error| format!("Не удалось скачать файл: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Сервер вернул ошибку {}", response.status()));
    }
    let bytes = response.bytes().await
        .map_err(|error| format!("Не удалось получить файл: {error}"))?;
    let mut safe_name: String = filename.chars()
        .map(|character| if matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { character })
        .collect();
    safe_name = safe_name.trim().trim_matches('.').to_string();
    if safe_name.is_empty() { safe_name = "kitchat-image".into(); }
    let downloads = app.path().download_dir()
        .map_err(|error| format!("Папка «Загрузки» недоступна: {error}"))?;
    let downloads = downloads.join("download kitchat");
    std::fs::create_dir_all(&downloads)
        .map_err(|error| format!("Не удалось создать папку «download kitchat»: {error}"))?;
    let original = std::path::Path::new(&safe_name);
    let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("kitchat-image");
    let extension = original.extension().and_then(|value| value.to_str());
    let mut target = downloads.join(&safe_name);
    let mut suffix = 1u32;
    while target.exists() {
        let candidate = match extension {
            Some(extension) => format!("{stem} ({suffix}).{extension}"),
            None => format!("{stem} ({suffix})"),
        };
        target = downloads.join(candidate);
        suffix += 1;
    }
    std::fs::write(&target, bytes)
        .map_err(|error| format!("Не удалось сохранить файл: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn direct_messages_request(
    token: String,
    query: std::collections::HashMap<String, String>,
    data: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    if token.trim().is_empty() {
        return Err("Требуется авторизация".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Не удалось создать HTTP-клиент: {error}"))?;
    let request = if let Some(form) = data {
        client.post("https://oliverkitchen.ru/api/direct_messages.php").query(&query).form(&form)
    } else {
        client.get("https://oliverkitchen.ru/api/direct_messages.php").query(&query)
    };
    let response = request.bearer_auth(token).send().await
        .map_err(|error| format!("Сервер личных сообщений недоступен: {error}"))?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await
        .map_err(|error| format!("Сервер вернул некорректный ответ: {error}"))?;
    if !status.is_success() || !value.get("ok").and_then(|item| item.as_bool()).unwrap_or(false) {
        return Err(value.get("error").and_then(|item| item.as_str()).unwrap_or("Ошибка личных сообщений").to_string());
    }
    Ok(value)
}


#[derive(serde::Serialize, Clone)]
struct GameActivity {
    game: String,
    executable: String,
    started_at: u64,
}

#[cfg(windows)]
#[tauri::command]
fn detect_game_activity() -> Result<Option<GameActivity>, String> {
    use std::collections::HashMap;
    use sysinfo::System;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    // Discord-like detection should not depend on a hardcoded list only.  A lot of
    // indie games have arbitrary executable names, and Minecraft is usually javaw.exe.
    // Gather titles of visible top-level windows and associate them with process IDs.
    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return BOOL(1);
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let written = GetWindowTextW(hwnd, &mut buffer);
        if written <= 0 {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&buffer[..written as usize]).trim().to_string();
        if !title.is_empty() {
            let windows = &mut *(lparam.0 as *mut HashMap<u32, String>);
            // Prefer the longer title for launchers that create several helper windows.
            match windows.get(&pid) {
                Some(current) if current.len() >= title.len() => {}
                _ => { windows.insert(pid, title); }
            }
        }
        BOOL(1)
    }

    let mut window_titles: HashMap<u32, String> = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window), LPARAM((&mut window_titles as *mut HashMap<u32, String>) as isize));
    }

    let mut system = System::new_all();
    system.refresh_all();

    fn alias(exe: &str, cmd: &str, title: &str) -> Option<&'static str> {
        let title_l = title.to_lowercase();
        // Unreal indie games often use <Name>-Win64-Shipping.exe and the actual
        // executable name can differ slightly between storefront builds.
        if exe.contains("howtofish") || exe.contains("how_to_fish") || title_l.contains("how to fish") {
            return Some("How to Fish");
        }
        match exe {
            "cs2.exe" => Some("Counter-Strike 2"),
            "dota2.exe" => Some("Dota 2"),
            "valorant-win64-shipping.exe" => Some("VALORANT"),
            "fortniteclient-win64-shipping.exe" => Some("Fortnite"),
            "gta5.exe" | "playgtav.exe" => Some("Grand Theft Auto V"),
            "rdr2.exe" => Some("Red Dead Redemption 2"),
            "eldenring.exe" => Some("ELDEN RING"),
            "cyberpunk2077.exe" => Some("Cyberpunk 2077"),
            "overwatch.exe" => Some("Overwatch 2"),
            "league of legends.exe" => Some("League of Legends"),
            "rocketleague.exe" => Some("Rocket League"),
            "terraria.exe" => Some("Terraria"),
            "starfield.exe" => Some("Starfield"),
            "bg3.exe" => Some("Baldur's Gate 3"),
            "hl2.exe" if cmd.contains("garrysmod") => Some("Garry's Mod"),
            "javaw.exe" | "java.exe" if cmd.contains("minecraft") || cmd.contains(".minecraft") || title_l.contains("minecraft") => Some("Minecraft"),
            "minecraft.windows.exe" => Some("Minecraft"),
            _ => None,
        }
    }

    fn ignored(exe: &str) -> bool {
        matches!(exe,
            "explorer.exe" | "dwm.exe" | "svchost.exe" | "system" | "systemsettings.exe" |
            "searchhost.exe" | "startmenuexperiencehost.exe" | "shellexperiencehost.exe" |
            "applicationframehost.exe" | "textinputhost.exe" | "taskmgr.exe" | "notepad.exe" |
            "msedge.exe" | "msedgewebview2.exe" | "chrome.exe" | "firefox.exe" | "opera.exe" |
            "steam.exe" | "steamwebhelper.exe" | "epicgameslauncher.exe" | "riotclientservices.exe" |
            "battle.net.exe" | "upc.exe" | "eadesktop.exe" | "discord.exe" | "telegram.exe" |
            "spotify.exe" | "obs64.exe" | "obs32.exe" | "vlc.exe" |
            "oliver-kitchen-desktop.exe" | "kitchat.exe" | "code.exe" | "powershell.exe" | "cmd.exe"
        )
    }

    fn pretty_name(exe: &str, title: &str) -> String {
        // Window titles are much more useful for Java/indie games than javaw.exe or game.exe.
        let title = title.trim();
        if !title.is_empty() && title.len() <= 96 {
            let lower = title.to_lowercase();
            if !lower.contains(" - google chrome") && !lower.contains(" - microsoft edge") {
                return title.to_string();
            }
        }
        let mut value = exe.trim_end_matches(".exe").to_string();
        for suffix in ["-Win64-Shipping", "-win64-shipping", "_Win64_Shipping"] {
            value = value.replace(suffix, "");
        }
        value = value.replace('_', " ").replace('-', " ");
        value.split_whitespace()
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    let mut best: Option<(i32, u64, GameActivity)> = None;
    for (pid, process) in system.processes() {
        let exe = process.name().to_string_lossy().to_lowercase();
        if ignored(&exe) { continue; }
        let command = process.cmd().iter().map(|part| part.to_string_lossy()).collect::<Vec<_>>().join(" ").to_lowercase();
        let path = process.exe().map(|path| path.to_string_lossy().to_lowercase()).unwrap_or_default();
        let title = window_titles.get(&pid.as_u32()).cloned().unwrap_or_default();
        let title_l = title.to_lowercase();
        let environment = process.environ().iter().map(|item| item.to_string_lossy().to_lowercase()).collect::<Vec<_>>();
        let steam_app = environment.iter().any(|item| item.starts_with("steamappid=") || item.starts_with("steam_app_id="));

        let known = alias(&exe, &command, &title);
        let mut score = if known.is_some() { 180 } else { 0 };
        if steam_app { score += 150; }
        if path.contains("steamapps\\common") || path.contains("steamapps/common") { score += 120; }
        if (exe.contains("win64-shipping.exe") || exe.contains("win32-shipping.exe")) && !title.is_empty() { score += 120; }
        if path.contains("epic games") || path.contains("xboxgames") || path.contains("riot games") || path.contains("gog galaxy\\games") || path.contains("gog galaxy/games") { score += 110; }
        if command.contains("minecraft") || command.contains(".minecraft") || title_l.contains("minecraft") { score += 150; }
        // A visible top-level window is supporting evidence. It is intentionally
        // insufficient on its own, so ordinary desktop apps are not reported as games.
        if !title.is_empty() { score += 25; }
        if score < 100 { continue; }

        let activity = GameActivity {
            game: known.map(str::to_string).unwrap_or_else(|| pretty_name(&exe, &title)),
            executable: exe.clone(),
            started_at: process.start_time(),
        };
        let candidate = (score, process.start_time(), activity);
        if best.as_ref().map_or(true, |current| candidate.0 > current.0 || (candidate.0 == current.0 && candidate.1 > current.1)) {
            best = Some(candidate);
        }
    }
    Ok(best.map(|(_, _, activity)| activity))
}

#[cfg(not(windows))]
#[tauri::command]
fn detect_game_activity() -> Result<Option<GameActivity>, String> { Ok(None) }

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg(windows)]
#[derive(Default)]
struct PttBinding(std::sync::Mutex<Option<String>>);

#[cfg(windows)]
#[tauri::command]
fn set_ptt_binding(binding: tauri::State<'_, PttBinding>, code: Option<String>) -> Result<(), String> {
    *binding.0.lock().map_err(|_| "Не удалось обновить клавишу PTT")? = code;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn set_ptt_binding(_code: Option<String>) -> Result<(), String> { Ok(()) }

#[cfg(windows)]
fn ptt_key_code(key: rdev::Key) -> Option<String> {
    use rdev::Key;
    let code = match key {
        Key::Space => "Space", Key::Return => "Enter", Key::Tab => "Tab", Key::Backspace => "Backspace",
        Key::UpArrow => "ArrowUp", Key::DownArrow => "ArrowDown", Key::LeftArrow => "ArrowLeft", Key::RightArrow => "ArrowRight",
        Key::Escape => "Escape", Key::Delete => "Delete", Key::Home => "Home", Key::End => "End", Key::PageUp => "PageUp", Key::PageDown => "PageDown",
        Key::KeyA => "KeyA", Key::KeyB => "KeyB", Key::KeyC => "KeyC", Key::KeyD => "KeyD", Key::KeyE => "KeyE", Key::KeyF => "KeyF",
        Key::KeyG => "KeyG", Key::KeyH => "KeyH", Key::KeyI => "KeyI", Key::KeyJ => "KeyJ", Key::KeyK => "KeyK", Key::KeyL => "KeyL",
        Key::KeyM => "KeyM", Key::KeyN => "KeyN", Key::KeyO => "KeyO", Key::KeyP => "KeyP", Key::KeyQ => "KeyQ", Key::KeyR => "KeyR",
        Key::KeyS => "KeyS", Key::KeyT => "KeyT", Key::KeyU => "KeyU", Key::KeyV => "KeyV", Key::KeyW => "KeyW", Key::KeyX => "KeyX",
        Key::KeyY => "KeyY", Key::KeyZ => "KeyZ",
        Key::Num0 => "Digit0", Key::Num1 => "Digit1", Key::Num2 => "Digit2", Key::Num3 => "Digit3", Key::Num4 => "Digit4",
        Key::Num5 => "Digit5", Key::Num6 => "Digit6", Key::Num7 => "Digit7", Key::Num8 => "Digit8", Key::Num9 => "Digit9",
        Key::F1 => "F1", Key::F2 => "F2", Key::F3 => "F3", Key::F4 => "F4", Key::F5 => "F5", Key::F6 => "F6",
        Key::F7 => "F7", Key::F8 => "F8", Key::F9 => "F9", Key::F10 => "F10", Key::F11 => "F11", Key::F12 => "F12",
        _ => return None,
    };
    Some(code.into())
}

#[derive(serde::Serialize)]
struct CaptureSource {
    id: usize,
    kind: &'static str,
    title: String,
    thumbnail: String,
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn jpeg_data(image: image::RgbaImage, width: u32, height: u32, quality: u8) -> Result<String, String> {
    use base64::Engine;
    let resized = image::DynamicImage::ImageRgba8(image).thumbnail(width, height).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&resized)
        .map_err(|error| error.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
#[cfg(windows)]
fn capture_sources() -> Result<Vec<CaptureSource>, String> {
    use windows_capture::{monitor::Monitor as WgcMonitor, window::Window as WgcWindow};
    use xcap::{Monitor as PreviewMonitor, Window as PreviewWindow};
    let mut result = Vec::new();
    let preview_windows = PreviewWindow::all().map_err(|error| error.to_string())?;
    for window in WgcWindow::enumerate().map_err(|error| error.to_string())? {
        let title = window.title().map_err(|error| error.to_string())?;
        if title.trim().is_empty() || window.width().unwrap_or(0) < 120 || window.height().unwrap_or(0) < 80 { continue; }
        let thumbnail = preview_windows.iter().find(|preview| preview.title().is_ok_and(|value| value == title))
            .and_then(|preview| preview.capture_image().ok())
            .and_then(|image| jpeg_data(image, 360, 210, 70).ok())
            .unwrap_or_default();
        result.push(CaptureSource { id: window.as_raw_hwnd() as usize, kind: "window", title, thumbnail });
    }
    let preview_monitors = PreviewMonitor::all().map_err(|error| error.to_string())?;
    for (index, monitor) in WgcMonitor::enumerate().map_err(|error| error.to_string())?.into_iter().enumerate() {
        let thumbnail = preview_monitors.get(index).and_then(|preview| preview.capture_image().ok())
            .and_then(|image| jpeg_data(image, 360, 210, 70).ok()).unwrap_or_default();
        let title = monitor.name().unwrap_or_else(|_| format!("Экран {}", index + 1));
        result.push(CaptureSource { id: monitor.as_raw_hmonitor() as usize, kind: "monitor", title, thumbnail });
    }
    Ok(result)
}

#[tauri::command]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn capture_sources() -> Result<Vec<CaptureSource>, String> {
    Err("Собственный нативный picker сейчас доступен только на Windows".into())
}

#[tauri::command]
#[cfg(windows)]
fn capture_frame(kind: String, id: usize, width: u32, height: u32, quality: u8) -> Result<String, String> {
    use xcap::{Monitor, Window};
    let image = if kind == "monitor" {
        // The picker exposes a real HMONITOR, while xcap uses its own numeric
        // monitor id. Resolve through the stable WGC enumeration order instead
        // of comparing two unrelated identifiers (which broke fallback capture).
        use windows_capture::monitor::Monitor as WgcMonitor;
        let index = WgcMonitor::enumerate().map_err(|error| error.to_string())?.into_iter()
            .position(|source| source.as_raw_hmonitor() as usize == id)
            .ok_or("Экран больше недоступен")?;
        Monitor::all().map_err(|error| error.to_string())?.into_iter().nth(index)
            .ok_or("Экран больше недоступен")?.capture_image().map_err(|error| error.to_string())?
    } else {
        Window::all().map_err(|error| error.to_string())?.into_iter()
            .find(|source| source.id().is_ok_and(|source_id| source_id == id as u32))
            .ok_or("Окно больше недоступно")?.capture_image().map_err(|error| error.to_string())?
    };
    jpeg_data(image, width.clamp(640, 3840), height.clamp(360, 2160), quality.clamp(75, 96))
}

#[tauri::command]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn capture_frame(kind: String, id: usize, width: u32, height: u32, quality: u8) -> Result<String, String> {
    use xcap::{Monitor, Window};
    let image = if kind == "monitor" {
        Monitor::all().map_err(|error| error.to_string())?.into_iter().nth(id).ok_or("Экран больше недоступен")?.capture_image().map_err(|error| error.to_string())?
    } else {
        Window::all().map_err(|error| error.to_string())?.into_iter().nth(id).ok_or("Окно больше недоступно")?.capture_image().map_err(|error| error.to_string())?
    };
    jpeg_data(image, width.clamp(640, 3840), height.clamp(360, 2160), quality.clamp(75, 96))
}

#[tauri::command]
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn capture_sources() -> Result<Vec<CaptureSource>, String> { Err("Нативный выбор источника пока доступен только на Windows".into()) }

#[tauri::command]
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn capture_frame(_kind: String, _id: usize, _width: u32, _height: u32, _quality: u8) -> Result<String, String> { Err("Нативный захват пока доступен только на Windows".into()) }

#[tauri::command]
fn tray_action(app: tauri::AppHandle, action: String) {
    use tauri::{Emitter, Manager};
    if let Some(tray_window) = app.get_webview_window("tray") {
        let _ = tray_window.hide();
    }
    match action.as_str() {
        "open" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        "updates" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("kitchat://check-update", ());
        }
        "quit" => {
            let _ = app.emit("kitchat://app-exiting", ());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1_000));
                app.exit(0);
            });
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launched_minimized = std::env::args().any(|argument| argument == "--minimized");
    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    #[cfg(windows)]
    let builder = builder.manage(PttBinding::default());
    let builder = builder.manage(native_stream::NativeStreamState::default());
    let builder = builder.manage(process_audio::ProcessAudioState::default());
    builder
        .setup(move |app| {
            use tauri::{
                tray::TrayIconBuilder,
                Manager, PhysicalPosition, Position,
            };

            #[cfg(windows)]
            {
                let app_handle = app.handle().clone();
                std::thread::Builder::new().name("kitchat-global-ptt".into()).spawn(move || {
                    use rdev::{Button, EventType};
                    use tauri::{Emitter, Manager};
                    let callback = move |event: rdev::Event| {
                        let (code, state) = match event.event_type {
                            EventType::KeyPress(key) => (ptt_key_code(key), "Pressed"),
                            EventType::KeyRelease(key) => (ptt_key_code(key), "Released"),
                            EventType::ButtonPress(button) => (Some(match button { Button::Left => "Mouse0", Button::Middle => "Mouse1", Button::Right => "Mouse2", Button::Unknown(1) => "Mouse3", Button::Unknown(2) => "Mouse4", _ => return }.into()), "Pressed"),
                            EventType::ButtonRelease(button) => (Some(match button { Button::Left => "Mouse0", Button::Middle => "Mouse1", Button::Right => "Mouse2", Button::Unknown(1) => "Mouse3", Button::Unknown(2) => "Mouse4", _ => return }.into()), "Released"),
                            _ => return,
                        };
                        let Some(code) = code else { return };
                        let binding = app_handle.state::<PttBinding>();
                        let matches = binding.0.lock().ok().and_then(|value| value.clone()).as_deref() == Some(code.as_str());
                        if matches {
                            let _ = app_handle.emit("kitchat://global-ptt", serde_json::json!({ "code": code, "state": state }));
                        }
                    };
                    if let Err(error) = rdev::listen(callback) { eprintln!("global PTT hook failed: {error:?}"); }
                })?;
            }

            TrayIconBuilder::with_id("kitchat-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("Kitchat — общение продолжается")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        position,
                        button,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        if button == tauri::tray::MouseButton::Left {
                            if let Some(tray_window) = tray.app_handle().get_webview_window("tray") {
                                let _ = tray_window.hide();
                            }
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        } else if button == tauri::tray::MouseButton::Right {
                            if let Some(window) = tray.app_handle().get_webview_window("tray") {
                                let scale = window.scale_factor().unwrap_or(1.0);
                                let popup_width = 246.0 * scale;
                                let popup_height = 184.0 * scale;
                                let monitors = window.available_monitors().unwrap_or_default();
                                let monitor = monitors.iter().find(|monitor| {
                                    let origin = monitor.position();
                                    let size = monitor.size();
                                    position.x >= origin.x as f64 && position.x < (origin.x + size.width as i32) as f64
                                        && position.y >= origin.y as f64 && position.y < (origin.y + size.height as i32) as f64
                                });
                                let (left, top, right, bottom) = monitor.map(|monitor| {
                                    let origin = monitor.position();
                                    let size = monitor.size();
                                    (origin.x as f64, origin.y as f64, (origin.x + size.width as i32) as f64, (origin.y + size.height as i32) as f64)
                                }).unwrap_or((0.0, 0.0, position.x + popup_width, position.y + popup_height));
                                let mut x = if position.x > (left + right) / 2.0 { position.x - popup_width + 18.0 } else { position.x - 18.0 };
                                let mut y = if position.y > (top + bottom) / 2.0 { position.y - popup_height - 14.0 } else { position.y + 14.0 };
                                x = x.clamp(left + 8.0, right - popup_width - 8.0);
                                y = y.clamp(top + 8.0, bottom - popup_height - 8.0);
                                let _ = window.set_position(Position::Physical(PhysicalPosition::new(x.round() as i32, y.round() as i32)));
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webview2_com::{
                        PermissionRequestedEventHandler,
                        Microsoft::Web::WebView2::Win32::{
                            COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        },
                    };

                    let controller = webview.controller();
                    let Ok(core) = (unsafe { controller.CoreWebView2() }) else { return };
                    let mut event_token = 0;
                    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = Default::default();
                        unsafe { args.PermissionKind(&mut kind)? };
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
                        }
                        Ok(())
                    }));
                    let _ = unsafe { core.add_PermissionRequested(&handler, &mut event_token) };
                })?;
            }
            if launched_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Focused(false) if window.label() == "tray" => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_system_audio::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            download_attachment,
            detect_game_activity,
            direct_messages_request,
            capture_sources,
            capture_frame,
            tray_action,
            set_ptt_binding,
            native_stream::native_stream_capabilities,
            native_stream::native_stream_validate,
            native_stream::native_stream_start,
            native_stream::native_stream_reconfigure,
            native_stream::native_stream_accept_offer,
            native_stream::native_stream_add_ice,
            native_stream::native_stream_remove_peer,
            native_stream::native_stream_stop,
            native_stream::native_stream_status,
            process_audio::process_audio_start,
            process_audio::process_audio_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
