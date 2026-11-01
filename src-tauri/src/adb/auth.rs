//! TVDeck ADB host key: RSA-2048 generation, PKCS#8 persistence and the
//! mincrypt RSAPublicKey public-key serialization adbd consumes.
//!
//! Wire format (reference: packages/modules/adb crypto key encoding):
//!   base64( len(u32 LE)=64 | n0inv(u32 LE) | n(256B LE) | rr(256B LE) | e(u32 LE) )
//!   followed by ` <name>`; the AUTH packet payload appends a trailing NUL.
//!
//! AUTH tokens are signed with RSASSA PKCS#1 v1.5 over a SHA-1 digest.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::rngs::OsRng;
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rsa::sha2::Sha256;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use sha1::{Digest, Sha1};
use thiserror::Error;

const KEY_BITS: usize = 2048;
const MODULUS_SIZE: usize = 256; // bytes
const MODULUS_WORDS: u32 = 64; // 256 bytes / 4
const ENCODED_SIZE: usize = 4 + 4 + MODULUS_SIZE + MODULUS_SIZE + 4; // 524
const TOKEN_LEN: usize = 20; // SHA-1 digest size adbd always sends

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("RSA key operation failed: {0}")]
    Rsa(#[from] rsa::Error),
    #[error("key store error: {0}")]
    Io(#[from] std::io::Error),
    #[error("stored ADB key is not RSA-2048 (modulus {0} bits)")]
    UnsupportedModulus(usize),
    #[error("AUTH token has bad length {} (expected 20)", _0)]
    BadToken(usize),
}

/// A private ADB host key: signs AUTH tokens, exposes the public half in
/// adbd-approved form plus a SHA-256 fingerprint for the UI.
pub struct HostKey {
    private: RsaPrivateKey,
    public_key_wire: Vec<u8>,
    fingerprint: String,
}

impl std::fmt::Debug for HostKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostKey")
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

impl HostKey {
    /// Load the persisted key from `dir`, generating and saving a new
    /// RSA-2048 one (ADB pins the wire format) if absent.
    pub async fn load_or_generate(dir: PathBuf) -> Result<Arc<HostKey>, KeyError> {
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&dir)?;
            let priv_path = dir.join("tvdeck_adbkey");
            let private = match fs::read(&priv_path) {
                Ok(pem) => RsaPrivateKey::from_pkcs8_pem(&String::from_utf8_lossy(&pem))
                    .map_err(rsa::Error::Pkcs8)?,
                Err(_) => {
                    let generated = RsaPrivateKey::new(&mut OsRng, KEY_BITS)?;
                    let pem = generated
                        .to_pkcs8_pem(LineEnding::LF)
                        .map_err(rsa::Error::Pkcs8)?;
                    fs::write(&priv_path, pem.as_str())?;
                    generated
                }
            };
            HostKey::from_private(private).map(Arc::new)
        })
        .await
        .expect("key task panicked")
    }

    fn from_private(private: RsaPrivateKey) -> Result<HostKey, KeyError> {
        let pub_rsa = RsaPublicKey::from(&private);
        let bits = pub_rsa.n().bits();
        if bits != KEY_BITS {
            return Err(KeyError::UnsupportedModulus(bits));
        }
        let blob = mincrypt_struct(&pub_rsa);
        let mut wire = B64.encode(blob);
        wire.push(' ');
        wire.push_str("tvdeck");
        wire.push('\0'); // NUL terminator travels inside the AUTH packet

        let fp_bytes = Sha256::digest(&wire[..wire.len() - 1]);
        let fingerprint = fp_bytes
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(":");

        Ok(HostKey {
            private,
            public_key_wire: wire.into_bytes(),
            fingerprint,
        })
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Full AUTH packet payload: base64 pubkey line + ` tvdeck` + NUL.
    pub fn public_key_line(&self) -> Vec<u8> {
        self.public_key_wire.clone()
    }

    /// RSASSA PKCS#1 v1.5 / SHA-1 over the device token (blinded).
    pub fn sign(&self, token: &[u8]) -> Result<Vec<u8>, KeyError> {
        if token.len() != TOKEN_LEN {
            return Err(KeyError::BadToken(token.len()));
        }
        let digest = Sha1::digest(token);
        self.private
            .sign(Pkcs1v15Sign::new::<Sha1>(), digest.as_slice())
            .map_err(KeyError::Rsa)
    }
}

/// 524-byte little-endian mincrypt struct adbd reads with vanilla ints.
fn mincrypt_struct(pub_key: &RsaPublicKey) -> [u8; ENCODED_SIZE] {
    let n = pub_key.n().to_bytes_le();
    let mut n_le = [0u8; MODULUS_SIZE];
    n_le
        .as_mut_slice()
        .iter_mut()
        .zip(n.iter())
        .for_each(|(out, &inb)| *out = inb);

    // n0inv = -(n^-1 mod 2^32); Montgomery reduction constant. Only defined
    // for odd modulus, which any RSA modulus is.
    let n0 = u32::from_le_bytes(n_le[..4].try_into().unwrap());
    let n0inv = neg_inverse_mod_2_32(n0);

    // R = 2^(MODULUS_SIZE*8); rr = R^2 mod n, little-endian.
    let rr = (BigUint::from(1u32) << (MODULUS_SIZE * 16)) % pub_key.n();
    let rr_bytes = rr.to_bytes_le();
    let mut rr_le = [0u8; MODULUS_SIZE];
    for (i, &b) in rr_bytes.iter().take(MODULUS_SIZE).enumerate() {
        rr_le[i] = b;
    }

    let e = pub_key.e().to_bytes_le();
    let mut e_le = [0u8; 4];
    e_le[..e.len().min(4)].copy_from_slice(&e[..e.len().min(4)]);

    let mut out = [0u8; ENCODED_SIZE];
    out[0..4].copy_from_slice(&MODULUS_WORDS.to_le_bytes());
    out[4..8].copy_from_slice(&n0inv.to_le_bytes());
    out[8..8 + MODULUS_SIZE].copy_from_slice(&n_le);
    out[8 + MODULUS_SIZE..8 + 2 * MODULUS_SIZE].copy_from_slice(&rr_le);
    out[8 + 2 * MODULUS_SIZE..].copy_from_slice(&e_le);
    out
}

/// Hensel lift: each round doubles correct bits, 3→6→12→24→48.
fn neg_inverse_mod_2_32(n0: u32) -> u32 {
    let mut inv = n0;
    for _ in 0..4 {
        inv = inv.wrapping_mul(2u32.wrapping_sub(n0.wrapping_mul(inv)));
    }
    inv.wrapping_neg()
}
