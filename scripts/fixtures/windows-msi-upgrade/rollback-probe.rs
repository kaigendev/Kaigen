#![windows_subsystem = "windows"]

use std::{env, fs, io::Write, path::PathBuf, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

fn sha256(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let mut h = [0x6a09e667u32,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    let bit_len = (bytes.len() as u64) * 8;
    let mut data = bytes.to_vec(); data.push(0x80);
    while data.len() % 64 != 56 { data.push(0); }
    data.extend_from_slice(&bit_len.to_be_bytes());
    for block in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() { w[i] = u32::from_be_bytes(word.try_into().unwrap()); }
        for i in 16..64 {
            let a = w[i-15].rotate_right(7) ^ w[i-15].rotate_right(18) ^ (w[i-15] >> 3);
            let b = w[i-2].rotate_right(17) ^ w[i-2].rotate_right(19) ^ (w[i-2] >> 10);
            w[i] = w[i-16].wrapping_add(a).wrapping_add(w[i-7]).wrapping_add(b);
        }
        let [mut a,mut b,mut c,mut d,mut e,mut f,mut g,mut z] = h;
        for i in 0..64 {
            let s = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let t = z.wrapping_add(s).wrapping_add((e & f) ^ (!e & g)).wrapping_add(K[i]).wrapping_add(w[i]);
            let u = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22)).wrapping_add((a & b) ^ (a & c) ^ (b & c));
            z=g; g=f; f=e; e=d.wrapping_add(t); d=c; c=b; b=a; a=t.wrapping_add(u);
        }
        for (state, value) in h.iter_mut().zip([a,b,c,d,e,f,g,z]) { *state = state.wrapping_add(value); }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

#[link(name = "msi")]
extern "system" {
    fn MsiQueryProductStateW(product: *const u16) -> i32;
    fn MsiEnumRelatedProductsW(upgrade: *const u16, reserved: u32, index: u32, product: *mut u16) -> u32;
}

fn registration(product: &str, upgrade: &str) -> (i32, Result<Vec<String>, u32>) {
    let product_wide: Vec<_> = product.encode_utf16().chain(Some(0)).collect();
    let upgrade_wide: Vec<_> = upgrade.encode_utf16().chain(Some(0)).collect();
    let state = unsafe { MsiQueryProductStateW(product_wide.as_ptr()) };
    let mut products = Vec::new();
    // All calls remain on this thread, as required by Windows Installer.
    for index in 0..4096 {
        let mut buffer = [0u16; 39];
        let code = unsafe { MsiEnumRelatedProductsW(upgrade_wide.as_ptr(), 0, index, buffer.as_mut_ptr()) };
        if code == 259 { return (state, Ok(products)); }
        if code != 0 { return (state, Err(code)); }
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        products.push(String::from_utf16_lossy(&buffer[..end]));
    }
    (state, Err(u32::MAX)) // Enumeration never completed: fail closed.
}

fn removal_observed(state: i32, products: &Result<Vec<String>, u32>, old: &str) -> bool {
    state == -1 && products.as_ref().is_ok_and(|codes| !codes.iter().any(|code| code.eq_ignore_ascii_case(old)))
}

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--watch-canary" {
        thread::sleep(Duration::from_secs(3)); return;
    }
    // The explicit mode prevents an old post-copy witness being accepted as post-removal proof.
    if args.len() != 6 || args[0] != "--post-removal" { std::process::exit(64); }
    let target = PathBuf::from(&args[1]);
    let expected = args[2].to_string_lossy().to_ascii_lowercase();
    let receipt = PathBuf::from(&args[3]);
    let old = args[4].to_string_lossy();
    let upgrade = args[5].to_string_lossy();
    let actual = fs::read(&target).map(|data| sha256(&data));
    let matched = actual.as_ref().is_ok_and(|hash| *hash == expected);
    let (old_state, related) = registration(&old, &upgrade);
    let removed = removal_observed(old_state, &related, &old);
    // The receipt is deliberately outside INSTALLFOLDER and the MSI transaction.
    let utc_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let related_code = related.as_ref().err().copied().unwrap_or(0);
    let related_products = related.unwrap_or_default().join(";");
    let text = format!("schema=2\nphase=deferred-after-removeexistingproducts\nobserved_unix_ms={utc_ms}\npid={}\ntarget={}\nexpected_sha256={}\nactual_sha256={}\nmatch={}\nold_product_code={}\nupgrade_code={}\nold_product_state={}\nrelated_query_result={}\nrelated_products={}\nremoval_observed={}\n",
        std::process::id(), target.display(), expected, actual.unwrap_or_else(|_| "READ_FAILED".into()), matched,
        old, upgrade, old_state, related_code, related_products, removed);
    match fs::OpenOptions::new().write(true).create_new(true).open(&receipt) {
        Ok(mut file) => {
            if file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).is_err() { std::process::exit(66); }
        }
        Err(_) => std::process::exit(65),
    }
    // Every branch fails installation; only both witnesses count as a late rollback test.
    std::process::exit(if matched && removed { 1 } else { 67 });
}

#[cfg(test)]
mod tests {
    use super::{sha256, removal_observed};
    #[test] fn removal_requires_absent_state_and_completed_unrelated_enumeration() {
        let old = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
        assert!(removal_observed(-1, &Ok(vec![]), old));
        assert!(removal_observed(-1, &Ok(vec!["{OTHER}".into()]), old));
        for state in [1, 2, 5, -2] { assert!(!removal_observed(state, &Ok(vec![]), old)); }
        assert!(!removal_observed(-1, &Err(5), old));
        assert!(!removal_observed(-1, &Ok(vec![old.to_ascii_lowercase()]), old));
    }
    #[test] fn sha256_known_vectors() {
        assert_eq!(sha256(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256(&vec![b'a'; 1_000_000]), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }
}
