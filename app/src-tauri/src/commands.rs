use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime};
use keyring::{Entry, Error as KeyringError};
use rusqlite::Connection;
use rust_xlsxwriter::{Format, Workbook, XlsxError};
use serde_json::{json, Value};
use tauri::{Manager, State};
use uuid::Uuid;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::macos_permissions;
use crate::models::{
    Activity, ActivityUpsertInput, ApiKeyInput, CaptureSourceId, CodeContext, ContextActivity,
    ContextEngagement, DateInput, DiagnosticsBundle, DiagnosticsEvent, DiagnosticsListInput,
    DiagnosticsRecordInput, Engagement, EngagementUpsertInput, IdInput, IdResult, InterpretResult,
    InterpretTextInput, KeySource, LlmAlternativeActivity, LlmEntry, MicrophonePermissionResult,
    MicrophonePermissionStatus, NormalizedEntry, OpenAiModelId, SettingsSetOpenAiModelInput,
    SettingsSetTranscriptionModelInput, SettingsStatus, StatusLevel, StorageHealth,
    SummaryExportResult, SummaryExportWeeklyExcelInput, SummaryLayoutColumn,
    SummaryLayoutFieldKey, SummaryLayoutPreset, SummaryLayoutState, TimelineCreateInput,
    TimelineDaySummary, TimelineEntry,
    TimelineMonthSummaryInput, TimelineUpdateInput, TimelineUpdateMode, TimelineWeekView,
    TimelineWeekViewDay, TimelineWeeklySummary, TimelineWeeklySummaryNote, TranscribeAudioInput,
    TranscribeAudioResult, TranscriptionModelId, Warning, WarningType,
};
use crate::openai;
use crate::state::AppState;

const MINUTES_IN_DAY: i64 = 24 * 60;
const TIME_INCREMENT_MINUTES: i64 = 15;
const DEFAULT_FALLBACK_DURATION_MINUTES: i64 = 30;
const ACTIVITY_FALLBACK_CONFIDENCE_CAP: f64 = 0.60;
const ACTIVITY_MATCH_SCORE_EPSILON: f64 = 1e-6;
const GLOBAL_ACTIVITY_FALLBACK_MIN_SCORE: f64 = 2.5;
const GLOBAL_ACTIVITY_FALLBACK_MIN_MARGIN: f64 = 0.75;
const MAX_SAVED_ENTRIES_PER_MESSAGE: usize = 8;
const APP_SETTING_OPENAI_MODEL: &str = "openai_model";
const APP_SETTING_TRANSCRIPTION_MODEL: &str = "openai_transcription_model";
const APP_SETTING_SUMMARY_LAYOUT_STATE: &str = "summary_layout_state";
const SUMMARY_LAYOUT_STATE_VERSION: i64 = 2;
const SUMMARY_LAYOUT_MAX_NAME_LENGTH: usize = 40;
const DEFAULT_SUMMARY_LAYOUT_PRESET_ID: &str = "preset-standard";
const DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID: &str = "row-total";
const SUMMARY_DAY_NAMES: [&str; 7] = [
    "Saturday",
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
];

fn state_lock_error() -> String {
    "application state lock poisoned".to_string()
}

fn default_summary_layout_row_total_column() -> SummaryLayoutColumn {
    SummaryLayoutColumn::RowTotal {
        id: DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID.to_string(),
    }
}

fn duration_ms(started_at: Instant) -> i64 {
    started_at.elapsed().as_millis() as i64
}

fn format_command_error(correlation_id: &str, message: impl AsRef<str>) -> String {
    format!(
        "{} [correlationId: {correlation_id}]",
        message.as_ref().trim()
    )
}

fn storage_health_label(value: &StorageHealth) -> &'static str {
    match value {
        StorageHealth::Ok => "ok",
        StorageHealth::Unavailable => "unavailable",
        StorageHealth::ReadError => "read_error",
    }
}

fn key_source_label(value: &KeySource) -> &'static str {
    match value {
        KeySource::Keyring => "keyring",
        KeySource::SessionCache => "session_cache",
        KeySource::None => "none",
    }
}

fn status_level_label(value: &StatusLevel) -> &'static str {
    match value {
        StatusLevel::Ok => "ok",
        StatusLevel::Warning => "warning",
        StatusLevel::Error => "error",
    }
}

fn openai_model_options() -> Vec<crate::models::OpenAiModelOption> {
    OpenAiModelId::options()
}

fn transcription_model_options() -> Vec<crate::models::TranscriptionModelOption> {
    TranscriptionModelId::options()
}

fn resolve_saved_openai_model_value(
    saved_value: Option<String>,
) -> (OpenAiModelId, Option<String>) {
    match saved_value {
        Some(value) => match OpenAiModelId::from_api_name(&value) {
            Some(model) => (model, None),
            None => (OpenAiModelId::default(), Some(value)),
        },
        None => (OpenAiModelId::default(), None),
    }
}

fn read_saved_openai_model(connection: &Connection) -> AppResult<(OpenAiModelId, Option<String>)> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_OPENAI_MODEL)?;
    Ok(resolve_saved_openai_model_value(saved_value))
}

fn resolve_saved_transcription_model_value(
    saved_value: Option<String>,
) -> (TranscriptionModelId, Option<String>) {
    match saved_value {
        Some(value) => match TranscriptionModelId::from_api_name(&value) {
            Some(model) => (model, None),
            None => (TranscriptionModelId::default(), Some(value)),
        },
        None => (TranscriptionModelId::default(), None),
    }
}

fn read_saved_transcription_model(
    connection: &Connection,
) -> AppResult<(TranscriptionModelId, Option<String>)> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_TRANSCRIPTION_MODEL)?;
    Ok(resolve_saved_transcription_model_value(saved_value))
}

fn default_summary_layout_columns() -> Vec<SummaryLayoutColumn> {
    vec![
        SummaryLayoutColumn::Field {
            id: "field-engagement-code".to_string(),
            field_key: SummaryLayoutFieldKey::EngagementCode,
        },
        SummaryLayoutColumn::Field {
            id: "field-activity-code".to_string(),
            field_key: SummaryLayoutFieldKey::ActivityCode,
        },
        SummaryLayoutColumn::Field {
            id: "field-activity-name".to_string(),
            field_key: SummaryLayoutFieldKey::ActivityName,
        },
        SummaryLayoutColumn::Field {
            id: "field-engagement-name".to_string(),
            field_key: SummaryLayoutFieldKey::EngagementName,
        },
        SummaryLayoutColumn::Field {
            id: "field-client-name".to_string(),
            field_key: SummaryLayoutFieldKey::ClientName,
        },
        SummaryLayoutColumn::Day {
            id: "day-0".to_string(),
            day_index: 0,
        },
        SummaryLayoutColumn::Day {
            id: "day-1".to_string(),
            day_index: 1,
        },
        SummaryLayoutColumn::Day {
            id: "day-2".to_string(),
            day_index: 2,
        },
        SummaryLayoutColumn::Day {
            id: "day-3".to_string(),
            day_index: 3,
        },
        SummaryLayoutColumn::Day {
            id: "day-4".to_string(),
            day_index: 4,
        },
        SummaryLayoutColumn::Day {
            id: "day-5".to_string(),
            day_index: 5,
        },
        SummaryLayoutColumn::Day {
            id: "day-6".to_string(),
            day_index: 6,
        },
        default_summary_layout_row_total_column(),
    ]
}

fn default_summary_layout_state() -> SummaryLayoutState {
    SummaryLayoutState {
        version: SUMMARY_LAYOUT_STATE_VERSION,
        selected_preset_id: DEFAULT_SUMMARY_LAYOUT_PRESET_ID.to_string(),
        presets: vec![SummaryLayoutPreset {
            id: DEFAULT_SUMMARY_LAYOUT_PRESET_ID.to_string(),
            name: "Standard".to_string(),
            columns: default_summary_layout_columns(),
        }],
    }
}

fn next_summary_layout_row_total_column_id(existing_ids: &HashSet<String>) -> String {
    if !existing_ids.contains(DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID) {
        return DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID.to_string();
    }

    let mut suffix = 1usize;
    loop {
        let candidate = format!(
            "{}-{suffix}",
            DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID
        );
        if !existing_ids.contains(&candidate) {
            return candidate;
        }

        suffix += 1;
    }
}

fn normalize_summary_layout_state(
    mut state: SummaryLayoutState,
) -> Result<SummaryLayoutState, String> {
    state.version = SUMMARY_LAYOUT_STATE_VERSION;
    state.selected_preset_id = state.selected_preset_id.trim().to_string();

    if state.presets.is_empty() {
        return Err("At least one summary layout preset is required.".to_string());
    }

    let mut preset_ids = HashSet::new();
    let mut preset_names = HashSet::new();

    for preset in &mut state.presets {
        preset.id = preset.id.trim().to_string();
        preset.name = preset.name.trim().to_string();

        if preset.id.is_empty() {
            return Err("Summary layout preset IDs cannot be empty.".to_string());
        }

        if preset.name.is_empty() {
            return Err("Summary layout preset names cannot be empty.".to_string());
        }

        if preset.name.chars().count() > SUMMARY_LAYOUT_MAX_NAME_LENGTH {
            return Err(format!(
                "Summary layout preset names must be {} characters or fewer.",
                SUMMARY_LAYOUT_MAX_NAME_LENGTH
            ));
        }

        if !preset_ids.insert(preset.id.clone()) {
            return Err("Summary layout preset IDs must be unique.".to_string());
        }

        if !preset_names.insert(preset.name.to_lowercase()) {
            return Err("Summary layout preset names must be unique.".to_string());
        }

        let mut column_ids = HashSet::new();
        let mut field_keys = HashSet::new();
        let mut day_indexes = HashSet::new();
        let mut row_total_count = 0usize;

        for column in &mut preset.columns {
            match column {
                SummaryLayoutColumn::Field { id, field_key } => {
                    *id = id.trim().to_string();
                    if id.is_empty() {
                        return Err(
                            "Summary layout field column IDs cannot be empty.".to_string(),
                        );
                    }
                    if !column_ids.insert(id.clone()) {
                        return Err("Summary layout column IDs must be unique.".to_string());
                    }
                    if !field_keys.insert(*field_key) {
                        return Err(
                            "A summary layout preset cannot include the same field twice."
                                .to_string(),
                        );
                    }
                }
                SummaryLayoutColumn::Day { id, day_index } => {
                    *id = id.trim().to_string();
                    if id.is_empty() {
                        return Err("Summary layout day column IDs cannot be empty.".to_string());
                    }
                    if !column_ids.insert(id.clone()) {
                        return Err("Summary layout column IDs must be unique.".to_string());
                    }
                    if *day_index > 6 {
                        return Err("Summary layout day indexes must be between 0 and 6.".to_string());
                    }
                    if !day_indexes.insert(*day_index) {
                        return Err(
                            "A summary layout preset cannot include the same day twice.".to_string(),
                        );
                    }
                }
                SummaryLayoutColumn::FreeText { id, label } => {
                    *id = id.trim().to_string();
                    *label = label.trim().to_string();
                    if id.is_empty() {
                        return Err(
                            "Summary layout free-text column IDs cannot be empty.".to_string(),
                        );
                    }
                    if !column_ids.insert(id.clone()) {
                        return Err("Summary layout column IDs must be unique.".to_string());
                    }
                    if label.is_empty() {
                        return Err(
                            "Summary layout free-text column labels cannot be empty.".to_string(),
                        );
                    }
                }
                SummaryLayoutColumn::RowTotal { id } => {
                    *id = id.trim().to_string();
                    if id.is_empty() {
                        return Err(
                            "Summary layout Row Total column IDs cannot be empty.".to_string(),
                        );
                    }
                    if !column_ids.insert(id.clone()) {
                        return Err("Summary layout column IDs must be unique.".to_string());
                    }
                    row_total_count += 1;
                    if row_total_count > 1 {
                        return Err(
                            "A summary layout preset cannot include Row Total more than once."
                                .to_string(),
                        );
                    }
                }
            }
        }

        if row_total_count == 0 {
            let row_total_id = next_summary_layout_row_total_column_id(&column_ids);
            column_ids.insert(row_total_id.clone());
            preset
                .columns
                .push(SummaryLayoutColumn::RowTotal { id: row_total_id });
        }

        let has_non_row_total_column = preset
            .columns
            .iter()
            .any(|column| !matches!(column, SummaryLayoutColumn::RowTotal { .. }));
        if !has_non_row_total_column {
            return Err(
                "Each summary layout preset must include at least one column besides Row Total."
                    .to_string(),
            );
        }
    }

    if state.selected_preset_id.is_empty() {
        return Err("A selected summary layout preset is required.".to_string());
    }

    if !preset_ids.contains(&state.selected_preset_id) {
        return Err("The selected summary layout preset does not exist.".to_string());
    }

    Ok(state)
}

fn read_summary_layout_state(connection: &Connection) -> AppResult<SummaryLayoutState> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_SUMMARY_LAYOUT_STATE)?;
    let state = saved_value
        .as_deref()
        .and_then(|value| serde_json::from_str::<SummaryLayoutState>(value).ok())
        .and_then(|state| normalize_summary_layout_state(state).ok())
        .unwrap_or_else(default_summary_layout_state);

    let serialized_state = serde_json::to_string(&state)?;
    if saved_value.as_deref() != Some(serialized_state.as_str()) {
        db::upsert_app_setting(
            connection,
            APP_SETTING_SUMMARY_LAYOUT_STATE,
            serialized_state.as_str(),
        )?;
    }

    Ok(state)
}

fn resolve_requested_openai_model(
    requested_model: Option<OpenAiModelId>,
    saved_model: OpenAiModelId,
) -> OpenAiModelId {
    requested_model.unwrap_or(saved_model)
}

fn capture_source_label(value: CaptureSourceId) -> &'static str {
    match value {
        CaptureSourceId::Text => "text",
        CaptureSourceId::Voice => "voice",
    }
}

fn microphone_permission_status_label(value: MicrophonePermissionStatus) -> &'static str {
    match value {
        MicrophonePermissionStatus::Granted => "granted",
        MicrophonePermissionStatus::Denied => "denied",
        MicrophonePermissionStatus::Restricted => "restricted",
        MicrophonePermissionStatus::NotDetermined => "not_determined",
        MicrophonePermissionStatus::Unsupported => "unsupported",
    }
}

fn record_invalid_saved_openai_model(
    state: &State<'_, AppState>,
    correlation_id: &str,
    command: &str,
    invalid_value: &str,
) {
    record_backend_event_with_state(
        state,
        correlation_id,
        "settings_model_fallback",
        command,
        "warning",
        None,
        None,
        json!({
          "message": "Invalid saved OpenAI model; defaulted to GPT-5 Nano.",
          "invalidValue": invalid_value,
          "fallbackModel": OpenAiModelId::default().api_name(),
          "fallbackModelLabel": OpenAiModelId::default().display_label(),
        }),
    );
}

fn record_invalid_saved_transcription_model(
    state: &State<'_, AppState>,
    correlation_id: &str,
    command: &str,
    invalid_value: &str,
) {
    record_backend_event_with_state(
        state,
        correlation_id,
        "settings_model_fallback",
        command,
        "warning",
        None,
        None,
        json!({
          "message": "Invalid saved transcription model; defaulted to GPT-4o Mini Transcribe.",
          "invalidValue": invalid_value,
          "fallbackModel": TranscriptionModelId::default().api_name(),
          "fallbackModelLabel": TranscriptionModelId::default().display_label(),
        }),
    );
}

fn timeline_month_bounds(month: &str) -> Result<(String, String), String> {
    let trimmed = month.trim();
    let mut parts = trimmed.split('-');
    let year = parts
        .next()
        .ok_or_else(|| "month must be in YYYY-MM format".to_string())?
        .parse::<i32>()
        .map_err(|_| "month must be in YYYY-MM format".to_string())?;
    let month_number = parts
        .next()
        .ok_or_else(|| "month must be in YYYY-MM format".to_string())?
        .parse::<u32>()
        .map_err(|_| "month must be in YYYY-MM format".to_string())?;

    if parts.next().is_some() {
        return Err("month must be in YYYY-MM format".to_string());
    }

    let start = NaiveDate::from_ymd_opt(year, month_number, 1)
        .ok_or_else(|| "month must be a valid calendar month".to_string())?;

    let (end_year, end_month) = if month_number == 12 {
        (year + 1, 1)
    } else {
        (year, month_number + 1)
    };

    let end_exclusive = NaiveDate::from_ymd_opt(end_year, end_month, 1)
        .ok_or_else(|| "failed to resolve month boundary".to_string())?;

    Ok((
        start.format("%Y-%m-%d").to_string(),
        end_exclusive.format("%Y-%m-%d").to_string(),
    ))
}

fn timeline_week_bounds(date: &str) -> Result<(String, String), String> {
    let selected_date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "date must be in YYYY-MM-DD format".to_string())?;
    let days_since_saturday = (selected_date.weekday().num_days_from_sunday() + 1) % 7;
    let week_start = selected_date - Duration::days(days_since_saturday as i64);
    let week_end_exclusive = week_start + Duration::days(7);

    Ok((
        week_start.format("%Y-%m-%d").to_string(),
        week_end_exclusive.format("%Y-%m-%d").to_string(),
    ))
}

fn timeline_week_view_bounds(date: &str) -> Result<(String, String), String> {
    let selected_date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "date must be in YYYY-MM-DD format".to_string())?;
    let days_since_sunday = selected_date.weekday().num_days_from_sunday() as i64;
    let week_start = selected_date - Duration::days(days_since_sunday);
    let week_end_exclusive = week_start + Duration::days(7);

    Ok((
        week_start.format("%Y-%m-%d").to_string(),
        week_end_exclusive.format("%Y-%m-%d").to_string(),
    ))
}

fn month_key_from_iso_date(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() < 7 {
        return None;
    }

    let month_key = &trimmed[..7];
    if NaiveDate::parse_from_str(&format!("{month_key}-01"), "%Y-%m-%d").is_ok() {
        Some(month_key.to_string())
    } else {
        None
    }
}

fn summary_day_header(day_index: usize, iso_date: &str) -> String {
    let day_name = SUMMARY_DAY_NAMES.get(day_index).copied().unwrap_or("Day");
    match NaiveDate::parse_from_str(iso_date.trim(), "%Y-%m-%d") {
        Ok(value) => format!("{day_name} ({})", value.format("%m/%d")),
        Err(_) => format!("{day_name} ({iso_date})"),
    }
}

fn format_minutes_as_hours(minutes: i64) -> f64 {
    (minutes as f64) / 60.0
}

fn format_summary_notes_for_export(notes: &[TimelineWeeklySummaryNote]) -> String {
    notes
        .iter()
        .map(|note| {
            format!(
                "{:.2} Hours: {}",
                format_minutes_as_hours(note.duration_minutes),
                note.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("failed to resolve Downloads folder: {error}"))?;

    fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("failed to create Downloads folder: {error}"))?;

    Ok(downloads_dir)
}

fn choose_export_file_path(downloads_dir: &Path, base_name: &str) -> PathBuf {
    let initial_path = downloads_dir.join(format!("{base_name}.xlsx"));
    if !initial_path.exists() {
        return initial_path;
    }

    let mut suffix = 2usize;
    loop {
        let candidate = downloads_dir.join(format!("{base_name} ({suffix}).xlsx"));
        if !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SummaryExportSheetColumnKind {
    Field(SummaryLayoutFieldKey),
    DayHours(usize),
    DayNotes(usize),
    FreeText,
    RowTotal,
}

#[derive(Debug, Clone)]
struct SummaryExportSheetColumn {
    header: String,
    kind: SummaryExportSheetColumnKind,
    width: u16,
    wrap_text: bool,
}

fn normalize_summary_layout_preset_for_export(
    preset: SummaryLayoutPreset,
) -> Result<SummaryLayoutPreset, String> {
    let normalized_state = normalize_summary_layout_state(SummaryLayoutState {
        version: SUMMARY_LAYOUT_STATE_VERSION,
        selected_preset_id: preset.id.clone(),
        presets: vec![preset],
    })?;

    normalized_state
        .presets
        .into_iter()
        .next()
        .ok_or_else(|| "At least one summary layout preset is required.".to_string())
}

fn summary_layout_field_label(field_key: SummaryLayoutFieldKey) -> &'static str {
    match field_key {
        SummaryLayoutFieldKey::EngagementCode => "Engagement Code",
        SummaryLayoutFieldKey::EngagementName => "Engagement Name",
        SummaryLayoutFieldKey::ClientName => "Client Name",
        SummaryLayoutFieldKey::EngagementTags => "Engagement Tags",
        SummaryLayoutFieldKey::EngagementUsage => "Engagement Usage",
        SummaryLayoutFieldKey::ActivityCode => "Activity Code",
        SummaryLayoutFieldKey::ActivityName => "Activity Name",
        SummaryLayoutFieldKey::ActivityTags => "Activity Tags",
        SummaryLayoutFieldKey::ActivityUsage => "Activity Usage",
    }
}

fn summary_layout_field_width(field_key: SummaryLayoutFieldKey) -> u16 {
    match field_key {
        SummaryLayoutFieldKey::EngagementCode => 16,
        SummaryLayoutFieldKey::ActivityCode => 14,
        SummaryLayoutFieldKey::ActivityName => 24,
        SummaryLayoutFieldKey::EngagementName => 24,
        SummaryLayoutFieldKey::ClientName => 20,
        SummaryLayoutFieldKey::EngagementTags => 22,
        SummaryLayoutFieldKey::EngagementUsage => 28,
        SummaryLayoutFieldKey::ActivityTags => 22,
        SummaryLayoutFieldKey::ActivityUsage => 28,
    }
}

fn summary_layout_field_wraps(field_key: SummaryLayoutFieldKey) -> bool {
    matches!(
        field_key,
        SummaryLayoutFieldKey::EngagementTags
            | SummaryLayoutFieldKey::EngagementUsage
            | SummaryLayoutFieldKey::ActivityTags
            | SummaryLayoutFieldKey::ActivityUsage
    )
}

fn summary_day_date<'a>(summary: &'a TimelineWeeklySummary, day_index: usize) -> &'a str {
    summary
        .days
        .get(day_index)
        .map(|day| day.date.as_str())
        .unwrap_or(summary.week_start_date.as_str())
}

