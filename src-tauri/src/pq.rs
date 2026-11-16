use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};


use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::profiles;

mod crypto;
mod engine;
#[cfg(feature = "pq-fault-tests")]
mod fault;
mod v2;
pub use engine::PqEngine;

const MLKEM_PUBLIC_KEY_BYTES: usize = 1184;
const MLKEM_SECRET_KEY_BYTES: usize = 2400;
const MLKEM_CIPHERTEXT_BYTES: usize = 1088;
const MLKEM_SHARED_SECRET_BYTES: usize = 32;

const PACKET_ID: u8 = 180;
#[derive(Clone, Serialize)]
pub struct PqStatus {
    pub identity_needs_entropy: bool,
    pub identity_waiting: bool,
    pub auto_pending: bool,
    pub manual_waiting_for_capability: bool,
    pub protocol_version: u8,
    pub shutdown_state: String,
    pub shutdown_cancellable: bool,
    pub shutdown_error: Option<String>,
    pub supported: bool,
    pub state: String,
    pub local_fingerprint: String,
    pub peer_fingerprint: Option<String>,
    pub fingerprint_changed: bool,
    pub error: Option<String>,
}

pub struct PacketResult {
    pub received_wire_id: Option<u64>,
    pub outgoing: Vec<Vec<u8>>,
    pub received_text: Option<String>,
    pub acknowledged_wire_id: Option<u64>,
    pub session_event: Option<PqSessionEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PqSessionEvent {
    OfferReceived,
    Active,
    Rejected,
    CloseRequested,
    Closed,
}

pub struct EncryptedMessage {
    #[cfg(test)]
    pub wire_id: u64,
    pub packets: Vec<Vec<u8>>,
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Некорректный hex в PQ identity".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Некорректный PQ hex".to_string())
        })
        .collect()
}

fn mlkem_keypair() -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut public_key = vec![0_u8; MLKEM_PUBLIC_KEY_BYTES];
    let mut secret_key = vec![0_u8; MLKEM_SECRET_KEY_BYTES];
    // SAFETY: Both output buffers are live, separate, and sized for ML-KEM-768.
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_keypair(public_key.as_mut_ptr(), secret_key.as_mut_ptr())
    };
    if result == 0 {
        Ok((public_key, secret_key))
    } else {
        crypto::wipe(&mut secret_key);
        Err(format!("mlkem-native keypair завершился с кодом {result}"))
    }
}

fn mlkem_encaps(public_key: &[u8]) -> Result<(Vec<u8>, [u8; 32]), String> {
    let public_key = <&[u8; MLKEM_PUBLIC_KEY_BYTES]>::try_from(public_key)
        .map_err(|_| "Некорректная длина ML-KEM-768 public key".to_string())?;
    let mut ciphertext = vec![0_u8; MLKEM_CIPHERTEXT_BYTES];
    let mut shared = [0_u8; MLKEM_SHARED_SECRET_BYTES];
    // SAFETY: The borrowed input and both separate output buffers have the
    // exact sizes required by this ML-KEM-768 call.
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_enc(
            ciphertext.as_mut_ptr(),
            shared.as_mut_ptr(),
            public_key.as_ptr(),
        )
    };
    if result == 0 {
        Ok((ciphertext, shared))
    } else {
        crypto::wipe(&mut shared);
        Err(format!("mlkem-native encaps завершился с кодом {result}"))
    }
}

fn mlkem_decaps(secret_key: &[u8], ciphertext: &[u8]) -> Result<[u8; 32], String> {
    let (Ok(secret_key), Ok(ciphertext)) = (
        <&[u8; MLKEM_SECRET_KEY_BYTES]>::try_from(secret_key),
        <&[u8; MLKEM_CIPHERTEXT_BYTES]>::try_from(ciphertext),
    ) else {
        return Err("Некорректный материал ML-KEM-768".to_string());
    };
    let mut shared = [0_u8; MLKEM_SHARED_SECRET_BYTES];
    // SAFETY: The borrowed inputs and separate output have the native sizes.
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_dec(
            shared.as_mut_ptr(),
            ciphertext.as_ptr(),
            secret_key.as_ptr(),
        )
    };
    if result == 0 {
        Ok(shared)
    } else {
        crypto::wipe(&mut shared);
        Err(format!("mlkem-native decaps завершился с кодом {result}"))
    }
}

fn aes_gcm_encrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid AES-256-GCM key length".to_string())?;
    cipher
        .encrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Failed to encrypt PQ message with AES-GCM".to_string())
}

fn aes_gcm_decrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    if encrypted.len() < 16 {
        return Err("Truncated AES-GCM ciphertext".to_string());
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid AES-256-GCM key length".to_string())?;
    cipher
        .decrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: encrypted,
                aad,
            },
        )
        .map_err(|_| "PQ message failed AES-GCM authentication".to_string())
}

/// Fills the ML-KEM caller's buffer with bytes from the operating system.
#[export_name = "kaigen_mlkem_randombytes"]
unsafe extern "C" fn randombytes(output: *mut u8, output_len: usize) -> i32 {
    if output.is_null() || output_len > isize::MAX as usize {
        return -1;
    }
    // SAFETY: mlkem-native supplies an exclusively writable buffer of output_len
    // bytes for this call. Its contents need not have been initialized.
    let output = unsafe {
        std::slice::from_raw_parts_mut(output.cast::<std::mem::MaybeUninit<u8>>(), output_len)
    };
    if getrandom::fill_uninit(output).is_ok() {
        0
    } else {
        -1
    }
}


unsafe extern "C" {
    fn PQCP_MLKEM_NATIVE_MLKEM768_keypair(public_key: *mut u8, secret_key: *mut u8) -> i32;
    fn PQCP_MLKEM_NATIVE_MLKEM768_enc(
        ciphertext: *mut u8,
        shared_secret: *mut u8,
        public_key: *const u8,
    ) -> i32;
    fn PQCP_MLKEM_NATIVE_MLKEM768_dec(
        shared_secret: *mut u8,
        ciphertext: *const u8,
        secret_key: *const u8,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn mlkem_native_round_trip_and_serialized_public_key_layout() {
        let (public_key, secret_key) = mlkem_keypair().unwrap();
        assert_eq!(
            &secret_key[1152..1152 + MLKEM_PUBLIC_KEY_BYTES],
            public_key.as_slice()
        );
        let (ciphertext, shared_secret) = mlkem_encaps(&public_key).unwrap();
        let recovered = mlkem_decaps(&secret_key, &ciphertext).unwrap();
        assert_eq!(recovered, shared_secret);
    }

    #[test]
    fn aes_gcm_detects_tampering() {
        let key = [7_u8; 32];
        let nonce = [9_u8; 12];
        let aad = b"Tox-PQ test metadata";
        let plaintext = "Проверка целостности 🔐".as_bytes();
        let encrypted = aes_gcm_encrypt(&key, &nonce, aad, plaintext).unwrap();
        assert_eq!(
            aes_gcm_decrypt(&key, &nonce, aad, &encrypted).unwrap(),
            plaintext
        );
        let mut tampered = encrypted;
        tampered[0] ^= 1;
        assert!(aes_gcm_decrypt(&key, &nonce, aad, &tampered).is_err());
    }

}
