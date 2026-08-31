use crc32fast::Hasher;
use flate2::read::DeflateDecoder;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const END_RECORD_SIZE: u64 = 22;
const MAX_END_SEARCH: u64 = END_RECORD_SIZE + u16::MAX as u64;
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 4_096;
const MAX_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MATERIAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 4_096;
const MAX_COMPRESSION_RATIO: u64 = 200;
const RATIO_GRACE_BYTES: u64 = 16 * 1024 * 1024;

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct CentralEntry {
    name: String,
    normalized_key: String,
    is_directory: bool,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_offset: u64,
}

#[derive(Debug)]
pub struct ExtractedQtoxArchive {
    root: PathBuf,
    pub profile_path: PathBuf,
    pub history_path: Option<PathBuf>,
    material_files: Vec<(String, PathBuf)>,
}

pub struct QtoxZipImportMaterial {
    pub savedata: Vec<u8>,
    pub data_files: Vec<(String, Vec<u8>)>,
    pub imported_name: String,
}

impl Drop for ExtractedQtoxArchive {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn extract(archive_path: &Path, staging_parent: &Path) -> Result<ExtractedQtoxArchive, String> {
    let metadata = fs::metadata(archive_path)
        .map_err(|error| format!("Could not inspect the qTox ZIP archive: {error}"))?;
    if !metadata.is_file() {
        return Err("QTOX_ZIP_NOT_A_FILE".to_string());
    }
    if metadata.len() < END_RECORD_SIZE || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("QTOX_ZIP_SIZE_INVALID".to_string());
    }

    let mut archive = File::open(archive_path)
        .map_err(|error| format!("Could not open the qTox ZIP archive: {error}"))?;
    let entries = read_central_directory(&mut archive, metadata.len())?;
    let profiles = entries
        .iter()
        .filter(|entry| {
            !entry.is_directory
                && Path::new(&entry.name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("tox"))
        })
        .collect::<Vec<_>>();
    if profiles.is_empty() {
        return Err("QTOX_ZIP_PROFILE_NOT_FOUND".to_string());
    }
    if profiles.len() != 1 {
        return Err("QTOX_ZIP_PROFILE_AMBIGUOUS".to_string());
    }
    let profile_entry = profiles[0];
    let profile_relative = PathBuf::from(&profile_entry.name);
    let profile_parent = profile_relative.parent().unwrap_or_else(|| Path::new(""));
    let history_key = normalized_path_key(&profile_relative.with_extension("db"))?;
    let settings_key = normalized_path_key(&profile_relative.with_extension("ini"))?;
    let avatar_prefix = {
        let value = normalized_path_key(&profile_parent.join("avatars"))?;
        format!("{value}/")
    };

    let root = create_staging_directory(staging_parent)?;
    let mut extracted = ExtractedQtoxArchive {
        profile_path: root.join(&profile_relative),
        history_path: None,
        material_files: Vec::new(),
        root,
    };
    let mut history_path = None;
    let mut material_files = Vec::new();

    for entry in &entries {
        if entry.is_directory {
            continue;
        }
        let destination = if entry.normalized_key == profile_entry.normalized_key {
            Some(extracted.profile_path.clone())
        } else if entry.normalized_key == history_key {
            let path = extracted.root.join(profile_relative.with_extension("db"));
            history_path = Some(path.clone());
            material_files.push(("qtox-import/history.db".to_string(), path.clone()));
            Some(path)
        } else if entry.normalized_key == settings_key {
            let path = extracted.root.join(profile_relative.with_extension("ini"));
            material_files.push(("qtox-import/profile.ini".to_string(), path.clone()));
            Some(path)
        } else if entry.normalized_key.starts_with(&avatar_prefix) {
            let path = extracted.root.join(&entry.name);
            let relative = entry
                .normalized_key
                .strip_prefix(&avatar_prefix)
                .ok_or_else(|| "QTOX_ZIP_PATH_INVALID".to_string())?;
            material_files.push((format!("qtox-import/avatars/{relative}"), path.clone()));
            Some(path)
        } else {
            None
        };
        if let Some(destination) = destination {
            extract_entry(&mut archive, entry, &destination)?;
        }
    }

