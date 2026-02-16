mod commands;
mod db;
mod error;
mod models;
mod openai;
mod state;

use std::time::Duration;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    if cfg!(debug_assertions) {
        builder = builder.plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );
    }

    builder
        .setup(|app| {
            let connection = db::init_database(&app.handle())?;
            let http_client = reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .build()?;

            app.manage(AppState {
                connection: std::sync::Mutex::new(connection),
                http_client,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get_status,
            commands::settings_set_openai_key,
            commands::engagement_list,
            commands::engagement_upsert,
            commands::engagement_delete,
            commands::activity_upsert,
            commands::activity_delete,
            commands::timeline_list_for_date,
            commands::timeline_update_entry,
            commands::interpret_text_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