fn summary_day_notes_header(summary: &TimelineWeeklySummary, day_index: usize) -> String {
    format!(
        "{} Notes",
        summary_day_header(day_index, summary_day_date(summary, day_index))
    )
}

fn summary_day_hours_header(summary: &TimelineWeeklySummary, day_index: usize) -> String {
    format!(
        "{} Hours",
        summary_day_header(day_index, summary_day_date(summary, day_index))
    )
}

fn build_summary_export_hours_sheet_columns(
    summary: &TimelineWeeklySummary,
    preset: &SummaryLayoutPreset,
) -> Vec<SummaryExportSheetColumn> {
    let mut columns = Vec::new();

    for column in &preset.columns {
        match column {
            SummaryLayoutColumn::Field { field_key, .. } => columns.push(SummaryExportSheetColumn {
                header: summary_layout_field_label(*field_key).to_string(),
                kind: SummaryExportSheetColumnKind::Field(*field_key),
                width: summary_layout_field_width(*field_key),
                wrap_text: summary_layout_field_wraps(*field_key),
            }),
            SummaryLayoutColumn::Day { day_index, .. } => {
                let resolved_day_index = *day_index as usize;
                columns.push(SummaryExportSheetColumn {
                    header: summary_day_header(
                        resolved_day_index,
                        summary_day_date(summary, resolved_day_index),
                    ),
                    kind: SummaryExportSheetColumnKind::DayHours(resolved_day_index),
                    width: 12,
                    wrap_text: false,
                });
            }
            SummaryLayoutColumn::FreeText { label, .. } => columns.push(SummaryExportSheetColumn {
                header: label.clone(),
                kind: SummaryExportSheetColumnKind::FreeText,
                width: 18,
                wrap_text: true,
            }),
            SummaryLayoutColumn::RowTotal { .. } => columns.push(SummaryExportSheetColumn {
                header: "Row Total".to_string(),
                kind: SummaryExportSheetColumnKind::RowTotal,
                width: 12,
                wrap_text: false,
            }),
        }
    }

    columns
}

fn build_summary_export_hours_and_notes_sheet_columns(
    summary: &TimelineWeeklySummary,
    preset: &SummaryLayoutPreset,
) -> Vec<SummaryExportSheetColumn> {
    let mut columns = Vec::new();
    let mut column_index = 0usize;

    while column_index < preset.columns.len() {
        match &preset.columns[column_index] {
            SummaryLayoutColumn::Field { field_key, .. } => {
                columns.push(SummaryExportSheetColumn {
                    header: summary_layout_field_label(*field_key).to_string(),
                    kind: SummaryExportSheetColumnKind::Field(*field_key),
                    width: summary_layout_field_width(*field_key),
                    wrap_text: summary_layout_field_wraps(*field_key),
                });
            }
            SummaryLayoutColumn::Day { day_index, .. } => {
                let resolved_day_index = *day_index as usize;
                columns.push(SummaryExportSheetColumn {
                    header: summary_day_hours_header(summary, resolved_day_index),
                    kind: SummaryExportSheetColumnKind::DayHours(resolved_day_index),
                    width: 12,
                    wrap_text: false,
                });

                if matches!(
                    preset.columns.get(column_index + 1),
                    Some(SummaryLayoutColumn::FreeText { .. })
                ) {
                    columns.push(SummaryExportSheetColumn {
                        header: summary_day_notes_header(summary, resolved_day_index),
                        kind: SummaryExportSheetColumnKind::DayNotes(resolved_day_index),
                        width: 42,
                        wrap_text: true,
                    });
                    column_index += 1;
                } else {
                    columns.push(SummaryExportSheetColumn {
                        header: summary_day_notes_header(summary, resolved_day_index),
                        kind: SummaryExportSheetColumnKind::DayNotes(resolved_day_index),
                        width: 42,
                        wrap_text: true,
                    });
                }
            }
            SummaryLayoutColumn::FreeText { label, .. } => {
                columns.push(SummaryExportSheetColumn {
                    header: label.clone(),
                    kind: SummaryExportSheetColumnKind::FreeText,
                    width: 18,
                    wrap_text: true,
                });
            }
            SummaryLayoutColumn::RowTotal { .. } => {
                columns.push(SummaryExportSheetColumn {
                    header: "Row Total".to_string(),
                    kind: SummaryExportSheetColumnKind::RowTotal,
                    width: 12,
                    wrap_text: false,
                });
            }
        }

        column_index += 1;
    }

    columns
}

fn normalize_export_display_text(value: Option<&str>) -> Option<String> {
    value
        .map(|candidate| candidate.trim())
        .filter(|candidate| !candidate.is_empty())
        .map(|candidate| candidate.to_string())
}

fn format_summary_code_value_for_export(code: Option<&str>, is_uncategorized: bool) -> String {
    if is_uncategorized {
        return "UNCAT".to_string();
    }

    normalize_export_display_text(code).unwrap_or_default()
}

fn resolve_summary_export_field_value(
    field_key: SummaryLayoutFieldKey,
    row: &crate::models::TimelineWeeklySummaryRow,
    engagement_by_id: &HashMap<String, Engagement>,
    activity_by_id: &HashMap<String, Activity>,
) -> String {
    let engagement = row
        .engagement_id
        .as_ref()
        .and_then(|engagement_id| engagement_by_id.get(engagement_id));
    let activity = row
        .activity_id
        .as_ref()
        .and_then(|activity_id| activity_by_id.get(activity_id));

    match field_key {
        SummaryLayoutFieldKey::EngagementCode => {
            format_summary_code_value_for_export(row.engagement_code.as_deref(), row.is_uncategorized)
        }
        SummaryLayoutFieldKey::EngagementName => row.engagement_name.clone(),
        SummaryLayoutFieldKey::ClientName => {
            normalize_export_display_text(Some(row.client_name.as_str()))
                .unwrap_or_else(|| "-".to_string())
        }
        SummaryLayoutFieldKey::EngagementTags => engagement
            .filter(|engagement| !engagement.tags.is_empty())
            .map(|engagement| engagement.tags.join(", "))
            .unwrap_or_else(|| "-".to_string()),
        SummaryLayoutFieldKey::EngagementUsage => normalize_export_display_text(
            engagement.and_then(|engagement| engagement.describe_when_to_use.as_deref()),
        )
        .unwrap_or_else(|| "-".to_string()),
        SummaryLayoutFieldKey::ActivityCode => {
            format_summary_code_value_for_export(row.activity_code.as_deref(), row.is_uncategorized)
        }
        SummaryLayoutFieldKey::ActivityName => row.activity_name.clone(),
        SummaryLayoutFieldKey::ActivityTags => activity
            .filter(|activity| !activity.tags.is_empty())
            .map(|activity| activity.tags.join(", "))
            .unwrap_or_else(|| "-".to_string()),
        SummaryLayoutFieldKey::ActivityUsage => normalize_export_display_text(
            activity.and_then(|activity| activity.describe_when_to_use.as_deref()),
        )
        .unwrap_or_else(|| "-".to_string()),
    }
}

fn build_export_metadata_maps(
    engagements: &[Engagement],
) -> (HashMap<String, Engagement>, HashMap<String, Activity>) {
    let mut engagement_by_id = HashMap::new();
    let mut activity_by_id = HashMap::new();

    for engagement in engagements {
        for activity in &engagement.activities {
            activity_by_id.insert(activity.id.clone(), activity.clone());
        }

        engagement_by_id.insert(engagement.id.clone(), engagement.clone());
    }

    (engagement_by_id, activity_by_id)
}

fn summary_export_footer_label_column_index(
    columns: &[SummaryExportSheetColumn],
) -> Option<usize> {
    columns.iter().position(|column| {
        !matches!(
            column.kind,
            SummaryExportSheetColumnKind::DayHours(_)
                | SummaryExportSheetColumnKind::DayNotes(_)
                | SummaryExportSheetColumnKind::RowTotal
        )
    })
}

fn write_layout_driven_summary_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    summary: &TimelineWeeklySummary,
    columns: &[SummaryExportSheetColumn],
    engagement_by_id: &HashMap<String, Engagement>,
    activity_by_id: &HashMap<String, Activity>,
) -> Result<(), XlsxError> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name(sheet_name)?;
    worksheet.set_freeze_panes(1, 0)?;

    let header_format = Format::new().set_bold();
    let hours_format = Format::new().set_num_format("0.00");
    let wrapped_text_format = Format::new().set_text_wrap();
    let plain_text_format = Format::new();
    let footer_label_column_index = summary_export_footer_label_column_index(columns);

    for (column_index, column) in columns.iter().enumerate() {
        let excel_column = column_index as u16;
        worksheet.write_with_format(0, excel_column, column.header.as_str(), &header_format)?;
        worksheet.set_column_width(excel_column, column.width)?;
    }

    let mut row_index: u32 = 1;
    for row in &summary.rows {
        for (column_index, column) in columns.iter().enumerate() {
            let excel_column = column_index as u16;
            match column.kind {
                SummaryExportSheetColumnKind::Field(field_key) => {
                    let value = resolve_summary_export_field_value(
                        field_key,
                        row,
                        engagement_by_id,
                        activity_by_id,
                    );
                    if column.wrap_text {
                        worksheet.write_with_format(
                            row_index,
                            excel_column,
                            value.as_str(),
                            &wrapped_text_format,
                        )?;
                    } else {
                        worksheet.write(row_index, excel_column, value.as_str())?;
                    }
                }
                SummaryExportSheetColumnKind::DayHours(day_index) => {
                    let total_minutes = row
                        .cells
                        .get(day_index)
                        .map(|cell| cell.total_minutes)
                        .unwrap_or(0);
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        format_minutes_as_hours(total_minutes),
                        &hours_format,
                    )?;
                }
                SummaryExportSheetColumnKind::DayNotes(day_index) => {
                    let notes = row
                        .cells
                        .get(day_index)
                        .map(|cell| format_summary_notes_for_export(&cell.notes))
                        .unwrap_or_default();
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        notes.as_str(),
                        &wrapped_text_format,
                    )?;
                }
                SummaryExportSheetColumnKind::FreeText => {
                    let format = if column.wrap_text {
                        &wrapped_text_format
                    } else {
                        &plain_text_format
                    };
                    worksheet.write_with_format(row_index, excel_column, "", format)?;
                }
                SummaryExportSheetColumnKind::RowTotal => {
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        format_minutes_as_hours(row.row_total_minutes),
                        &hours_format,
                    )?;
                }
            }
        }

        row_index += 1;
    }

    for (column_index, column) in columns.iter().enumerate() {
        let excel_column = column_index as u16;
        match column.kind {
            SummaryExportSheetColumnKind::Field(_) | SummaryExportSheetColumnKind::FreeText => {
                if footer_label_column_index == Some(column_index) {
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        "Day Totals",
                        &header_format,
                    )?;
                } else if column.wrap_text {
                    worksheet.write_with_format(row_index, excel_column, "", &wrapped_text_format)?;
                } else {
                    worksheet.write_with_format(row_index, excel_column, "", &plain_text_format)?;
                }
            }
            SummaryExportSheetColumnKind::DayHours(day_index) => {
                let total_minutes = summary.day_total_minutes.get(day_index).copied().unwrap_or(0);
                worksheet.write_with_format(
                    row_index,
                    excel_column,
                    format_minutes_as_hours(total_minutes),
                    &hours_format,
                )?;
            }
            SummaryExportSheetColumnKind::DayNotes(_) => {
                worksheet.write_with_format(row_index, excel_column, "", &wrapped_text_format)?;
            }
            SummaryExportSheetColumnKind::RowTotal => {
                worksheet.write_with_format(
                    row_index,
                    excel_column,
                    format_minutes_as_hours(summary.week_total_minutes),
                    &hours_format,
                )?;
            }
        }
    }

    Ok(())
}

fn write_weekly_hours_sheet(
    workbook: &mut Workbook,
    summary: &TimelineWeeklySummary,
    preset: &SummaryLayoutPreset,
    engagement_by_id: &HashMap<String, Engagement>,
    activity_by_id: &HashMap<String, Activity>,
) -> Result<(), XlsxError> {
    let columns = build_summary_export_hours_sheet_columns(summary, preset);
    write_layout_driven_summary_sheet(
        workbook,
        "Weekly Hours",
        summary,
        &columns,
        engagement_by_id,
        activity_by_id,
    )
}

fn write_weekly_hours_and_notes_sheet(
    workbook: &mut Workbook,
    summary: &TimelineWeeklySummary,
    preset: &SummaryLayoutPreset,
    engagement_by_id: &HashMap<String, Engagement>,
    activity_by_id: &HashMap<String, Activity>,
) -> Result<(), XlsxError> {
    let columns = build_summary_export_hours_and_notes_sheet_columns(summary, preset);
    write_layout_driven_summary_sheet(
        workbook,
        "Weekly Hours + Notes",
        summary,
        &columns,
        engagement_by_id,
        activity_by_id,
    )
}

#[derive(Debug, Clone)]
struct KeyStatus {
    has_open_ai_key: bool,
    storage_health: StorageHealth,
    key_source: KeySource,
    status_level: StatusLevel,
    last_error: Option<String>,
}

fn derive_key_status_level(has_open_ai_key: bool, key_source: &KeySource) -> StatusLevel {
    if !has_open_ai_key {
        return StatusLevel::Error;
    }

    match key_source {
        KeySource::Keyring => StatusLevel::Ok,
        KeySource::SessionCache => StatusLevel::Warning,
        KeySource::None => StatusLevel::Error,
    }
}

#[derive(Debug, Clone)]
struct TemporalReference {
    local_date: NaiveDate,
    rounded_end_minute: i64,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TemporalCueType {
    ExplicitClock,
    RelativeDuration,
    ImplicitRecentDuration,
    None,
}

fn temporal_cue_type_label(value: TemporalCueType) -> &'static str {
    match value {
        TemporalCueType::ExplicitClock => "explicit_clock",
        TemporalCueType::RelativeDuration => "relative_duration",
        TemporalCueType::ImplicitRecentDuration => "implicit_recent_duration",
        TemporalCueType::None => "none",
    }
}

#[derive(Debug, Clone)]
struct NormalizedEntryResult {
    entry: NormalizedEntry,
    note: Option<String>,
    used_temporal_fallback: bool,
    duration_defaulted: bool,
    fallback_reason: Option<String>,
    raw_start: Option<String>,
    raw_end: Option<String>,
    raw_duration: Option<i64>,
    llm_activity_ref: Option<String>,
    llm_activity_reason: Option<String>,
    llm_alternative_activities: Option<Vec<LlmAlternativeActivity>>,
    temporal_cue_type: TemporalCueType,
    temporal_source: &'static str,
}

#[derive(Debug, Clone)]
struct PreparedEntry {
    entry: NormalizedEntry,
    used_activity_fallback: bool,
    used_temporal_fallback: bool,
    duration_defaulted: bool,
    fallback_summary: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ActivityFallbackDecision {
    attempted: bool,
    applied: bool,
    reason: Option<String>,
    candidate_count: usize,
    chosen_activity_ref: Option<String>,
    chosen_activity_name: Option<String>,
    chosen_score: Option<f64>,
    matched_terms: Vec<String>,
    note: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct GlobalActivityFallbackDecision {
    attempted: bool,
    applied: bool,
    reason: Option<String>,
    candidate_count: usize,
    chosen_engagement_ref: Option<String>,
    chosen_activity_ref: Option<String>,
    chosen_activity_name: Option<String>,
    chosen_score: Option<f64>,
    matched_terms: Vec<String>,
    note: Option<String>,
}

#[derive(Debug, Clone)]
struct RefResolutionDecision {
    applied: bool,
    reason: &'static str,
    original_engagement_ref: Option<String>,
    original_activity_ref: Option<String>,
    resolved_engagement_ref: Option<String>,
    resolved_activity_ref: Option<String>,
}

#[derive(Debug, Clone)]
struct ActivityCandidateMatch {
    activity_ref: String,
    name: String,
    score: f64,
    matched_terms: Vec<String>,
}

#[derive(Debug, Clone)]
struct GlobalActivityCandidateMatch {
    engagement_ref: String,
    engagement_name: String,
    activity_ref: String,
    activity_name: String,
    score: f64,
    matched_terms: Vec<String>,
}

#[derive(Debug, Clone)]
struct MatchingText {
    phrase: String,
    padded_phrase: String,
    tokens: HashSet<String>,
}

fn build_fallback_summary(
    used_temporal_fallback: bool,
    used_activity_fallback: bool,
) -> Option<String> {
    match (used_temporal_fallback, used_activity_fallback) {
        (true, true) => Some("Activity + temporal fallback applied".to_string()),
        (true, false) => Some("Temporal fallback applied".to_string()),
        (false, true) => Some("Activity fallback applied".to_string()),
        (false, false) => None,
    }
}

fn normalize_description_for_dedupe(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn prepared_entry_dedupe_key(entry: &PreparedEntry) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        entry.entry.date,
        entry.entry.start_minute,
        entry.entry.end_minute,
        entry.entry.engagement_ref.as_deref().unwrap_or(""),
        entry.entry.activity_ref.as_deref().unwrap_or(""),
        normalize_description_for_dedupe(&entry.entry.description)
    )
}

fn dedupe_prepared_entries(entries: Vec<PreparedEntry>) -> Vec<PreparedEntry> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(entries.len());

    for entry in entries {
        let key = prepared_entry_dedupe_key(&entry);
        if seen.insert(key) {
            deduped.push(entry);
        }
    }

    deduped
}

fn keyring_entry() -> AppResult<Entry> {
    Entry::new("OmniSheet", "openai_api_key")
        .map_err(|error| AppError::Config(format!("failed to open keyring entry: {error}")))
}

fn cached_api_key(state: &State<'_, AppState>) -> Option<String> {
    state
        .api_key_cache
        .lock()
        .ok()
        .and_then(|cache| cache.clone())
        .filter(|value| !value.trim().is_empty())
}

