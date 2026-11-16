use std::{
    collections::HashSet,
    fs::{self, File},
    path::{Path, PathBuf},
};

pub(super) use super::helper_types::{
    checked_path, create_private_dir, single_name, Layout, Mode, WINDOWS_ENTRIES,
};
const PRIVATE_NAMES: &[&str] = &[
    "profiles",
    "downloads",
    "cache",
    "caches",
    "logs",
    "history",
    "user-data",
    "userdata",
    "user data",
    "default",
    "local storage",
    "session storage",
    "gpucache",
    "code cache",
];

impl Layout {
    pub(super) fn detect(portable_root: &Path) -> Result<Self, String> {
        let executable = running_executable()?;
        checked_path(&executable)?;
        checked_path(portable_root)?;
        let portable_root =
            fs::canonicalize(portable_root).map_err(|_| "UPDATE_LOCATION_INVALID")?;
        #[cfg(target_os = "windows")]
        {
            if executable
                .file_name()
                .and_then(|s| s.to_str())
                .is_none_or(|s| !s.eq_ignore_ascii_case("Kaigen.exe"))
            {
                return Err("UPDATE_LOCATION_UNSUPPORTED".into());
            }
            let program_root = executable
                .parent()
                .ok_or("UPDATE_LOCATION_INVALID")?
                .to_path_buf();
            let mode = if super::platform::msi_directory()
                .is_some_and(|path| fs::canonicalize(path).ok().as_ref() == Some(&program_root))
            {
                Mode::WindowsMsi
            } else {
                Mode::WindowsPortable
            };
            return Ok(Self {
                mode,
                program_root,
                executable,
                target_name: "Kaigen.exe".into(),
                portable_root,
            });
        }
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("APPIMAGE").is_none() {
                return Err("UPDATE_LOCATION_UNSUPPORTED".into());
            }
            let program_root = executable
                .parent()
                .ok_or("UPDATE_LOCATION_INVALID")?
                .to_path_buf();
            let target_name = executable
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("UPDATE_LOCATION_INVALID")?
                .to_string();
            return Ok(Self {
                mode: Mode::LinuxAppImage,
                program_root,
                executable,
                target_name,
                portable_root,
            });
        }
        #[cfg(target_os = "macos")]
        {
            let bundle = executable
                .ancestors()
                .find(|path| path.extension().is_some_and(|ext| ext == "app"))
                .ok_or("UPDATE_LOCATION_UNSUPPORTED")?;
            let program_root = bundle
                .parent()
                .ok_or("UPDATE_LOCATION_INVALID")?
                .to_path_buf();
            let target_name = bundle
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("UPDATE_LOCATION_INVALID")?
                .to_string();
            return Ok(Self {
                mode: Mode::MacApp,
                program_root,
                executable,
                target_name,
                portable_root,
            });
        }
        #[allow(unreachable_code)]
        Err("UPDATE_PLATFORM_UNSUPPORTED".into())
    }

    pub(super) fn asset_name(&self) -> &'static str {
        match self.mode {
            Mode::WindowsPortable => "Kaigen-portable-windows-x64.zip",
            Mode::WindowsMsi => "Kaigen-installer-windows-x64.msi",
            Mode::LinuxAppImage => "Kaigen-portable-debian-x64.zip",
            Mode::MacApp => "Kaigen-portable-macos-universal.zip",
        }
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        checked_path(&self.program_root)?;
        checked_path(&self.portable_root)?;
        if !self.program_root.is_dir()
            || !self.executable.starts_with(&self.program_root)
            || !single_name(&self.target_name)
        {
            return Err("UPDATE_LOCATION_INVALID".into());
        }
        if self.portable_root != self.program_root
            && self
                .portable_root
                .starts_with(self.program_root.join(&self.target_name))
        {
            return Err("UPDATE_DATA_LOCATION_OVERLAP".into());
        }
        match self.mode {
            Mode::WindowsPortable | Mode::WindowsMsi => {
                if self.target_name != "Kaigen.exe"
                    || self.executable != self.program_root.join("Kaigen.exe")
                {
                    return Err("UPDATE_LOCATION_INVALID".into());
                }
                for name in WINDOWS_ENTRIES {
                    let path = self.program_root.join(name);
                    if path.exists() {
                        checked_path(&path)?;
                    }
                    if self.portable_root != self.program_root
                        && self.portable_root.starts_with(&path)
                    {
                        return Err("UPDATE_DATA_LOCATION_OVERLAP".into());
                    }
                }
            }
            Mode::LinuxAppImage => {
                if self.executable != self.program_root.join(&self.target_name) {
                    return Err("UPDATE_LOCATION_INVALID".into());
                }
            }
            Mode::MacApp => {
                if !self.target_name.ends_with(".app")
                    || !self.executable.starts_with(
                        self.program_root
                            .join(&self.target_name)
                            .join("Contents/MacOS"),
                    )
                {
                    return Err("UPDATE_LOCATION_INVALID".into());
                }
            }
        }
        Ok(())
    }
}

