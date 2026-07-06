mod commands;
mod db;
mod error;
mod macos_permissions;
mod models;
mod openai;
mod quick_add;
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

    let app = builder
        .setup(|app| {
            let connection = db::init_database(&app.handle())?;
            let session_id = Uuid::new_v4().to_string();
            let http_client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(90))
                .build()?;
            let app_version = app.package_info().version.to_string();

            app.manage(AppState {
                connection: std::sync::Mutex::new(connection),
                http_client,
                session_id,
                app_version,
                api_key_cache: std::sync::Mutex::new(None),
            });

            quick_add::setup(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quick_add::quick_add_hide_window,
            quick_add::quick_add_resize_window,
            quick_add::quick_add_show_main_window,
            commands::settings_get_status,
            commands::settings_set_openai_key,
            commands::settings_set_openai_model,
            commands::settings_set_calendar_bulk_model,
            commands::settings_set_timeline_preferences,
            commands::settings_set_calendar_bulk_preferences,
            commands::settings_set_quick_add_preferences,
            commands::settings_set_interface_preferences,
            commands::settings_set_transcription_model,
            commands::summary_layout_state_get,
            commands::summary_layout_state_set,
            commands::reporting_state_get,
            commands::reporting_state_set,
            commands::engagement_list,
            commands::engagement_upsert,
            commands::engagement_delete,
            commands::activity_upsert,
            commands::activity_delete,
            commands::timeline_list_for_date,
            commands::timeline_list_for_week_view,
            commands::quick_add_suggestions,
            commands::timeline_month_summary,
            commands::timeline_weekly_summary,
            commands::summary_export_weekly_excel,
            commands::timeline_update_entry,
            commands::timeline_create_entry,
            commands::timeline_delete_entry,
            commands::calendar_extract_events,
            commands::calendar_import_entries,
            commands::transcribe_audio_clip,
            commands::voice_request_microphone_permission,
            commands::interpret_text_message,
            commands::diagnostics_record_frontend_event,
            commands::diagnostics_list,
            commands::diagnostics_copy_bundle,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = _event
        {
            quick_add::handle_app_reopen(_app, has_visible_windows);
        }
    });
}