fn read_key_status(state: &State<'_, AppState>) -> KeyStatus {
    let entry = match keyring_entry() {
        Ok(value) => value,
        Err(error) => {
            if let Some(_cached_key) = cached_api_key(state) {
                let key_source = KeySource::SessionCache;
                let has_open_ai_key = true;
                return KeyStatus {
                    has_open_ai_key,
                    storage_health: StorageHealth::Unavailable,
                    key_source: key_source.clone(),
                    status_level: derive_key_status_level(has_open_ai_key, &key_source),
                    last_error: Some(
                        "Keyring unavailable; using in-memory session key for this app session"
                            .to_string(),
                    ),
                };
            }

            let key_source = KeySource::None;
            let has_open_ai_key = false;
            return KeyStatus {
                has_open_ai_key,
                storage_health: StorageHealth::Unavailable,
                key_source: key_source.clone(),
                status_level: derive_key_status_level(has_open_ai_key, &key_source),
                last_error: Some(error.to_string()),
            };
        }
    };

    match entry.get_password() {
        Ok(password) => {
            let has_open_ai_key = !password.trim().is_empty();
            let key_source = KeySource::Keyring;
            KeyStatus {
                has_open_ai_key,
                storage_health: StorageHealth::Ok,
                key_source: key_source.clone(),
                status_level: derive_key_status_level(has_open_ai_key, &key_source),
                last_error: if password.trim().is_empty() {
                    Some("OpenAI API key is empty".to_string())
                } else {
                    None
                },
            }
        }
        Err(KeyringError::NoEntry) => {
            if let Some(_cached_key) = cached_api_key(state) {
                let key_source = KeySource::SessionCache;
                let has_open_ai_key = true;
                KeyStatus {
                    has_open_ai_key,
                    storage_health: StorageHealth::ReadError,
                    key_source: key_source.clone(),
                    status_level: derive_key_status_level(has_open_ai_key, &key_source),
                    last_error: Some(
                        "Keyring returned no entry; using in-memory session key for this app session"
                            .to_string(),
                    ),
                }
            } else {
                let key_source = KeySource::None;
                let has_open_ai_key = false;
                KeyStatus {
                    has_open_ai_key,
                    storage_health: StorageHealth::Ok,
                    key_source: key_source.clone(),
                    status_level: derive_key_status_level(has_open_ai_key, &key_source),
                    last_error: None,
                }
            }
        }
        Err(error) => {
            if let Some(_cached_key) = cached_api_key(state) {
                let key_source = KeySource::SessionCache;
                let has_open_ai_key = true;
                KeyStatus {
                    has_open_ai_key,
                    storage_health: StorageHealth::ReadError,
                    key_source: key_source.clone(),
                    status_level: derive_key_status_level(has_open_ai_key, &key_source),
                    last_error: Some(format!(
                        "OpenAI API key could not be read from keyring ({error}); using in-memory session key for this app session"
                    )),
                }
            } else {
                let key_source = KeySource::None;
                let has_open_ai_key = false;
                KeyStatus {
                    has_open_ai_key,
                    storage_health: StorageHealth::ReadError,
                    key_source: key_source.clone(),
                    status_level: derive_key_status_level(has_open_ai_key, &key_source),
                    last_error: Some(format!("OpenAI API key could not be read: {error}")),
                }
            }
        }
    }
}

fn get_openai_api_key(state: &State<'_, AppState>) -> AppResult<String> {
    let entry = match keyring_entry() {
        Ok(value) => value,
        Err(error) => {
            if let Some(cached_key) = cached_api_key(state) {
                return Ok(cached_key);
            }

            return Err(error);
        }
    };

    let api_key = match entry.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => {
            if let Some(cached_key) = cached_api_key(state) {
                return Ok(cached_key);
            }

            return Err(AppError::Config(
                "OpenAI API key is not configured".to_string(),
            ));
        }
        Err(error) => {
            if let Some(cached_key) = cached_api_key(state) {
                return Ok(cached_key);
            }

            return Err(AppError::Config(format!(
                "OpenAI API key could not be read: {error}"
            )));
        }
    };

    if api_key.trim().is_empty() {
        return Err(AppError::Config(
            "OpenAI API key is configured but empty".to_string(),
        ));
    }

    Ok(api_key)
}

fn details_to_json(value: Value) -> String {
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

#[allow(clippy::too_many_arguments)]
fn record_backend_event(
    connection: &Connection,
    app_state: &AppState,
    correlation_id: &str,
    event_type: &str,
    command: &str,
    status: &str,
    duration_ms: Option<i64>,
    message_text: Option<&str>,
    details: Value,
) {
    let details_json = details_to_json(details);

    let _ = db::insert_diagnostics_event(
        connection,
        &app_state.session_id,
        correlation_id,
        "backend",
        event_type,
        Some(command),
        status,
        duration_ms,
        message_text,
        &details_json,
    );

    if status == "error" {
        log::error!(
            target: "diagnostics",
            "[{command}] {event_type} failed cid={correlation_id} details={details_json}"
        );
    } else if status == "warning" {
        log::warn!(
            target: "diagnostics",
            "[{command}] {event_type} warning cid={correlation_id} details={details_json}"
        );
    } else {
        log::info!(
            target: "diagnostics",
            "[{command}] {event_type} ok cid={correlation_id} details={details_json}"
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn record_backend_event_with_state(
    state: &State<'_, AppState>,
    correlation_id: &str,
    event_type: &str,
    command: &str,
    status: &str,
    duration_ms: Option<i64>,
    message_text: Option<&str>,
    details: Value,
) {
    if let Ok(connection) = state.connection.lock() {
        record_backend_event(
            &connection,
            state.inner(),
            correlation_id,
            event_type,
            command,
            status,
            duration_ms,
            message_text,
            details,
        );
    }
}

fn llm_attempt_event_status(attempt: &openai::LlmAttemptTelemetry) -> &'static str {
    if attempt.outcome == "success" {
        "ok"
    } else if attempt.retryable {
        "warning"
    } else {
        "error"
    }
}

fn llm_attempt_summary(attempts: &[openai::LlmAttemptTelemetry]) -> Value {
    let successful_attempt = attempts
        .iter()
        .find(|attempt| attempt.outcome == "success")
        .map(|attempt| attempt.attempt);
    let retry_count = attempts.len().saturating_sub(1);
    let retryable_failure_count = attempts
        .iter()
        .filter(|attempt| attempt.outcome != "success" && attempt.retryable)
        .count();
    let attempt_durations_ms = attempts
        .iter()
        .map(|attempt| attempt.duration_ms)
        .collect::<Vec<_>>();
    let attempt_outcomes = attempts
        .iter()
        .map(|attempt| attempt.outcome)
        .collect::<Vec<_>>();
    let total_backoff_delay_ms = attempts
        .iter()
        .filter_map(|attempt| attempt.retry_delay_ms)
        .sum::<u64>();

    json!({
      "attemptCount": attempts.len(),
      "retryCount": retry_count,
      "retryableFailureCount": retryable_failure_count,
      "successfulAttempt": successful_attempt,
      "attemptOutcomes": attempt_outcomes,
      "attemptDurationsMs": attempt_durations_ms,
      "totalBackoffDelayMs": total_backoff_delay_ms,
    })
}

fn record_llm_attempt_events(
    state: &State<'_, AppState>,
    correlation_id: &str,
    command: &str,
    model: OpenAiModelId,
    attempts: &[openai::LlmAttemptTelemetry],
) {
    for attempt in attempts {
        record_backend_event_with_state(
            state,
            correlation_id,
            "llm_attempt",
            command,
            llm_attempt_event_status(attempt),
            Some(attempt.duration_ms),
            None,
            json!({
              "attempt": attempt.attempt,
              "maxAttempts": attempt.max_attempts,
              "outcome": attempt.outcome,
              "httpStatus": attempt.http_status,
              "retryable": attempt.retryable,
              "retryDelayMs": attempt.retry_delay_ms,
              "errorClass": attempt.error_class,
              "error": attempt.error_message.as_deref(),
              "model": model.api_name(),
              "modelLabel": model.display_label(),
            }),
        );
    }
}

fn record_transcription_attempt_events(
    state: &State<'_, AppState>,
    correlation_id: &str,
    command: &str,
    model: TranscriptionModelId,
    attempts: &[openai::LlmAttemptTelemetry],
) {
    for attempt in attempts {
        record_backend_event_with_state(
            state,
            correlation_id,
            "transcription_attempt",
            command,
            llm_attempt_event_status(attempt),
            Some(attempt.duration_ms),
            None,
            json!({
              "attempt": attempt.attempt,
              "maxAttempts": attempt.max_attempts,
              "outcome": attempt.outcome,
              "httpStatus": attempt.http_status,
              "retryable": attempt.retryable,
              "retryDelayMs": attempt.retry_delay_ms,
              "errorClass": attempt.error_class,
              "error": attempt.error_message.as_deref(),
              "transcriptionModel": model.api_name(),
              "transcriptionModelLabel": model.display_label(),
            }),
        );
    }
}

#[tauri::command]
pub fn settings_get_status(state: State<'_, AppState>) -> Result<SettingsStatus, String> {
    let command = "settings_get_status";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();

    let key_status = read_key_status(&state);
    let (
        selected_open_ai_model,
        invalid_saved_model,
        selected_transcription_model,
        invalid_saved_transcription_model,
    ) = {
        let connection = state.connection.lock().map_err(|_| {
            let message = state_lock_error();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "stage": "read_model_setting", "message": message }),
            );
            format_command_error(&correlation_id, message)
        })?;

        let (selected_open_ai_model, invalid_saved_model) =
            match read_saved_openai_model(&connection) {
                Ok(value) => value,
                Err(error) => {
                    let message = error.to_string();
                    record_backend_event(
                        &connection,
                        state.inner(),
                        &correlation_id,
                        "command_error",
                        command,
                        "error",
                        Some(duration_ms(started_at)),
                        None,
                        json!({ "stage": "read_model_setting", "message": message }),
                    );
                    return Err(format_command_error(&correlation_id, message));
                }
            };

        let (selected_transcription_model, invalid_saved_transcription_model) =
            match read_saved_transcription_model(&connection) {
                Ok(value) => value,
                Err(error) => {
                    let message = error.to_string();
                    record_backend_event(
                        &connection,
                        state.inner(),
                        &correlation_id,
                        "command_error",
                        command,
                        "error",
                        Some(duration_ms(started_at)),
                        None,
                        json!({ "stage": "read_transcription_model_setting", "message": message }),
                    );
                    return Err(format_command_error(&correlation_id, message));
                }
            };

        (
            selected_open_ai_model,
            invalid_saved_model,
            selected_transcription_model,
            invalid_saved_transcription_model,
        )
    };

    if let Some(invalid_value) = invalid_saved_model.as_deref() {
        record_invalid_saved_openai_model(&state, &correlation_id, command, invalid_value);
    }

    if let Some(invalid_value) = invalid_saved_transcription_model.as_deref() {
        record_invalid_saved_transcription_model(&state, &correlation_id, command, invalid_value);
    }

    let status = SettingsStatus {
        has_open_ai_key: key_status.has_open_ai_key,
        storage_health: key_status.storage_health.clone(),
        key_source: key_status.key_source.clone(),
        status_level: key_status.status_level.clone(),
        last_error: key_status.last_error.clone(),
        selected_open_ai_model,
        available_open_ai_models: openai_model_options(),
        selected_transcription_model,
        available_transcription_models: transcription_model_options(),
    };

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_success",
        command,
        // Command execution succeeded; key health severity is reported in details.statusLevel.
        "ok",
        Some(duration_ms(started_at)),
        None,
        json!({
          "hasOpenAiKey": status.has_open_ai_key,
          "storageHealth": storage_health_label(&status.storage_health),
          "keySource": key_source_label(&status.key_source),
          "statusLevel": status_level_label(&status.status_level),
          "lastError": status.last_error,
          "selectedOpenAiModel": status.selected_open_ai_model.api_name(),
          "selectedOpenAiModelLabel": status.selected_open_ai_model.display_label(),
          "availableOpenAiModelCount": status.available_open_ai_models.len(),
          "selectedTranscriptionModel": status.selected_transcription_model.api_name(),
          "selectedTranscriptionModelLabel": status.selected_transcription_model.display_label(),
          "availableTranscriptionModelCount": status.available_transcription_models.len(),
        }),
    );

    Ok(status)
}

#[tauri::command]
pub fn settings_set_openai_key(
    state: State<'_, AppState>,
    input: ApiKeyInput,
) -> Result<(), String> {
    let command = "settings_set_openai_key";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let trimmed_api_key = input.api_key.trim();

    if trimmed_api_key.is_empty() {
        let message = "API key cannot be empty";
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "message": message }),
        );

        return Err(format_command_error(&correlation_id, message));
    }

    let set_result: AppResult<()> = (|| {
        let entry = keyring_entry()?;
        entry
            .set_password(trimmed_api_key)
            .map_err(|error| AppError::Config(format!("failed to store API key: {error}")))?;

        let verified = entry.get_password().map_err(|error| {
            AppError::Config(format!("failed to verify API key storage: {error}"))
        })?;

        if verified.trim().is_empty() {
            return Err(AppError::Config(
                "API key storage verification returned an empty key".to_string(),
            ));
        }

        if verified.trim() != trimmed_api_key {
            return Err(AppError::Config(
                "API key storage verification failed: value mismatch".to_string(),
            ));
        }

        Ok(())
    })();

    match set_result {
        Ok(()) => {
            if let Ok(mut cache) = state.api_key_cache.lock() {
                *cache = Some(trimmed_api_key.to_string());
            }

            record_backend_event_with_state(
                &state,
                &correlation_id,
                "key_save_verify",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({ "verified": true, "keySource": "keyring" }),
            );
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            if let Ok(mut cache) = state.api_key_cache.lock() {
                *cache = Some(trimmed_api_key.to_string());
            }

            record_backend_event_with_state(
                &state,
                &correlation_id,
                "key_save_verify",
                command,
                "warning",
                Some(duration_ms(started_at)),
                None,
                json!({
                    "message": message,
                    "verified": false,
                    "fallback": "session_cache",
                    "keySource": "session_cache"
                }),
            );
            Ok(())
        }
    }
}

#[tauri::command]
pub fn settings_set_openai_model(
    state: State<'_, AppState>,
    input: SettingsSetOpenAiModelInput,
) -> Result<(), String> {
    let command = "settings_set_openai_model";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let selected_model = input.model;

    let connection = state.connection.lock().map_err(|_| {
        let message = state_lock_error();
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "open_connection", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;

    let save_result: Result<(), String> = (|| {
        db::upsert_app_setting(
            &connection,
            APP_SETTING_OPENAI_MODEL,
            selected_model.api_name(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_OPENAI_MODEL)
            .map_err(|error| error.to_string())?;

        if verified.as_deref() != Some(selected_model.api_name()) {
            return Err("OpenAI model setting verification failed".to_string());
        }

        Ok(())
    })();

    match save_result {
        Ok(()) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_success",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "selectedOpenAiModel": selected_model.api_name(),
                  "selectedOpenAiModelLabel": selected_model.display_label(),
                  "verified": true,
                }),
            );
            Ok(())
        }
        Err(message) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "stage": "save_model_setting",
                  "message": message,
                  "selectedOpenAiModel": selected_model.api_name(),
                  "selectedOpenAiModelLabel": selected_model.display_label(),
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn settings_set_transcription_model(
    state: State<'_, AppState>,
    input: SettingsSetTranscriptionModelInput,
) -> Result<(), String> {
    let command = "settings_set_transcription_model";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let selected_model = input.model;

    let connection = state.connection.lock().map_err(|_| {
        let message = state_lock_error();
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "open_connection", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;

    let save_result: Result<(), String> = (|| {
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TRANSCRIPTION_MODEL,
            selected_model.api_name(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_TRANSCRIPTION_MODEL)
            .map_err(|error| error.to_string())?;

        if verified.as_deref() != Some(selected_model.api_name()) {
            return Err("Transcription model setting verification failed".to_string());
        }

        Ok(())
    })();

    match save_result {
        Ok(()) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_success",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "selectedTranscriptionModel": selected_model.api_name(),
                  "selectedTranscriptionModelLabel": selected_model.display_label(),
                  "verified": true,
                }),
            );
            Ok(())
        }
        Err(message) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "stage": "save_transcription_model_setting",
                  "message": message,
                  "selectedTranscriptionModel": selected_model.api_name(),
                  "selectedTranscriptionModelLabel": selected_model.display_label(),
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn summary_layout_state_get(state: State<'_, AppState>) -> Result<SummaryLayoutState, String> {
    let command = "summary_layout_state_get";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();

    let connection = state.connection.lock().map_err(|_| {
        let message = state_lock_error();
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "open_connection", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;

    match read_summary_layout_state(&connection) {
        Ok(layout_state) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_success",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "presetCount": layout_state.presets.len(),
                  "selectedPresetId": layout_state.selected_preset_id,
                }),
            );
            Ok(layout_state)
        }
        Err(error) => {
            let message = error.to_string();
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "stage": "read_summary_layout_state", "message": message }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn summary_layout_state_set(
    state: State<'_, AppState>,
    input: SummaryLayoutState,
) -> Result<SummaryLayoutState, String> {
    let command = "summary_layout_state_set";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let normalized_state = normalize_summary_layout_state(input)
        .map_err(|message| format_command_error(&correlation_id, message))?;

    let connection = state.connection.lock().map_err(|_| {
        let message = state_lock_error();
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "open_connection", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;

    let save_result: Result<(), String> = (|| {
        let serialized_state =
            serde_json::to_string(&normalized_state).map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_SUMMARY_LAYOUT_STATE,
            serialized_state.as_str(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_SUMMARY_LAYOUT_STATE)
            .map_err(|error| error.to_string())?;
        if verified.as_deref() != Some(serialized_state.as_str()) {
            return Err("Summary layout preset save verification failed.".to_string());
        }

        Ok(())
    })();

    match save_result {
        Ok(()) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_success",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "presetCount": normalized_state.presets.len(),
                  "selectedPresetId": normalized_state.selected_preset_id,
                  "verified": true,
                }),
            );
            Ok(normalized_state)
        }
        Err(message) => {
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "stage": "save_summary_layout_state",
                  "message": message,
                  "presetCount": normalized_state.presets.len(),
                  "selectedPresetId": normalized_state.selected_preset_id,
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn engagement_list(state: State<'_, AppState>) -> Result<Vec<Engagement>, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    db::list_engagements(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn engagement_upsert(
    state: State<'_, AppState>,
    input: EngagementUpsertInput,
) -> Result<IdResult, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let id = db::upsert_engagement(&connection, input).map_err(|error| error.to_string())?;
    Ok(IdResult { id })
}

#[tauri::command]
pub fn engagement_delete(state: State<'_, AppState>, input: IdInput) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    db::delete_engagement(&connection, &input.id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn activity_upsert(
    state: State<'_, AppState>,
    input: ActivityUpsertInput,
) -> Result<IdResult, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let id = db::upsert_activity(&connection, input).map_err(|error| error.to_string())?;
    Ok(IdResult { id })
}

#[tauri::command]
pub fn activity_delete(state: State<'_, AppState>, input: IdInput) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    db::delete_activity(&connection, &input.id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn timeline_list_for_date(
    state: State<'_, AppState>,
    input: DateInput,
) -> Result<Vec<TimelineEntry>, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    db::list_timeline_entries(&connection, input.date.trim()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn timeline_month_summary(
    state: State<'_, AppState>,
    input: TimelineMonthSummaryInput,
) -> Result<Vec<TimelineDaySummary>, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let (start_date, end_date_exclusive) = timeline_month_bounds(&input.month)?;

    db::list_timeline_day_summaries_for_month(&connection, &start_date, &end_date_exclusive)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn timeline_weekly_summary(
    state: State<'_, AppState>,
    input: DateInput,
) -> Result<TimelineWeeklySummary, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let (start_date, end_date_exclusive) = timeline_week_bounds(&input.date)?;

    db::list_timeline_weekly_summary(&connection, &start_date, &end_date_exclusive)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn timeline_list_for_week_view(
    state: State<'_, AppState>,
    input: DateInput,
) -> Result<TimelineWeekView, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let (start_date, end_date_exclusive) = timeline_week_view_bounds(&input.date)?;
    let week_start = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|_| "date must be in YYYY-MM-DD format".to_string())?;
    let entries = db::list_timeline_entries_for_date_range(&connection, &start_date, &end_date_exclusive)
        .map_err(|error| error.to_string())?;
    let days = (0..7)
        .map(|index| TimelineWeekViewDay {
            date: (week_start + Duration::days(index)).format("%Y-%m-%d").to_string(),
        })
        .collect::<Vec<_>>();
    let week_end_date = days
        .last()
        .map(|day| day.date.clone())
        .unwrap_or_else(|| start_date.clone());

    Ok(TimelineWeekView {
        week_start_date: start_date,
        week_end_date,
        days,
        entries,
    })
}

#[tauri::command]
pub fn summary_export_weekly_excel(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: SummaryExportWeeklyExcelInput,
) -> Result<SummaryExportResult, String> {
    let layout_preset = normalize_summary_layout_preset_for_export(input.layout_preset)?;
    let (start_date, end_date_exclusive) = timeline_week_bounds(&input.date)?;
    let (summary, engagements) = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        let summary = db::list_timeline_weekly_summary(&connection, &start_date, &end_date_exclusive)
            .map_err(|error| error.to_string())?;
        let engagements = db::list_engagements(&connection).map_err(|error| error.to_string())?;
        (summary, engagements)
    };
    let (engagement_by_id, activity_by_id) = build_export_metadata_maps(&engagements);

    let week_end_date = summary.week_end_date.clone();
    let downloads_dir = resolve_downloads_dir(&app)?;
    let base_name = format!(
        "OmniSheet_Weekly_Summary_{}_to_{}",
        summary.week_start_date, week_end_date
    );
    let file_path = choose_export_file_path(&downloads_dir, &base_name);

    let mut workbook = Workbook::new();
    write_weekly_hours_sheet(
        &mut workbook,
        &summary,
        &layout_preset,
        &engagement_by_id,
        &activity_by_id,
    )
        .map_err(|error| format!("failed to build Weekly Hours sheet: {error}"))?;
    write_weekly_hours_and_notes_sheet(
        &mut workbook,
        &summary,
        &layout_preset,
        &engagement_by_id,
        &activity_by_id,
    )
        .map_err(|error| format!("failed to build Weekly Hours + Notes sheet: {error}"))?;
    workbook
        .save(&file_path)
        .map_err(|error| format!("failed to write workbook: {error}"))?;

    let auto_open_attempted = true;
    let (auto_open_succeeded, auto_open_error) = match open::that(&file_path) {
        Ok(_) => (true, None),
        Err(error) => (false, Some(error.to_string())),
    };

    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("summary.xlsx")
        .to_string();

    Ok(SummaryExportResult {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        auto_open_attempted,
        auto_open_succeeded,
        auto_open_error,
    })
}

