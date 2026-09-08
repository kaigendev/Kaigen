//! Cryptographic building blocks for the durable PQ session protocol.
//!
//! X25519 is provided by the already pinned libsodium 1.0.22 build. New
//! long-term ML-KEM identities may incorporate a caller-provided digest of
//! local interaction timing as HMAC_DRBG personalization. The operating
//! system CSPRNG remains the complete entropy source in every case.

use sha2::{Digest, Sha256};
use std::sync::atomic::{compiler_fence, Ordering};
use std::sync::OnceLock;

const X25519_BYTES: usize = 32;
const MLKEM_KEYPAIR_COINS_BYTES: usize = 64;
const OPTIONAL_NOISE_DIGEST_BYTES: usize = 32;
const MAX_DRBG_BYTES_PER_REQUEST: usize = 1 << 16;
const MAX_DRBG_RESEED_INTERVAL: u64 = 1 << 48;
const IDENTITY_PERSONALIZATION: &[u8] = b"Kaigen PQ identity ML-KEM-768 v2\0";

/// Best-effort erasure for short-lived secret buffers.
///
/// Volatile stores plus the compiler fence keep the writes observable to the
/// optimizer. Callers must still avoid cloning secret material unnecessarily.
#[inline(never)]
pub(super) fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

pub(super) fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut key_block = [0_u8; 64];
    if key.len() > key_block.len() {
        let mut key_hash: [u8; 32] = Sha256::digest(key).into();
        key_block[..key_hash.len()].copy_from_slice(&key_hash);
        wipe(&mut key_hash);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..key_block.len() {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let mut inner_hash: [u8; 32] = inner.finalize().into();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let result = outer.finalize().into();

    wipe(&mut key_block);
    wipe(&mut inner_pad);
    wipe(&mut outer_pad);
    wipe(&mut inner_hash);
    result
}

/// HMAC_DRBG with SHA-256 as specified by NIST SP 800-90A Rev. 1 section 10.1.2.
///
/// This narrow implementation is used only to turn a fresh OS entropy input,
/// fresh OS nonce, and optional personalization into the 64 uniform bytes
/// required by ML-KEM.KeyGen_Internal.
struct HmacDrbg {
    key: [u8; 32],
    value: [u8; 32],
    reseed_counter: u64,
}

impl HmacDrbg {
    fn instantiate(entropy_input: &[u8], nonce: &[u8], personalization: &[u8]) -> Self {
        let mut drbg = Self {
            key: [0_u8; 32],
            value: [1_u8; 32],
            reseed_counter: 1,
        };
        let mut seed_material =
            Vec::with_capacity(entropy_input.len() + nonce.len() + personalization.len());
        seed_material.extend_from_slice(entropy_input);
        seed_material.extend_from_slice(nonce);
        seed_material.extend_from_slice(personalization);
        drbg.update(&seed_material);
        wipe(&mut seed_material);
        drbg
    }

    fn update(&mut self, provided_data: &[u8]) {
        let mut input = Vec::with_capacity(self.value.len() + 1 + provided_data.len());
        input.extend_from_slice(&self.value);
        input.push(0x00);
        input.extend_from_slice(provided_data);
        let next_key = hmac_sha256(&self.key, &input);
        wipe(&mut self.key);
        self.key = next_key;
        wipe(&mut input);

        let next_value = hmac_sha256(&self.key, &self.value);
        wipe(&mut self.value);
        self.value = next_value;

        if provided_data.is_empty() {
            return;
        }

        let mut input = Vec::with_capacity(self.value.len() + 1 + provided_data.len());
        input.extend_from_slice(&self.value);
        input.push(0x01);
        input.extend_from_slice(provided_data);
        let next_key = hmac_sha256(&self.key, &input);
        wipe(&mut self.key);
        self.key = next_key;
        wipe(&mut input);

        let next_value = hmac_sha256(&self.key, &self.value);
        wipe(&mut self.value);
        self.value = next_value;
    }

    fn generate(&mut self, output: &mut [u8], additional_input: &[u8]) -> Result<(), String> {
        if output.len() > MAX_DRBG_BYTES_PER_REQUEST {
            return Err("HMAC_DRBG request exceeds the SP 800-90A limit".to_string());
        }
        if self.reseed_counter > MAX_DRBG_RESEED_INTERVAL {
            return Err("HMAC_DRBG reseed is required".to_string());
        }
        if !additional_input.is_empty() {
            self.update(additional_input);
        }

        let mut offset = 0;
        while offset < output.len() {
            let next_value = hmac_sha256(&self.key, &self.value);
            wipe(&mut self.value);
            self.value = next_value;
            let take = (output.len() - offset).min(self.value.len());
            output[offset..offset + take].copy_from_slice(&self.value[..take]);
            offset += take;
        }

        // Algorithm 10 always updates the state after a generate request; an
        // empty slice represents the Null additional_input used by the CAVP.
        self.update(additional_input);
        self.reseed_counter += 1;
        Ok(())
    }
}

impl Drop for HmacDrbg {
    fn drop(&mut self) {
        wipe(&mut self.key);
        wipe(&mut self.value);
        self.reseed_counter = 0;
    }
}

fn sodium_ready() -> Result<(), String> {
    static SODIUM_INIT_RESULT: OnceLock<i32> = OnceLock::new();
    let result = *SODIUM_INIT_RESULT.get_or_init(|| unsafe { sodium_init() });
    if result < 0 {
        Err("libsodium initialization failed".to_string())
    } else {
        Ok(())
    }
}

/// Generate a fresh ephemeral X25519 secret/public key pair.
pub(super) fn x25519_keypair() -> Result<([u8; X25519_BYTES], [u8; X25519_BYTES]), String> {
    sodium_ready()?;
    let mut secret = [0_u8; X25519_BYTES];
    if let Err(error) = getrandom::fill(&mut secret) {
        wipe(&mut secret);
        return Err(format!(
            "OS CSPRNG failed for X25519 key generation: {error}"
        ));
    }
    let mut public = [0_u8; X25519_BYTES];
    let result = unsafe { crypto_scalarmult_curve25519_base(public.as_mut_ptr(), secret.as_ptr()) };
    if result != 0 {
        wipe(&mut secret);
        wipe(&mut public);
        return Err(format!(
            "libsodium X25519 public-key derivation failed with code {result}"
        ));
    }
    Ok((secret, public))
}

/// Derive an X25519 shared secret and reject low-order peer inputs.
pub(super) fn x25519(
    secret: &[u8; X25519_BYTES],
    public: &[u8; X25519_BYTES],
) -> Result<[u8; X25519_BYTES], String> {
    sodium_ready()?;
    let mut shared = [0_u8; X25519_BYTES];
    let result = unsafe {
        crypto_scalarmult_curve25519(shared.as_mut_ptr(), secret.as_ptr(), public.as_ptr())
    };
    let all_zero = shared
        .iter()
        .fold(0_u8, |accumulator, byte| accumulator | byte)
        == 0;
    if result != 0 || all_zero {
        wipe(&mut shared);
        return Err("Rejected low-order X25519 public key".to_string());
    }
    Ok(shared)
}

/// Create a new long-term ML-KEM-768 identity.
///
/// `extra_noise` is either empty or a 32-byte digest produced by the chat's
/// local interaction collector. It is personalization only: security does not
/// rely on it and the OS CSPRNG supplies the full entropy input and nonce.
/// The returned tuple is `(public_key, secret_key)`.
pub(super) fn identity_keypair(extra_noise: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    if !extra_noise.is_empty() && extra_noise.len() != OPTIONAL_NOISE_DIGEST_BYTES {
        return Err("Optional entropy input must be an empty or 32-byte digest".to_string());
    }

    let mut entropy_input = [0_u8; 32];
    let mut nonce = [0_u8; 16];
    if let Err(error) = getrandom::fill(&mut entropy_input) {
        wipe(&mut entropy_input);
        return Err(format!(
            "OS CSPRNG failed for ML-KEM entropy input: {error}"
        ));
    }
    if let Err(error) = getrandom::fill(&mut nonce) {
        wipe(&mut entropy_input);
        wipe(&mut nonce);
        return Err(format!("OS CSPRNG failed for ML-KEM nonce: {error}"));
    }

    let mut personalization =
        Vec::with_capacity(IDENTITY_PERSONALIZATION.len() + 1 + OPTIONAL_NOISE_DIGEST_BYTES);
    personalization.extend_from_slice(IDENTITY_PERSONALIZATION);
    personalization.push(u8::from(!extra_noise.is_empty()));
    personalization.extend_from_slice(extra_noise);

    let mut drbg = HmacDrbg::instantiate(&entropy_input, &nonce, &personalization);
    wipe(&mut entropy_input);
    wipe(&mut nonce);
    wipe(&mut personalization);

    let mut coins = [0_u8; MLKEM_KEYPAIR_COINS_BYTES];
    if let Err(error) = drbg.generate(&mut coins, &[]) {
        wipe(&mut coins);
        return Err(error);
    }
    drop(drbg);

    let mut public_key = vec![0_u8; super::MLKEM_PUBLIC_KEY_BYTES];
    let mut secret_key = vec![0_u8; super::MLKEM_SECRET_KEY_BYTES];
    let result = unsafe {
        PQCP_MLKEM_NATIVE_MLKEM768_keypair_derand(
            public_key.as_mut_ptr(),
            secret_key.as_mut_ptr(),
            coins.as_ptr(),
        )
    };
    wipe(&mut coins);
    if result != 0 {
        wipe(&mut public_key);
        wipe(&mut secret_key);
        return Err(format!(
            "mlkem-native deterministic keypair generation failed with code {result}"
        ));
    }
    Ok((public_key, secret_key))
}

unsafe extern "C" {
    fn sodium_init() -> i32;
    fn crypto_scalarmult_curve25519_base(public_key: *mut u8, secret_key: *const u8) -> i32;
    fn crypto_scalarmult_curve25519(
        shared_secret: *mut u8,
        secret_key: *const u8,
        public_key: *const u8,
    ) -> i32;
    fn PQCP_MLKEM_NATIVE_MLKEM768_keypair_derand(
        public_key: *mut u8,
        secret_key: *mut u8,
        coins: *const u8,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_hex<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut output = [0_u8; N];
        for (index, byte) in output.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        output
    }

    #[test]
    fn hmac_drbg_matches_nist_cavs_14_3_sha256_no_reseed_count_zero() {
        // Official NIST DRBGVS no-reseed vector, HMAC_DRBG SHA-256, COUNT=0.
        let entropy =
            decode_hex::<32>("ca851911349384bffe89de1cbdc46e6831e44d34a4fb935ee285dd14b71a7488");
        let nonce = decode_hex::<16>("659ba96c601dc69fc902940805ec0ca8");
        let expected = decode_hex::<128>(
            "e528e9abf2dece54d47c7e75e5fe302149f817ea9fb4bee6f4199697d04d5b89\
             d54fbb978a15b5c443c9ec21036d2460b6f73ebad0dc2aba6e624abf07745bc1\
             07694bb7547bb0995f70de25d6b29e2d3011bb19d27676c07162c8b5ccde0668\
             961df86803482cb37ed6d5c0bb8d50cf1f50d476aa0458bdaba806f48be9dcb8"
                .replace(char::is_whitespace, "")
                .as_str(),
        );
        let mut drbg = HmacDrbg::instantiate(&entropy, &nonce, &[]);
        let mut first = [0_u8; 128];
        let mut second = [0_u8; 128];
        drbg.generate(&mut first, &[]).unwrap();
        drbg.generate(&mut second, &[]).unwrap();
        assert_eq!(second, expected);
        wipe(&mut first);
        wipe(&mut second);
    }

    #[test]
    fn x25519_matches_rfc_7748_key_agreement_vector() {
        let alice_secret =
            decode_hex::<32>("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let bob_public =
            decode_hex::<32>("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        let expected =
            decode_hex::<32>("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
        let mut shared = x25519(&alice_secret, &bob_public).unwrap();
        assert_eq!(shared, expected);
        wipe(&mut shared);
    }

    #[test]
    fn x25519_keypairs_agree_and_reject_all_zero_public_key() {
        let (mut alice_secret, alice_public) = x25519_keypair().unwrap();
        let (mut bob_secret, bob_public) = x25519_keypair().unwrap();
        let mut alice_shared = x25519(&alice_secret, &bob_public).unwrap();
        let mut bob_shared = x25519(&bob_secret, &alice_public).unwrap();
        assert_eq!(alice_shared, bob_shared);
        assert!(x25519(&alice_secret, &[0_u8; 32]).is_err());
        wipe(&mut alice_secret);
        wipe(&mut bob_secret);
        wipe(&mut alice_shared);
        wipe(&mut bob_shared);
    }

    #[test]
    fn new_identity_uses_derandomized_mlkem_keygen_with_optional_digest() {
        let (public_key, mut secret_key) = identity_keypair(&[0x42; 32]).unwrap();
        let (ciphertext, mut sent_shared) = super::super::mlkem_encaps(&public_key).unwrap();
        let mut received_shared = super::super::mlkem_decaps(&secret_key, &ciphertext).unwrap();
        assert_eq!(sent_shared, received_shared);
        wipe(&mut secret_key);
        wipe(&mut sent_shared);
        wipe(&mut received_shared);
        assert!(identity_keypair(&[0_u8; 31]).is_err());
    }

    #[test]
    fn wipe_clears_the_target_buffer() {
        let mut secret = [0xa5_u8; 32];
        wipe(&mut secret);
        assert_eq!(secret, [0_u8; 32]);
    }
}
