use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

fn shortened(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

pub(crate) fn read_original(source: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(source).map_err(|error| format!("Could not read the attachment: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > crate::MAX_CHAT_FILE_BYTES {
        return Err("ATTACHMENT_SIZE_LIMIT".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // Bound the actual read too: a file may grow after its length was checked.
    file.take(crate::MAX_CHAT_FILE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the attachment: {error}"))?;
    if bytes.len() as u64 > crate::MAX_CHAT_FILE_BYTES {
        return Err("ATTACHMENT_SIZE_LIMIT".into());
    }
    Ok(bytes)
}

/// The caller supplies a validated incoming original and an actual native folder selection.
pub(crate) fn save(source: &Path, directory: &Path) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(directory)
        .map_err(|error| format!("Could not locate the selected folder: {error}"))?;
    if !directory.is_dir() {
        return Err("The selected folder is unavailable".into());
    }
    let bytes = read_original(source)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The attachment name is unavailable".to_string())?;
    let stem = source.file_stem().and_then(|value| value.to_str()).unwrap_or("file");
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("");
    for sequence in 0..10_000 {
        let candidate = if sequence == 0 {
            name.to_string()
        } else {
            let extension = shortened(extension, 32);
            format!("{} ({sequence}){}{}", shortened(stem, 120), if extension.is_empty() { "" } else { "." }, extension)
        };
        let destination = directory.join(candidate);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&destination) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the file copy: {error}")),
        };
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err(format!("Could not save the file copy: {error}"));
        }
        return Ok(destination);
    }
    Err("FILE_COPY_NAME_UNAVAILABLE".into())
}
