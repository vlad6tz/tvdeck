//! TVDeck backend binary + Tauri IPC surface.
//!
//! Commands: `connect_device`, `scan_lan`, `apply_preset`, `install_apk`
//! (+ small helpers: `run_shell`, `get_presets`, `disconnect`).
//!
//! ADB / discovery / preset logic lives in the sibling modules so Tauri
//! stays a thin transport shell here.

pub mod adb;
pub mod discovery;
pub mod presets;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use tokio::sync::Mutex;

use adb::{AdbDevice, DeviceInfo, HandshakeEvent};

const CONNECT_PORT: u16 = 5555;

#[derive(Default)]
pub struct AppState {
    /// The one live device connection (single-TV UX; reconnecting a new
    /// device replaces the old stream).
    device: Mutex<Option<AdbDevice>>,
    /// Lazily built RSA host key, reused across reconnects.
    host_key: tokio::sync::OnceCell<Arc<adb::auth::HostKey>>,
}

#[derive(Debug, serde::Serialize)]
pub struct ScanEntry {
    ip: String,
    name: Option<String>,
    /// "mdns" or "tcp" (subnet port-5555 sweep).
    source: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ConnectResult {
    ok: bool,
    info: Option<DeviceInfo>,
    /// Our key fingerprint (matches the number the TV dialog shows).
    fingerprint: Option<String>,
    error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct PresetResult {
    preset_id: String,
    steps: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
async fn scan_lan() -> Result<Vec<ScanEntry>, String> {
    let found = discovery::discover().await.map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|d| ScanEntry {
            ip: d.ip,
            name: d.name,
            source: d.source,
        })
        .collect())
}

#[tauri::command]
async fn connect_device(state: State<'_, AppState>, ip: String) -> Result<ConnectResult, String> {
    let ip = ip.trim().to_string();
    if ip.parse::<std::net::Ipv4Addr>().is_err() {
        return Ok(failed(format!("'{}' is not a valid IPv4 address", ip), None));
    }

    let key = host_key(&state).await?;

    // The connect callback runs inside the handshake: use shared cells so
    // the closure (sync) can report without blocking the await.
    let pending_auth = Arc::new(Mutex::<Option<String>>::new(None));
    let info_holder = Arc::new(Mutex::<Option<DeviceInfo>>::new(None));

    let pending_cb = pending_auth.clone();
    let info_cb = info_holder.clone();
    let device = match AdbDevice::connect(&ip, CONNECT_PORT, key, &mut move |ev| match ev {
        HandshakeEvent::AuthorizationRequired { fingerprint } => {
            pending_cb.try_lock().ok().map(|mut slot| *slot = Some(fingerprint));
        }
        HandshakeEvent::Connected { info } => {
            info_cb.try_lock().ok().map(|mut slot| *slot = Some(info));
        }
    })
    .await
    {
        Ok(d) => d,
        Err(e) => {
            // If the fingerprint surfaced, the TV was waiting on the user's
            // on-screen "Allow USB debugging?" approval.
            let fp = pending_auth.lock().await.take();
            let mut text = e.to_string();
            if fp.is_some() {
                text.push_str(
                    "\n→ Accept the 'Allow USB debugging' dialog on the TV, then press Connect again.",
                );
            }
            return Ok(ConnectResult {
                ok: false,
                info: None,
                fingerprint: fp,
                error: Some(text),
            });
        }
    };

    // Store the connection; the frontend asks nothing else to go live.
    *state.device.lock().await = Some(device);

    let info = info_holder.lock().await.clone();
    Ok(ConnectResult {
        ok: true,
        info,
        fingerprint: None,
        error: None,
    })
}

fn failed(err: String, fp: Option<String>) -> ConnectResult {
    ConnectResult {
        ok: false,
        info: None,
        fingerprint: fp,
        error: Some(err),
    }
}


#[tauri::command]
async fn apply_preset(state: State<'_, AppState>, preset_id: String) -> Result<PresetResult, String> {
    let preset = presets::catalog()
        .into_iter()
        .find(|p| p.id == preset_id)
        .ok_or(format!("unknown preset id '{}'", preset_id))?;

    let mut slot = state.device.lock().await;
    let device = slot
        .as_mut()
        .ok_or_else(|| "No TV connected. Connect to a TV first.".to_string())?;

    run_preset(device, preset).await
}

#[tauri::command]
async fn grant_launcher(
    state: State<'_, AppState>,
    package: String,
) -> Result<PresetResult, String> {
    if package.trim().is_empty() || !package.trim().chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err("package name contains unsafe characters".into());
    }
    let mut slot = state.device.lock().await;
    let device = slot
        .as_mut()
        .ok_or_else(|| "No TV connected. Connect to a TV first.".to_string())?;
    run_preset(device, presets::launcher_preset(&package.trim())).await
}