#[tauri::command]
pub fn timeline_update_entry(
    state: State<'_, AppState>,
    input: TimelineUpdateInput,
) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    let previous_date = db::get_entry_date(&connection, &input.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "timeline entry not found".to_string())?;

    let next_date = input.date.trim();
    let (start_minute, end_minute, duration_minutes) = match input.mode {
        TimelineUpdateMode::Manual => {
            validate_manual_update_window(input.start_minute, input.end_minute)?
        }
        TimelineUpdateMode::Drag => {
            normalize_snapped_update_window(input.start_minute, input.end_minute)
        }
    };

    db::update_timeline_entry(
        &connection,
        &input.id,
        next_date,
        start_minute,
        end_minute,
        duration_minutes,
        &input.description,
        input.engagement_id.as_deref(),
        input.activity_id.as_deref(),
    )
    .map_err(|error| error.to_string())?;

    db::clear_entry_warnings(
        &connection,
        &input.id,
        &[
            WarningType::LowConfidence,
            WarningType::Overlap,
            WarningType::Unmatched,
        ],
    )
    .map_err(|error| error.to_string())?;

    if input.engagement_id.is_none() || input.activity_id.is_none() {
        db::add_warning(
            &connection,
            &input.id,
            WarningType::Unmatched,
            Some("Entry is uncategorized".to_string()),
        )
        .map_err(|error| error.to_string())?;
    }

    let _ = db::recompute_overlap_warnings(&connection, &previous_date)
        .map_err(|error| error.to_string())?;

    if next_date != previous_date {
        let _ = db::recompute_overlap_warnings(&connection, next_date)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn timeline_create_entry(
    state: State<'_, AppState>,
    input: TimelineCreateInput,
) -> Result<IdResult, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let date = input.date.trim();
    let (start_minute, end_minute, duration_minutes) =
        validate_manual_update_window(input.start_minute, input.end_minute)?;

    let id = db::insert_manual_timeline_entry(
        &connection,
        date,
        start_minute,
        end_minute,
        duration_minutes,
        "",
    )
    .map_err(|error| error.to_string())?;

    db::add_warning(
        &connection,
        &id,
        WarningType::Unmatched,
        Some("Entry is uncategorized".to_string()),
    )
    .map_err(|error| error.to_string())?;

    let _ = db::recompute_overlap_warnings(&connection, date).map_err(|error| error.to_string())?;

    Ok(IdResult { id })
}

#[tauri::command]
pub fn timeline_delete_entry(state: State<'_, AppState>, input: IdInput) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    let previous_date = db::get_entry_date(&connection, &input.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "timeline entry not found".to_string())?;

    db::delete_timeline_entry(&connection, &input.id).map_err(|error| error.to_string())?;

    let _ = db::recompute_overlap_warnings(&connection, &previous_date)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn voice_request_microphone_permission(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<MicrophonePermissionResult, String> {
    let command = "voice_request_microphone_permission";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_start",
        command,
        "ok",
        None,
        None,
        json!({
          "platform": if cfg!(target_os = "macos") { "macos" } else { "non_macos" },
        }),
    );

    let outcome = match macos_permissions::request_microphone_permission(&app).await {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "message": message,
                  "platform": if cfg!(target_os = "macos") { "macos" } else { "non_macos" },
                }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    let result_status = outcome.result.status;
    let diagnostic_status = match result_status {
        MicrophonePermissionStatus::Granted | MicrophonePermissionStatus::Unsupported => "ok",
        MicrophonePermissionStatus::Denied
        | MicrophonePermissionStatus::Restricted
        | MicrophonePermissionStatus::NotDetermined => "warning",
    };

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "voice_permission_status",
        command,
        diagnostic_status,
        Some(duration_ms(started_at)),
        None,
        json!({
          "initialStatus": microphone_permission_status_label(outcome.initial_status),
          "finalStatus": microphone_permission_status_label(result_status),
          "requested": outcome.result.requested,
          "platform": if cfg!(target_os = "macos") { "macos" } else { "non_macos" },
        }),
    );

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_success",
        command,
        diagnostic_status,
        Some(duration_ms(started_at)),
        None,
        json!({
          "initialStatus": microphone_permission_status_label(outcome.initial_status),
          "finalStatus": microphone_permission_status_label(result_status),
          "requested": outcome.result.requested,
          "platform": if cfg!(target_os = "macos") { "macos" } else { "non_macos" },
        }),
    );

    Ok(outcome.result)
}

fn truncate_for_bundle(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        value.to_string()
    } else {
        format!("{}...", &value[..limit])
    }
}

fn diagnostics_event_line(event: &DiagnosticsEvent) -> String {
    let command = event.command.as_deref().unwrap_or("-");
    let duration = event
        .duration_ms
        .map(|value| format!("{value}ms"))
        .unwrap_or_else(|| "-".to_string());
    let message = event
        .message_text
        .as_deref()
        .map(|value| truncate_for_bundle(value, 80))
        .unwrap_or_else(|| "-".to_string());
    let details = truncate_for_bundle(&event.details_json, 220);

    format!(
        "- ts={} layer={} type={} status={} cmd={} dur={} cid={} msg={} details={}",
        event.timestamp,
        event.layer,
        event.event_type,
        event.status,
        command,
        duration,
        event.correlation_id,
        message,
        details
    )
}