pub(super) fn running_executable() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    if let Some(path) = std::env::var_os("APPIMAGE") {
        return fs::canonicalize(path).map_err(|_| "UPDATE_LOCATION_INVALID".into());
    }
    fs::canonicalize(std::env::current_exe().map_err(|_| "UPDATE_LOCATION_INVALID")?)
        .map_err(|_| "UPDATE_LOCATION_INVALID".into())
}

/// All names and link relationships are admitted before extraction. Only selected
/// program roots are returned to the transaction; portable user-data stays out.
pub(super) fn extract(
    layout: &Layout,
    archive: &Path,
    stage: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<String>, String> {
    use crate::qtox_zip_import::{extract_entry, read_directory_with_policy};
    let mut file = File::open(archive).map_err(|_| "UPDATE_ARCHIVE_UNAVAILABLE")?;
    let size = file
        .metadata()
        .map_err(|_| "UPDATE_ARCHIVE_UNAVAILABLE")?
        .len();
    let entries = read_directory_with_policy(&mut file, size, layout.mode == Mode::MacApp)
        .map_err(|_| "UPDATE_ARCHIVE_INVALID")?;
    let prefix = match layout.mode {
        Mode::WindowsPortable => "Kaigen-portable",
        Mode::LinuxAppImage => "Kaigen-portable-debian-x64",
        Mode::MacApp => "Kaigen-portable-macos-universal",
        Mode::WindowsMsi => return Err("UPDATE_PACKAGE_INVALID".into()),
    };
    let mut selected = Vec::new();
    let mut roots = HashSet::new();
    let mut links = Vec::new();
    let names = entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<HashSet<_>>();
    for (index, entry) in entries.iter().enumerate() {
        let name = entry.name.trim_end_matches('/');
        if name == prefix && entry.is_directory {
            continue;
        }
        if layout.mode == Mode::MacApp && (name == "__MACOSX" || name.starts_with("__MACOSX/")) {
            if entry.is_symlink {
                return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
            }
            if !entry.is_directory {
                let metadata = name
                    .strip_prefix("__MACOSX/")
                    .ok_or("UPDATE_ARCHIVE_LAYOUT_INVALID")?;
                let (parent, leaf) = metadata.rsplit_once('/').unwrap_or(("", metadata));
                let leaf = leaf
                    .strip_prefix("._")
                    .ok_or("UPDATE_ARCHIVE_LAYOUT_INVALID")?;
                let real = if parent.is_empty() {
                    leaf.to_string()
                } else {
                    format!("{parent}/{leaf}")
                };
                if !names.contains(real.as_str()) && !names.contains(format!("{real}/").as_str()) {
                    return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
                }
            }
            continue;
        }
        let relative = name
            .strip_prefix(prefix)
            .and_then(|name| name.strip_prefix('/'))
            .ok_or("UPDATE_ARCHIVE_LAYOUT_INVALID")?;
        let parts: Vec<&str> = relative.split('/').collect();
        let first = parts[0];
        if layout.mode == Mode::WindowsPortable {
            if ["data", "profiles", "downloads"].contains(&first) {
                if parts.len() != 1 || !entry.is_directory {
                    return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
                }
                continue;
            }
            validate_windows_entry(relative, entry.is_directory)?;
            if entry.is_symlink {
                return Err("UPDATE_LINK_DENIED".into());
            }
            roots.insert(first.to_string());
            selected.push((index, PathBuf::from(relative)));
        } else if layout.mode == Mode::LinuxAppImage {
            if relative == "kaigen-updater" && !entry.is_directory && !entry.is_symlink {
                roots.insert("kaigen-updater".into());
                selected.push((index, PathBuf::from("kaigen-updater")));
            } else if ["data", "profiles", "downloads"].contains(&first) {
                if parts.len() != 1 || !entry.is_directory {
                    return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
                }
            } else if relative == "Kaigen-x86_64.AppImage"
                && !entry.is_directory
                && !entry.is_symlink
            {
                roots.insert(layout.target_name.clone());
                selected.push((index, PathBuf::from(&layout.target_name)));
            } else if entry.is_symlink
                || parts
                    .iter()
                    .any(|part| PRIVATE_NAMES.contains(&part.to_ascii_lowercase().as_str()))
                    && !entry.is_directory
            {
                return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
            }
        } else {
            if first == "Kaigen-portable-data" {
                if !entry.is_directory
                    || parts.len() > 2
                    || (parts.len() == 2 && !["data", "downloads", "profiles"].contains(&parts[1]))
                {
                    return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
                }
                continue;
            }
            if first != "Kaigen.app" {
                if entry.is_symlink || (parts.len() > 1 && !entry.is_directory) {
                    return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
                }
                continue;
            }
            roots.insert(layout.target_name.clone());
            if entry.is_symlink {
                if entry.uncompressed_size > 4096 {
                    return Err("UPDATE_LINK_DENIED".into());
                }
                if names
                    .iter()
                    .any(|name| name.starts_with(&(entry.name.clone() + "/")))
                {
                    return Err("UPDATE_LINK_DENIED".into());
                }
                links.push(index);
            }
            selected.push((
                index,
                PathBuf::from(&layout.target_name).join(parts.iter().skip(1).collect::<PathBuf>()),
            ));
        }
    }
    create_private_dir(stage)?;
    let total = selected.len() as u64;
    if layout.mode == Mode::MacApp {
        // Read link bodies with the same size/CRC checks before native ditto can
        // materialize anything; targets must stay inside this .app lexically.
        for index in links {
            let temp = stage.join(format!("link-{index}"));
            extract_entry(&mut file, &entries[index], &temp)
                .map_err(|_| "UPDATE_ARCHIVE_INVALID")?;
            let target = fs::read_to_string(&temp).map_err(|_| "UPDATE_LINK_DENIED")?;
            fs::remove_file(&temp).map_err(|_| "UPDATE_DISK_WRITE_FAILED")?;
            checked_bundle_link(&entries[index].name, &target, prefix)?;
        }
        #[cfg(target_os = "macos")]
        {
            let expanded = stage.join("expanded");
            create_private_dir(&expanded)?;
            let status = std::process::Command::new("/usr/bin/ditto")
                .args(["-x", "-k"])
                .arg(archive)
                .arg(&expanded)
                .status()
                .map_err(|_| "UPDATE_EXTRACT_FAILED")?;
            if !status.success() {
                return Err("UPDATE_EXTRACT_FAILED".into());
            }
            let bundle = expanded.join(prefix).join("Kaigen.app");
            validate_tree_links(&bundle, &bundle)?;
            fs::rename(&bundle, stage.join(&layout.target_name))
                .map_err(|_| "UPDATE_EXTRACT_FAILED")?;
            progress(total, total);
        }
        #[cfg(not(target_os = "macos"))]
        return Err("UPDATE_PLATFORM_UNSUPPORTED".into());
    } else {
        for (done, (index, relative)) in selected.iter().enumerate() {
            let entry = &entries[*index];
            let destination = stage.join(relative);
            if entry.is_directory {
                fs::create_dir_all(&destination).map_err(|_| "UPDATE_EXTRACT_FAILED")?;
            } else {
                extract_entry(&mut file, entry, &destination)
                    .map_err(|_| "UPDATE_ARCHIVE_INVALID")?;
            }
            #[cfg(unix)]
            if !entry.is_directory {
                use std::os::unix::fs::PermissionsExt;
                let mode = if layout.mode == Mode::LinuxAppImage {
                    0o755
                } else {
                    u32::from(entry.unix_mode) & 0o777
                };
                fs::set_permissions(&destination, fs::Permissions::from_mode(mode))
                    .map_err(|_| "UPDATE_EXTRACT_FAILED")?;
            }
            progress(done as u64 + 1, total);
        }
    }
    let required = match layout.mode {
        Mode::WindowsPortable => stage.join("Kaigen.exe"),
        Mode::LinuxAppImage => stage.join(&layout.target_name),
        Mode::MacApp => stage.join(&layout.target_name).join("Contents/MacOS").join(
            layout
                .executable
                .file_name()
                .ok_or("UPDATE_PACKAGE_INVALID")?,
        ),
        Mode::WindowsMsi => unreachable!(),
    };
    if !required.is_file() {
        return Err("UPDATE_PACKAGE_INVALID".into());
    }
    if layout.mode == Mode::WindowsPortable
        && [
            "KaigenUpdater.exe",
            "toxcore.dll",
            "pthreadVC3.dll",
            "WebView2Runtime",
            "TorExpertBundle",
            "runtime",
        ]
        .iter()
        .any(|name| !stage.join(name).exists())
    {
        return Err("UPDATE_PACKAGE_INVALID".into());
    }
    if layout.mode == Mode::LinuxAppImage && !stage.join("kaigen-updater").is_file() {
        return Err("UPDATE_HELPER_MISSING".into());
    }
    if layout.mode == Mode::MacApp
        && !stage
            .join(&layout.target_name)
            .join("Contents/Helpers/kaigen-updater")
            .is_file()
    {
        return Err("UPDATE_HELPER_MISSING".into());
    }
    let mut result: Vec<_> = roots.into_iter().collect();
    result.sort();
    if result.is_empty() {
        return Err("UPDATE_PACKAGE_INVALID".into());
    }
    #[cfg(windows)]
    for name in &result {
        prepare_program_acl(&stage.join(name))?;
    }
    Ok(result)
}

#[cfg(windows)]
fn prepare_program_acl(root: &Path) -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SetFileSecurityW,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        },
    };
    // Only admitted program payload receives these rights. The staging parent,
    // journal and every user-data directory retain their private DACL. Explicit
    // ACEs on each file also cover restricted WebView2 AppContainer processes.
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)(A;OICI;GRGX;;;BU)(A;OICI;GRGX;;;AC)(A;OICI;GRGX;;;S-1-15-2-2)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("UPDATE_PROGRAM_PERMISSIONS_FAILED".into());
    }
    fn visit(path: &Path, descriptor: PSECURITY_DESCRIPTOR) -> Result<(), String> {
        checked_path(path)?;
        let metadata =
            fs::symlink_metadata(path).map_err(|_| "UPDATE_PROGRAM_PERMISSIONS_FAILED")?;
        if !metadata.is_dir() && !metadata.is_file() {
            return Err("UPDATE_LINK_DENIED".into());
        }
        // Win32 ACL APIs need the verbatim absolute form for long paths; Rust
        // filesystem operations already support them. Admission above still
        // rejects links before resolving this existing program entry.
        let absolute = fs::canonicalize(path).map_err(|_| "UPDATE_PROGRAM_PERMISSIONS_FAILED")?;
        let name: Vec<u16> = absolute.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            SetFileSecurityW(
                name.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        } == 0
        {
            return Err("UPDATE_PROGRAM_PERMISSIONS_FAILED".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| "UPDATE_PROGRAM_PERMISSIONS_FAILED")? {
                visit(
                    &entry
                        .map_err(|_| "UPDATE_PROGRAM_PERMISSIONS_FAILED")?
                        .path(),
                    descriptor,
                )?;
            }
        }
        Ok(())
    }
    let result = visit(root, descriptor);
    unsafe {
        LocalFree(descriptor);
    }
    result
}

