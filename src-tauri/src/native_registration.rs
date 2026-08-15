use crate::native_protocol::validate_origin;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const HOST_NAME: &str = "com.long.translate";
pub const MANIFEST_FILE_NAME: &str = "com.long.translate.json";
const REGISTER_FLAG: &str = "--register-native-host";
const UNREGISTER_FLAG: &str = "--unregister-native-host";
const ORIGIN_FLAG: &str = "--origin";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeHostManifest {
    pub name: String,
    pub description: String,
    pub path: String,
    #[serde(rename = "type")]
    pub interface_type: String,
    pub allowed_origins: Vec<String>,
}

impl NativeHostManifest {
    fn new(spec: &RegistrationSpec) -> io::Result<Self> {
        validate_host_name(&spec.host_name)?;
        validate_host_path(&spec.host_path)?;
        let allowed_origins = validate_origins(&spec.allowed_origins)?;
        let path = spec.host_path.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Native Host path must be valid Unicode",
            )
        })?;
        Ok(Self {
            name: spec.host_name.clone(),
            description: "Long Translate browser bridge".to_string(),
            path: path.to_string(),
            interface_type: "stdio".to_string(),
            allowed_origins,
        })
    }

    fn validate_for(&self, host_name: &str, host_path: &Path) -> io::Result<()> {
        if self.name != host_name
            || self.description.trim().is_empty()
            || self.interface_type != "stdio"
            || !paths_equal(Path::new(&self.path), host_path)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Native Host manifest identity does not match this executable",
            ));
        }
        validate_origins(&self.allowed_origins).map(|_| ())
    }
}

#[derive(Clone, Debug)]
pub struct RegistrationSpec {
    pub host_name: String,
    pub host_path: PathBuf,
    pub manifest_path: PathBuf,
    pub allowed_origins: Vec<String>,
}

impl RegistrationSpec {
    pub fn installed(host_path: PathBuf, allowed_origins: Vec<String>) -> io::Result<Self> {
        Ok(Self {
            host_name: HOST_NAME.to_string(),
            manifest_path: installed_manifest_path(&host_path)?,
            host_path,
            allowed_origins,
        })
    }
}

#[cfg(windows)]
fn installed_manifest_path(_host_path: &Path) -> io::Result<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "LOCALAPPDATA is unavailable for Native Host registration",
        )
    })?;
    manifest_path_in_local_app_data(Path::new(&local_app_data))
}

#[cfg(not(windows))]
fn installed_manifest_path(host_path: &Path) -> io::Result<PathBuf> {
    let parent = host_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host executable has no parent directory",
        )
    })?;
    Ok(parent.join(MANIFEST_FILE_NAME))
}

fn manifest_path_in_local_app_data(local_app_data: &Path) -> io::Result<PathBuf> {
    if !local_app_data.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host data root must be an absolute path",
        ));
    }
    Ok(local_app_data
        .join(HOST_NAME)
        .join("native-messaging")
        .join(MANIFEST_FILE_NAME))
}

pub fn handle_cli_command(args: &[String]) -> Option<io::Result<String>> {
    match args.get(1).map(String::as_str) {
        Some(REGISTER_FLAG) => Some(register_from_cli(args)),
        Some(UNREGISTER_FLAG) => Some(unregister_from_cli(args)),
        _ => None,
    }
}

pub fn load_allowed_origins(host_path: &Path) -> io::Result<Vec<String>> {
    let spec = RegistrationSpec::installed(host_path.to_path_buf(), Vec::new())?;
    let bytes = fs::read(&spec.manifest_path)?;
    let manifest = serde_json::from_slice::<NativeHostManifest>(&bytes).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Native Host manifest is invalid JSON: {error}"),
        )
    })?;
    manifest.validate_for(HOST_NAME, host_path)?;
    Ok(manifest.allowed_origins)
}