#[tauri::command]
pub async fn transcribe_audio_clip(
    state: State<'_, AppState>,
    input: TranscribeAudioInput,
) -> Result<TranscribeAudioResult, String> {
    let command = "transcribe_audio_clip";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_start",
        command,
        "ok",
        None,
        None,
        json!({
          "mimeType": input.mime_type,
          "audioDurationMs": input.duration_ms,
          "captureTimestampIso": input.capture_timestamp_iso,
        }),
    );

    let encoded_audio = input
        .audio_base64
        .trim()
        .rsplit_once(',')
        .map(|(_, data)| data)
        .unwrap_or_else(|| input.audio_base64.trim());

    if encoded_audio.is_empty() {
        let message = "audio payload cannot be empty";
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "message": message }),
        );
        return Err(format_command_error(&correlation_id, message));
    }

    if input.mime_type.trim().is_empty() {
        let message = "audio mime type cannot be empty";
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "message": message }),
        );
        return Err(format_command_error(&correlation_id, message));
    }

    if input.duration_ms <= 0 {
        let message = "audio duration must be greater than zero";
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "message": message, "audioDurationMs": input.duration_ms }),
        );
        return Err(format_command_error(&correlation_id, message));
    }

    let audio_bytes = BASE64_STANDARD.decode(encoded_audio).map_err(|error| {
        let message = format!("audio payload could not be decoded: {error}");
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "decode_audio", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;

    let api_key = match get_openai_api_key(&state) {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "stage": "read_key", "message": message }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    let (selected_transcription_model, invalid_saved_model) = {
        let connection = state.connection.lock().map_err(|_| {
            let message = state_lock_error();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "stage": "read_transcription_model_setting", "message": message }),
            );
            format_command_error(&correlation_id, message)
        })?;

        match read_saved_transcription_model(&connection) {
            Ok(value) => value,
            Err(error) => {
                let message = error.to_string();
                record_backend_event(
                    &connection,
                    state.inner(),
                    &correlation_id,
                    "command_error",
                    command,
                    "error",
                    Some(duration_ms(started_at)),
                    None,
                    json!({ "stage": "read_transcription_model_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        }
    };

    if let Some(invalid_value) = invalid_saved_model.as_deref() {
        record_invalid_saved_transcription_model(&state, &correlation_id, command, invalid_value);
    }

    let transcription_started_at = Instant::now();
    let mut transcription_attempts = Vec::<openai::LlmAttemptTelemetry>::new();
    let transcription_result = openai::transcribe_audio(
        &state.http_client,
        &api_key,
        selected_transcription_model,
        &audio_bytes,
        input.mime_type.trim(),
        &mut transcription_attempts,
    )
    .await;

    record_transcription_attempt_events(
        &state,
        &correlation_id,
        command,
        selected_transcription_model,
        &transcription_attempts,
    );
    let transcription_duration_ms = duration_ms(transcription_started_at);
    let transcription_summary = llm_attempt_summary(&transcription_attempts);

    let transcript_text = match transcription_result {
        Ok(value) => {
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "transcription_response",
                command,
                "ok",
                Some(transcription_duration_ms),
                None,
                json!({
                  "audioDurationMs": input.duration_ms,
                  "decodedAudioBytes": audio_bytes.len(),
                  "transcriptLength": value.len(),
                  "transcriptionModel": selected_transcription_model.api_name(),
                  "transcriptionModelLabel": selected_transcription_model.display_label(),
                  "transcriptionDurationMs": transcription_duration_ms,
                  "attemptSummary": transcription_summary,
                }),
            );
            value
        }
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "transcription_response",
                command,
                "error",
                Some(transcription_duration_ms),
                None,
                json!({
                  "message": message,
                  "audioDurationMs": input.duration_ms,
                  "decodedAudioBytes": audio_bytes.len(),
                  "transcriptionModel": selected_transcription_model.api_name(),
                  "transcriptionModelLabel": selected_transcription_model.display_label(),
                  "transcriptionDurationMs": transcription_duration_ms,
                  "attemptSummary": transcription_summary,
                }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_success",
        command,
        "ok",
        Some(duration_ms(started_at)),
        None,
        json!({
          "audioDurationMs": input.duration_ms,
          "decodedAudioBytes": audio_bytes.len(),
          "transcriptLength": transcript_text.len(),
          "transcriptionModel": selected_transcription_model.api_name(),
          "transcriptionModelLabel": selected_transcription_model.display_label(),
          "transcriptionDurationMs": transcription_duration_ms,
        }),
    );

    Ok(TranscribeAudioResult {
        transcript_text,
        transcription_model_used: selected_transcription_model,
        transcription_model_used_label: selected_transcription_model.display_label().to_string(),
        transcription_duration_ms,
        audio_duration_ms: input.duration_ms,
    })
}

#[tauri::command]
pub async fn interpret_text_message(
    state: State<'_, AppState>,
    input: InterpretTextInput,
) -> Result<InterpretResult, String> {
    let command = "interpret_text_message";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_start",
        command,
        "ok",
        None,
        Some(input.raw_text.trim()),
        json!({
          "timezone": input.timezone,
          "clientTimestampIso": input.client_timestamp_iso,
          "clientLocalDate": input.client_local_date,
          "clientLocalTime": input.client_local_time,
          "clientUtcOffsetMinutes": input.client_utc_offset_minutes,
          "requestedOpenAiModel": input.open_ai_model.map(|model| model.api_name()),
          "captureSource": input.capture_source.map(capture_source_label),
          "transcriptionModel": input.transcription_model.map(|model| model.api_name()),
          "transcriptionDurationMs": input.transcription_duration_ms,
        }),
    );

    if input.raw_text.trim().is_empty() {
        let message = "message cannot be empty";
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "message": message }),
        );
        return Err(format_command_error(&correlation_id, message));
    }

    let parsed_timestamp = parse_client_timestamp(&input.client_timestamp_iso);
    let temporal_reference = build_temporal_reference(&input, parsed_timestamp);
    let temporal_cue_type = detect_temporal_cue_type(input.raw_text.trim());

    let api_key = match get_openai_api_key(&state) {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                Some(input.raw_text.trim()),
                json!({ "stage": "read_key", "message": message }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    let (saved_openai_model, invalid_saved_model, code_context) = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        let (saved_openai_model, invalid_saved_model) = match read_saved_openai_model(&connection) {
            Ok(value) => value,
            Err(error) => {
                let message = error.to_string();
                record_backend_event(
                    &connection,
                    state.inner(),
                    &correlation_id,
                    "command_error",
                    command,
                    "error",
                    Some(duration_ms(started_at)),
                    Some(input.raw_text.trim()),
                    json!({ "stage": "read_model_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        let code_context = match db::load_code_context(&connection) {
            Ok(value) => value,
            Err(error) => {
                let message = error.to_string();
                record_backend_event(
                    &connection,
                    state.inner(),
                    &correlation_id,
                    "command_error",
                    command,
                    "error",
                    Some(duration_ms(started_at)),
                    Some(input.raw_text.trim()),
                    json!({ "stage": "load_code_context", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        (saved_openai_model, invalid_saved_model, code_context)
    };

    if let Some(invalid_value) = invalid_saved_model.as_deref() {
        record_invalid_saved_openai_model(&state, &correlation_id, command, invalid_value);
    }

    let selected_openai_model =
        resolve_requested_openai_model(input.open_ai_model, saved_openai_model);

    let llm_started_at = Instant::now();
    let mut llm_attempts = Vec::<openai::LlmAttemptTelemetry>::new();
    let llm_result = openai::interpret_message(
        &state.http_client,
        &api_key,
        selected_openai_model,
        input.raw_text.trim(),
        &input.client_timestamp_iso,
        &input.client_local_date,
        &input.client_local_time,
        input.client_utc_offset_minutes,
        &input.timezone,
        &code_context,
        &mut llm_attempts,
    )
    .await;

    record_llm_attempt_events(
        &state,
        &correlation_id,
        command,
        selected_openai_model,
        &llm_attempts,
    );
    let llm_duration_ms = duration_ms(llm_started_at);
    let llm_summary = llm_attempt_summary(&llm_attempts);

    let llm_response = match llm_result {
        Ok(response) => {
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "llm_response",
                command,
                "ok",
                Some(llm_duration_ms),
                None,
                json!({
                  "entryCount": response.entries.len(),
                  "model": selected_openai_model.api_name(),
                  "modelLabel": selected_openai_model.display_label(),
                  "totalLlmDurationMs": llm_duration_ms,
                  "attemptSummary": llm_summary,
                }),
            );
            response
        }
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "llm_response",
                command,
                "error",
                Some(llm_duration_ms),
                Some(input.raw_text.trim()),
                json!({
                  "message": message,
                  "model": selected_openai_model.api_name(),
                  "modelLabel": selected_openai_model.display_label(),
                  "totalLlmDurationMs": llm_duration_ms,
                  "attemptSummary": llm_summary,
                }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    let interpreted_entry_count = llm_response.entries.len() as i64;

    let interpreted_entries_json = serde_json::to_string(&llm_response)
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let normalization_results = llm_response
        .entries
        .iter()
        .map(|entry| {
            normalize_llm_entry(
                entry,
                &temporal_reference,
                input.raw_text.trim(),
                temporal_cue_type,
            )
        })
        .collect::<Vec<_>>();

    let mut prepared_entries = Vec::<PreparedEntry>::new();
    let mut normalization_notes = Vec::<String>::new();
    let mut normalization_details = Vec::<Value>::new();
    let mut fallback_count = 0;

    for mut result in normalization_results {
        let ref_resolution = reconcile_context_refs(&mut result.entry, &code_context);
        let activity_fallback = apply_activity_fallback_if_needed(
            &mut result.entry,
            input.raw_text.trim(),
            &code_context,
        );
        let global_activity_fallback = apply_global_activity_fallback_if_needed(
            &mut result.entry,
            input.raw_text.trim(),
            &code_context,
        );

        if let Some(note) = result.note {
            normalization_notes.push(note);
        }

        if let Some(note) = activity_fallback.note.clone() {
            normalization_notes.push(note);
        }

        if let Some(note) = global_activity_fallback.note.clone() {
            normalization_notes.push(note);
        }

        if ref_resolution.applied {
            normalization_notes.push(format!(
                "Reference resolution applied ({})",
                ref_resolution.reason
            ));
        }

        if result.used_temporal_fallback {
            fallback_count += 1;
        }

        let used_activity_fallback = activity_fallback.applied || global_activity_fallback.applied;
        let fallback_summary =
            build_fallback_summary(result.used_temporal_fallback, used_activity_fallback);

        normalization_details.push(json!({
          "usedTemporalFallback": result.used_temporal_fallback,
          "fallbackReason": result.fallback_reason,
          "temporalCueType": temporal_cue_type_label(result.temporal_cue_type),
          "temporalSource": result.temporal_source,
          "llmStartRaw": result.raw_start,
          "llmEndRaw": result.raw_end,
          "llmDurationRaw": result.raw_duration,
          "durationDefaulted": result.duration_defaulted,
          "savedDate": result.entry.date,
          "savedStartMinute": result.entry.start_minute,
          "savedEndMinute": result.entry.end_minute,
          "llmChosenActivityRef": result.llm_activity_ref,
          "llmActivityReason": result.llm_activity_reason,
          "llmAlternativeActivities": result.llm_alternative_activities,
          "originalEngagementRef": ref_resolution.original_engagement_ref,
          "originalActivityRef": ref_resolution.original_activity_ref,
          "savedEngagementRef": result.entry.engagement_ref,
          "savedActivityRef": result.entry.activity_ref,
          "savedConfidence": result.entry.confidence,
          "refResolutionApplied": ref_resolution.applied,
          "refResolutionReason": ref_resolution.reason,
          "resolvedEngagementRef": ref_resolution.resolved_engagement_ref,
          "resolvedActivityRef": ref_resolution.resolved_activity_ref,
          "attemptedActivityFallback": activity_fallback.attempted,
          "usedActivityFallback": activity_fallback.applied,
          "activityFallbackReason": activity_fallback.reason,
          "activityFallbackCandidateCount": activity_fallback.candidate_count,
          "activityFallbackChosenRef": activity_fallback.chosen_activity_ref,
          "activityFallbackChosenName": activity_fallback.chosen_activity_name,
          "activityFallbackScore": activity_fallback.chosen_score,
          "activityFallbackMatchedTerms": activity_fallback.matched_terms,
          "attemptedGlobalActivityFallback": global_activity_fallback.attempted,
          "usedGlobalActivityFallback": global_activity_fallback.applied,
          "globalActivityFallbackReason": global_activity_fallback.reason,
          "globalActivityFallbackCandidateCount": global_activity_fallback.candidate_count,
          "globalActivityFallbackChosenEngagementRef": global_activity_fallback.chosen_engagement_ref,
          "globalActivityFallbackChosenActivityRef": global_activity_fallback.chosen_activity_ref,
          "globalActivityFallbackChosenActivityName": global_activity_fallback.chosen_activity_name,
          "globalActivityFallbackScore": global_activity_fallback.chosen_score,
          "globalActivityFallbackMatchedTerms": global_activity_fallback.matched_terms,
          "fallbackSummary": fallback_summary.clone(),
        }));

        prepared_entries.push(PreparedEntry {
            entry: result.entry,
            used_activity_fallback,
            used_temporal_fallback: result.used_temporal_fallback,
            duration_defaulted: result.duration_defaulted,
            fallback_summary,
        });
    }

    if prepared_entries.is_empty() {
        let used_temporal_fallback = true;
        let used_activity_fallback = false;
        let fallback_summary =
            build_fallback_summary(used_temporal_fallback, used_activity_fallback);
        prepared_entries.push(PreparedEntry {
            entry: fallback_entry(&temporal_reference, input.raw_text.trim()),
            used_activity_fallback,
            used_temporal_fallback,
            duration_defaulted: false,
            fallback_summary: fallback_summary.clone(),
        });
        fallback_count += 1;
        let note = format!(
            "No LLM entries returned. Defaulted to {} - {} based on capture time.",
            minute_to_hhmm(
                (temporal_reference.rounded_end_minute - DEFAULT_FALLBACK_DURATION_MINUTES).max(0),
            ),
            minute_to_hhmm(temporal_reference.rounded_end_minute)
        );
        normalization_notes.push(note.clone());
        normalization_details.push(json!({
          "usedTemporalFallback": true,
          "fallbackReason": "no_llm_entries",
          "temporalCueType": temporal_cue_type_label(temporal_cue_type),
          "temporalSource": "fallback",
          "durationDefaulted": false,
          "savedDate": temporal_reference.local_date.format("%Y-%m-%d").to_string(),
          "savedStartMinute": (temporal_reference.rounded_end_minute - DEFAULT_FALLBACK_DURATION_MINUTES).max(0),
          "savedEndMinute": temporal_reference.rounded_end_minute,
          "llmChosenActivityRef": null,
          "llmActivityReason": null,
          "llmAlternativeActivities": null,
          "originalEngagementRef": null,
          "originalActivityRef": null,
          "refResolutionApplied": false,
          "refResolutionReason": null,
          "resolvedEngagementRef": null,
          "resolvedActivityRef": null,
          "attemptedActivityFallback": false,
          "usedActivityFallback": false,
          "fallbackSummary": fallback_summary,
          "note": note,
        }));
    }

    let mut prepared_entries = dedupe_prepared_entries(prepared_entries);
    let unique_entry_count = prepared_entries.len() as i64;

    if prepared_entries.len() > MAX_SAVED_ENTRIES_PER_MESSAGE {
        let dropped_count = prepared_entries.len() - MAX_SAVED_ENTRIES_PER_MESSAGE;
        prepared_entries.truncate(MAX_SAVED_ENTRIES_PER_MESSAGE);
        let note = format!(
            "LLM produced too many entries; kept the first {} and dropped {}.",
            MAX_SAVED_ENTRIES_PER_MESSAGE, dropped_count
        );
        normalization_notes.push(note);
    }

    let saved_entry_count = prepared_entries.len() as i64;
    let truncated_entry_count = (unique_entry_count - saved_entry_count).max(0);
    let contains_multiple_events = unique_entry_count > 1;

    let confidence_average = prepared_entries
        .iter()
        .map(|prepared| prepared.entry.confidence)
        .sum::<f64>()
        / prepared_entries.len() as f64;

    let raw_message_id = Uuid::new_v4().to_string();
    let mut created_entry_ids = Vec::new();
    let mut warnings: Vec<Warning> = Vec::new();
    let mut touched_dates: HashSet<String> = HashSet::new();

    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    connection
        .execute_batch("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let write_result: Result<Vec<String>, String> = (|| {
        db::insert_raw_message(
            &connection,
            &raw_message_id,
            input.raw_text.trim(),
            &interpreted_entries_json,
            selected_openai_model.api_name(),
            capture_source_label(input.capture_source.unwrap_or(CaptureSourceId::Text)),
            input.transcription_model.map(|model| model.api_name()),
            input.transcription_duration_ms,
            confidence_average,
            parsed_timestamp.timestamp(),
            interpreted_entry_count,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            contains_multiple_events,
        )
        .map_err(|error| error.to_string())?;

        for (index, prepared_entry) in prepared_entries.into_iter().enumerate() {
            let normalized_entry = prepared_entry.entry;
            let (engagement_id, activity_id) = resolve_ref_ids(&normalized_entry, &code_context);

            let entry_id = db::insert_timesheet_entry(
                &connection,
                &raw_message_id,
                &normalized_entry,
                engagement_id.as_deref(),
                activity_id.as_deref(),
                prepared_entry.used_activity_fallback,
                prepared_entry.used_temporal_fallback,
                prepared_entry.duration_defaulted,
                prepared_entry.fallback_summary.as_deref(),
                Some(index as i64 + 1),
                Some(saved_entry_count),
                capture_source_label(input.capture_source.unwrap_or(CaptureSourceId::Text)),
            )
            .map_err(|error| error.to_string())?;

            touched_dates.insert(normalized_entry.date.clone());
            created_entry_ids.push(entry_id.clone());

            if normalized_entry.confidence < db::LOW_CONFIDENCE_THRESHOLD {
                warnings.push(
                    db::add_warning(
                        &connection,
                        &entry_id,
                        WarningType::LowConfidence,
                        Some("AI confidence is below review threshold".to_string()),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }

            if engagement_id.is_none() || activity_id.is_none() {
                warnings.push(
                    db::add_warning(
                        &connection,
                        &entry_id,
                        WarningType::Unmatched,
                        Some("Entry is uncategorized".to_string()),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
        }

        let mut touched_month_keys = touched_dates
            .iter()
            .filter_map(|date| month_key_from_iso_date(date))
            .collect::<Vec<_>>();
        touched_month_keys.sort();
        touched_month_keys.dedup();

        for date in &touched_dates {
            let overlap_warnings = db::recompute_overlap_warnings(&connection, date)
                .map_err(|error| error.to_string())?;
            warnings.extend(overlap_warnings);
        }

        Ok(touched_month_keys)
    })();

    let touched_month_keys = match write_result {
        Ok(value) => value,
        Err(message) => {
            let _ = connection.execute_batch("ROLLBACK");
            record_backend_event(
                &connection,
                state.inner(),
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                Some(input.raw_text.trim()),
                json!({ "message": message }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

    connection
        .execute_batch("COMMIT")
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    record_backend_event(
        &connection,
        state.inner(),
        &correlation_id,
        "command_success",
        command,
        "ok",
        Some(duration_ms(started_at)),
        Some(input.raw_text.trim()),
        json!({
          "rawMessageId": raw_message_id,
          "createdEntryCount": created_entry_ids.len(),
          "interpretedEntryCount": interpreted_entry_count,
          "uniqueEntryCount": unique_entry_count,
          "savedEntryCount": saved_entry_count,
          "truncatedEntryCount": truncated_entry_count,
          "containsMultipleEvents": contains_multiple_events,
          "touchedMonthKeys": touched_month_keys,
          "warningCount": warnings.len(),
          "normalizationFallbackCount": fallback_count,
          "normalizationNotes": normalization_notes,
          "normalizationDetails": normalization_details,
          "model": selected_openai_model.api_name(),
          "modelLabel": selected_openai_model.display_label(),
          "captureSource": capture_source_label(input.capture_source.unwrap_or(CaptureSourceId::Text)),
          "transcriptionModel": input.transcription_model.map(|model| model.api_name()),
          "transcriptionDurationMs": input.transcription_duration_ms,
          "llmDurationMs": llm_duration_ms,
        }),
    );

    Ok(InterpretResult {
        correlation_id,
        raw_message_id,
        created_entry_ids,
        interpreted_entry_count,
        unique_entry_count,
        saved_entry_count,
        truncated_entry_count,
        contains_multiple_events,
        touched_month_keys,
        warnings,
        normalization_notes,
        model_used: selected_openai_model,
        model_used_label: selected_openai_model.display_label().to_string(),
        llm_duration_ms,
    })
}

#[tauri::command]
pub fn diagnostics_record_frontend_event(
    state: State<'_, AppState>,
    input: DiagnosticsRecordInput,
) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    if input.correlation_id.trim().is_empty() {
        return Err("frontend diagnostics event requires correlationId".to_string());
    }

    let details_json = input.details_json.unwrap_or_else(|| "{}".to_string());

    db::insert_diagnostics_event(
        &connection,
        &state.session_id,
        input.correlation_id.trim(),
        if input.layer.trim().is_empty() {
            "frontend"
        } else {
            input.layer.trim()
        },
        if input.event_type.trim().is_empty() {
            "event"
        } else {
            input.event_type.trim()
        },
        input.command.as_deref(),
        if input.status.trim().is_empty() {
            "ok"
        } else {
            input.status.trim()
        },
        input.duration_ms,
        input.message_text.as_deref(),
        &details_json,
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn diagnostics_list(
    state: State<'_, AppState>,
    input: DiagnosticsListInput,
) -> Result<Vec<DiagnosticsEvent>, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    db::prune_old_diagnostics(&connection, db::DIAGNOSTICS_RETENTION_DAYS)
        .map_err(|error| error.to_string())?;

    let filter = input
        .filter
        .as_deref()
        .map(|value| value.trim().to_lowercase());

    db::list_diagnostics_events(&connection, input.limit.unwrap_or(100), filter.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn diagnostics_copy_bundle(state: State<'_, AppState>) -> Result<DiagnosticsBundle, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    db::prune_old_diagnostics(&connection, db::DIAGNOSTICS_RETENTION_DAYS)
        .map_err(|error| error.to_string())?;

    let recent_events =
        db::list_diagnostics_events(&connection, 120, None).map_err(|error| error.to_string())?;
    let recent_errors = db::list_diagnostics_events(&connection, 20, Some("errors"))
        .map_err(|error| error.to_string())?;

    let key_status = read_key_status(&state);

    let mut lines = Vec::<String>::new();
    lines.push("# OmniSheet Diagnostics Bundle".to_string());
    lines.push(format!("generatedAt: {}", Local::now().to_rfc3339()));
    lines.push(format!("appVersion: {}", state.app_version));
    lines.push(format!("sessionId: {}", state.session_id));
    lines.push(format!(
        "os: {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    lines.push(format!("keyConfigured: {}", key_status.has_open_ai_key));
    lines.push(format!(
        "storageHealth: {}",
        storage_health_label(&key_status.storage_health)
    ));
    lines.push(format!(
        "keySource: {}",
        key_source_label(&key_status.key_source)
    ));
    lines.push(format!(
        "statusLevel: {}",
        status_level_label(&key_status.status_level)
    ));
    lines.push(format!(
        "lastKeyError: {}",
        key_status.last_error.unwrap_or_else(|| "none".to_string())
    ));
    lines.push(
        "note: prototype diagnostics currently include message text; migrate to metadata-only before production.".to_string(),
    );
    lines.push(String::new());
    lines.push("## Recent Errors".to_string());
    if recent_errors.is_empty() {
        lines.push("- none".to_string());
    } else {
        for event in &recent_errors {
            lines.push(diagnostics_event_line(event));
        }
    }

    lines.push(String::new());
    lines.push("## Recent Events".to_string());
    if recent_events.is_empty() {
        lines.push("- none".to_string());
    } else {
        for event in &recent_events {
            lines.push(diagnostics_event_line(event));
        }
    }

    Ok(DiagnosticsBundle {
        text: lines.join("\n"),
    })
}

fn parse_client_timestamp(timestamp: &str) -> DateTime<Local> {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.with_timezone(&Local))
        .unwrap_or_else(|_| Local::now())
}

fn build_temporal_reference(
    input: &InterpretTextInput,
    parsed_timestamp: DateTime<Local>,
) -> TemporalReference {
    let local_date =
        parse_date(input.client_local_date.trim()).unwrap_or_else(|| parsed_timestamp.date_naive());
    let local_time =
        parse_time(input.client_local_time.trim()).unwrap_or_else(|| parsed_timestamp.time());
    let rounded_end_minute = round_to_nearest_15(minutes_from_time(local_time) as i64)
        .clamp(TIME_INCREMENT_MINUTES, MINUTES_IN_DAY);

    TemporalReference {
        local_date,
        rounded_end_minute,
    }
}

fn fallback_entry(reference: &TemporalReference, raw_text: &str) -> NormalizedEntry {
    let date = reference.local_date.format("%Y-%m-%d").to_string();
    let end_minute = reference.rounded_end_minute;
    let start_minute = (end_minute - DEFAULT_FALLBACK_DURATION_MINUTES).max(0);

    NormalizedEntry {
        date,
        start_minute,
        end_minute,
        duration_minutes: end_minute - start_minute,
        description: raw_text.to_string(),
        user_submission_text: raw_text.to_string(),
        confidence: 0.5,
        engagement_ref: None,
        activity_ref: None,
    }
}

fn normalize_llm_entry(
    entry: &LlmEntry,
    reference: &TemporalReference,
    fallback_description: &str,
    temporal_cue_type: TemporalCueType,
) -> NormalizedEntryResult {
    let date = entry
        .date
        .as_deref()
        .and_then(parse_date)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| reference.local_date.format("%Y-%m-%d").to_string());

    let raw_start = entry
        .start_time
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let raw_end = entry
        .end_time
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let raw_duration = entry.duration_minutes;
    let llm_activity_ref = entry
        .activity_ref
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let llm_activity_reason = entry
        .activity_reason
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let llm_alternative_activities = entry.alternative_activities.as_ref().map(|activities| {
        activities
            .iter()
            .filter_map(|activity| {
                let activity_ref = activity.activity_ref.trim();
                let reason = activity.reason.trim();
                if activity_ref.is_empty() || reason.is_empty() {
                    return None;
                }

                Some(LlmAlternativeActivity {
                    activity_ref: activity_ref.to_string(),
                    reason: reason.to_string(),
                })
            })
            .take(3)
            .collect::<Vec<_>>()
    });
    let llm_alternative_activities = llm_alternative_activities
        .and_then(|activities| (!activities.is_empty()).then_some(activities));

    let parsed_start = raw_start.as_deref().and_then(parse_time_to_minutes);
    let parsed_end = raw_end.as_deref().and_then(parse_time_to_minutes);

    let fallback_start = (reference.rounded_end_minute - DEFAULT_FALLBACK_DURATION_MINUTES).max(0);
    let fallback_end = reference.rounded_end_minute;
    let normalized_duration = raw_duration
        .filter(|value| *value > 0)
        .map(normalize_duration)
        .unwrap_or(DEFAULT_FALLBACK_DURATION_MINUTES);

    let has_invalid_duration = matches!(raw_duration, Some(value) if value <= 0);
    let duration_defaulted =
        raw_duration.is_none() && !(parsed_start.is_some() && parsed_end.is_some());
    let has_midnight_zero_tuple = matches!(
        (parsed_start, parsed_end, raw_duration),
        (Some(0), Some(0), Some(value)) if value <= 0
    );
    let has_no_times = parsed_start.is_none() && parsed_end.is_none();

    let (start_minute, end_minute, fallback_reason, temporal_source) = if has_invalid_duration {
        (
            fallback_start,
            fallback_end,
            Some("invalid_duration".to_string()),
            "fallback",
        )
    } else if has_midnight_zero_tuple {
        (
            fallback_start,
            fallback_end,
            Some("invalid_midnight_default".to_string()),
            "fallback",
        )
    } else {
        match (parsed_start, parsed_end) {
            (Some(start), Some(end)) => (start, end, None, "llm_start_end"),
            (Some(start), None) => (
                start,
                start + normalized_duration,
                None,
                "llm_start_plus_duration",
            ),
            (None, Some(end)) => (
                end - normalized_duration,
                end,
                None,
                "llm_end_minus_duration",
            ),
            (None, None) => {
                if raw_duration.unwrap_or(0) > 0 {
                    if temporal_cue_type == TemporalCueType::RelativeDuration {
                        (
                            reference.rounded_end_minute - normalized_duration,
                            reference.rounded_end_minute,
                            None,
                            "derived_from_duration",
                        )
                    } else if temporal_cue_type == TemporalCueType::ImplicitRecentDuration {
                        (
                            reference.rounded_end_minute - normalized_duration,
                            reference.rounded_end_minute,
                            None,
                            "derived_from_bare_duration",
                        )
                    } else {
                        let reason = if temporal_cue_type == TemporalCueType::ExplicitClock {
                            "unable_to_parse_explicit_time"
                        } else if has_no_times {
                            "no_temporal_data"
                        } else {
                            "unusable_temporal_data"
                        };

                        (
                            fallback_start,
                            fallback_end,
                            Some(reason.to_string()),
                            "fallback",
                        )
                    }
                } else {
                    let reason = if temporal_cue_type == TemporalCueType::ExplicitClock {
                        "unable_to_parse_explicit_time"
                    } else if temporal_cue_type == TemporalCueType::RelativeDuration {
                        "unable_to_derive_relative_duration"
                    } else if temporal_cue_type == TemporalCueType::ImplicitRecentDuration {
                        "unable_to_derive_bare_duration"
                    } else if has_no_times {
                        "no_temporal_data"
                    } else {
                        "unusable_temporal_data"
                    };

                    (
                        fallback_start,
                        fallback_end,
                        Some(reason.to_string()),
                        "fallback",
                    )
                }
            }
        }
    };

    let should_use_fallback = fallback_reason.is_some();

    let (normalized_start, normalized_end, duration_minutes) =
        normalize_snapped_update_window(start_minute, end_minute);

    let note = fallback_reason.as_ref().map(|reason| {
        format!(
            "Temporal fallback applied ({reason}): saved {} - {}",
            minute_to_hhmm(normalized_start),
            minute_to_hhmm(normalized_end),
        )
    });

    NormalizedEntryResult {
        entry: NormalizedEntry {
            date,
            start_minute: normalized_start,
            end_minute: normalized_end,
            duration_minutes,
            description: entry
                .description
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback_description.to_string()),
            user_submission_text: fallback_description.to_string(),
            confidence: normalize_confidence(entry.confidence),
            engagement_ref: entry
                .engagement_ref
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            activity_ref: entry
                .activity_ref
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        },
        note,
        used_temporal_fallback: should_use_fallback,
        duration_defaulted,
        fallback_reason,
        raw_start,
        raw_end,
        raw_duration,
        llm_activity_ref,
        llm_activity_reason,
        llm_alternative_activities,
        temporal_cue_type,
        temporal_source,
    }
}

fn apply_activity_fallback_if_needed(
    entry: &mut NormalizedEntry,
    raw_text: &str,
    code_context: &CodeContext,
) -> ActivityFallbackDecision {
    if entry.activity_ref.is_some() {
        return ActivityFallbackDecision::default();
    }

    let Some(engagement_ref) = entry.engagement_ref.as_deref() else {
        return ActivityFallbackDecision::default();
    };

    let mut decision = ActivityFallbackDecision {
        attempted: true,
        ..ActivityFallbackDecision::default()
    };

    let Some(engagement) = code_context.engagements.iter().find(|candidate| {
        candidate
            .engagement_ref
            .eq_ignore_ascii_case(engagement_ref)
    }) else {
        decision.reason = Some("engagement_ref_not_found_in_context".to_string());
        return decision;
    };

    decision.candidate_count = engagement.activities.len();

    if engagement.activities.is_empty() {
        decision.reason = Some("no_active_activities".to_string());
        return decision;
    }

    let Some(candidate) = select_best_activity_candidate(engagement, raw_text) else {
        decision.reason = Some("no_similarity_signal".to_string());
        return decision;
    };

    entry.activity_ref = Some(candidate.activity_ref.clone());
    entry.confidence = entry.confidence.min(ACTIVITY_FALLBACK_CONFIDENCE_CAP);

    decision.applied = true;
    decision.reason = Some("engagement_known_activity_missing".to_string());
    decision.chosen_activity_ref = Some(candidate.activity_ref.clone());
    decision.chosen_activity_name = Some(candidate.name.clone());
    decision.chosen_score = Some(candidate.score);
    decision.matched_terms = candidate.matched_terms.clone();
    decision.note = Some(format!(
        "Activity fallback applied: selected {} ({}) for {} using activity name/tag similarity.",
        candidate.activity_ref, candidate.name, engagement.name
    ));

    decision
}

fn apply_global_activity_fallback_if_needed(
    entry: &mut NormalizedEntry,
    raw_text: &str,
    code_context: &CodeContext,
) -> GlobalActivityFallbackDecision {
    if entry.engagement_ref.is_some() || entry.activity_ref.is_some() {
        return GlobalActivityFallbackDecision::default();
    }

    let mut decision = GlobalActivityFallbackDecision {
        attempted: true,
        candidate_count: code_context
            .engagements
            .iter()
            .map(|engagement| engagement.activities.len())
            .sum(),
        ..GlobalActivityFallbackDecision::default()
    };

    if decision.candidate_count == 0 {
        decision.reason = Some("no_active_activities".to_string());
        return decision;
    }

    let Some((best, runner_up)) = select_best_global_activity_candidate(code_context, raw_text)
    else {
        decision.reason = Some("no_similarity_signal".to_string());
        return decision;
    };

    if best.score < GLOBAL_ACTIVITY_FALLBACK_MIN_SCORE {
        decision.reason = Some("below_score_threshold".to_string());
        return decision;
    }

    if runner_up.as_ref().is_some_and(|candidate| {
        (best.score - candidate.score) < GLOBAL_ACTIVITY_FALLBACK_MIN_MARGIN
    }) {
        decision.reason = Some("ambiguous_best_match".to_string());
        return decision;
    }

    entry.engagement_ref = Some(best.engagement_ref.clone());
    entry.activity_ref = Some(best.activity_ref.clone());
    entry.confidence = entry.confidence.min(ACTIVITY_FALLBACK_CONFIDENCE_CAP);

    decision.applied = true;
    decision.reason = Some("activity_implied_parent_engagement".to_string());
    decision.chosen_engagement_ref = Some(best.engagement_ref.clone());
    decision.chosen_activity_ref = Some(best.activity_ref.clone());
    decision.chosen_activity_name = Some(best.activity_name.clone());
    decision.chosen_score = Some(best.score);
    decision.matched_terms = best.matched_terms.clone();
    decision.note = Some(format!(
        "Global activity fallback applied: selected {} ({}) under {} using cross-engagement activity similarity.",
        best.activity_ref, best.activity_name, best.engagement_name
    ));

    decision
}

fn reconcile_context_refs(
    entry: &mut NormalizedEntry,
    code_context: &CodeContext,
) -> RefResolutionDecision {
    let original_engagement_ref = normalize_optional_ref(entry.engagement_ref.clone());
    let original_activity_ref = normalize_optional_ref(entry.activity_ref.clone());
    let mut resolved_engagement_ref = original_engagement_ref.clone();
    let mut resolved_activity_ref = original_activity_ref.clone();
    let mut reason = "already_valid";

    let engagement = resolved_engagement_ref
        .as_deref()
        .and_then(|engagement_ref| find_engagement_by_ref(code_context, engagement_ref));
    let activity_match = resolved_activity_ref
        .as_deref()
        .and_then(|activity_ref| find_activity_by_ref(code_context, activity_ref));

    match (engagement, activity_match) {
        (Some(engagement), Some((owner, activity))) => {
            resolved_engagement_ref = Some(engagement.engagement_ref.clone());
            if owner.id == engagement.id {
                resolved_activity_ref = Some(activity.activity_ref.clone());
            } else {
                resolved_activity_ref = None;
                reason = "cleared_invalid_activity_for_engagement";
            }
        }
        (Some(engagement), None) => {
            resolved_engagement_ref = Some(engagement.engagement_ref.clone());
            if resolved_activity_ref.is_some() {
                resolved_activity_ref = None;
                reason = "cleared_unknown_activity_ref";
            }
        }
        (None, Some((owner, activity))) => {
            resolved_engagement_ref = Some(owner.engagement_ref.clone());
            resolved_activity_ref = Some(activity.activity_ref.clone());
            reason = "derived_engagement_from_activity_ref";
        }
        (None, None) => {
            if resolved_engagement_ref.is_some() || resolved_activity_ref.is_some() {
                reason = "cleared_unknown_refs";
            }
            resolved_engagement_ref = None;
            resolved_activity_ref = None;
        }
    }

    let applied = original_engagement_ref != resolved_engagement_ref
        || original_activity_ref != resolved_activity_ref;

    entry.engagement_ref = resolved_engagement_ref.clone();
    entry.activity_ref = resolved_activity_ref.clone();

    RefResolutionDecision {
        applied,
        reason,
        original_engagement_ref,
        original_activity_ref,
        resolved_engagement_ref,
        resolved_activity_ref,
    }
}

fn resolve_ref_ids(
    entry: &NormalizedEntry,
    code_context: &CodeContext,
) -> (Option<String>, Option<String>) {
    let engagement = entry
        .engagement_ref
        .as_deref()
        .and_then(|engagement_ref| find_engagement_by_ref(code_context, engagement_ref));

    let Some(engagement) = engagement else {
        return (None, None);
    };

    let activity_id = entry
        .activity_ref
        .as_deref()
        .and_then(|activity_ref| {
            engagement
                .activities
                .iter()
                .find(|activity| activity.activity_ref.eq_ignore_ascii_case(activity_ref))
        })
        .map(|activity| activity.id.clone());

    (Some(engagement.id.clone()), activity_id)
}

fn find_engagement_by_ref<'a>(
    code_context: &'a CodeContext,
    engagement_ref: &str,
) -> Option<&'a ContextEngagement> {
    code_context.engagements.iter().find(|candidate| {
        candidate
            .engagement_ref
            .eq_ignore_ascii_case(engagement_ref)
    })
}

fn find_activity_by_ref<'a>(
    code_context: &'a CodeContext,
    activity_ref: &str,
) -> Option<(&'a ContextEngagement, &'a ContextActivity)> {
    for engagement in &code_context.engagements {
        if let Some(activity) = engagement
            .activities
            .iter()
            .find(|candidate| candidate.activity_ref.eq_ignore_ascii_case(activity_ref))
        {
            return Some((engagement, activity));
        }
    }

    None
}

fn normalize_optional_ref(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn select_best_activity_candidate(
    engagement: &ContextEngagement,
    raw_text: &str,
) -> Option<ActivityCandidateMatch> {
    let message = build_matching_text(raw_text);
    let mut best: Option<ActivityCandidateMatch> = None;

    for activity in &engagement.activities {
        let candidate = score_activity_candidate(&message, activity);
        if candidate.score <= 0.0 || candidate.matched_terms.is_empty() {
            continue;
        }

        let should_replace = match &best {
            None => true,
            Some(current) => is_better_activity_candidate(&candidate, current),
        };

        if should_replace {
            best = Some(candidate);
        }
    }

    best
}

fn select_best_global_activity_candidate(
    code_context: &CodeContext,
    raw_text: &str,
) -> Option<(
    GlobalActivityCandidateMatch,
    Option<GlobalActivityCandidateMatch>,
)> {
    let message = build_matching_text(raw_text);
    let mut best: Option<GlobalActivityCandidateMatch> = None;
    let mut runner_up: Option<GlobalActivityCandidateMatch> = None;

    for engagement in &code_context.engagements {
        for activity in &engagement.activities {
            let candidate = score_activity_candidate(&message, activity);
            if candidate.score <= 0.0 || candidate.matched_terms.is_empty() {
                continue;
            }

            let global_candidate = GlobalActivityCandidateMatch {
                engagement_ref: engagement.engagement_ref.clone(),
                engagement_name: engagement.name.clone(),
                activity_ref: candidate.activity_ref,
                activity_name: candidate.name,
                score: candidate.score,
                matched_terms: candidate.matched_terms,
            };

            match &best {
                None => best = Some(global_candidate),
                Some(current_best) => {
                    if is_better_global_activity_candidate(&global_candidate, current_best) {
                        runner_up = best.take();
                        best = Some(global_candidate);
                    } else if runner_up.as_ref().is_none_or(|current_runner_up| {
                        is_better_global_activity_candidate(&global_candidate, current_runner_up)
                    }) {
                        runner_up = Some(global_candidate);
                    }
                }
            }
        }
    }

    best.map(|best_candidate| (best_candidate, runner_up))
}

fn is_better_activity_candidate(
    candidate: &ActivityCandidateMatch,
    current: &ActivityCandidateMatch,
) -> bool {
    if candidate.score > current.score + ACTIVITY_MATCH_SCORE_EPSILON {
        return true;
    }

    if (candidate.score - current.score).abs() > ACTIVITY_MATCH_SCORE_EPSILON {
        return false;
    }

    if candidate.matched_terms.len() != current.matched_terms.len() {
        return candidate.matched_terms.len() > current.matched_terms.len();
    }

    candidate.activity_ref < current.activity_ref
}

fn is_better_global_activity_candidate(
    candidate: &GlobalActivityCandidateMatch,
    current: &GlobalActivityCandidateMatch,
) -> bool {
    if candidate.score > current.score + ACTIVITY_MATCH_SCORE_EPSILON {
        return true;
    }

    if (candidate.score - current.score).abs() > ACTIVITY_MATCH_SCORE_EPSILON {
        return false;
    }

    if candidate.matched_terms.len() != current.matched_terms.len() {
        return candidate.matched_terms.len() > current.matched_terms.len();
    }

    if candidate.engagement_ref != current.engagement_ref {
        return candidate.engagement_ref < current.engagement_ref;
    }

    candidate.activity_ref < current.activity_ref
}

fn score_activity_candidate(
    message: &MatchingText,
    activity: &ContextActivity,
) -> ActivityCandidateMatch {
    let mut score = 0.0;
    let mut matched_terms = HashSet::<String>::new();

    let name_text = build_matching_text(&activity.name);
    let (name_score, name_matches) = score_match_component(message, &name_text, 2.0, 1.25);
    score += name_score;
    matched_terms.extend(name_matches);

    let mut activity_tokens = name_text.tokens.clone();
    if let Some(describe_when_to_use) = activity.describe_when_to_use.as_deref() {
        let description_text = build_matching_text(describe_when_to_use);
        activity_tokens.extend(description_text.tokens.iter().cloned());
        let (description_score, description_matches) =
            score_match_component(message, &description_text, 3.25, 1.75);
        score += description_score;
        matched_terms.extend(description_matches);
    }

    for tag in &activity.tags {
        let tag_text = build_matching_text(tag);
        activity_tokens.extend(tag_text.tokens.iter().cloned());
        let (tag_score, tag_matches) = score_match_component(message, &tag_text, 2.5, 1.5);
        score += tag_score;
        matched_terms.extend(tag_matches);
    }

    if !message.tokens.is_empty() && !activity_tokens.is_empty() {
        let intersection_count = message.tokens.intersection(&activity_tokens).count();
        if intersection_count > 0 {
            let union_count = message.tokens.union(&activity_tokens).count();
            if union_count > 0 {
                score += intersection_count as f64 / union_count as f64;
            }
        }
    }

    let mut matched_terms = matched_terms.into_iter().collect::<Vec<_>>();
    matched_terms.sort();
    if matched_terms.len() > 8 {
        matched_terms.truncate(8);
    }

    ActivityCandidateMatch {
        activity_ref: activity.activity_ref.clone(),
        name: activity.name.clone(),
        score,
        matched_terms,
    }
}

fn score_match_component(
    message: &MatchingText,
    component: &MatchingText,
    phrase_weight: f64,
    token_weight: f64,
) -> (f64, HashSet<String>) {
    let mut score = 0.0;
    let mut matches = HashSet::<String>::new();

    if component.phrase.is_empty() {
        return (score, matches);
    }

    if message.padded_phrase.contains(&component.padded_phrase) {
        score += phrase_weight;
        matches.insert(component.phrase.clone());
    }

    if !message.tokens.is_empty() && !component.tokens.is_empty() {
        let overlap = component
            .tokens
            .intersection(&message.tokens)
            .cloned()
            .collect::<Vec<_>>();

        if !overlap.is_empty() {
            score += token_weight * (overlap.len() as f64 / component.tokens.len() as f64);
            matches.extend(overlap);
        }
    }

    (score, matches)
}

fn build_matching_text(value: &str) -> MatchingText {
    let phrase = normalize_for_matching(value);
    let padded_phrase = if phrase.is_empty() {
        " ".to_string()
    } else {
        format!(" {phrase} ")
    };
    let tokens = phrase
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(|token| token.to_string())
        .collect::<HashSet<_>>();

    MatchingText {
        phrase,
        padded_phrase,
        tokens,
    }
}

fn normalize_for_matching(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn detect_temporal_cue_type(raw_text: &str) -> TemporalCueType {
    if message_has_explicit_clock_time_cue(raw_text) {
        TemporalCueType::ExplicitClock
    } else if message_has_relative_duration_cue(raw_text) {
        TemporalCueType::RelativeDuration
    } else if message_has_implicit_recent_duration_cue(raw_text) {
        TemporalCueType::ImplicitRecentDuration
    } else {
        TemporalCueType::None
    }
}

fn message_has_explicit_clock_time_cue(raw_text: &str) -> bool {
    let lower = raw_text.to_lowercase();

    if lower.contains("noon") || lower.contains("midnight") {
        return true;
    }

    let chars = lower.chars().collect::<Vec<_>>();
    for index in 1..chars.len().saturating_sub(1) {
        if chars[index] == ':'
            && chars[index - 1].is_ascii_digit()
            && chars[index + 1].is_ascii_digit()
        {
            return true;
        }
    }

    let normalized = lower
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == ':' {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();

    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if token.ends_with("am") || token.ends_with("pm") {
            let value = token
                .strip_suffix("am")
                .or_else(|| token.strip_suffix("pm"))
                .unwrap_or("");
            if !value.is_empty()
                && value
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == ':')
            {
                return true;
            }
        }

        if (*token == "am" || *token == "pm") && index > 0 {
            let previous = tokens[index - 1];
            if previous
                .chars()
                .all(|character| character.is_ascii_digit() || character == ':')
            {
                return true;
            }
        }
    }

    false
}

fn message_has_relative_duration_cue(raw_text: &str) -> bool {
    let normalized = raw_text
        .to_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == ':' {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();

    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return false;
    }

    for (index, token) in tokens.iter().enumerate() {
        if *token == "since" {
            return true;
        }

        if *token == "past" || *token == "last" {
            if let Some(next) = tokens.get(index + 1) {
                if is_duration_unit(next) {
                    return true;
                }

                if is_duration_value(next)
                    && tokens
                        .get(index + 2)
                        .is_some_and(|candidate| is_duration_unit(candidate))
                {
                    return true;
                }
            }
        }

        if *token == "for" {
            if let Some(next) = tokens.get(index + 1) {
                if (*next == "the")
                    && tokens
                        .get(index + 2)
                        .is_some_and(|candidate| *candidate == "past" || *candidate == "last")
                {
                    return true;
                }

                if (*next == "a" || *next == "an")
                    && tokens
                        .get(index + 2)
                        .is_some_and(|candidate| is_duration_unit(candidate))
                {
                    return true;
                }

                if is_duration_value(next)
                    && tokens
                        .get(index + 2)
                        .is_some_and(|candidate| is_duration_unit(candidate))
                {
                    return true;
                }
            }
        }
    }

    false
}

fn message_has_implicit_recent_duration_cue(raw_text: &str) -> bool {
    if message_has_explicit_clock_time_cue(raw_text) || message_has_future_planned_cue(raw_text) {
        return false;
    }

    let normalized = raw_text
        .to_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == ':' {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();

    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.len() < 2 {
        return false;
    }

    if is_duration_value(tokens[0]) && is_duration_unit(tokens[1]) {
        return true;
    }

    for index in 0..tokens.len().saturating_sub(2) {
        if matches!(
            tokens[index],
            "spent" | "spend" | "doing" | "working" | "reviewing"
        ) && is_duration_value(tokens[index + 1])
            && is_duration_unit(tokens[index + 2])
        {
            return true;
        }
    }

    false
}

fn message_has_future_planned_cue(raw_text: &str) -> bool {
    let normalized = raw_text
        .to_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == ':' {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();

    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return false;
    }

    for (index, token) in tokens.iter().enumerate() {
        if matches!(*token, "tomorrow" | "later" | "will" | "gonna") {
            return true;
        }

        if *token == "going"
            && tokens
                .get(index + 1)
                .is_some_and(|candidate| *candidate == "to")
        {
            return true;
        }

        if *token == "after"
            && tokens
                .get(index + 1)
                .is_some_and(|candidate| *candidate == "that")
        {
            return true;
        }

        if *token == "plan"
            && tokens
                .get(index + 1)
                .is_some_and(|candidate| *candidate == "to")
        {
            return true;
        }
    }

    false
}

fn is_duration_value(value: &str) -> bool {
    value.chars().all(|character| character.is_ascii_digit())
        || matches!(
            value,
            "a" | "an"
                | "one"
                | "two"
                | "three"
                | "four"
                | "five"
                | "six"
                | "seven"
                | "eight"
                | "nine"
                | "ten"
                | "half"
                | "quarter"
        )
}

fn is_duration_unit(value: &str) -> bool {
    matches!(
        value,
        "m" | "min" | "mins" | "minute" | "minutes" | "h" | "hr" | "hrs" | "hour" | "hours"
    )
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn parse_time_to_minutes(value: &str) -> Option<i64> {
    parse_time(value).map(|time| minutes_from_time(time) as i64)
}

fn parse_time(value: &str) -> Option<NaiveTime> {
    let normalized = value.trim().to_lowercase();
    if normalized == "noon" {
        return NaiveTime::from_hms_opt(12, 0, 0);
    }

    if normalized == "midnight" {
        return NaiveTime::from_hms_opt(0, 0, 0);
    }

    ["%H:%M", "%H:%M:%S", "%I:%M %p", "%I %p"]
        .iter()
        .find_map(|format| {
            NaiveTime::parse_from_str(value.trim(), format)
                .ok()
                .or_else(|| NaiveTime::parse_from_str(&value.trim().to_uppercase(), format).ok())
        })
}

fn minutes_from_time(value: NaiveTime) -> u32 {
    value.hour() * 60 + value.minute()
}

fn round_to_nearest_increment(value: i64, increment: i64) -> i64 {
    ((value as f64 / increment as f64).round() as i64) * increment
}

fn round_to_nearest_15(value: i64) -> i64 {
    round_to_nearest_increment(value, TIME_INCREMENT_MINUTES)
}

fn minute_to_hhmm(value: i64) -> String {
    let normalized = value.clamp(0, MINUTES_IN_DAY);
    let wrapped = if normalized == MINUTES_IN_DAY {
        0
    } else {
        normalized
    };
    let hours = wrapped / 60;
    let minutes = wrapped % 60;
    format!("{hours:02}:{minutes:02}")
}

fn normalize_duration(duration: i64) -> i64 {
    let rounded = round_to_nearest_15(duration.max(TIME_INCREMENT_MINUTES));
    rounded.clamp(TIME_INCREMENT_MINUTES, MINUTES_IN_DAY)
}

fn normalize_confidence(raw_value: Option<f64>) -> f64 {
    let Some(mut value) = raw_value else {
        return 0.5;
    };

    if !value.is_finite() {
        return 0.5;
    }

    if value > 1.0 && value <= 100.0 {
        value /= 100.0;
    }

    value.clamp(0.0, 1.0)
}

fn normalize_snapped_update_window(start_minute: i64, end_minute: i64) -> (i64, i64, i64) {
    let mut normalized_start = round_to_nearest_15(start_minute).clamp(0, MINUTES_IN_DAY);
    let mut normalized_end = round_to_nearest_15(end_minute).clamp(0, MINUTES_IN_DAY);

    if normalized_end <= normalized_start {
        normalized_end = (normalized_start + TIME_INCREMENT_MINUTES).min(MINUTES_IN_DAY);
    }

    if normalized_end == MINUTES_IN_DAY
        && normalized_end - normalized_start < TIME_INCREMENT_MINUTES
    {
        normalized_start = (MINUTES_IN_DAY - TIME_INCREMENT_MINUTES).max(0);
    }

    let duration_minutes = (normalized_end - normalized_start).max(TIME_INCREMENT_MINUTES);
    (normalized_start, normalized_end, duration_minutes)
}

fn validate_manual_update_window(
    start_minute: i64,
    end_minute: i64,
) -> Result<(i64, i64, i64), String> {
    if !(0..MINUTES_IN_DAY).contains(&start_minute) {
        return Err("start time must be between 00:00 and 23:59".to_string());
    }

    if !(1..=MINUTES_IN_DAY).contains(&end_minute) {
        return Err("end time must be between 00:01 and 24:00".to_string());
    }

    if end_minute <= start_minute {
        return Err("end time must be later than start time".to_string());
    }

    Ok((start_minute, end_minute, end_minute - start_minute))
}

trait TimeParts {
    fn hour(&self) -> u32;
    fn minute(&self) -> u32;
}

impl TimeParts for NaiveTime {
    fn hour(&self) -> u32 {
        chrono::Timelike::hour(self)
    }

    fn minute(&self) -> u32 {
        chrono::Timelike::minute(self)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Local, NaiveDate};

    use crate::models::{
        Activity, CodeContext, ContextActivity, ContextEngagement, Engagement, KeySource,
        LlmEntry, NormalizedEntry, OpenAiModelId, StatusLevel, SummaryLayoutColumn,
        SummaryLayoutFieldKey, SummaryLayoutPreset, SummaryLayoutState, TimelineWeeklySummary,
        TimelineWeeklySummaryCell, TimelineWeeklySummaryDay, TimelineWeeklySummaryNote,
        TimelineWeeklySummaryRow, TranscriptionModelId,
    };
    use crate::openai::LlmAttemptTelemetry;

    use super::{
        apply_activity_fallback_if_needed, apply_global_activity_fallback_if_needed,
        build_export_metadata_maps, build_summary_export_hours_and_notes_sheet_columns,
        build_summary_export_hours_sheet_columns, dedupe_prepared_entries,
        default_summary_layout_state, derive_key_status_level, llm_attempt_event_status,
        message_has_explicit_clock_time_cue, message_has_implicit_recent_duration_cue,
        message_has_relative_duration_cue, normalize_confidence, normalize_llm_entry,
        normalize_snapped_update_window, normalize_summary_layout_preset_for_export,
        normalize_summary_layout_state, reconcile_context_refs, resolve_requested_openai_model,
        resolve_saved_openai_model_value, resolve_saved_transcription_model_value,
        resolve_summary_export_field_value, round_to_nearest_15, summary_day_notes_header,
        timeline_week_bounds, timeline_week_view_bounds, validate_manual_update_window,
        PreparedEntry, SummaryExportSheetColumnKind, TemporalCueType, TemporalReference,
        MINUTES_IN_DAY,
    };

    #[test]
    fn rounds_to_nearest_quarter_hour() {
        assert_eq!(round_to_nearest_15(7), 0);
        assert_eq!(round_to_nearest_15(8), 15);
        assert_eq!(round_to_nearest_15(44), 45);
        assert_eq!(round_to_nearest_15(53), 60);
    }

    #[test]
    fn timeline_week_bounds_uses_saturday_start_and_friday_end() {
        let (start, end_exclusive) = timeline_week_bounds("2026-03-04").expect("valid bounds");
        assert_eq!(start, "2026-02-28");
        assert_eq!(end_exclusive, "2026-03-07");
    }

    #[test]
    fn timeline_week_view_bounds_uses_sunday_start_and_saturday_end() {
        let (start, end_exclusive) =
            timeline_week_view_bounds("2026-04-01").expect("valid bounds");
        assert_eq!(start, "2026-03-29");
        assert_eq!(end_exclusive, "2026-04-05");
    }

    #[test]
    fn update_window_enforces_minimum_quarter_hour() {
        let (start, end, duration) = normalize_snapped_update_window(150, 150);
        assert_eq!(start, 150);
        assert_eq!(end, 165);
        assert_eq!(duration, 15);
    }

    #[test]
    fn update_window_clamps_to_day_end() {
        let (start, end, duration) = normalize_snapped_update_window(1439, 1600);
        assert_eq!(start, 1425);
        assert_eq!(end, 1440);
        assert_eq!(duration, 15);
    }

    #[test]
    fn manual_update_window_preserves_exact_minutes() {
        let (start, end, duration) =
            validate_manual_update_window(9 * 60 + 7, 9 * 60 + 52).expect("valid manual window");
        assert_eq!(start, 547);
        assert_eq!(end, 592);
        assert_eq!(duration, 45);
    }

    #[test]
    fn manual_update_window_allows_end_of_day() {
        let (start, end, duration) =
            validate_manual_update_window(23 * 60 + 59, MINUTES_IN_DAY).expect("valid day end");
        assert_eq!(start, 1439);
        assert_eq!(end, 1440);
        assert_eq!(duration, 1);
    }

    #[test]
    fn manual_update_window_rejects_invalid_ranges() {
        let equal_error =
            validate_manual_update_window(600, 600).expect_err("equal range rejected");
        assert_eq!(equal_error, "end time must be later than start time");

        let reversed_error =
            validate_manual_update_window(615, 610).expect_err("reversed range rejected");
        assert_eq!(reversed_error, "end time must be later than start time");
    }

    #[test]
    fn local_timestamp_available_for_fallback_paths() {
        let now = Local::now();
        assert!(now.timestamp() > 0);
    }

    #[test]
    fn key_status_level_is_ok_for_keyring_backed_key() {
        assert!(matches!(
            derive_key_status_level(true, &KeySource::Keyring),
            StatusLevel::Ok
        ));
    }

    #[test]
    fn key_status_level_is_warning_for_session_cache_fallback() {
        assert!(matches!(
            derive_key_status_level(true, &KeySource::SessionCache),
            StatusLevel::Warning
        ));
    }

    #[test]
    fn key_status_level_is_error_when_no_usable_key_exists() {
        assert!(matches!(
            derive_key_status_level(false, &KeySource::None),
            StatusLevel::Error
        ));
    }

    #[test]
    fn saved_openai_model_defaults_when_missing_or_invalid() {
        let (missing_model, missing_invalid_value) = resolve_saved_openai_model_value(None);
        assert_eq!(missing_model, OpenAiModelId::Gpt5Nano);
        assert!(missing_invalid_value.is_none());

        let (invalid_model, invalid_value) =
            resolve_saved_openai_model_value(Some("legacy-model".to_string()));
        assert_eq!(invalid_model, OpenAiModelId::Gpt5Nano);
        assert_eq!(invalid_value.as_deref(), Some("legacy-model"));
    }

    #[test]
    fn requested_openai_model_override_takes_precedence() {
        assert_eq!(
            resolve_requested_openai_model(Some(OpenAiModelId::Gpt41Nano), OpenAiModelId::Gpt5Nano),
            OpenAiModelId::Gpt41Nano
        );
        assert_eq!(
            resolve_requested_openai_model(None, OpenAiModelId::Gpt41Nano),
            OpenAiModelId::Gpt41Nano
        );
    }

    #[test]
    fn saved_transcription_model_defaults_when_missing_or_invalid() {
        let (missing_model, missing_invalid_value) = resolve_saved_transcription_model_value(None);
        assert_eq!(missing_model, TranscriptionModelId::Gpt4oMiniTranscribe);
        assert!(missing_invalid_value.is_none());

        let (invalid_model, invalid_value) =
            resolve_saved_transcription_model_value(Some("legacy-transcribe".to_string()));
        assert_eq!(invalid_model, TranscriptionModelId::Gpt4oMiniTranscribe);
        assert_eq!(invalid_value.as_deref(), Some("legacy-transcribe"));
    }

    #[test]
    fn default_summary_layout_state_seeds_standard_preset() {
        let state = default_summary_layout_state();
        assert_eq!(state.version, 2);
        assert_eq!(state.presets.len(), 1);
        assert_eq!(state.presets[0].name, "Standard");
        assert_eq!(state.selected_preset_id, state.presets[0].id);
        assert_eq!(state.presets[0].columns.len(), 13);
        assert!(matches!(
            state.presets[0].columns.last(),
            Some(SummaryLayoutColumn::RowTotal { .. })
        ));
    }

    #[test]
    fn summary_layout_state_rejects_duplicate_preset_names() {
        let state = SummaryLayoutState {
            version: 99,
            selected_preset_id: "preset-a".to_string(),
            presets: vec![
                SummaryLayoutPreset {
                    id: "preset-a".to_string(),
                    name: "Alpha".to_string(),
                    columns: vec![SummaryLayoutColumn::Field {
                        id: "field-a".to_string(),
                        field_key: SummaryLayoutFieldKey::EngagementCode,
                    }],
                },
                SummaryLayoutPreset {
                    id: "preset-b".to_string(),
                    name: " alpha ".to_string(),
                    columns: vec![SummaryLayoutColumn::FreeText {
                        id: "free-text".to_string(),
                        label: "Notes".to_string(),
                    }],
                },
            ],
        };

        let error = normalize_summary_layout_state(state).expect_err("duplicate names rejected");
        assert_eq!(error, "Summary layout preset names must be unique.");
    }

    #[test]
    fn summary_layout_state_trims_and_validates_columns() {
        let normalized = normalize_summary_layout_state(SummaryLayoutState {
            version: 0,
            selected_preset_id: " preset-a ".to_string(),
            presets: vec![SummaryLayoutPreset {
                id: " preset-a ".to_string(),
                name: " Working Layout ".to_string(),
                columns: vec![
                    SummaryLayoutColumn::Field {
                        id: " field-a ".to_string(),
                        field_key: SummaryLayoutFieldKey::EngagementName,
                    },
                    SummaryLayoutColumn::Day {
                        id: " day-2 ".to_string(),
                        day_index: 2,
                    },
                    SummaryLayoutColumn::FreeText {
                        id: " free-text ".to_string(),
                        label: " Notes ".to_string(),
                    },
                ],
            }],
        })
        .expect("state should normalize");

        assert_eq!(normalized.version, 2);
        assert_eq!(normalized.selected_preset_id, "preset-a");
        assert_eq!(normalized.presets[0].name, "Working Layout");
        match &normalized.presets[0].columns[2] {
            SummaryLayoutColumn::FreeText { id, label } => {
                assert_eq!(id, "free-text");
                assert_eq!(label, "Notes");
            }
            _ => panic!("expected free-text column"),
        }
        assert!(matches!(
            normalized.presets[0].columns[3],
            SummaryLayoutColumn::RowTotal { .. }
        ));
    }

    #[test]
    fn summary_layout_state_appends_row_total_to_legacy_presets() {
        let normalized = normalize_summary_layout_state(SummaryLayoutState {
            version: 1,
            selected_preset_id: "preset-a".to_string(),
            presets: vec![SummaryLayoutPreset {
                id: "preset-a".to_string(),
                name: "Legacy Layout".to_string(),
                columns: vec![SummaryLayoutColumn::Field {
                    id: "field-client-name".to_string(),
                    field_key: SummaryLayoutFieldKey::ClientName,
                }],
            }],
        })
        .expect("legacy presets should normalize");

        assert_eq!(normalized.presets[0].columns.len(), 2);
        assert!(matches!(
            normalized.presets[0].columns[1],
            SummaryLayoutColumn::RowTotal { .. }
        ));
    }

    #[test]
    fn summary_layout_state_rejects_duplicate_row_total_columns() {
        let error = normalize_summary_layout_state(SummaryLayoutState {
            version: 2,
            selected_preset_id: "preset-a".to_string(),
            presets: vec![SummaryLayoutPreset {
                id: "preset-a".to_string(),
                name: "Broken Layout".to_string(),
                columns: vec![
                    SummaryLayoutColumn::Field {
                        id: "field-client-name".to_string(),
                        field_key: SummaryLayoutFieldKey::ClientName,
                    },
                    SummaryLayoutColumn::RowTotal {
                        id: "row-total".to_string(),
                    },
                    SummaryLayoutColumn::RowTotal {
                        id: "row-total-2".to_string(),
                    },
                ],
            }],
        })
        .expect_err("duplicate row total should fail");

        assert_eq!(
            error,
            "A summary layout preset cannot include Row Total more than once."
        );
    }

    #[test]
    fn summary_layout_state_requires_a_non_total_column() {
        let error = normalize_summary_layout_state(SummaryLayoutState {
            version: 2,
            selected_preset_id: "preset-a".to_string(),
            presets: vec![SummaryLayoutPreset {
                id: "preset-a".to_string(),
                name: "Totals Only".to_string(),
                columns: vec![SummaryLayoutColumn::RowTotal {
                    id: "row-total".to_string(),
                }],
            }],
        })
        .expect_err("totals-only layout should fail");

        assert_eq!(
            error,
            "Each summary layout preset must include at least one column besides Row Total."
        );
    }

    fn test_weekly_summary() -> TimelineWeeklySummary {
        TimelineWeeklySummary {
            week_start_date: "2026-03-28".to_string(),
            week_end_date: "2026-04-03".to_string(),
            days: vec![
                TimelineWeeklySummaryDay {
                    date: "2026-03-28".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-03-29".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-03-30".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-03-31".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-04-01".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-04-02".to_string(),
                },
                TimelineWeeklySummaryDay {
                    date: "2026-04-03".to_string(),
                },
            ],
            rows: vec![TimelineWeeklySummaryRow {
                engagement_id: Some("eng-1".to_string()),
                activity_id: Some("act-1".to_string()),
                engagement_code: Some("ENG-1".to_string()),
                activity_code: Some("ACT-1".to_string()),
                activity_name: "Testing".to_string(),
                engagement_name: "Client Work".to_string(),
                client_name: "Acme".to_string(),
                is_uncategorized: false,
                cells: vec![
                    TimelineWeeklySummaryCell {
                        total_minutes: 120,
                        notes: vec![TimelineWeeklySummaryNote {
                            start_minute: 480,
                            end_minute: 600,
                            duration_minutes: 120,
                            description: "Control testing".to_string(),
                        }],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 60,
                        notes: vec![],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 0,
                        notes: vec![],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 0,
                        notes: vec![],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 0,
                        notes: vec![],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 0,
                        notes: vec![],
                    },
                    TimelineWeeklySummaryCell {
                        total_minutes: 0,
                        notes: vec![],
                    },
                ],
                row_total_minutes: 180,
            }],
            day_total_minutes: vec![120, 60, 0, 0, 0, 0, 0],
            week_total_minutes: 180,
        }
    }

    fn test_engagements() -> Vec<Engagement> {
        vec![Engagement {
            id: "eng-1".to_string(),
            code: Some("ENG-1".to_string()),
            name: "Client Work".to_string(),
            client: Some("Acme".to_string()),
            color_hex: None,
            tags: vec!["SOX".to_string(), "FAIT".to_string()],
            describe_when_to_use: Some("Use for client delivery work.".to_string()),
            is_active: true,
            created_at: 0,
            updated_at: 0,
            activities: vec![Activity {
                id: "act-1".to_string(),
                engagement_id: "eng-1".to_string(),
                code: Some("ACT-1".to_string()),
                name: "Testing".to_string(),
                color_hex: None,
                tags: vec!["controls".to_string()],
                describe_when_to_use: Some("Use for testing controls.".to_string()),
                is_active: true,
                created_at: 0,
                updated_at: 0,
            }],
        }]
    }

    #[test]
    fn summary_export_layout_preset_normalizes_before_export() {
        let normalized = normalize_summary_layout_preset_for_export(SummaryLayoutPreset {
            id: " preset-a ".to_string(),
            name: " Export Layout ".to_string(),
            columns: vec![
                SummaryLayoutColumn::Field {
                    id: " field-activity ".to_string(),
                    field_key: SummaryLayoutFieldKey::ActivityName,
                },
                SummaryLayoutColumn::FreeText {
                    id: " free-text ".to_string(),
                    label: " Notes Slot ".to_string(),
                },
            ],
        })
        .expect("preset should normalize");

        assert_eq!(normalized.id, "preset-a");
        assert_eq!(normalized.name, "Export Layout");
        match &normalized.columns[1] {
            SummaryLayoutColumn::FreeText { id, label } => {
                assert_eq!(id, "free-text");
                assert_eq!(label, "Notes Slot");
            }
            _ => panic!("expected free-text column"),
        }
        assert!(matches!(
            normalized.columns[2],
            SummaryLayoutColumn::RowTotal { .. }
        ));
    }

    #[test]
    fn hours_export_uses_row_total_position_from_preset() {
        let summary = test_weekly_summary();
        let cases = [
            (
                "first",
                vec![
                    SummaryLayoutColumn::RowTotal {
                        id: "row-total".to_string(),
                    },
                    SummaryLayoutColumn::Field {
                        id: "field-engagement-code".to_string(),
                        field_key: SummaryLayoutFieldKey::EngagementCode,
                    },
                    SummaryLayoutColumn::Day {
                        id: "day-0".to_string(),
                        day_index: 0,
                    },
                ],
                0usize,
            ),
            (
                "middle",
                vec![
                    SummaryLayoutColumn::Field {
                        id: "field-engagement-code".to_string(),
                        field_key: SummaryLayoutFieldKey::EngagementCode,
                    },
                    SummaryLayoutColumn::RowTotal {
                        id: "row-total".to_string(),
                    },
                    SummaryLayoutColumn::Day {
                        id: "day-0".to_string(),
                        day_index: 0,
                    },
                ],
                1usize,
            ),
            (
                "last",
                vec![
                    SummaryLayoutColumn::Field {
                        id: "field-engagement-code".to_string(),
                        field_key: SummaryLayoutFieldKey::EngagementCode,
                    },
                    SummaryLayoutColumn::Day {
                        id: "day-0".to_string(),
                        day_index: 0,
                    },
                    SummaryLayoutColumn::RowTotal {
                        id: "row-total".to_string(),
                    },
                ],
                2usize,
            ),
        ];

        for (label, preset_columns, row_total_index) in cases {
            let preset = SummaryLayoutPreset {
                id: format!("preset-{label}"),
                name: format!("Layout {label}"),
                columns: preset_columns,
            };

            let columns = build_summary_export_hours_sheet_columns(&summary, &preset);
            assert_eq!(columns.len(), 3, "{label} preset should keep three export columns");
            assert!(
                matches!(columns[row_total_index].kind, SummaryExportSheetColumnKind::RowTotal),
                "{label} preset should keep Row Total at the requested position"
            );
        }
    }

    #[test]
    fn hours_and_notes_export_reuses_only_adjacent_free_text_columns() {
        let summary = test_weekly_summary();
        let preset = SummaryLayoutPreset {
            id: "preset-export".to_string(),
            name: "Export".to_string(),
            columns: vec![
                SummaryLayoutColumn::Field {
                    id: "field-engagement-code".to_string(),
                    field_key: SummaryLayoutFieldKey::EngagementCode,
                },
                SummaryLayoutColumn::Day {
                    id: "day-0".to_string(),
                    day_index: 0,
                },
                SummaryLayoutColumn::FreeText {
                    id: "free-text-adjacent".to_string(),
                    label: "Custom Notes".to_string(),
                },
                SummaryLayoutColumn::Day {
                    id: "day-1".to_string(),
                    day_index: 1,
                },
                SummaryLayoutColumn::Field {
                    id: "field-client-name".to_string(),
                    field_key: SummaryLayoutFieldKey::ClientName,
                },
                SummaryLayoutColumn::FreeText {
                    id: "free-text-later".to_string(),
                    label: "Later Blank".to_string(),
                },
                SummaryLayoutColumn::RowTotal {
                    id: "row-total".to_string(),
                },
            ],
        };

        let columns = build_summary_export_hours_and_notes_sheet_columns(&summary, &preset);
        assert_eq!(columns.len(), 8);
        assert!(matches!(
            columns[0].kind,
            SummaryExportSheetColumnKind::Field(SummaryLayoutFieldKey::EngagementCode)
        ));
        assert!(matches!(columns[1].kind, SummaryExportSheetColumnKind::DayHours(0)));
        assert!(matches!(columns[2].kind, SummaryExportSheetColumnKind::DayNotes(0)));
        assert_eq!(columns[2].header, summary_day_notes_header(&summary, 0));
        assert!(matches!(columns[3].kind, SummaryExportSheetColumnKind::DayHours(1)));
        assert!(matches!(columns[4].kind, SummaryExportSheetColumnKind::DayNotes(1)));
        assert!(matches!(
            columns[5].kind,
            SummaryExportSheetColumnKind::Field(SummaryLayoutFieldKey::ClientName)
        ));
        assert!(matches!(columns[6].kind, SummaryExportSheetColumnKind::FreeText));
        assert_eq!(columns[6].header, "Later Blank");
        assert!(matches!(columns[7].kind, SummaryExportSheetColumnKind::RowTotal));
    }

    #[test]
    fn summary_export_field_value_matches_summary_table_rules() {
        let engagements = test_engagements();
        let (engagement_by_id, activity_by_id) = build_export_metadata_maps(&engagements);
        let summary = test_weekly_summary();
        let row = &summary.rows[0];

        assert_eq!(
            resolve_summary_export_field_value(
                SummaryLayoutFieldKey::EngagementTags,
                row,
                &engagement_by_id,
                &activity_by_id,
            ),
            "SOX, FAIT"
        );
        assert_eq!(
            resolve_summary_export_field_value(
                SummaryLayoutFieldKey::ActivityUsage,
                row,
                &engagement_by_id,
                &activity_by_id,
            ),
            "Use for testing controls."
        );

        let uncategorized_row = TimelineWeeklySummaryRow {
            engagement_id: None,
            activity_id: None,
            engagement_code: None,
            activity_code: None,
            activity_name: "Uncategorized".to_string(),
            engagement_name: "Uncategorized".to_string(),
            client_name: "".to_string(),
            is_uncategorized: true,
            cells: vec![],
            row_total_minutes: 0,
        };

        assert_eq!(
            resolve_summary_export_field_value(
                SummaryLayoutFieldKey::EngagementCode,
                &uncategorized_row,
                &engagement_by_id,
                &activity_by_id,
            ),
            "UNCAT"
        );
        assert_eq!(
            resolve_summary_export_field_value(
                SummaryLayoutFieldKey::ClientName,
                &uncategorized_row,
                &engagement_by_id,
                &activity_by_id,
            ),
            "-"
        );
    }

    #[test]
    fn confidence_normalization_handles_percent_values() {
        assert_eq!(normalize_confidence(Some(0.82)), 0.82);
        assert_eq!(normalize_confidence(Some(90.0)), 0.9);
        assert_eq!(normalize_confidence(Some(-1.0)), 0.0);
    }

    #[test]
    fn explicit_time_cue_detection_identifies_clock_times() {
        assert!(message_has_explicit_clock_time_cue("Met client at 2:30 PM"));
        assert!(message_has_explicit_clock_time_cue(
            "reviewed controls at 14:10"
        ));
        assert!(!message_has_explicit_clock_time_cue(
            "Reviewed OS-01 for non-sap itgcs"
        ));
    }

    #[test]
    fn relative_time_cue_detection_identifies_duration_language() {
        assert!(message_has_relative_duration_cue(
            "for the past hour i've been in meetings for rr itacs"
        ));
        assert!(message_has_relative_duration_cue(
            "for 45 minutes I was in planning"
        ));
        assert!(message_has_relative_duration_cue(
            "since lunch i was testing controls"
        ));
        assert!(!message_has_relative_duration_cue(
            "Reviewed OS-01 for non-sap itgcs"
        ));
    }

    #[test]
    fn implicit_recent_duration_detection_identifies_bare_duration_worklogs() {
        assert!(message_has_implicit_recent_duration_cue(
            "15 minutes to non-sap FDT-DB-02 with Nick"
        ));
        assert!(message_has_implicit_recent_duration_cue(
            "30 minutes on pcc review"
        ));
        assert!(message_has_implicit_recent_duration_cue(
            "spent 15 minutes on non-sap"
        ));
    }

    #[test]
    fn implicit_recent_duration_detection_excludes_future_planned_wording() {
        assert!(!message_has_implicit_recent_duration_cue(
            "tomorrow 15 minutes on non-sap"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "going to spend 15 minutes on non-sap"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "will spend 30 minutes on pcc later"
        ));
    }

    #[test]
    fn normalization_falls_back_to_capture_window_when_no_time_cue() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-15".to_string()),
            start_time: Some("00:00".to_string()),
            end_time: Some("00:00".to_string()),
            duration_minutes: Some(0),
            description: Some("Reviewed OS-01".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.7),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert!(result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.entry.start_minute, 1290);
        assert_eq!(result.entry.end_minute, 1320);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_defaults_missing_duration_without_temporal_fallback() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-15".to_string()),
            start_time: Some("12:00".to_string()),
            end_time: None,
            duration_minutes: None,
            description: Some("FAIT TR sync".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::ExplicitClock,
        );

        assert!(!result.used_temporal_fallback);
        assert!(result.duration_defaulted);
        assert_eq!(result.temporal_source, "llm_start_plus_duration");
        assert_eq!(result.entry.start_minute, 720);
        assert_eq!(result.entry.end_minute, 750);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_preserves_quarter_hour_duration() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-15".to_string()),
            start_time: Some("12:00".to_string()),
            end_time: None,
            duration_minutes: Some(15),
            description: Some("Quick check-in".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::ExplicitClock,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.entry.start_minute, 720);
        assert_eq!(result.entry.end_minute, 735);
        assert_eq!(result.entry.duration_minutes, 15);
    }

    #[test]
    fn normalization_keeps_explicit_clock_times() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-15".to_string()),
            start_time: Some("13:00".to_string()),
            end_time: Some("13:30".to_string()),
            duration_minutes: Some(30),
            description: Some("Client meeting".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::ExplicitClock,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.entry.start_minute, 780);
        assert_eq!(result.entry.end_minute, 810);
    }

    #[test]
    fn normalization_does_not_mark_default_when_start_and_end_define_duration() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-15".to_string()),
            start_time: Some("13:00".to_string()),
            end_time: Some("14:00".to_string()),
            duration_minutes: None,
            description: Some("Client meeting".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::ExplicitClock,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.entry.start_minute, 780);
        assert_eq!(result.entry.end_minute, 840);
        assert_eq!(result.entry.duration_minutes, 60);
    }

    #[test]
    fn normalization_keeps_relative_duration_window_when_llm_times_present() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: Some("20:48".to_string()),
            end_time: Some("21:48".to_string()),
            duration_minutes: Some(60),
            description: Some("Meetings for RR ITACs".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::RelativeDuration,
        );

        assert!(!result.used_temporal_fallback);
        assert_eq!(result.entry.start_minute, 1245);
        assert_eq!(result.entry.end_minute, 1305);
        assert_eq!(result.entry.duration_minutes, 60);
    }

    #[test]
    fn normalization_derives_from_duration_when_relative_cue_has_no_times() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: None,
            end_time: None,
            duration_minutes: Some(60),
            description: Some("Meetings for RR ITACs".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::RelativeDuration,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.temporal_source, "derived_from_duration");
        assert_eq!(result.entry.start_minute, 1260);
        assert_eq!(result.entry.end_minute, 1320);
        assert_eq!(result.entry.duration_minutes, 60);
    }

    #[test]
    fn normalization_derives_from_bare_duration_when_recent_cue_has_no_times() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: None,
            end_time: None,
            duration_minutes: Some(15),
            description: Some("Non-SAP work with Nick".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1095,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "fallback",
            TemporalCueType::ImplicitRecentDuration,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.temporal_source, "derived_from_bare_duration");
        assert_eq!(result.entry.start_minute, 1080);
        assert_eq!(result.entry.end_minute, 1095);
        assert_eq!(result.entry.duration_minutes, 15);
    }

    #[test]
    fn normalization_falls_back_when_future_planned_duration_has_no_anchor() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: None,
            end_time: None,
            duration_minutes: Some(15),
            description: Some("Planned Non-SAP work".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1095,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert!(result.used_temporal_fallback);
        assert_eq!(result.fallback_reason.as_deref(), Some("no_temporal_data"));
        assert_eq!(result.entry.start_minute, 1065);
        assert_eq!(result.entry.end_minute, 1095);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_falls_back_for_duration_without_relative_or_clock_cue() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: None,
            end_time: None,
            duration_minutes: Some(60),
            description: Some("Meetings".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert!(result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(result.fallback_reason.as_deref(), Some("no_temporal_data"));
        assert_eq!(result.entry.start_minute, 1290);
        assert_eq!(result.entry.end_minute, 1320);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_marks_missing_duration_when_temporal_fallback_is_used() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-02-17".to_string()),
            start_time: None,
            end_time: None,
            duration_minutes: None,
            description: Some("Meetings".to_string()),
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 17).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert!(result.used_temporal_fallback);
        assert!(result.duration_defaulted);
        assert_eq!(result.fallback_reason.as_deref(), Some("no_temporal_data"));
        assert_eq!(result.entry.start_minute, 1290);
        assert_eq!(result.entry.end_minute, 1320);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn activity_fallback_selects_best_matching_activity_within_engagement() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-69306633".to_string()),
                name: "PCC SOC2".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        id: "activity-1".to_string(),
                        activity_ref: "act-001-001".to_string(),
                        code: Some("0001".to_string()),
                        name: "Report 1".to_string(),
                        tags: vec!["PCC".to_string(), "detail review".to_string()],
                        describe_when_to_use: Some(
                            "Use for reporting and detailed review work.".to_string(),
                        ),
                    },
                    ContextActivity {
                        id: "activity-2".to_string(),
                        activity_ref: "act-001-002".to_string(),
                        code: Some("0006".to_string()),
                        name: "Admin/Management".to_string(),
                        tags: vec!["Admin".to_string(), "Management".to_string()],
                        describe_when_to_use: Some(
                            "Use for management and administrative effort.".to_string(),
                        ),
                    },
                ],
            }],
        };

        let mut entry = NormalizedEntry {
            date: "2026-02-23".to_string(),
            start_minute: 1080,
            end_minute: 1320,
            duration_minutes: 240,
            description: "Flight home from Reno for the PCC data center visit.".to_string(),
            user_submission_text: "Flight home from Reno for the PCC data center visit."
                .to_string(),
            confidence: 0.9,
            engagement_ref: Some("eng-001".to_string()),
            activity_ref: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "Just got home from a 4 hour flight from Reno for the PCC data center visit",
            &code_context,
        );

        assert!(decision.attempted);
        assert!(decision.applied);
        assert_eq!(entry.activity_ref.as_deref(), Some("act-001-001"));
        assert!(entry.confidence <= 0.60);
        assert_eq!(decision.chosen_activity_ref.as_deref(), Some("act-001-001"));
    }

    #[test]
    fn activity_fallback_keeps_null_when_no_similarity_signal_exists() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-1".to_string()),
                name: "Example".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        id: "activity-1".to_string(),
                        activity_ref: "act-001-001".to_string(),
                        code: Some("1000".to_string()),
                        name: "Testing".to_string(),
                        tags: vec!["controls".to_string()],
                        describe_when_to_use: None,
                    },
                    ContextActivity {
                        id: "activity-2".to_string(),
                        activity_ref: "act-001-002".to_string(),
                        code: Some("2000".to_string()),
                        name: "Documentation".to_string(),
                        tags: vec!["writeups".to_string()],
                        describe_when_to_use: None,
                    },
                ],
            }],
        };

        let mut entry = NormalizedEntry {
            date: "2026-02-23".to_string(),
            start_minute: 60,
            end_minute: 90,
            duration_minutes: 30,
            description: "Unrelated message".to_string(),
            user_submission_text: "Unrelated message".to_string(),
            confidence: 0.85,
            engagement_ref: Some("eng-001".to_string()),
            activity_ref: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "completely unrelated phrase with no overlap",
            &code_context,
        );

        assert!(decision.attempted);
        assert!(!decision.applied);
        assert_eq!(decision.reason.as_deref(), Some("no_similarity_signal"));
        assert!(entry.activity_ref.is_none());
        assert_eq!(entry.confidence, 0.85);
    }

    #[test]
    fn activity_fallback_can_use_description_guidance_without_tag_overlap() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-2".to_string()),
                name: "Client Work".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        id: "activity-1".to_string(),
                        activity_ref: "act-001-001".to_string(),
                        code: Some("A-10".to_string()),
                        name: "Fieldwork".to_string(),
                        tags: vec![],
                        describe_when_to_use: Some(
                            "Use when performing walkthrough meetings with client stakeholders."
                                .to_string(),
                        ),
                    },
                    ContextActivity {
                        id: "activity-2".to_string(),
                        activity_ref: "act-001-002".to_string(),
                        code: Some("A-20".to_string()),
                        name: "Reporting".to_string(),
                        tags: vec![],
                        describe_when_to_use: Some(
                            "Use when drafting final report language and manager review notes."
                                .to_string(),
                        ),
                    },
                ],
            }],
        };

        let mut entry = NormalizedEntry {
            date: "2026-02-23".to_string(),
            start_minute: 60,
            end_minute: 90,
            duration_minutes: 30,
            description: "Walkthrough call".to_string(),
            user_submission_text: "Walkthrough call".to_string(),
            confidence: 0.9,
            engagement_ref: Some("eng-001".to_string()),
            activity_ref: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "Met with client stakeholders for a walkthrough meeting",
            &code_context,
        );

        assert!(decision.applied);
        assert_eq!(entry.activity_ref.as_deref(), Some("act-001-001"));
    }

    #[test]
    fn global_activity_fallback_derives_parent_engagement_from_specific_activity_match() {
        let code_context = CodeContext {
            engagements: vec![
                ContextEngagement {
                    id: "engagement-1".to_string(),
                    engagement_ref: "eng-001".to_string(),
                    code: Some("E-69306633".to_string()),
                    name: "Apple FY26".to_string(),
                    tags: vec!["SOX".to_string(), "FAIT".to_string()],
                    describe_when_to_use: Some("For the Apple SOX/FAIT audit.".to_string()),
                    activities: vec![
                        ContextActivity {
                            id: "activity-1".to_string(),
                            activity_ref: "act-001-001".to_string(),
                            code: Some("0348".to_string()),
                            name: "Engagement Management - Meetings".to_string(),
                            tags: vec![],
                            describe_when_to_use: Some(
                                "Use this activity for generic meeting events and/or team meetings. Do NOT use this for meetings that pertain to specific work streams (for example SAP or non-SAP meetings).".to_string(),
                            ),
                        },
                        ContextActivity {
                            id: "activity-2".to_string(),
                            activity_ref: "act-001-002".to_string(),
                            code: Some("0350".to_string()),
                            name: "Non-SAP ITGC".to_string(),
                            tags: vec!["Non-SAP".to_string(), "Non SAP ITGC".to_string()],
                            describe_when_to_use: Some(
                                "Use this for anything \"Non-SAP\" related.".to_string(),
                            ),
                        },
                    ],
                },
                ContextEngagement {
                    id: "engagement-2".to_string(),
                    engagement_ref: "eng-002".to_string(),
                    code: Some("E-2".to_string()),
                    name: "Other Work".to_string(),
                    tags: vec![],
                    describe_when_to_use: Some("Use for other work.".to_string()),
                    activities: vec![ContextActivity {
                        id: "activity-3".to_string(),
                        activity_ref: "act-002-001".to_string(),
                        code: Some("0001".to_string()),
                        name: "Admin".to_string(),
                        tags: vec!["Admin".to_string()],
                        describe_when_to_use: Some(
                            "Use for generic administrative work.".to_string(),
                        ),
                    }],
                },
            ],
        };

        let mut entry = NormalizedEntry {
            date: "2026-03-18".to_string(),
            start_minute: 495,
            end_minute: 525,
            duration_minutes: 30,
            description: "PMO/Uploading prior year workpapers for non-sap".to_string(),
            user_submission_text: "PMO/Uploading prior year workpapers for non-sap, 30 minutes"
                .to_string(),
            confidence: 0.8,
            engagement_ref: None,
            activity_ref: None,
        };

        let decision = apply_global_activity_fallback_if_needed(
            &mut entry,
            "PMO/Uploading prior year workpapers for non-sap, 30 minutes",
            &code_context,
        );

        assert!(decision.attempted);
        assert!(decision.applied);
        assert_eq!(entry.engagement_ref.as_deref(), Some("eng-001"));
        assert_eq!(entry.activity_ref.as_deref(), Some("act-001-002"));
        assert_eq!(
            decision.reason.as_deref(),
            Some("activity_implied_parent_engagement")
        );
        assert!(entry.confidence <= 0.60);
    }

    #[test]
    fn global_activity_fallback_keeps_null_when_best_match_is_ambiguous() {
        let code_context = CodeContext {
            engagements: vec![
                ContextEngagement {
                    id: "engagement-1".to_string(),
                    engagement_ref: "eng-001".to_string(),
                    code: Some("E-1".to_string()),
                    name: "Client A".to_string(),
                    tags: vec![],
                    describe_when_to_use: Some("Use for client A work.".to_string()),
                    activities: vec![ContextActivity {
                        id: "activity-1".to_string(),
                        activity_ref: "act-001-001".to_string(),
                        code: Some("1000".to_string()),
                        name: "General Testing".to_string(),
                        tags: vec!["testing".to_string()],
                        describe_when_to_use: Some(
                            "Use for testing controls and walkthrough support.".to_string(),
                        ),
                    }],
                },
                ContextEngagement {
                    id: "engagement-2".to_string(),
                    engagement_ref: "eng-002".to_string(),
                    code: Some("E-2".to_string()),
                    name: "Client B".to_string(),
                    tags: vec![],
                    describe_when_to_use: Some("Use for client B work.".to_string()),
                    activities: vec![ContextActivity {
                        id: "activity-2".to_string(),
                        activity_ref: "act-002-001".to_string(),
                        code: Some("2000".to_string()),
                        name: "General Testing".to_string(),
                        tags: vec!["testing".to_string()],
                        describe_when_to_use: Some(
                            "Use for testing controls and walkthrough support.".to_string(),
                        ),
                    }],
                },
            ],
        };

        let mut entry = NormalizedEntry {
            date: "2026-03-18".to_string(),
            start_minute: 495,
            end_minute: 525,
            duration_minutes: 30,
            description: "Testing support".to_string(),
            user_submission_text: "testing support".to_string(),
            confidence: 0.8,
            engagement_ref: None,
            activity_ref: None,
        };

        let decision =
            apply_global_activity_fallback_if_needed(&mut entry, "testing support", &code_context);

        assert!(decision.attempted);
        assert!(!decision.applied);
        assert_eq!(decision.reason.as_deref(), Some("ambiguous_best_match"));
        assert!(entry.engagement_ref.is_none());
        assert!(entry.activity_ref.is_none());
    }

    #[test]
    fn global_activity_fallback_does_not_override_existing_engagement_choice() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-1".to_string()),
                name: "Apple FY26".to_string(),
                tags: vec![],
                describe_when_to_use: Some("For the Apple SOX/FAIT audit.".to_string()),
                activities: vec![ContextActivity {
                    id: "activity-1".to_string(),
                    activity_ref: "act-001-001".to_string(),
                    code: Some("0350".to_string()),
                    name: "Non-SAP ITGC".to_string(),
                    tags: vec!["Non-SAP".to_string()],
                    describe_when_to_use: Some(
                        "Use this for anything \"Non-SAP\" related.".to_string(),
                    ),
                }],
            }],
        };

        let mut entry = NormalizedEntry {
            date: "2026-03-18".to_string(),
            start_minute: 495,
            end_minute: 525,
            duration_minutes: 30,
            description: "non-sap".to_string(),
            user_submission_text: "non-sap".to_string(),
            confidence: 0.8,
            engagement_ref: Some("eng-001".to_string()),
            activity_ref: None,
        };

        let decision =
            apply_global_activity_fallback_if_needed(&mut entry, "non-sap", &code_context);

        assert!(!decision.attempted);
        assert!(!decision.applied);
        assert_eq!(entry.engagement_ref.as_deref(), Some("eng-001"));
        assert!(entry.activity_ref.is_none());
    }

    #[test]
    fn reconcile_context_refs_derives_parent_engagement_from_activity_ref() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-1".to_string()),
                name: "Apple FY26".to_string(),
                tags: vec![],
                describe_when_to_use: Some("For the Apple SOX/FAIT audit.".to_string()),
                activities: vec![ContextActivity {
                    id: "activity-1".to_string(),
                    activity_ref: "act-001-001".to_string(),
                    code: Some("0350".to_string()),
                    name: "Non-SAP ITGC".to_string(),
                    tags: vec!["Non-SAP".to_string()],
                    describe_when_to_use: Some(
                        "Use this for anything \"Non-SAP\" related.".to_string(),
                    ),
                }],
            }],
        };

        let mut entry = NormalizedEntry {
            date: "2026-03-18".to_string(),
            start_minute: 495,
            end_minute: 525,
            duration_minutes: 30,
            description: "non-sap".to_string(),
            user_submission_text: "non-sap".to_string(),
            confidence: 0.8,
            engagement_ref: None,
            activity_ref: Some("act-001-001".to_string()),
        };

        let decision = reconcile_context_refs(&mut entry, &code_context);

        assert!(decision.applied);
        assert_eq!(decision.reason, "derived_engagement_from_activity_ref");
        assert_eq!(entry.engagement_ref.as_deref(), Some("eng-001"));
        assert_eq!(entry.activity_ref.as_deref(), Some("act-001-001"));
    }

    #[test]
    fn llm_attempt_status_mapping_prefers_success_over_retryable() {
        let success_attempt = LlmAttemptTelemetry {
            attempt: 1,
            max_attempts: 3,
            duration_ms: 50,
            outcome: "success",
            http_status: Some(200),
            retryable: false,
            retry_delay_ms: None,
            error_class: None,
            error_message: None,
        };
        assert_eq!(llm_attempt_event_status(&success_attempt), "ok");

        let retryable_failure = LlmAttemptTelemetry {
            attempt: 1,
            max_attempts: 3,
            duration_ms: 50,
            outcome: "transport_error",
            http_status: None,
            retryable: true,
            retry_delay_ms: Some(700),
            error_class: Some("timeout"),
            error_message: Some("timeout".to_string()),
        };
        assert_eq!(llm_attempt_event_status(&retryable_failure), "warning");

        let terminal_failure = LlmAttemptTelemetry {
            attempt: 3,
            max_attempts: 3,
            duration_ms: 50,
            outcome: "http_error",
            http_status: Some(429),
            retryable: false,
            retry_delay_ms: None,
            error_class: None,
            error_message: Some("rate limited".to_string()),
        };
        assert_eq!(llm_attempt_event_status(&terminal_failure), "error");
    }

    #[test]
    fn dedupe_prepared_entries_removes_exact_duplicates() {
        let template = PreparedEntry {
            entry: NormalizedEntry {
                date: "2026-03-02".to_string(),
                start_minute: 540,
                end_minute: 570,
                duration_minutes: 30,
                description: "Control testing".to_string(),
                user_submission_text: "Control testing".to_string(),
                confidence: 0.8,
                engagement_ref: Some("eng-001".to_string()),
                activity_ref: Some("act-001-001".to_string()),
            },
            used_activity_fallback: false,
            used_temporal_fallback: false,
            duration_defaulted: false,
            fallback_summary: None,
        };

        let entries = vec![template.clone(), template];
        let deduped = dedupe_prepared_entries(entries);

        assert_eq!(deduped.len(), 1);
    }

    #[test]
    fn dedupe_prepared_entries_normalizes_description_case_and_spacing() {
        let first = PreparedEntry {
            entry: NormalizedEntry {
                date: "2026-03-02".to_string(),
                start_minute: 540,
                end_minute: 570,
                duration_minutes: 30,
                description: "Controls   testing".to_string(),
                user_submission_text: "Controls testing".to_string(),
                confidence: 0.8,
                engagement_ref: Some("eng-001".to_string()),
                activity_ref: Some("act-001-001".to_string()),
            },
            used_activity_fallback: false,
            used_temporal_fallback: false,
            duration_defaulted: false,
            fallback_summary: None,
        };

        let second = PreparedEntry {
            entry: NormalizedEntry {
                date: "2026-03-02".to_string(),
                start_minute: 540,
                end_minute: 570,
                duration_minutes: 30,
                description: "controls testing".to_string(),
                user_submission_text: "controls testing".to_string(),
                confidence: 0.8,
                engagement_ref: Some("eng-001".to_string()),
                activity_ref: Some("act-001-001".to_string()),
            },
            used_activity_fallback: true,
            used_temporal_fallback: false,
            duration_defaulted: false,
            fallback_summary: Some("Activity fallback applied".to_string()),
        };

        let deduped = dedupe_prepared_entries(vec![first, second]);
        assert_eq!(deduped.len(), 1);
    }
}