    if !extracted.profile_path.is_file() {
        return Err("QTOX_ZIP_PROFILE_NOT_FOUND".to_string());
    }
    extracted.history_path = history_path;
    extracted.material_files = material_files;
    Ok(extracted)
}

pub fn read_material(
    archive_path: &Path,
    password: Option<&str>,
) -> Result<QtoxZipImportMaterial, String> {
    let extracted = extract(archive_path, &std::env::temp_dir())?;
    let imported_name = extracted
        .profile_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported qTox profile")
        .to_string();
    let mut material_bytes = fs::metadata(&extracted.profile_path)
        .map_err(|error| format!("Could not inspect the qTox ZIP profile: {error}"))?
        .len();
    for (_, path) in &extracted.material_files {
        material_bytes = material_bytes
            .checked_add(
                fs::metadata(path)
                    .map_err(|error| format!("Could not inspect qTox ZIP profile data: {error}"))?
                    .len(),
            )
            .ok_or_else(|| "QTOX_ZIP_MATERIAL_TOO_LARGE".to_string())?;
    }
    if material_bytes > MAX_MATERIAL_BYTES {
        return Err("QTOX_ZIP_MATERIAL_TOO_LARGE".to_string());
    }
    let mut savedata = fs::read(&extracted.profile_path)
        .map_err(|error| format!("Could not read the qTox ZIP profile: {error}"))?;
    if crate::profiles::is_encrypted(&savedata) {
        let decrypted = (|| {
            let password = password
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "PROFILE_PASSWORD_REQUIRED".to_string())?;
            let cipher = crate::profiles::ProfileCipher::unlock(&savedata, password)?;
            cipher.decrypt(&savedata)
        })();
        match decrypted {
            Ok(decrypted) => {
                crate::wipe_sensitive_bytes(&mut savedata);
                savedata = decrypted;
            }
            Err(error) => {
                crate::wipe_sensitive_bytes(&mut savedata);
                return Err(error);
            }
        }
    }
    let mut data_files = Vec::with_capacity(extracted.material_files.len());
    for (relative, path) in &extracted.material_files {
        match fs::read(path) {
            Ok(bytes) => data_files.push((relative.clone(), bytes)),
            Err(error) => {
                crate::wipe_sensitive_bytes(&mut savedata);
                for (_, bytes) in &mut data_files {
                    crate::wipe_sensitive_bytes(bytes);
                }
                return Err(format!("Could not read qTox ZIP profile data: {error}"));
            }
        }
    }
    Ok(QtoxZipImportMaterial {
        savedata,
        data_files,
        imported_name,
    })
}