pub fn register(spec: &RegistrationSpec) -> io::Result<()> {
    let manifest = NativeHostManifest::new(spec)?;
    let payload = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Cannot serialize Native Host manifest: {error}"),
        )
    })?;
    let _lock = RegistrationLock::acquire(&spec.host_name)?;
    recover_interrupted_manifest_update(&spec.manifest_path)?;
    let mut manifest_update = ManifestUpdate::install(&spec.manifest_path, &payload)?;

    if let Err(error) = register_registry_entries(spec) {
        let rollback = manifest_update.rollback();
        return Err(combine_rollback_error(error, rollback));
    }
    manifest_update.commit()
}

pub fn unregister(spec: &RegistrationSpec) -> io::Result<()> {
    validate_host_name(&spec.host_name)?;
    let _lock = RegistrationLock::acquire(&spec.host_name)?;
    recover_interrupted_manifest_update(&spec.manifest_path)?;
    unregister_registry_entries(spec)?;
    remove_owned_manifest(spec)
}

pub fn registered_manifest_paths(host_name: &str) -> io::Result<[Option<PathBuf>; 2]> {
    validate_host_name(host_name)?;
    read_registry_entries(host_name)
}

fn register_from_cli(args: &[String]) -> io::Result<String> {
    let origins = parse_origin_args(&args[2..])?;
    let host_path = current_executable()?;
    let spec = RegistrationSpec::installed(host_path, origins)?;
    register(&spec)?;
    Ok(format!(
        "Native Host registered for Chrome and Edge: {}",
        spec.manifest_path.display()
    ))
}

fn unregister_from_cli(args: &[String]) -> io::Result<String> {
    if args.len() != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{UNREGISTER_FLAG} does not accept additional arguments"),
        ));
    }
    let host_path = current_executable()?;
    let spec = RegistrationSpec::installed(host_path, Vec::new())?;
    unregister(&spec)?;
    Ok("Native Host registration removed from Chrome and Edge".to_string())
}

fn current_executable() -> io::Result<PathBuf> {
    std::env::current_exe()
}

fn parse_origin_args(args: &[String]) -> io::Result<Vec<String>> {
    let mut origins = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] != ORIGIN_FLAG || index + 1 >= args.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Expected repeated {ORIGIN_FLAG} <chrome-extension-origin> arguments"),
            ));
        }
        origins.push(args[index + 1].clone());
        index += 2;
    }
    validate_origins(&origins)
}

fn validate_origins(origins: &[String]) -> io::Result<Vec<String>> {
    if origins.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "At least one explicit extension origin is required",
        ));
    }
    let mut validated = Vec::with_capacity(origins.len());
    for origin in origins {
        validate_origin(origin, std::slice::from_ref(origin))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.message))?;
        if !validated.contains(origin) {
            validated.push(origin.clone());
        }
    }
    Ok(validated)
}

fn validate_host_name(host_name: &str) -> io::Result<()> {
    let valid = !host_name.is_empty()
        && !host_name.starts_with('.')
        && !host_name.ends_with('.')
        && !host_name.contains("..")
        && host_name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.')
        });
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host name does not meet Chromium naming rules",
        ));
    }
    Ok(())
}

fn validate_host_path(host_path: &Path) -> io::Result<()> {
    if !host_path.is_absolute() || !host_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native Host executable must be an existing absolute file",
        ));
    }
    Ok(())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().replace('/', "\\");
    let right = right.to_string_lossy().replace('/', "\\");
    left.eq_ignore_ascii_case(&right)
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.long-translate-backup")
}

fn recover_interrupted_manifest_update(path: &Path) -> io::Result<()> {
    let backup = backup_path(path);
    if backup.exists() {
        if path.exists() {
            fs::remove_file(backup)?;
        } else {
            fs::rename(backup, path)?;
        }
    }
    Ok(())
}

struct ManifestUpdate {
    target: PathBuf,
    backup: PathBuf,
    had_previous: bool,
    finished: bool,
}

struct TemporaryManifest {
    path: PathBuf,
    moved: bool,
}

impl TemporaryManifest {
    fn new(path: PathBuf) -> Self {
        Self { path, moved: false }
    }

    fn mark_moved(&mut self) {
        self.moved = true;
    }
}

