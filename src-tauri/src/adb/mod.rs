//! TVDeck native ADB client: async TCP transport to `<TV>:5555`, CNXN/AUTH
//! RSA handshake, legacy `shell:` streams and `sync:` file push.
//!
//! Zero host-side `adb` binary involvement: this module IS the adb client.

pub mod auth;
pub mod messages;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::adb::auth::HostKey;
use messages::{
    recv_packet, send_packet, A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_WRTE,
    ADB_AUTH_RSAPUBLICKEY, ADB_AUTH_SIGNATURE, ADB_AUTH_TOKEN, HOST_MAX_PAYLOAD, VERSION,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Device may sit at the "Allow USB debugging?" dialog for a while.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(90);
const COMMAND_DEADLINE: Duration = Duration::from_secs(120);
const RECV_CAP_MAX: u32 = 256 * 1024; // hardbound recv buffer (RAM budget)

#[derive(Debug, Error)]
pub enum AdbError {
    #[error("Connection declined. The TV may be asleep, or network debugging is turned off.")]
  Unreachable {
        addr: String,
        #[source]
        source: std::io::Error,
    },
    #[error("The TV did not answer. Give it a moment, then try again.")]
    HandshakeTimeout(String),
    #[error("The TV rejected the request: {0}")]
    Device(String),
    #[error("adb wire protocol issue: {0}")]
    Wire(#[from] messages::WireError),
    #[error("unexpected frame {0:#010x} during adb handshake")]
    UnexpectedHandshakeFrame(u32),
    #[error("ADB key error: {0}")]
    Key(#[from] auth::KeyError),
    #[error("This step took too long. The TV may have gone to sleep; try again.")]
    CommandTimeout(String),
    #[error("file error: {0}")]
    File(#[from] std::io::Error),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub model: String,
    pub brand: String,
    pub android_version: String,
    pub sdk_level: String,
    pub data_partition: String,
}

pub enum HandshakeEvent {
    Connected { info: DeviceInfo },
    /// A dialog "Allow USB debugging from TVDeck?" should now be on the TV
    /// screen; surface the key fingerprint in the UI.
    AuthorizationRequired { fingerprint: String },
}

pub struct AdbDevice {
    stream: TcpStream,
    key: Arc<HostKey>,
    /// Max payload a single WRTE of ours may carry (min of both peers).
    send_payload_cap: u32,
    next_local_id: u32,
}

impl AdbDevice {
    /// Connect, authenticate (surfaces `AuthorizationRequired` while the TV
    /// shows the RSA dialog) and pull basic device identity.
    pub async fn connect(
        ip: &str,
        port: u16,
        key: Arc<HostKey>,
        on_event: &mut impl FnMut(HandshakeEvent),
    ) -> Result<AdbDevice, AdbError> {
        let addr = format!("{}:{}", ip, port);
        let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
            .await
            .map_err(|_| AdbError::Unreachable {
                addr: addr.clone(),
                source: std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout"),
            })?
            .map_err(|e| AdbError::Unreachable { addr, source: e })?;
        stream.set_nodelay(true).ok();

        let mut dev = AdbDevice {
            stream,
            key,
            send_payload_cap: HOST_MAX_PAYLOAD,
            next_local_id: 1,
        };

        // CNXN: version, advertised max payload, identity banner.
        dev.send(
            A_CNXN,
            VERSION,
            HOST_MAX_PAYLOAD,
            b"host::".to_vec(),
        )
        .await?;

        let deadline = tokio::time::Instant::now() + HANDSHAKE_DEADLINE;
        let mut signature_sent = false;

        loop {
            let pkt = recv_deadline(&mut dev.stream, deadline).await?;
            match pkt.command {
                A_CNXN => {
                    // arg1 = device's max payload for one packet.
                    let device_max = pkt.arg1.max(4096).min(RECV_CAP_MAX);
                    dev.send_payload_cap = dev.send_payload_cap.min(device_max);
                    break;
                }
                A_AUTH if pkt.arg0 == ADB_AUTH_TOKEN => {
                    if !signature_sent {
                        let sig = dev.key.sign(&pkt.payload)?;
                        dev.send(A_AUTH, ADB_AUTH_SIGNATURE, 0, sig).await?;
                        signature_sent = true;
                    } else {
                        // Signature rejected: present the public key so the
                        // confirmation dialog appears on the TV.
                        dev.send(A_AUTH, ADB_AUTH_RSAPUBLICKEY, 0, dev.key.public_key_line())
                            .await?;
                        on_event(HandshakeEvent::AuthorizationRequired {
                            fingerprint: dev.key.fingerprint().to_string(),
                        });
                    }
                }
                A_AUTH => {
                    return Err(AdbError::Device(format!(
                        "unexpected AUTH subtype {}",
                        pkt.arg0
                    )));
                }
                other => return Err(AdbError::UnexpectedHandshakeFrame(other)),
            }
        }

        let info = dev.fetch_device_info().await?;
        on_event(HandshakeEvent::Connected { info });
        Ok(dev)
    }

    async fn fetch_device_info(&mut self) -> Result<DeviceInfo, AdbError> {
        // Property names are compile-time constants: no quoting needed.
        let script = [
            "ro.product.model",
            "ro.product.brand",
            "ro.build.version.release",
            "ro.build.version.sdk",
        ]
        .iter()
        .map(|p| format!("getprop {}", p))
        .collect::<Vec<_>>()
        .join("; ");

        let raw = self.shell(&script).await?;
        let mut lines = raw.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty());

        let model = lines.next().unwrap_or_else(|| "Unknown".into());
        let brand = lines.next().unwrap_or_default();
        let android_version = lines.next().unwrap_or_default();
        let sdk_level = lines.next().unwrap_or_default();
        // Show how full /data is so users know before installing APKs.
        let df = self.shell("df /data 2>/dev/null | tail -n 1").await.unwrap_or_default();
        let data_partition = df.trim().to_string();

        Ok(DeviceInfo {
            model,
            brand,
            android_version,
            sdk_level,
            data_partition,
        })
    }

    async fn send(
        &mut self,
        command: u32,
        arg0: u32,
        arg1: u32,
        payload: Vec<u8>,
    ) -> Result<(), messages::WireError> {
        send_packet(
            &mut self.stream,
            &messages::Packet::new(command, arg0, arg1, payload),
        )
        .await
    }

    /// Run `cmd`, returning combined stdout+stderr until the remote stream
    /// closes (legacy v1 shell closes when the command exits).
    pub async fn shell(&mut self, cmd: &str) -> Result<String, AdbError> {
        match timeout(COMMAND_DEADLINE, self.raw_shell_loop(cmd)).await {
            Ok(r) => r.map_err(Into::into),
            Err(_elapsed) => Err(AdbError::CommandTimeout(cmd.to_string())),
        }
    }

    async fn raw_shell_loop(&mut self, cmd: &str) -> Result<String, messages::WireError> {
        let local = self.next_local_id;
        self.next_local_id += 1;

        let mut open_payload = Vec::with_capacity(cmd.len() + 6);
        open_payload.extend_from_slice(b"shell:");
        open_payload.extend_from_slice(cmd.as_bytes());
        send_packet(
            &mut self.stream,
            &messages::Packet::new(A_OPEN, local, 0, open_payload),
        )
        .await?;

        let mut out: Vec<u8> = Vec::new();
        loop {
            let pkt = recv_packet(&mut self.stream, RECV_CAP_MAX).await?;
            match pkt.command {
                A_OKAY if pkt.arg0 == local => { /* stream established */ }
                A_WRTE if pkt.arg1 == local => {
                    out.extend_from_slice(&pkt.payload);
                    send_packet(
                        &mut self.stream,
                        &messages::Packet::new(A_OKAY, local, pkt.arg0, Vec::new()),
                    )
                    .await?;
                }
                A_CLSE if pkt.arg1 == local => break,
                // Very old adbd builds close with 0/0 args.
                A_CLSE => break,
                other => {
                    return Err(messages::WireError::CorruptMagic(other));
                }
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

async fn recv_deadline(
    stream: &mut TcpStream,
    deadline: tokio::time::Instant,
) -> Result<messages::Packet, AdbError> {
    match tokio::time::timeout_at(deadline, recv_packet(stream, RECV_CAP_MAX)).await {
        Ok(Ok(pkt)) => Ok(pkt),
        Ok(Err(e)) => Err(e.into()),
        Err(_elapsed) => Err(AdbError::HandshakeTimeout(
            "timeout waiting for TV response during handshake".into(),
        )),
    }
}
