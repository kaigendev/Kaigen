use std::convert::TryFrom;

pub struct ZipEntry {
    pub name: String,
    pub bytes: Vec<u8>,
}

impl Drop for ZipEntry {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

struct CentralEntry {
    name: Vec<u8>,
    crc32: u32,
    size: u32,
    offset: u32,
}

pub fn encode(entries: Vec<ZipEntry>) -> Result<Vec<u8>, String> {
    let entry_count =
        u16::try_from(entries.len()).map_err(|_| "QTOX_ZIP_ENTRY_LIMIT".to_string())?;
    let mut output = Vec::new();
    let mut central = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = safe_name(&entry.name)?;
        let name_bytes = name.into_bytes();
        let name_length =
            u16::try_from(name_bytes.len()).map_err(|_| "QTOX_ZIP_NAME_TOO_LONG".to_string())?;
        let size =
            u32::try_from(entry.bytes.len()).map_err(|_| "QTOX_ZIP_FILE_TOO_LARGE".to_string())?;
        let offset = u32::try_from(output.len()).map_err(|_| "QTOX_ZIP_TOO_LARGE".to_string())?;
        let crc32 = crc32(&entry.bytes);

        push_u32(&mut output, 0x0403_4b50);
        push_u16(&mut output, 20);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, crc32);
        push_u32(&mut output, size);
        push_u32(&mut output, size);
        push_u16(&mut output, name_length);
        push_u16(&mut output, 0);
        output.extend_from_slice(&name_bytes);
        output.extend_from_slice(&entry.bytes);
        central.push(CentralEntry {
            name: name_bytes,
            crc32,
            size,
            offset,
        });
    }

    let central_offset =
        u32::try_from(output.len()).map_err(|_| "QTOX_ZIP_TOO_LARGE".to_string())?;
    for entry in central {
        push_u32(&mut output, 0x0201_4b50);
        push_u16(&mut output, 20);
        push_u16(&mut output, 20);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, entry.crc32);
        push_u32(&mut output, entry.size);
        push_u32(&mut output, entry.size);
        push_u16(
            &mut output,
            u16::try_from(entry.name.len()).map_err(|_| "QTOX_ZIP_NAME_TOO_LONG".to_string())?,
        );
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, 0);
        push_u32(&mut output, entry.offset);
        output.extend_from_slice(&entry.name);
    }
    let central_size = u32::try_from(output.len())
        .map_err(|_| "QTOX_ZIP_TOO_LARGE".to_string())?
        .checked_sub(central_offset)
        .ok_or_else(|| "QTOX_ZIP_INVALID".to_string())?;
    push_u32(&mut output, 0x0605_4b50);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, entry_count);
    push_u16(&mut output, entry_count);
    push_u32(&mut output, central_size);
    push_u32(&mut output, central_offset);
    push_u16(&mut output, 0);
    Ok(output)
}

fn safe_name(value: &str) -> Result<String, String> {
    let value = value.replace('\\', "/");
    if value.is_empty()
        || value.starts_with('/')
        || value.as_bytes().contains(&0)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("QTOX_ZIP_PATH_INVALID".to_string());
    }
    Ok(value)
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut value = 0xffff_ffff_u32;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(value & 1);
            value = (value >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_zip_has_local_central_and_end_records() {
        let zip = encode(vec![ZipEntry {
            name: "Profile.tox".to_string(),
            bytes: b"tox-profile".to_vec(),
        }])
        .unwrap();
        assert_eq!(&zip[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert!(zip
            .windows(4)
            .any(|value| value == [0x50, 0x4b, 0x01, 0x02]));
        assert_eq!(
            &zip[zip.len() - 22..zip.len() - 18],
            &[0x50, 0x4b, 0x05, 0x06]
        );
        assert!(zip
            .windows(b"Profile.tox".len())
            .any(|value| value == b"Profile.tox"));
        assert!(zip
            .windows(b"tox-profile".len())
            .any(|value| value == b"tox-profile"));
    }

    #[test]
    fn zip_slip_names_are_rejected() {
        let error = encode(vec![ZipEntry {
            name: "../profile.tox".to_string(),
            bytes: Vec::new(),
        }])
        .unwrap_err();
        assert_eq!(error, "QTOX_ZIP_PATH_INVALID");
    }
}