impl Drop for TemporaryManifest {
    fn drop(&mut self) {
        if !self.moved {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl ManifestUpdate {
    fn install(target: &Path, payload: &[u8]) -> io::Result<Self> {
        let parent = target.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Manifest has no parent directory",
            )
        })?;
        fs::create_dir_all(parent)?;
        let temporary_path = parent.join(format!(".{MANIFEST_FILE_NAME}.{}.tmp", Uuid::new_v4()));
        let mut temporary = TemporaryManifest::new(temporary_path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.path)?;
        file.write_all(payload)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);

        let backup = backup_path(target);
        let had_previous = target.exists();
        if had_previous {
            fs::rename(target, &backup)?;
        }
        if let Err(error) = fs::rename(&temporary.path, target) {
            if had_previous {
                let _ = fs::rename(&backup, target);
            }
            return Err(error);
        }
        temporary.mark_moved();
        Ok(Self {
            target: target.to_path_buf(),
            backup,
            had_previous,
            finished: false,
        })
    }

    fn commit(&mut self) -> io::Result<()> {
        if self.had_previous && self.backup.exists() {
            fs::remove_file(&self.backup)?;
        }
        self.finished = true;
        Ok(())
    }

    fn rollback(&mut self) -> io::Result<()> {
        if self.target.exists() {
            fs::remove_file(&self.target)?;
        }
        if self.had_previous && self.backup.exists() {
            fs::rename(&self.backup, &self.target)?;
        }
        self.finished = true;
        Ok(())
    }
}

impl Drop for ManifestUpdate {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.rollback();
        }
    }
}

fn remove_owned_manifest(spec: &RegistrationSpec) -> io::Result<()> {
    let bytes = match fs::read(&spec.manifest_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let manifest = serde_json::from_slice::<NativeHostManifest>(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to remove an invalid Native Host manifest",
        )
    })?;
    manifest.validate_for(&spec.host_name, &spec.host_path)?;
    fs::remove_file(&spec.manifest_path)
}

