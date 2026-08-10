#![cfg(windows)]

use long_translate_lib::native_registration::{
    register, registered_manifest_paths, unregister, NativeHostManifest, RegistrationSpec,
};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

struct RegistrationFixture {
    spec: RegistrationSpec,
    root: PathBuf,
}

impl RegistrationFixture {
    fn new() -> Self {
        let suffix = Uuid::new_v4().simple().to_string();
        let root = std::env::temp_dir().join(format!("long-translate-registration-{suffix}"));
        fs::create_dir_all(&root).expect("test directory should be created");
        let host_path = std::env::current_exe().expect("test executable path should exist");
        Self {
            spec: RegistrationSpec {
                host_name: format!("com.long.translate_test.{suffix}"),
                host_path,
                manifest_path: root.join("native-host.json"),
                allowed_origins: vec![
                    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(),
                    "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/".to_string(),
                ],
            },
            root,
        }
    }
}

impl Drop for RegistrationFixture {
    fn drop(&mut self) {
        let _ = unregister(&self.spec);
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn current_user_registration_is_idempotent_upgradeable_and_reversible() {
    let mut fixture = RegistrationFixture::new();

    register(&fixture.spec).expect("first registration should succeed");
    register(&fixture.spec).expect("repeated registration should be idempotent");
    let registered = registered_manifest_paths(&fixture.spec.host_name)
        .expect("Chrome and Edge entries should be readable");
    assert_eq!(
        registered,
        [
            Some(fixture.spec.manifest_path.clone()),
            Some(fixture.spec.manifest_path.clone()),
        ]
    );

    fixture.spec.allowed_origins =
        vec!["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_string()];
    register(&fixture.spec).expect("registration upgrade should succeed");
    let manifest: NativeHostManifest = serde_json::from_slice(
        &fs::read(&fixture.spec.manifest_path).expect("manifest should exist"),
    )
    .expect("manifest should remain valid JSON");
    assert_eq!(manifest.allowed_origins, fixture.spec.allowed_origins);

    unregister(&fixture.spec).expect("unregistration should succeed");
    unregister(&fixture.spec).expect("repeated unregistration should be idempotent");
    assert_eq!(
        registered_manifest_paths(&fixture.spec.host_name).unwrap(),
        [None, None]
    );
    assert!(!fixture.spec.manifest_path.exists());
}

#[test]
fn unregistration_preserves_entries_owned_by_another_manifest() {
    let fixture = RegistrationFixture::new();
    register(&fixture.spec).expect("registration should succeed");

    let other = RegistrationSpec {
        manifest_path: fixture.root.join("other-native-host.json"),
        ..fixture.spec.clone()
    };
    unregister(&other).expect("foreign ownership check should not fail");

    assert_eq!(
        registered_manifest_paths(&fixture.spec.host_name).unwrap(),
        [
            Some(fixture.spec.manifest_path.clone()),
            Some(fixture.spec.manifest_path.clone()),
        ]
    );
    assert!(fixture.spec.manifest_path.exists());
}