async fn run_preset(device: &mut AdbDevice, preset: presets::Preset) -> Result<PresetResult, String> {
    let mut result = PresetResult {
        preset_id: preset.id.clone(),
        steps: Vec::new(),
        error: None,
    };
    for cmd in &preset.commands {
        match device.shell(&cmd.cmd).await {
            Ok(out) => {
                // `pm disable-user` / `pm grant` print nothing on success;
                // anything that IS printed is almost surely the error text.
                let trimmed = out.trim().to_string();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("Success") {
                    result.steps.push(format!("{}: OK", cmd.cmd));
                } else {
                    result.steps.push(format!("{}: {}", cmd.cmd, trimmed));
                }
            }
            Err(e) => {
                result.error = Some(format!("{} failed: {}", cmd.cmd, e));
                return Ok(result);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
async fn install_apk(state: State<'_, AppState>, apk_path: String) -> Result<PresetResult, String> {
    let path = PathBuf::from(apk_path.trim_matches('"'));
    if !path.is_file() {
        return Err(format!("not a readable file: {}", path.display()));
    }
    if path.extension().and_then(|e| e.to_str()) != Some("apk") {
        return Err("Please choose a valid Android TV .apk file.".into());
    }

    let mut slot = state.device.lock().await;
    let device = slot
        .as_mut()
        .ok_or_else(|| "No TV connected. Connect to a TV first.".to_string())?;

    let out = device.install_apk(&path).await.map_err(|e| e.to_string())?;
    Ok(PresetResult {
        preset_id: "install-apk".into(),
        steps: out
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect(),
        error: None,
    })
}

#[tauri::command]
async fn run_shell(state: State<'_, AppState>, cmd: String) -> Result<String, String> {
    let cmd = cmd.trim().to_string();
    if cmd.is_empty() || cmd.contains(';') || cmd.contains("&&") || cmd.contains('|') {
        return Err("compound shell input ( ; && | ) is not allowed from the console".into());
    }
    let mut slot = state.device.lock().await;
    let device = slot
        .as_mut()
        .ok_or_else(|| "No TV connected. Connect to a TV first.".to_string())?;
    device.shell(&cmd).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_presets() -> Result<Vec<presets::Preset>, String> {
    Ok(presets::catalog())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<bool, String> {
    *state.device.lock().await = None;
    Ok(true)
}

async fn host_key(state: &State<'_, AppState>) -> Result<Arc<adb::auth::HostKey>, String> {
    let dir = key_dir()
        .ok_or_else(|| "cannot resolve the home directory to store the ADB key".to_string())?;
    if let Some(k) = state.host_key.get() {
        return Ok(k.clone());
    }
    let key = adb::auth::HostKey::load_or_generate(dir)
        .await
        .map_err(|e| e.to_string())?;
    let _ = state.host_key.set(key.clone());
    Ok(key)
}

/// `~/.config/tvdeck` (respects XDG-ish convention, works on Win/mac).
fn key_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".config").join("tvdeck"))
}

pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_lan,
            connect_device,
            apply_preset,
            install_apk,
            run_shell,
            get_presets,
            grant_launcher,
            disconnect
        ])
        .run(tauri::generate_context!())
        .expect("TVDeck failed to start");
}

#[cfg(test)]
mod tests {
    use super::presets;

    #[test]
    fn catalog_has_core_presets() {
        let catalog = presets::catalog();
        let ids: Vec<&str> = catalog.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"xiaomi-debloat"));
        assert!(ids.contains(&"background-ram-opt"));
        assert!(ids.contains(&"animation-speedup"));
    }

    #[test]
    fn launcher_preset_grants_secure_settings() {
        let p = presets::launcher_preset("com.spocky.projtv");
        assert!(p
            .commands
            .iter()
            .any(|c| c.cmd.contains("pm grant com.spocky.projtv android.permission.WRITE_SECURE_SETTINGS")));
    }
}