fn combine_rollback_error(error: io::Error, rollback: io::Result<()>) -> io::Error {
    match rollback {
        Ok(()) => error,
        Err(rollback_error) => io::Error::new(
            error.kind(),
            format!("{error}; manifest rollback also failed: {rollback_error}"),
        ),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, WAIT_ABANDONED, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_SZ,
    };
    use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

    const CHROME_KEY: &str = "SOFTWARE\\Google\\Chrome\\NativeMessagingHosts";
    const EDGE_KEY: &str = "SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts";

    struct OwnedKey(HKEY);

    impl Drop for OwnedKey {
        fn drop(&mut self) {
            // SAFETY: the handle was returned by a successful registry open/create call
            // and is closed exactly once by this guard.
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    #[derive(Debug)]
    pub(super) struct RegistrationLock {
        handle: HANDLE,
    }

    impl RegistrationLock {
        pub(super) fn acquire(host_name: &str) -> io::Result<Self> {
            let name = wide(format!(
                "Local\\LongTranslate.NativeHost.Registration.{host_name}"
            ));
            // SAFETY: the name is NUL terminated and the returned handle is owned here.
            let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                .map_err(|error| io::Error::other(error.to_string()))?;
            // SAFETY: handle is a valid mutex handle returned immediately above.
            let wait = unsafe { WaitForSingleObject(handle, 0) };
            if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
                return Ok(Self { handle });
            }
            // SAFETY: this branch never acquired the mutex but still owns its handle.
            unsafe {
                let _ = CloseHandle(handle);
            }
            if wait == WAIT_TIMEOUT {
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "Another Native Host registration is already in progress",
                ))
            } else if wait == WAIT_FAILED {
                Err(io::Error::last_os_error())
            } else {
                Err(io::Error::other(format!(
                    "Unexpected Native Host registration mutex result: {}",
                    wait.0
                )))
            }
        }
    }

    impl Drop for RegistrationLock {
        fn drop(&mut self) {
            // SAFETY: this guard owns the acquired mutex and its handle.
            unsafe {
                let _ = ReleaseMutex(self.handle);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    pub(super) fn register_registry_entries(spec: &RegistrationSpec) -> io::Result<()> {
        let keys = registry_keys(&spec.host_name);
        let previous = keys
            .iter()
            .map(|key| read_default_value(key))
            .collect::<io::Result<Vec<_>>>()?;
        for (index, key) in keys.iter().enumerate() {
            if let Err(error) = write_default_value(key, &spec.manifest_path) {
                let rollback = rollback_values(&keys[..=index], &previous[..=index]);
                return Err(combine_registry_rollback_error(error, rollback));
            }
        }
        Ok(())
    }

    pub(super) fn unregister_registry_entries(spec: &RegistrationSpec) -> io::Result<()> {
        let keys = registry_keys(&spec.host_name);
        let previous = keys
            .iter()
            .map(|key| read_default_value(key))
            .collect::<io::Result<Vec<_>>>()?;
        let mut removed = Vec::new();
        for (index, key) in keys.iter().enumerate() {
            if previous[index]
                .as_deref()
                .is_some_and(|value| paths_equal(value, &spec.manifest_path))
            {
                if let Err(error) = delete_key(key) {
                    let rollback = rollback_removed(&keys, &previous, &removed);
                    return Err(combine_registry_rollback_error(error, rollback));
                }
                removed.push(index);
            }
        }
        Ok(())
    }

    fn registry_keys(host_name: &str) -> [String; 2] {
        [
            format!("{CHROME_KEY}\\{host_name}"),
            format!("{EDGE_KEY}\\{host_name}"),
        ]
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value
            .as_ref()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn check(status: WIN32_ERROR) -> io::Result<()> {
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status.0 as i32))
        }
    }

    fn open_key(path: &str) -> io::Result<Option<OwnedKey>> {
        let path = wide(path);
        let mut key = HKEY::default();
        // SAFETY: path is NUL terminated, key points to writable storage, and the
        // returned handle is immediately wrapped in an owned guard.
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        check(status)?;
        Ok(Some(OwnedKey(key)))
    }

    fn read_default_value(path: &str) -> io::Result<Option<PathBuf>> {
        let Some(key) = open_key(path)? else {
            return Ok(None);
        };
        let mut value_type = Default::default();
        let mut byte_count = 0_u32;
        // SAFETY: querying with no output buffer is the documented way to obtain size.
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR::null(),
                None,
                Some(&mut value_type),
                None,
                Some(&mut byte_count),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        check(status)?;
        if value_type != REG_SZ || byte_count == 0 || !byte_count.is_multiple_of(2) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Native Host registry default value is not a valid REG_SZ",
            ));
        }
        let mut value = vec![0_u16; byte_count as usize / 2];
        // SAFETY: the byte buffer length comes from the preceding registry query.
        check(unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR::null(),
                None,
                Some(&mut value_type),
                Some(value.as_mut_ptr().cast()),
                Some(&mut byte_count),
            )
        })?;
        while value.last() == Some(&0) {
            value.pop();
        }
        Ok(Some(PathBuf::from(OsString::from_wide(&value))))
    }

    fn write_default_value(path: &str, value: &Path) -> io::Result<()> {
        let path = wide(path);
        let value = wide(value.as_os_str());
        let mut key = HKEY::default();
        // SAFETY: both strings are NUL terminated and the returned handle is guarded.
        check(unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), &mut key) })?;
        let key = OwnedKey(key);
        let bytes =
            unsafe { std::slice::from_raw_parts(value.as_ptr().cast::<u8>(), value.len() * 2) };
        // SAFETY: the value buffer remains valid for this synchronous call.
        check(unsafe { RegSetValueExW(key.0, PCWSTR::null(), 0, REG_SZ, Some(bytes)) })
    }

    fn delete_key(path: &str) -> io::Result<()> {
        let path = wide(path);
        // SAFETY: path is a valid NUL-terminated string.
        let status = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())) };
        if status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            check(status)
        }
    }

    fn rollback_values(keys: &[String], values: &[Option<PathBuf>]) -> io::Result<()> {
        for (key, value) in keys.iter().zip(values).rev() {
            match value {
                Some(value) => write_default_value(key, value)?,
                None => delete_key(key)?,
            }
        }
        Ok(())
    }

    fn rollback_removed(
        keys: &[String],
        values: &[Option<PathBuf>],
        removed: &[usize],
    ) -> io::Result<()> {
        for index in removed.iter().rev() {
            if let Some(value) = &values[*index] {
                write_default_value(&keys[*index], value)?;
            }
        }
        Ok(())
    }

    fn combine_registry_rollback_error(error: io::Error, rollback: io::Result<()>) -> io::Error {
        match rollback {
            Ok(()) => error,
            Err(rollback_error) => io::Error::new(
                error.kind(),
                format!("{error}; registry rollback also failed: {rollback_error}"),
            ),
        }
    }

    pub(super) fn read_registry_entries(host_name: &str) -> io::Result<[Option<PathBuf>; 2]> {
        let keys = registry_keys(host_name);
        Ok([read_default_value(&keys[0])?, read_default_value(&keys[1])?])
    }
}

