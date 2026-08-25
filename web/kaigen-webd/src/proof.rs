use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicChallenge {
    pub challenge_id: String,
    pub salt: String,
    pub difficulty: u8,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofSolution {
    pub challenge_id: String,
    pub nonce: u64,
}

struct Challenge {
    source: [u8; 32],
    salt: [u8; 24],
    difficulty: u8,
    expires_at: u64,
}

#[derive(Default)]
pub struct ProofRegistry {
    challenges: HashMap<String, Challenge>,
}

impl ProofRegistry {
    pub fn issue(
        &mut self,
        source: [u8; 32],
        difficulty: u8,
        now: u64,
    ) -> Result<PublicChallenge, String> {
        self.prune(now);
        let mut id = [0_u8; 24];
        let mut salt = [0_u8; 24];
        getrandom(&mut id)?;
        getrandom(&mut salt)?;
        let challenge_id = URL_SAFE_NO_PAD.encode(id);
        let expires_at = now.saturating_add(5 * 60);
        self.challenges.insert(
            challenge_id.clone(),
            Challenge {
                source,
                salt,
                difficulty,
                expires_at,
            },
        );
        Ok(PublicChallenge {
            challenge_id,
            salt: URL_SAFE_NO_PAD.encode(salt),
            difficulty,
            expires_at: expires_at.saturating_mul(1000),
        })
    }

    pub fn consume(&mut self, source: &[u8; 32], solution: &ProofSolution, now: u64) -> bool {
        self.prune(now);
        let Some(challenge) = self.challenges.remove(&solution.challenge_id) else {
            return false;
        };
        if now > challenge.expires_at || !bool::from(challenge.source.ct_eq(source)) {
            return false;
        }
        let salt = URL_SAFE_NO_PAD.encode(challenge.salt);
        let value = format!("{salt}:{}", solution.nonce);
        let digest = Sha256::digest(value.as_bytes());
        leading_zero_bits(&digest) >= challenge.difficulty
    }

    fn prune(&mut self, now: u64) {
        self.challenges
            .retain(|_, challenge| challenge.expires_at >= now);
    }
}

fn leading_zero_bits(bytes: &[u8]) -> u8 {
    let mut bits = 0_u8;
    for byte in bytes {
        if *byte == 0 {
            bits = bits.saturating_add(8);
        } else {
            bits = bits.saturating_add(byte.leading_zeros() as u8);
            break;
        }
    }
    bits
}

fn getrandom(output: &mut [u8]) -> Result<(), String> {
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), output)
        .map_err(|_| "Secure random source failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_is_source_bound_and_single_use() {
        let source = [1_u8; 32];
        let mut registry = ProofRegistry::default();
        let challenge = registry.issue(source, 12, 10).unwrap();
        let mut nonce = 0_u64;
        loop {
            let value = format!("{}:{nonce}", challenge.salt);
            if leading_zero_bits(&Sha256::digest(value.as_bytes())) >= challenge.difficulty {
                break;
            }
            nonce += 1;
        }
        let solution = ProofSolution {
            challenge_id: challenge.challenge_id,
            nonce,
        };
        assert!(!registry.consume(&[2_u8; 32], &solution, 20));
        assert!(!registry.consume(&source, &solution, 20));
    }
}