fn validate_windows_entry(name: &str, directory: bool) -> Result<(), String> {
    let parts: Vec<_> = name.split('/').collect();
    let root = parts[0];
    if !WINDOWS_ENTRIES.contains(&root)
        || (parts.len() > 1 && !["WebView2Runtime", "TorExpertBundle", "runtime"].contains(&root))
    {
        return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
    }
    if parts.len() == 1
        && directory != ["WebView2Runtime", "TorExpertBundle", "runtime"].contains(&root)
    {
        return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
    }
    if root == "runtime" && parts.len() > 1 && !["dictionaries", "qtox-import"].contains(&parts[1])
    {
        return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
    }
    if root == "TorExpertBundle" && parts.len() > 1 && !["tor", "data", "docs"].contains(&parts[1])
    {
        return Err("UPDATE_ARCHIVE_LAYOUT_INVALID".into());
    }
    if root == "TorExpertBundle"
        && parts.get(1) == Some(&"data")
        && parts.len() > 2
        && (parts.len() != 3
            || directory
            || !["geoip", "geoip6", "torrc-defaults"].contains(&parts[2]))
    {
        return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
    }
    for (index, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        if PRIVATE_NAMES.contains(&lower.as_str())
            || (lower == "data" && !(root == "TorExpertBundle" && index == 1))
            || [
                "profiles.json",
                "proxy-settings.json",
                "tor-settings.json",
                "local state",
                "preferences",
                "cookies",
            ]
            .contains(&lower.as_str())
            || [".tox", ".kai", ".db", ".sqlite", ".sqlite3", ".log"]
                .iter()
                .any(|ext| lower.ends_with(ext))
        {
            return Err("UPDATE_PRIVATE_DATA_IN_PACKAGE".into());
        }
    }
    Ok(())
}

