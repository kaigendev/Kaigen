//! The personal qTox settings file is either Qt INI or QTOX records, optionally
//! protected with toxencryptsave. Historical message author aliases are not
//! contact overrides; only Friends/Friend/alias is imported as a local name.

use std::{collections::BTreeMap, collections::HashMap, fs, path::Path};

use crate::profiles::{self, ProfileCipher};

const MAX_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Default)]
struct FriendSetting {
    address: String,
    alias: String,
}

pub(crate) fn read_friend_aliases(
    profile_path: &Path,
    password: Option<&str>,
) -> Result<HashMap<Vec<u8>, String>, String> {
    let personal = profile_path.with_extension("ini");
    let global = profile_path.with_file_name("qtox.ini");
    let path = if personal.is_file() {
        &personal
    } else {
        &global
    };
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect qTox contact settings: {error}"))?;
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err("QTOX_SETTINGS_TOO_LARGE".to_string());
    }
    let mut bytes =
        fs::read(path).map_err(|error| format!("Could not read qTox contact settings: {error}"))?;
    if profiles::is_encrypted(&bytes) {
        let decrypted = password
            .filter(|password| !password.is_empty())
            .ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())
            .and_then(|password| ProfileCipher::unlock(&bytes, password))
            .and_then(|cipher| cipher.decrypt(&bytes));
        crate::wipe_sensitive_bytes(&mut bytes);
        bytes = decrypted?;
    }
    let result = parse_friend_aliases(&bytes);
    crate::wipe_sensitive_bytes(&mut bytes);
    result
}

fn invalid() -> String {
    "QTOX_SETTINGS_INVALID".to_string()
}

pub(crate) fn parse_friend_aliases(bytes: &[u8]) -> Result<HashMap<Vec<u8>, String>, String> {
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("QTOX_SETTINGS_TOO_LARGE".to_string());
    }
    let records = if bytes.starts_with(b"QTOX") {
        parse_serialized(&bytes[4..])?
    } else {
        parse_ini(bytes)?
    };
    let mut aliases = HashMap::new();
    for friend in records.into_values() {
        let alias = crate::sanitize_untrusted_text(&friend.alias)
            .trim()
            .to_string();
        if alias.is_empty() {
            continue;
        }
        // qTox accepts both ToxPk (64 hex digits) and ToxId (76 digits).
        let key = public_key_from_address(friend.address.trim()).ok_or_else(invalid)?;
        aliases.insert(key, alias);
    }
    Ok(aliases)
}

pub(crate) fn public_key_from_address(address: &str) -> Option<Vec<u8>> {
    if !matches!(address.len(), 64 | 76) || !address.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|offset| u8::from_str_radix(&address[offset..offset + 2], 16).ok())
        .collect()
}

fn set_friend_value(friend: &mut FriendSetting, key: &str, value: &str) {
    match key {
        "addr" => friend.address = value.to_string(),
        "alias" => friend.alias = value.to_string(),
        _ => {}
    }
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn vint(&mut self) -> Result<usize, String> {
        let mut value = 0usize;
        for shift in (0..35).step_by(7) {
            let (&byte, remaining) = self.0.split_first().ok_or_else(invalid)?;
            self.0 = remaining;
            if shift == 28 && byte > 7 {
                return Err(invalid());
            }
            value |= usize::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(invalid())
    }

    fn data(&mut self) -> Result<&'a [u8], String> {
        let length = self.vint()?;
        if length > self.0.len() {
            return Err(invalid());
        }
        let (value, remaining) = self.0.split_at(length);
        self.0 = remaining;
        Ok(value)
    }

    fn text(&mut self) -> Result<&'a str, String> {
        std::str::from_utf8(self.data()?).map_err(|_| invalid())
    }

    fn packed_vint(&mut self) -> Result<usize, String> {
        let mut cursor = Cursor(self.data()?);
        let value = cursor.vint()?;
        if !cursor.0.is_empty() {
            return Err(invalid());
        }
        Ok(value)
    }
}

