use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn create_empty_file(path: String) -> Result<(), String> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);

    app.dialog().file().pick_folder(move |result| {
        let _ = tx.blocking_send(result);
    });

    let result = rx
        .recv()
        .await
        .ok_or_else(|| "Directory picker closed before returning a result".to_string())?;

    Ok(result
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Native "save as" sheet. Returns the chosen absolute path, or `None` when the
/// user cancelled. Modeled on `pick_directory` — the dialog callback is bridged
/// onto the async runtime through a one-shot channel so the command stays async
/// (no blocking Tauri command; see the ui-responsiveness conformance test).
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);

    // Offer the extension implied by the default file name as a filter, so the
    // sheet doesn't strip/append a surprising suffix.
    let ext = std::path::Path::new(&default_name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned());

    let mut builder = app.dialog().file().set_file_name(&default_name);
    if let Some(ref e) = ext {
        builder = builder.add_filter(e.to_uppercase(), &[e.as_str()]);
    }
    builder.save_file(move |result| {
        let _ = tx.blocking_send(result);
    });

    let result = rx
        .recv()
        .await
        .ok_or_else(|| "Save dialog closed before returning a result".to_string())?;

    Ok(result
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Native "open file" sheet, optionally narrowed to a single extension (passed
/// WITHOUT the leading dot, e.g. `"skillpack"`). Returns the chosen absolute
/// path, or `None` when the user cancelled.
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    extension: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);

    let mut builder = app.dialog().file();
    if let Some(ref ext) = extension {
        let ext = ext.trim_start_matches('.');
        if !ext.is_empty() {
            builder = builder.add_filter(ext.to_uppercase(), &[ext]);
        }
    }
    builder.pick_file(move |result| {
        let _ = tx.blocking_send(result);
    });

    let result = rx
        .recv()
        .await
        .ok_or_else(|| "File picker closed before returning a result".to_string())?;

    Ok(result
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}
