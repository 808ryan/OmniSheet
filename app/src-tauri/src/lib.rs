mod commands;
mod db;
mod error;
mod models;
mod openai;
mod state;

use std::time::Duration;

use state::AppState;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};
use uuid::Uuid;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::LogDir { file_name: None }),
            ])
            .build(),
    );

    builder
        .setup(|app| {
            let connection = db::init_database(&app.handle())?;
            let http_client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(90))
                .build()?;
            let session_id = Uuid::new_v4().to_string();
            let app_version = app.package_info().version.to_string();

            app.manage(AppState {
                connection: std::sync::Mutex::new(connection),
                http_client,
                session_id,
                app_version,
                api_key_cache: std::sync::Mutex::new(None),
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
            commands::timeline_month_summary,
            commands::timeline_weekly_summary,
            commands::summary_export_weekly_excel,
            commands::timeline_update_entry,
            commands::timeline_delete_entry,
            commands::interpret_text_message,
            commands::diagnostics_record_frontend_event,
            commands::diagnostics_list,
            commands::diagnostics_copy_bundle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