fn parse_serialized(bytes: &[u8]) -> Result<BTreeMap<usize, FriendSetting>, String> {
    let mut cursor = Cursor(bytes);
    let mut group = "";
    let mut array: Option<(&str, usize)> = None;
    let mut friends = BTreeMap::new();
    while let Some((&tag, remaining)) = cursor.0.split_first() {
        cursor.0 = remaining;
        match tag {
            0 => {
                cursor.data()?;
                cursor.data()?;
            }
            1 => {
                if array.is_some() {
                    return Err(invalid());
                }
                group = cursor.text()?;
            }
            2 => {
                if array.is_some() {
                    return Err(invalid());
                }
                array = Some((cursor.text()?, cursor.packed_vint()?));
            }
            3 => {
                let (array_name, size) = array.ok_or_else(invalid)?;
                let index = cursor.packed_vint()?;
                if index >= size {
                    return Err(invalid());
                }
                let key = cursor.text()?;
                let value = cursor.text()?;
                if group == "Friends" && array_name == "Friend" {
                    set_friend_value(friends.entry(index).or_default(), key, value);
                }
            }
            4 => {
                if array.take().is_none() {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    if array.is_some() {
        return Err(invalid());
    }
    Ok(friends)
}

fn parse_ini(bytes: &[u8]) -> Result<BTreeMap<usize, FriendSetting>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut group = "";
    let mut friends = BTreeMap::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            group = &line[1..line.len() - 1];
            continue;
        }
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let full = format!("{group}/{}", key.trim().replace('\\', "/"));
        let parts = full.split('/').collect::<Vec<_>>();
        if parts.len() != 4 || parts[0] != "Friends" || parts[1] != "Friend" {
            continue;
        }
        let index = parts[2].parse::<usize>().map_err(|_| invalid())?;
        set_friend_value(
            friends.entry(index).or_default(),
            parts[3],
            &decode_ini_value(value.trim())?,
        );
    }
    Ok(friends)
}

fn decode_ini_value(value: &str) -> Result<String, String> {
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    let mut chars = value.chars().peekable();
    let mut units = Vec::new();
    while let Some(character) = chars.next() {
        let decoded = if character == '\\' {
            match chars.next().ok_or_else(invalid)? {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '0' => '\0',
                'x' => {
                    let mut hex = String::new();
                    while hex.len() < 4
                        && chars.peek().is_some_and(|value| value.is_ascii_hexdigit())
                    {
                        hex.push(chars.next().unwrap());
                    }
                    units.push(u16::from_str_radix(&hex, 16).map_err(|_| invalid())?);
                    continue;
                }
                character => character,
            }
        } else {
            character
        };
        units.extend(decoded.encode_utf16(&mut [0; 2]).iter().copied());
    }
    let text = String::from_utf16(&units).map_err(|_| invalid())?;
    Ok(text
        .strip_prefix("@@")
        .map(|value| format!("@{value}"))
        .unwrap_or(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ini_aliases_preserve_unicode_quotes_and_friend_identity() {
        let first = "AB".repeat(32);
        let second = "CD".repeat(38);
        let ini = format!(
            "[Friends]\nFriend\\size=2\nFriend\\1\\addr={first}\nFriend\\1\\alias=\"Мой контакт, 工作\"\nFriend\\2\\addr={second}\nFriend\\2\\alias=\\x414\\x440\\x443\\x433 \\xd83d\\xde80\n[Requests]\nRequest\\1\\alias=ignored\n"
        );
        let aliases = parse_friend_aliases(ini.as_bytes()).unwrap();
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases[&vec![0xAB; 32]], "Мой контакт, 工作");
        assert_eq!(aliases[&vec![0xCD; 32]], "Друг 🚀");
    }

    #[test]
    fn serialized_alias_records_are_bounded_and_ignore_other_settings() {
        let mut bytes =
            b"QTOX\x01\x07Friends\x02\x06Friend\x01\x01\x03\x01\x00\x04addr\x40".to_vec();
        bytes.extend_from_slice("EF".repeat(32).as_bytes());
        bytes.extend_from_slice(
            b"\x03\x01\x00\x05alias\x05Local\x04\x01\x07Privacy\x00\x03key\x03yes",
        );
        let aliases = parse_friend_aliases(&bytes).unwrap();
        assert_eq!(aliases[&vec![0xEF; 32]], "Local");
        for invalid in [
            b"QTOX\x02\x06Friend\x01\x01".as_slice(),
            b"QTOX\xff",
            b"QTOX\x01\xff\xff\xff\xff\x08",
        ] {
            assert!(parse_friend_aliases(invalid).is_err());
        }
    }
}
