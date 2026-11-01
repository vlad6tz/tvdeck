//! ADB wire framing: `apacket` i/o on a raw TCP transport.
//!
//! Message header (24 bytes, all little-endian):
//!   [0]  u32 command magic (`A_CNXN`, `A_AUTH`, `A_OPEN`, `A_OKAY`, `A_WRTE`, `A_CLSE`)
//!   [4]  u32 arg0
//!   [8]  u32 arg1
//!   [12] u32 data_length
//!   [16] u32 data_checksum (sum of payload bytes)
//!   [20] u32 magic (command ^ 0xFFFFFFFF)
//!
//! Reference: packages/modules/adb/protocol.h, adb_io.cpp (AOSP).

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const VERSION: u32 = 0x0100_0001;
/// Host-side advertised max payload. adbd historically uses 4096 and
/// up to 256 KiB on newer versions; 8192 keeps buffers tame on Mi Boxes.
pub const HOST_MAX_PAYLOAD: u32 = 8192;

pub const A_CNXN: u32 = 0x434E_584E; // "CNXN"
pub const A_AUTH: u32 = 0x4155_5448; // "AUTH"
pub const A_OPEN: u32 = 0x4F50_454E; // "OPEN"
pub const A_OKAY: u32 = 0x4F4B_4159; // "OKAY"
pub const A_CLSE: u32 = 0x434C_5345; // "CLSE"
pub const A_WRTE: u32 = 0x5752_5445; // "WRTE"

pub const ADB_AUTH_TOKEN: u32 = 1; // device -> host, payload = token to sign
pub const ADB_AUTH_SIGNATURE: u32 = 2; // host -> device, payload = RSASSA-PKCS1-v1_5/SHA-1(token)
pub const ADB_AUTH_RSAPUBLICKEY: u32 = 1; // host -> device, payload = adbkey.pub line + NUL

#[derive(Debug, Clone)]
pub struct Packet {
    pub command: u32,
    pub arg0: u32,
    pub arg1: u32,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn new(command: u32, arg0: u32, arg1: u32, payload: Vec<u8>) -> Self {
        Packet {
            command,
            arg0,
            arg1,
            payload,
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "{:04X} arg0={} arg1={} len={}",
            self.command,
            self.arg0,
            self.arg1,
            self.payload.len()
        )
    }
}

pub fn checksum(payload: &[u8]) -> u32 {
    payload.iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32))
}

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("ADB header desynchronized (bad magic 0x{0:08X})")]
    CorruptMagic(u32),
    #[error("ADB packet claims {0} byte payload, exceeding negotiated cap")]
    PayloadTooLarge(u32),
    #[error("ADB packet checksum mismatch")]
    ChecksumMismatch,
    #[error("socket/i-o error: {0}")]
    Io(#[from] io::Error),
}

impl WireError {
    /// Payload length exceeded the negotiated cap — the stream is unusable.
    fn corrupt(_command: u32, len: u32) -> WireError {
        WireError::PayloadTooLarge(len)
    }
}

/// Header fields on the wire (LE).
fn encode_header(command: u32, arg0: u32, arg1: u32, len: u32, sum: u32) -> [u8; 24] {
    let mut h = [0u8; 24];
    h[0..4].copy_from_slice(&command.to_le_bytes());
    h[4..8].copy_from_slice(&arg0.to_le_bytes());
    h[8..12].copy_from_slice(&arg1.to_le_bytes());
    h[12..16].copy_from_slice(&len.to_le_bytes());
    h[16..20].copy_from_slice(&sum.to_le_bytes());
    h[20..24].copy_from_slice(&(!command).to_le_bytes());
    h
}

pub async fn send_packet(stream: &mut TcpStream, pkt: &Packet) -> Result<(), WireError> {
    let sum = checksum(&pkt.payload);
    let header = encode_header(
        pkt.command,
        pkt.arg0,
        pkt.arg1,
        pkt.payload.len() as u32,
        sum,
    );
    stream.write_all(&header).await?;
    if !pkt.payload.is_empty() {
        stream.write_all(&pkt.payload).await?;
    }
    Ok(())
}

pub async fn recv_packet(stream: &mut TcpStream, max_payload: u32) -> Result<Packet, WireError> {
    let mut header = [0u8; 24];
    stream.read_exact(&mut header).await?;

    let rd_u32 = |off: usize| u32::from_le_bytes(header[off..off + 4].try_into().unwrap());
    let command = rd_u32(0);
    let magic = rd_u32(20);

    // Lenient check: some adbd builds frame everything correctly but a
    // desynchronized socket returns garbage; fail cleanly instead of
    // trying to allocate `data_length` gigabytes of garbage.
    if magic != !command {
        return Err(WireError::CorruptMagic(command));
    }

    let arg0 = rd_u32(4);
    let arg1 = rd_u32(8);
    let len = rd_u32(12) as usize;
    let sum = rd_u32(16);

    if len > max_payload as usize {
        return Err(WireError::corrupt(command, len as u32));
    }

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await?;

    if checksum(&payload) != sum {
        return Err(WireError::ChecksumMismatch);
    }

    Ok(Packet::new(command, arg0, arg1, payload))
}

