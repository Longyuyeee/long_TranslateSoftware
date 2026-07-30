use tauri::AppHandle;

fn public_key_is_configured(public_key: Option<&str>) -> bool {
    public_key.is_some_and(|key| !key.trim().is_empty() && !key.contains("REPLACE_WITH"))
}

pub fn is_configured(app: &AppHandle) -> bool {
    public_key_is_configured(
        app.config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config.get("pubkey"))
            .and_then(|key| key.as_str()),
    )
}

#[tauri::command]
pub fn updater_configured(app: AppHandle) -> bool {
    is_configured(&app)
}

#[cfg(test)]
mod tests {
    use super::public_key_is_configured;

    #[test]
    fn updater_requires_a_non_placeholder_public_key() {
        assert!(!public_key_is_configured(None));
        assert!(!public_key_is_configured(Some("  ")));
        assert!(!public_key_is_configured(Some(
            "REPLACE_WITH_YOUR_PUBLIC_KEY"
        )));
        assert!(public_key_is_configured(Some("dW50cnVzdGVkIHRlc3Qga2V5")));
    }
}