#[cfg(windows)]
use platform::{
    read_registry_entries, register_registry_entries, unregister_registry_entries, RegistrationLock,
};

#[cfg(not(windows))]
fn register_registry_entries(_spec: &RegistrationSpec) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Native Host registration is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
fn unregister_registry_entries(_spec: &RegistrationSpec) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Native Host registration is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
fn read_registry_entries(_host_name: &str) -> io::Result<[Option<PathBuf>; 2]> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Native Host registration is currently supported only on Windows",
    ))
}

#[cfg(not(windows))]
struct RegistrationLock;

#[cfg(not(windows))]
impl RegistrationLock {
    fn acquire(_host_name: &str) -> io::Result<Self> {
        Ok(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_uses_chromium_contract_and_deduplicates_origins() {
        let host_path = std::env::current_exe().unwrap();
        let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string();
        let spec = RegistrationSpec {
            host_name: HOST_NAME.to_string(),
            manifest_path: host_path.with_extension("json"),
            host_path,
            allowed_origins: vec![origin.clone(), origin.clone()],
        };
        let manifest = NativeHostManifest::new(&spec).unwrap();
        assert_eq!(manifest.name, HOST_NAME);
        assert_eq!(manifest.interface_type, "stdio");
        assert_eq!(manifest.allowed_origins, [origin]);
    }

    #[test]
    fn cli_requires_explicit_exact_origins() {
        assert!(parse_origin_args(&[]).is_err());
        assert!(parse_origin_args(&[ORIGIN_FLAG.to_string()]).is_err());
        assert!(parse_origin_args(
            &[ORIGIN_FLAG.to_string(), "chrome-extension://*/".to_string(),]
        )
        .is_err());
        assert_eq!(
            parse_origin_args(&[
                ORIGIN_FLAG.to_string(),
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
            ])
            .unwrap(),
            ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
        );
    }

    #[test]
    fn invalid_host_names_are_rejected() {
        for name in ["", ".host", "host.", "host..name", "Host", "host-name"] {
            assert!(validate_host_name(name).is_err(), "accepted {name}");
        }
        validate_host_name("com.long.translate_test").unwrap();
    }

    #[test]
    fn installed_manifest_uses_a_user_writable_absolute_data_root() {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\Users\fixture\AppData\Local")
        } else {
            PathBuf::from("/tmp/fixture-local-data")
        };
        let path = manifest_path_in_local_app_data(&root).unwrap();
        assert_eq!(
            path,
            root.join(HOST_NAME)
                .join("native-messaging")
                .join(MANIFEST_FILE_NAME)
        );
        assert!(manifest_path_in_local_app_data(Path::new("relative")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn registration_mutex_releases_without_a_stale_file() {
        let host_name = format!("com.long.translate_test.{}", Uuid::new_v4().simple());
        let first = RegistrationLock::acquire(&host_name).unwrap();
        let competing_name = host_name.clone();
        let competing_error =
            std::thread::spawn(move || RegistrationLock::acquire(&competing_name).unwrap_err())
                .join()
                .unwrap();
        assert_eq!(competing_error.kind(), io::ErrorKind::WouldBlock);
        drop(first);
        RegistrationLock::acquire(&host_name).unwrap();
    }
}
