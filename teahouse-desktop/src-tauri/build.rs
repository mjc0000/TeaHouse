fn main() {
    // The window controls live in the page (the app is served over http, i.e. a
    // remote origin), so the commands have to be declarable in a capability.
    // This generates `allow-shell-control` / `allow-shell-action` /
    // `allow-shell-state` under the app's ACL manifest.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "shell_control",
                "shell_action",
                "shell_state",
                "shell_zoom",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