fn read_central_directory(file: &mut File, archive_size: u64) -> Result<Vec<CentralEntry>, String> {
    let search_size = archive_size.min(MAX_END_SEARCH);
    file.seek(SeekFrom::End(-(search_size as i64)))
        .map_err(|error| format!("Could not seek in the qTox ZIP archive: {error}"))?;
    let mut tail = vec![0_u8; search_size as usize];
    file.read_exact(&mut tail)
        .map_err(|error| format!("Could not read the qTox ZIP archive: {error}"))?;
    let end_index = (0..=tail.len().saturating_sub(END_RECORD_SIZE as usize))
        .rev()
        .find(|index| {
            tail.get(*index..*index + 4) == Some(&[0x50, 0x4b, 0x05, 0x06])
                && tail
                    .get(*index + 20..*index + 22)
                    .map(read_u16)
                    .is_some_and(|comment| {
                        *index + END_RECORD_SIZE as usize + comment as usize == tail.len()
                    })
        })
        .ok_or_else(|| "QTOX_ZIP_END_RECORD_INVALID".to_string())?;
    let end = &tail[end_index..end_index + END_RECORD_SIZE as usize];
    let disk = read_u16(&end[4..6]);
    let central_disk = read_u16(&end[6..8]);
    let entries_on_disk = read_u16(&end[8..10]);
    let entry_count = read_u16(&end[10..12]);
    let central_size = read_u32(&end[12..16]);
    let central_offset = read_u32(&end[16..20]);
    if entries_on_disk == u16::MAX
        || entry_count == u16::MAX
        || central_size == u32::MAX
        || central_offset == u32::MAX
    {
        return Err("QTOX_ZIP64_UNSUPPORTED".to_string());
    }
    if disk != 0 || central_disk != 0 || entries_on_disk != entry_count {
        return Err("QTOX_ZIP_MULTIDISK_UNSUPPORTED".to_string());
    }
    let entry_count = usize::from(entry_count);
    if entry_count == 0 || entry_count > MAX_ENTRY_COUNT {
        return Err("QTOX_ZIP_ENTRY_LIMIT".to_string());
    }
    let end_offset = archive_size - search_size + end_index as u64;
    let central_end = u64::from(central_offset)
        .checked_add(u64::from(central_size))
        .ok_or_else(|| "QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string())?;
    if central_end != end_offset {
        return Err("QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string());
    }

    file.seek(SeekFrom::Start(u64::from(central_offset)))
        .map_err(|error| format!("Could not seek to the qTox ZIP directory: {error}"))?;
    let mut entries = Vec::with_capacity(entry_count);
    let mut normalized_paths = HashSet::with_capacity(entry_count);
    let mut total_size = 0_u64;
    for _ in 0..entry_count {
        let mut fixed = [0_u8; 46];
        file.read_exact(&mut fixed)
            .map_err(|_| "QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string())?;
        if fixed[..4] != [0x50, 0x4b, 0x01, 0x02] {
            return Err("QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string());
        }
        let version_made_by = read_u16(&fixed[4..6]);
        let flags = read_u16(&fixed[8..10]);
        let method = read_u16(&fixed[10..12]);
        let crc32 = read_u32(&fixed[16..20]);
        let compressed_size = read_u32(&fixed[20..24]);
        let uncompressed_size = read_u32(&fixed[24..28]);
        let name_length = usize::from(read_u16(&fixed[28..30]));
        let extra_length = usize::from(read_u16(&fixed[30..32]));
        let comment_length = usize::from(read_u16(&fixed[32..34]));
        let disk_start = read_u16(&fixed[34..36]);
        let external_attributes = read_u32(&fixed[38..42]);
        let local_offset = read_u32(&fixed[42..46]);

        if flags & 0x0001 != 0 || flags & 0x0040 != 0 {
            return Err("QTOX_ZIP_ENCRYPTED_UNSUPPORTED".to_string());
        }
        if method != 0 && method != 8 {
            return Err("QTOX_ZIP_COMPRESSION_UNSUPPORTED".to_string());
        }
        if compressed_size == u32::MAX
            || uncompressed_size == u32::MAX
            || local_offset == u32::MAX
            || disk_start == u16::MAX
        {
            return Err("QTOX_ZIP64_UNSUPPORTED".to_string());
        }
        if disk_start != 0 {
            return Err("QTOX_ZIP_MULTIDISK_UNSUPPORTED".to_string());
        }
        if name_length == 0 || name_length > MAX_NAME_BYTES {
            return Err("QTOX_ZIP_PATH_INVALID".to_string());
        }
        let mut name = vec![0_u8; name_length];
        file.read_exact(&mut name)
            .map_err(|_| "QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string())?;
        let mut extra = vec![0_u8; extra_length];
        file.read_exact(&mut extra)
            .map_err(|_| "QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string())?;
        reject_zip64_extra(&extra)?;
        file.seek(SeekFrom::Current(comment_length as i64))
            .map_err(|_| "QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string())?;

        let name =
            std::str::from_utf8(&name).map_err(|_| "QTOX_ZIP_PATH_ENCODING_INVALID".to_string())?;
        let (name, is_directory) = safe_archive_path(name)?;
        let normalized_key = normalized_path_key(Path::new(&name))?;
        if !normalized_paths.insert(normalized_key.clone()) {
            return Err("QTOX_ZIP_PATH_DUPLICATE".to_string());
        }
        reject_special_file(version_made_by, external_attributes, is_directory)?;

        let compressed_size = u64::from(compressed_size);
        let uncompressed_size = u64::from(uncompressed_size);
        if uncompressed_size > MAX_ENTRY_BYTES {
            return Err("QTOX_ZIP_FILE_TOO_LARGE".to_string());
        }
        total_size = total_size
            .checked_add(uncompressed_size)
            .ok_or_else(|| "QTOX_ZIP_TOO_LARGE".to_string())?;
        if total_size > MAX_TOTAL_BYTES {
            return Err("QTOX_ZIP_TOO_LARGE".to_string());
        }
        if uncompressed_size > RATIO_GRACE_BYTES
            && (compressed_size == 0
                || uncompressed_size
                    > compressed_size
                        .checked_mul(MAX_COMPRESSION_RATIO)
                        .unwrap_or(u64::MAX))
        {
            return Err("QTOX_ZIP_COMPRESSION_RATIO_INVALID".to_string());
        }
        entries.push(CentralEntry {
            name,
            normalized_key,
            is_directory,
            flags,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            local_offset: u64::from(local_offset),
        });
    }
    let current = file
        .stream_position()
        .map_err(|error| format!("Could not inspect the qTox ZIP directory: {error}"))?;
    if current != central_end {
        return Err("QTOX_ZIP_CENTRAL_DIRECTORY_INVALID".to_string());
    }
    Ok(entries)
}

fn extract_entry(file: &mut File, entry: &CentralEntry, destination: &Path) -> Result<(), String> {
    file.seek(SeekFrom::Start(entry.local_offset))
        .map_err(|error| format!("Could not seek to a qTox ZIP entry: {error}"))?;
    let mut fixed = [0_u8; 30];
    file.read_exact(&mut fixed)
        .map_err(|_| "QTOX_ZIP_LOCAL_HEADER_INVALID".to_string())?;
    if fixed[..4] != [0x50, 0x4b, 0x03, 0x04] {
        return Err("QTOX_ZIP_LOCAL_HEADER_INVALID".to_string());
    }
    let flags = read_u16(&fixed[6..8]);
    let method = read_u16(&fixed[8..10]);
    let name_length = usize::from(read_u16(&fixed[26..28]));
    let extra_length = usize::from(read_u16(&fixed[28..30]));
    if flags != entry.flags
        || method != entry.method
        || name_length == 0
        || name_length > MAX_NAME_BYTES
    {
        return Err("QTOX_ZIP_LOCAL_HEADER_INVALID".to_string());
    }
    let mut name = vec![0_u8; name_length];
    file.read_exact(&mut name)
        .map_err(|_| "QTOX_ZIP_LOCAL_HEADER_INVALID".to_string())?;
    let name =
        std::str::from_utf8(&name).map_err(|_| "QTOX_ZIP_PATH_ENCODING_INVALID".to_string())?;
    let (name, is_directory) = safe_archive_path(name)?;
    if is_directory || normalized_path_key(Path::new(&name))? != entry.normalized_key {
        return Err("QTOX_ZIP_LOCAL_HEADER_INVALID".to_string());
    }
    file.seek(SeekFrom::Current(extra_length as i64))
        .map_err(|_| "QTOX_ZIP_LOCAL_HEADER_INVALID".to_string())?;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create qTox ZIP staging data: {error}"))?;
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Could not create a qTox ZIP staging file: {error}"))?;
    let source = file.take(entry.compressed_size);
    let mut input: Box<dyn Read + '_> = match entry.method {
        0 => Box::new(source),
        8 => Box::new(DeflateDecoder::new(source)),
        _ => return Err("QTOX_ZIP_COMPRESSION_UNSUPPORTED".to_string()),
    };
    let mut hasher = Hasher::new();
    let mut written = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| "QTOX_ZIP_DECOMPRESSION_FAILED".to_string())?;
        if count == 0 {
            break;
        }
        written = written
            .checked_add(count as u64)
            .ok_or_else(|| "QTOX_ZIP_FILE_TOO_LARGE".to_string())?;
        if written > entry.uncompressed_size || written > MAX_ENTRY_BYTES {
            return Err("QTOX_ZIP_DECOMPRESSED_SIZE_INVALID".to_string());
        }
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not write qTox ZIP staging data: {error}"))?;
    }
    if written != entry.uncompressed_size {
        return Err("QTOX_ZIP_DECOMPRESSED_SIZE_INVALID".to_string());
    }
    if hasher.finalize() != entry.crc32 {
        return Err("QTOX_ZIP_CRC_INVALID".to_string());
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not flush qTox ZIP staging data: {error}"))?;
    Ok(())
}

fn safe_archive_path(value: &str) -> Result<(String, bool), String> {
    let value = value.replace('\\', "/");
    let is_directory = value.ends_with('/');
    let value = value.trim_end_matches('/');
    if value.is_empty()
        || value.starts_with('/')
        || value.as_bytes().contains(&0)
        || value.contains(':')
    {
        return Err("QTOX_ZIP_PATH_INVALID".to_string());
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("QTOX_ZIP_PATH_INVALID".to_string());
    }
    for component in value.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
            || is_windows_reserved_name(component)
        {
            return Err("QTOX_ZIP_PATH_INVALID".to_string());
        }
    }
    Ok((value.to_string(), is_directory))
}

fn normalized_path_key(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or_else(|| "QTOX_ZIP_PATH_ENCODING_INVALID".to_string())?
        .replace('\\', "/")
        .to_lowercase();
    safe_archive_path(&value).map(|(value, _)| value)
}

fn is_windows_reserved_name(component: &str) -> bool {
    let base = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

fn reject_special_file(
    version_made_by: u16,
    external_attributes: u32,
    is_directory: bool,
) -> Result<(), String> {
    let host = (version_made_by >> 8) as u8;
    let mode = (external_attributes >> 16) as u16;
    let kind = mode & 0o170000;
    if kind == 0o120000 || external_attributes & 0x0000_0400 != 0 {
        return Err("QTOX_ZIP_SPECIAL_FILE_UNSUPPORTED".to_string());
    }
    if host == 3 || host == 19 {
        if kind != 0 && kind != 0o100000 && kind != 0o040000 {
            return Err("QTOX_ZIP_SPECIAL_FILE_UNSUPPORTED".to_string());
        }
        if (is_directory && kind == 0o100000) || (!is_directory && kind == 0o040000) {
            return Err("QTOX_ZIP_SPECIAL_FILE_UNSUPPORTED".to_string());
        }
    }
    Ok(())
}

fn reject_zip64_extra(extra: &[u8]) -> Result<(), String> {
    let mut offset = 0_usize;
    while offset < extra.len() {
        if extra.len() - offset < 4 {
            return Err("QTOX_ZIP_EXTRA_INVALID".to_string());
        }
        let identifier = read_u16(&extra[offset..offset + 2]);
        let length = usize::from(read_u16(&extra[offset + 2..offset + 4]));
        offset = offset
            .checked_add(4 + length)
            .ok_or_else(|| "QTOX_ZIP_EXTRA_INVALID".to_string())?;
        if offset > extra.len() {
            return Err("QTOX_ZIP_EXTRA_INVALID".to_string());
        }
        if identifier == 0x0001 {
            return Err("QTOX_ZIP64_UNSUPPORTED".to_string());
        }
    }
    Ok(())
}

fn create_staging_directory(parent: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create qTox ZIP staging directory: {error}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..32 {
        let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".qtox-import-{}-{now:x}-{sequence:x}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create qTox ZIP staging directory: {error}"
                ))
            }
        }
    }
    Err("QTOX_ZIP_STAGING_COLLISION".to_string())
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::DeflateEncoder;
    use flate2::Compression;

    #[derive(Clone)]
    struct TestEntry<'a> {
        name: &'a str,
        bytes: &'a [u8],
        method: u16,
        flags: u16,
        version_made_by: u16,
        external_attributes: u32,
        declared_uncompressed_size: Option<u32>,
    }

    fn write_test_zip(path: &Path, entries: &[TestEntry<'_>]) {
        let mut output = Vec::new();
        let mut central = Vec::new();
        for entry in entries {
            let payload = if entry.method == 8 {
                let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(entry.bytes).unwrap();
                encoder.finish().unwrap()
            } else {
                entry.bytes.to_vec()
            };
            let crc = {
                let mut hasher = Hasher::new();
                hasher.update(entry.bytes);
                hasher.finalize()
            };
            let declared_size = entry
                .declared_uncompressed_size
                .unwrap_or(entry.bytes.len() as u32);
            let offset = output.len() as u32;
            output.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            output.extend_from_slice(&20_u16.to_le_bytes());
            output.extend_from_slice(&entry.flags.to_le_bytes());
            output.extend_from_slice(&entry.method.to_le_bytes());
            output.extend_from_slice(&[0_u8; 4]);
            output.extend_from_slice(&crc.to_le_bytes());
            output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            output.extend_from_slice(&declared_size.to_le_bytes());
            output.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            output.extend_from_slice(&0_u16.to_le_bytes());
            output.extend_from_slice(entry.name.as_bytes());
            output.extend_from_slice(&payload);
            central.push((
                entry.clone(),
                payload.len() as u32,
                declared_size,
                crc,
                offset,
            ));
        }
        let central_offset = output.len() as u32;
        for (entry, compressed_size, declared_size, crc, offset) in &central {
            output.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            output.extend_from_slice(&entry.version_made_by.to_le_bytes());
            output.extend_from_slice(&20_u16.to_le_bytes());
            output.extend_from_slice(&entry.flags.to_le_bytes());
            output.extend_from_slice(&entry.method.to_le_bytes());
            output.extend_from_slice(&[0_u8; 4]);
            output.extend_from_slice(&crc.to_le_bytes());
            output.extend_from_slice(&compressed_size.to_le_bytes());
            output.extend_from_slice(&declared_size.to_le_bytes());
            output.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            output.extend_from_slice(&[0_u8; 6]);
            output.extend_from_slice(&0_u16.to_le_bytes());
            output.extend_from_slice(&entry.external_attributes.to_le_bytes());
            output.extend_from_slice(&offset.to_le_bytes());
            output.extend_from_slice(entry.name.as_bytes());
        }
        let central_size = output.len() as u32 - central_offset;
        output.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        output.extend_from_slice(&[0_u8; 4]);
        output.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        output.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        output.extend_from_slice(&central_size.to_le_bytes());
        output.extend_from_slice(&central_offset.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        fs::write(path, output).unwrap();
    }

    fn entry<'a>(name: &'a str, bytes: &'a [u8], method: u16) -> TestEntry<'a> {
        TestEntry {
            name,
            bytes,
            method,
            flags: 0,
            version_made_by: 20,
            external_attributes: 0,
            declared_uncompressed_size: None,
        }
    }

    fn test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kaigen-{label}-{}-{}",
            std::process::id(),
            STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn extracts_one_stored_profile_with_sibling_data_and_cleans_on_drop() {
        let root = test_root("qtox-zip-stored");
        let archive = root.join("profile.zip");
        write_test_zip(
            &archive,
            &[
                entry("portable/Alice.tox", b"savedata", 0),
                entry("portable/Alice.db", b"history", 0),
                entry("portable/Alice.ini", b"settings", 0),
                entry("portable/avatars/key", b"avatar", 0),
                entry("unrelated.bin", b"ignored", 0),
            ],
        );
        let stage_parent = root.join("stage");
        let extracted = extract(&archive, &stage_parent).unwrap();
        let staging_root = extracted.root.clone();
        assert_eq!(fs::read(&extracted.profile_path).unwrap(), b"savedata");
        assert_eq!(
            fs::read(extracted.history_path.as_ref().unwrap()).unwrap(),
            b"history"
        );
        assert_eq!(
            fs::read(extracted.profile_path.with_extension("ini")).unwrap(),
            b"settings"
        );
        assert_eq!(
            fs::read(staging_root.join("portable/avatars/key")).unwrap(),
            b"avatar"
        );
        assert!(!staging_root.join("unrelated.bin").exists());
        assert_eq!(fs::read(&archive).unwrap()[..4], [0x50, 0x4b, 0x03, 0x04]);
        drop(extracted);
        assert!(!staging_root.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_deflated_profile() {
        let root = test_root("qtox-zip-deflate");
        let archive = root.join("profile.zip");
        write_test_zip(&archive, &[entry("Alice.tox", b"deflated savedata", 8)]);
        let extracted = extract(&archive, &root.join("stage")).unwrap();
        assert_eq!(
            fs::read(&extracted.profile_path).unwrap(),
            b"deflated savedata"
        );
        drop(extracted);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn material_api_unlocks_savedata_and_returns_only_bounded_profile_data() {
        let root = test_root("qtox-zip-material");
        let archive = root.join("profile.zip");
        let cipher = crate::profiles::ProfileCipher::new("profile password").unwrap();
        let encrypted = cipher.encrypt(b"private savedata").unwrap();
        write_test_zip(
            &archive,
            &[
                entry("Alice.tox", &encrypted, 8),
                entry("Alice.db", b"history", 8),
                entry("Alice.ini", b"settings", 0),
                entry("avatars/key", b"avatar", 0),
                entry("ignored.bin", b"ignored", 0),
            ],
        );
        assert_eq!(
            read_material(&archive, None).err().unwrap(),
            "PROFILE_PASSWORD_REQUIRED"
        );
        let material = read_material(&archive, Some("profile password")).unwrap();
        assert_eq!(material.imported_name, "Alice");
        assert_eq!(material.savedata, b"private savedata");
        assert_eq!(
            material
                .data_files
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "qtox-import/history.db",
                "qtox-import/profile.ini",
                "qtox-import/avatars/key"
            ]
        );
        assert!(!material
            .data_files
            .iter()
            .any(|(path, _)| path.contains("ignored")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_traversal_encryption_symlinks_and_ambiguous_profiles() {
        let cases = [
            (
                "traversal",
                vec![entry("../Alice.tox", b"savedata", 0)],
                "QTOX_ZIP_PATH_INVALID",
            ),
            (
                "encrypted",
                vec![TestEntry {
                    flags: 1,
                    ..entry("Alice.tox", b"savedata", 0)
                }],
                "QTOX_ZIP_ENCRYPTED_UNSUPPORTED",
            ),
            (
                "symlink",
                vec![TestEntry {
                    version_made_by: 3 << 8,
                    external_attributes: (0o120777_u32) << 16,
                    ..entry("Alice.tox", b"savedata", 0)
                }],
                "QTOX_ZIP_SPECIAL_FILE_UNSUPPORTED",
            ),
            (
                "ambiguous",
                vec![
                    entry("Alice.tox", b"savedata", 0),
                    entry("Bob.tox", b"savedata", 0),
                ],
                "QTOX_ZIP_PROFILE_AMBIGUOUS",
            ),
        ];
        for (label, entries, expected) in cases {
            let root = test_root(label);
            let archive = root.join("profile.zip");
            write_test_zip(&archive, &entries);
            assert_eq!(
                extract(&archive, &root.join("stage")).unwrap_err(),
                expected
            );
            assert!(fs::read_dir(root.join("stage"))
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn rejects_zip64_and_bomb_declarations_before_extraction() {
        let root = test_root("qtox-zip-bounds");
        let archive = root.join("bomb.zip");
        write_test_zip(
            &archive,
            &[TestEntry {
                declared_uncompressed_size: Some((RATIO_GRACE_BYTES + 1) as u32),
                ..entry("Alice.tox", b"x", 0)
            }],
        );
        assert_eq!(
            extract(&archive, &root.join("stage")).unwrap_err(),
            "QTOX_ZIP_COMPRESSION_RATIO_INVALID"
        );

        let zip64 = root.join("zip64.zip");
        write_test_zip(&zip64, &[entry("Alice.tox", b"savedata", 0)]);
        let mut bytes = fs::read(&zip64).unwrap();
        let end = bytes.len() - END_RECORD_SIZE as usize;
        bytes[end + 10..end + 12].copy_from_slice(&u16::MAX.to_le_bytes());
        fs::write(&zip64, bytes).unwrap();
        assert_eq!(
            extract(&zip64, &root.join("stage")).unwrap_err(),
            "QTOX_ZIP64_UNSUPPORTED"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crc_failure_removes_partial_staging_tree() {
        let root = test_root("qtox-zip-cleanup");
        let archive = root.join("profile.zip");
        write_test_zip(&archive, &[entry("Alice.tox", b"savedata", 0)]);
        let mut bytes = fs::read(&archive).unwrap();
        let payload = bytes
            .windows(b"savedata".len())
            .position(|value| value == b"savedata")
            .unwrap();
        bytes[payload] ^= 1;
        fs::write(&archive, bytes).unwrap();
        let stage = root.join("stage");
        assert_eq!(
            extract(&archive, &stage).unwrap_err(),
            "QTOX_ZIP_CRC_INVALID"
        );
        assert!(fs::read_dir(&stage)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));
        fs::remove_dir_all(root).unwrap();
    }
}
