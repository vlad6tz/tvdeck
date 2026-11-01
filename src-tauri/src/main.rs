//! TVDeck backend binary + Tauri IPC surface.
//!
//! Commands: `connect_device`, `scan_lan`.
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
            connect_device
        ])
        .run(tauri::generate_context!())
        .expect("TVDeck failed to start");
}
