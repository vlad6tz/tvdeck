//! LAN discovery: mDNS browsing (`_androidtvremote2._tcp`, `_adb._tcp`)
//! plus an async subnet sweep probing TCP 5555 — catches dumb-fire TVs
//! that never answer mDNS (older Xiaomi/FireTV builds especially).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("mDNS subsystem unavailable: {0}")]
    Mdns(String),
    #[error("cannot determine the machine's LAN subnet")]
    NoNetwork,
}

#[derive(Debug, Clone, Serialize)]
pub struct TvDevice {
    pub ip: String,
    /// Model/name from mDNS TXT if advertised, else `None`.
    pub name: Option<String>,
    /// `mdns` when found via service records, `tcp` via port sweep.
    pub source: String,
}

const ANDROID_TV_TYPES: [&str; 2] = ["_androidtvremote2._tcp.local.", "_adb._tcp.local."];
const SWEEP_PORT: u16 = 5555;
const SWEEP_CONCURRENCY: usize = 96;
const PER_IP_TIMEOUT: Duration = Duration::from_millis(600);
const MDNS_WINDOW: Duration = Duration::from_secs(4);

/// Discover TVs on the LAN. mDNS first, subnet sweep to fill gaps.
pub async fn discover() -> Result<Vec<TvDevice>, DiscoveryError> {
    let mut by_ip: HashMap<String, TvDevice> = HashMap::new();

    if let Ok(mdns_hits) = mdns_browse(ANDROID_TV_TYPES).await {
        for hit in mdns_hits {
            by_ip.entry(hit.ip.clone()).or_insert(hit);
        }
    }

    if let Ok(subnet_hits) = sweep_subnet().await {
        for hit in subnet_hits {
            by_ip
                .entry(hit.ip.clone())
                .or_insert(hit);
        }
    }

    let mut found: Vec<TvDevice> = by_ip.into_values().collect();
    found.sort_by(|a, b| a.ip.cmp(&b.ip));
    Ok(found)
}

async fn mdns_browse(service_types: [&str; 2]) -> Result<Vec<TvDevice>, DiscoveryError> {
    let daemon = ServiceDaemon::new().map_err(|e| DiscoveryError::Mdns(e.to_string()))?;
    let mut found: HashMap<String, TvDevice> = HashMap::new();

    let mut receivers = Vec::new();
    for ty in service_types {
        match daemon.browse(ty) {
            Ok(rx) => receivers.push(rx),
            Err(_) => continue,
        }
    }

    let deadline = tokio::time::Instant::now() + MDNS_WINDOW;
    for rx in receivers.iter_mut() {
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, rx.recv_async()).await {
                Ok(Ok(ServiceEvent::ServiceResolved(info))) => {
                    if let Some(dev) = to_tv_device(&info) {
                        found.insert(dev.ip.clone(), dev);
                    }
                }
                Ok(Ok(_)) => continue,
                Ok(Err(_)) | Err(_) => break,
            }
        }
    }
    daemon.stop_browse("_all_").ok();
    Ok(found.into_values().collect())
}

fn to_tv_device(info: &ServiceInfo) -> Option<TvDevice> {
    let ip = info
        .get_addresses()
        .iter()
        .next()
        .map(|a| a.to_string())?;
    let name = info
        .get_property_val_str("model")
        .map(|s| s.to_string())
        .or_else(|| Some(info.get_fullname().to_string()));
    Some(TvDevice {
        ip,
        name,
        source: "mdns".into(),
    })
}

/// Async multithreaded sweep of every /24 host on the default interface,
/// trying `connect` on 5555. Success = an adb daemon answered.
async fn sweep_subnet() -> Result<Vec<TvDevice>, DiscoveryError> {
    let local_ip = local_ip_address::local_ip().map_err(|_| DiscoveryError::NoNetwork)?;
    let octets = match local_ip {
        IpAddr::V4(v4) => v4.octets(),
        IpAddr::V6(_) => return Err(DiscoveryError::NoNetwork),
    };
    let base = [octets[0], octets[1], octets[2], 0];

    let semaphore = Arc::new(Semaphore::new(SWEEP_CONCURRENCY));
    let mut handles = Vec::new();
    for host in 1..255u32 {
        let ip = Ipv4Addr::from(
            u32::from(Ipv4Addr::from(base)) + host,
        );
        let permit = semaphore.clone().acquire_owned().await.ok();
        handles.push(tokio::spawn(async move {
            // Permit released once the task finishes either way.
            let _permit = permit;
            let addr = format!("{}:{}", ip, SWEEP_PORT);
            match timeout(PER_IP_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(_stream)) => Some(TvDevice {
                    ip: ip.to_string(),
                    name: None,
                    source: "tcp".into(),
                }),
                _ => None,
            }
        }));
    }

    let mut hits = Vec::new();
    for h in handles {
        if let Ok(Some(dev)) = h.await {
            hits.push(dev);
        }
    }
    Ok(hits)
}