fn checked_bundle_link(name: &str, target: &str, prefix: &str) -> Result<(), String> {
    if target.is_empty()
        || target.contains(['\\', ':', '\0', '\n', '\r'])
        || Path::new(target).is_absolute()
    {
        return Err("UPDATE_LINK_DENIED".into());
    }
    let mut parts: Vec<_> = name.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.len() <= 2 {
                    return Err("UPDATE_LINK_DENIED".into());
                }
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    if parts.first() != Some(&prefix) || parts.get(1) != Some(&"Kaigen.app") {
        return Err("UPDATE_LINK_DENIED".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn validate_tree_links(root: &Path, at: &Path) -> Result<(), String> {
    for entry in fs::read_dir(at).map_err(|_| "UPDATE_LINK_DENIED")? {
        let entry = entry.map_err(|_| "UPDATE_LINK_DENIED")?;
        let kind = entry.file_type().map_err(|_| "UPDATE_LINK_DENIED")?;
        if kind.is_symlink() {
            if !fs::canonicalize(entry.path())
                .map_err(|_| "UPDATE_LINK_DENIED")?
                .starts_with(root)
            {
                return Err("UPDATE_LINK_DENIED".into());
            }
        } else if kind.is_dir() {
            validate_tree_links(root, &entry.path())?;
        } else if !kind.is_file() {
            return Err("UPDATE_LINK_DENIED".into());
        }
    }
    Ok(())
}
