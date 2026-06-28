use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Weekday};
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
    default_reporting_display_columns, Activity, ActivityUpsertInput, ApiKeyInput,
    CalendarExtractCandidate, CalendarExtractInput, CalendarExtractResult,
    CalendarImportEntryInput, CalendarImportInput, CalendarImportResult, CalendarVisionEvent,
    CaptureSourceId, CodeContext, ContextActivity, ContextEngagement, DateInput, DiagnosticsBundle,
    DiagnosticsEvent, DiagnosticsListInput, DiagnosticsRecordInput, Engagement, EngagementType,
    EngagementUpsertInput, IdInput, IdResult, InterpretResult, InterpretTextInput, KeySource,
    LlmAlternativeActivity, LlmEntry, LlmGapFillActivity, LlmGapFillRequest, LlmTimeOffRequest,
    MicrophonePermissionResult, MicrophonePermissionStatus, NormalizedEntry, OpenAiModelId,
    QuickAddPreferences, QuickAddSuggestionInput, QuickAddSuggestionResult, ReportingDisplayColumn,
    ReportingDisplayDensity, ReportingDisplayPreset, ReportingRowLabelMode, ReportingState,
    ReportingViewMode, SettingsSetCalendarBulkModelInput, SettingsSetCalendarBulkPreferencesInput,
    SettingsSetInterfacePreferencesInput, SettingsSetOpenAiModelInput,
    SettingsSetQuickAddPreferencesInput, SettingsSetTimelinePreferencesInput,
    SettingsSetTranscriptionModelInput, SettingsStatus, StatusLevel, StorageHealth,
    SummaryExportResult, SummaryExportWeeklyExcelInput, SummaryLayoutColumn, SummaryLayoutFieldKey,
    SummaryLayoutPreset, SummaryLayoutState, TimelineCreateInput, TimelineDaySummary,
    TimelineEntry, TimelineMonthSummaryInput, TimelineTotalBreakdown, TimelineUpdateInput,
    TimelineUpdateMode, TimelineWeekStartDay, TimelineWeekView, TimelineWeekViewDay,
    TimelineWeeklySummary, TimelineWeeklySummaryNote, TranscribeAudioInput, TranscribeAudioResult,
    TranscriptionModelId, Warning, WarningType,
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
const MAX_GAP_FILL_SAVED_ENTRIES_PER_MESSAGE: usize = 24;
const MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE: usize = 45;
const DEFAULT_GAP_FILL_START_MINUTE: i64 = 9 * 60;
const DEFAULT_GAP_FILL_END_MINUTE: i64 = 18 * 60;
const DEFAULT_TIME_OFF_START_MINUTE: i64 = 9 * 60;
const DEFAULT_TIME_OFF_END_MINUTE: i64 = 17 * 60;
const APP_SETTING_OPENAI_KEY_CONFIGURED: &str = "openai_key_configured";
const APP_SETTING_OPENAI_MODEL: &str = "openai_model";
const APP_SETTING_CALENDAR_BULK_OPENAI_MODEL: &str = "calendar_bulk_openai_model";
const APP_SETTING_TRANSCRIPTION_MODEL: &str = "openai_transcription_model";
const APP_SETTING_TIMELINE_EXCLUDE_UNCATEGORIZED_FROM_DAILY_TOTALS: &str =
    "timeline_exclude_uncategorized_from_daily_totals";
const APP_SETTING_TIMELINE_SHOW_UNCATEGORIZED_DAILY_TOTAL: &str =
    "timeline_show_uncategorized_daily_total";
const APP_SETTING_TIMELINE_INCLUDE_EXTERNAL_IN_TOTALS: &str = "timeline_include_external_in_totals";
const APP_SETTING_TIMELINE_INCLUDE_INTERNAL_IN_TOTALS: &str = "timeline_include_internal_in_totals";
const APP_SETTING_TIMELINE_SEPARATE_ENGAGEMENT_TYPE_TOTALS: &str =
    "timeline_separate_engagement_type_totals";
const APP_SETTING_TIMELINE_WEEK_START_DAY: &str = "timeline_week_start_day";
const APP_SETTING_CALENDAR_BULK_IGNORED_KEYWORDS: &str = "calendar_bulk_ignored_keywords";
const APP_SETTING_CALENDAR_BULK_IGNORE_ALL_DAY_EVENTS: &str = "calendar_bulk_ignore_all_day_events";
const APP_SETTING_QUICK_ADD_PREFERENCES: &str = "quick_add_preferences";
const APP_SETTING_SHOW_DIAGNOSTICS_TAB: &str = "show_diagnostics_tab";
const APP_SETTING_SUMMARY_LAYOUT_STATE: &str = "summary_layout_state";
const APP_SETTING_REPORTING_STATE: &str = "reporting_state";
const SUMMARY_LAYOUT_STATE_VERSION: i64 = 3;
const SUMMARY_LAYOUT_MAX_NAME_LENGTH: usize = 40;
const DEFAULT_SUMMARY_LAYOUT_PRESET_ID: &str = "preset-standard";
const DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID: &str = "row-total";
const REPORTING_STATE_VERSION: i64 = 1;
const REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH: usize = 40;
const DEFAULT_REPORTING_DISPLAY_PRESET_ID: &str = "reporting-display-compact-review";
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

fn resolve_saved_calendar_bulk_model_value(
    saved_value: Option<String>,
) -> (OpenAiModelId, Option<String>) {
    match saved_value {
        Some(value) => match OpenAiModelId::from_api_name(&value) {
            Some(model) => (model, None),
            None => (OpenAiModelId::default_calendar_bulk_model(), Some(value)),
        },
        None => (OpenAiModelId::default_calendar_bulk_model(), None),
    }
}

fn read_saved_calendar_bulk_model(
    connection: &Connection,
) -> AppResult<(OpenAiModelId, Option<String>)> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_CALENDAR_BULK_OPENAI_MODEL)?;
    Ok(resolve_saved_calendar_bulk_model_value(saved_value))
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

fn read_saved_openai_key_configured_marker(connection: &Connection) -> AppResult<Option<bool>> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_OPENAI_KEY_CONFIGURED)?;
    Ok(saved_value.map(|value| resolve_saved_bool_setting_value(Some(value), false)))
}

fn read_saved_openai_key_configured(connection: &Connection) -> AppResult<bool> {
    Ok(read_saved_openai_key_configured_marker(connection)?.unwrap_or(false))
}

fn write_openai_key_configured(connection: &Connection, value: bool) -> AppResult<()> {
    db::upsert_app_setting(
        connection,
        APP_SETTING_OPENAI_KEY_CONFIGURED,
        bool_app_setting_value(value),
    )
}

fn bool_app_setting_value(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TimelinePreferenceValues {
    exclude_uncategorized_from_totals: bool,
    show_uncategorized_total: bool,
    include_external_in_totals: bool,
    include_internal_in_totals: bool,
    separate_engagement_type_totals: bool,
    week_start_day: TimelineWeekStartDay,
}

fn resolve_saved_bool_setting_value(saved_value: Option<String>, default_value: bool) -> bool {
    match saved_value.as_deref().map(str::trim) {
        Some("true") | Some("1") => true,
        Some("false") | Some("0") => false,
        _ => default_value,
    }
}

fn resolve_saved_timeline_week_start_day(saved_value: Option<String>) -> TimelineWeekStartDay {
    saved_value
        .as_deref()
        .and_then(TimelineWeekStartDay::from_setting_value)
        .unwrap_or_default()
}

fn normalize_timeline_preference_values(
    mut values: TimelinePreferenceValues,
) -> TimelinePreferenceValues {
    if !values.include_external_in_totals && !values.include_internal_in_totals {
        values.include_external_in_totals = true;
    }

    values
}

fn validate_timeline_preferences(preferences: TimelinePreferenceValues) -> Result<(), String> {
    if !preferences.include_external_in_totals && !preferences.include_internal_in_totals {
        return Err(
            "at least one of external or internal type codes must be included in totals"
                .to_string(),
        );
    }

    Ok(())
}

fn read_saved_timeline_preferences(connection: &Connection) -> AppResult<TimelinePreferenceValues> {
    let exclude_uncategorized = resolve_saved_bool_setting_value(
        db::get_app_setting(
            connection,
            APP_SETTING_TIMELINE_EXCLUDE_UNCATEGORIZED_FROM_DAILY_TOTALS,
        )?,
        true,
    );
    let show_uncategorized_total = resolve_saved_bool_setting_value(
        db::get_app_setting(
            connection,
            APP_SETTING_TIMELINE_SHOW_UNCATEGORIZED_DAILY_TOTAL,
        )?,
        false,
    );
    let include_external_in_totals = resolve_saved_bool_setting_value(
        db::get_app_setting(connection, APP_SETTING_TIMELINE_INCLUDE_EXTERNAL_IN_TOTALS)?,
        true,
    );
    let include_internal_in_totals = resolve_saved_bool_setting_value(
        db::get_app_setting(connection, APP_SETTING_TIMELINE_INCLUDE_INTERNAL_IN_TOTALS)?,
        false,
    );
    let separate_engagement_type_totals = resolve_saved_bool_setting_value(
        db::get_app_setting(
            connection,
            APP_SETTING_TIMELINE_SEPARATE_ENGAGEMENT_TYPE_TOTALS,
        )?,
        true,
    );
    let week_start_day = resolve_saved_timeline_week_start_day(db::get_app_setting(
        connection,
        APP_SETTING_TIMELINE_WEEK_START_DAY,
    )?);

    Ok(normalize_timeline_preference_values(
        TimelinePreferenceValues {
            exclude_uncategorized_from_totals: exclude_uncategorized,
            show_uncategorized_total,
            include_external_in_totals,
            include_internal_in_totals,
            separate_engagement_type_totals,
            week_start_day,
        },
    ))
}

fn apply_timeline_preferences_to_breakdown(
    breakdown: &mut TimelineTotalBreakdown,
    preferences: TimelinePreferenceValues,
) {
    breakdown.primary_minutes = 0;

    if preferences.include_external_in_totals {
        breakdown.primary_minutes += breakdown.external_minutes;
    }
    if preferences.include_internal_in_totals {
        breakdown.primary_minutes += breakdown.internal_minutes;
    }
    if !preferences.exclude_uncategorized_from_totals {
        breakdown.primary_minutes += breakdown.uncategorized_minutes;
    }
}

fn apply_timeline_preferences_to_weekly_summary(
    summary: &mut TimelineWeeklySummary,
    preferences: TimelinePreferenceValues,
) {
    for breakdown in &mut summary.day_total_breakdowns {
        apply_timeline_preferences_to_breakdown(breakdown, preferences);
    }
    apply_timeline_preferences_to_breakdown(&mut summary.week_total_breakdown, preferences);

    summary.day_total_minutes = summary
        .day_total_breakdowns
        .iter()
        .map(|breakdown| breakdown.primary_minutes)
        .collect();
    summary.week_total_minutes = summary.week_total_breakdown.primary_minutes;
}

fn normalize_calendar_bulk_ignored_keywords(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut normalized = Vec::<String>::new();

    for value in values {
        for candidate in value.split([',', '\n', ';']) {
            let keyword = candidate.trim().to_lowercase();
            if keyword.is_empty() || !seen.insert(keyword.clone()) {
                continue;
            }
            normalized.push(keyword);
        }
    }

    normalized
}

fn read_saved_calendar_bulk_preferences(connection: &Connection) -> AppResult<(Vec<String>, bool)> {
    let saved_keywords =
        db::get_app_setting(connection, APP_SETTING_CALENDAR_BULK_IGNORED_KEYWORDS)?;
    let parsed_keywords = saved_keywords
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_else(|| {
            vec![
                "lunch".to_string(),
                "focus".to_string(),
                "block".to_string(),
            ]
        });
    let ignored_keywords = normalize_calendar_bulk_ignored_keywords(&parsed_keywords);
    let ignore_all_day_events = resolve_saved_bool_setting_value(
        db::get_app_setting(connection, APP_SETTING_CALENDAR_BULK_IGNORE_ALL_DAY_EVENTS)?,
        true,
    );

    Ok((ignored_keywords, ignore_all_day_events))
}

fn default_quick_add_preferences() -> QuickAddPreferences {
    QuickAddPreferences {
        engagement_order: Vec::new(),
        hidden_engagement_ids: Vec::new(),
        activity_order: HashMap::new(),
        hidden_activity_ids: Vec::new(),
    }
}

fn normalize_id_list(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut normalized = Vec::<String>::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }

        normalized.push(trimmed.to_string());
    }

    normalized
}

fn normalize_quick_add_preferences(preferences: QuickAddPreferences) -> QuickAddPreferences {
    let mut activity_order = HashMap::<String, Vec<String>>::new();

    for (engagement_id, activity_ids) in preferences.activity_order {
        let normalized_engagement_id = engagement_id.trim();
        if normalized_engagement_id.is_empty() {
            continue;
        }

        activity_order.insert(
            normalized_engagement_id.to_string(),
            normalize_id_list(&activity_ids),
        );
    }

    QuickAddPreferences {
        engagement_order: normalize_id_list(&preferences.engagement_order),
        hidden_engagement_ids: normalize_id_list(&preferences.hidden_engagement_ids),
        activity_order,
        hidden_activity_ids: normalize_id_list(&preferences.hidden_activity_ids),
    }
}

fn read_saved_quick_add_preferences(connection: &Connection) -> AppResult<QuickAddPreferences> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_QUICK_ADD_PREFERENCES)?;
    let parsed_preferences = saved_value
        .as_deref()
        .and_then(|value| serde_json::from_str::<QuickAddPreferences>(value).ok())
        .unwrap_or_else(default_quick_add_preferences);

    Ok(normalize_quick_add_preferences(parsed_preferences))
}

fn read_saved_show_diagnostics_tab(connection: &Connection) -> AppResult<bool> {
    Ok(resolve_saved_bool_setting_value(
        db::get_app_setting(connection, APP_SETTING_SHOW_DIAGNOSTICS_TAB)?,
        false,
    ))
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
        let candidate = format!("{}-{suffix}", DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID);
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
                        return Err("Summary layout field column IDs cannot be empty.".to_string());
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
                        return Err(
                            "Summary layout day indexes must be between 0 and 6.".to_string()
                        );
                    }
                    if !day_indexes.insert(*day_index) {
                        return Err("A summary layout preset cannot include the same day twice."
                            .to_string());
                    }
                }
                SummaryLayoutColumn::FreeText {
                    id,
                    label,
                    row_values,
                    repeat,
                    repeat_value,
                    repeat_row_key,
                } => {
                    *id = id.trim().to_string();
                    *label = label.trim().to_string();
                    let mut normalized_row_values = HashMap::new();
                    for (key, value) in std::mem::take(row_values) {
                        let normalized_key = key.trim().to_string();
                        let normalized_value = value.trim().to_string();
                        if !normalized_key.is_empty() && !normalized_value.is_empty() {
                            normalized_row_values.insert(normalized_key, normalized_value);
                        }
                    }
                    *row_values = normalized_row_values;
                    *repeat_value = repeat_value.trim().to_string();
                    *repeat_row_key = repeat_row_key
                        .as_ref()
                        .map(|candidate| candidate.trim().to_string())
                        .filter(|candidate| !candidate.is_empty());
                    if !*repeat {
                        repeat_value.clear();
                        *repeat_row_key = None;
                    }
                    if id.is_empty() {
                        return Err(
                            "Summary layout free-text column IDs cannot be empty.".to_string()
                        );
                    }
                    if !column_ids.insert(id.clone()) {
                        return Err("Summary layout column IDs must be unique.".to_string());
                    }
                    if label.is_empty() {
                        return Err(
                            "Summary layout free-text column labels cannot be empty.".to_string()
                        );
                    }
                }
                SummaryLayoutColumn::RowTotal { id } => {
                    *id = id.trim().to_string();
                    if id.is_empty() {
                        return Err(
                            "Summary layout Row Total column IDs cannot be empty.".to_string()
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

fn default_reporting_display_preset() -> ReportingDisplayPreset {
    ReportingDisplayPreset {
        id: DEFAULT_REPORTING_DISPLAY_PRESET_ID.to_string(),
        name: "Compact Review".to_string(),
        density: ReportingDisplayDensity::Compact,
        row_label_mode: ReportingRowLabelMode::Combined,
        show_codes: true,
        show_client: false,
        show_engagement_type: false,
        show_empty_days: true,
        columns: default_reporting_display_columns(),
    }
}

fn default_reporting_state() -> ReportingState {
    ReportingState {
        version: REPORTING_STATE_VERSION,
        selected_view_mode: ReportingViewMode::Table,
        selected_display_preset_id: DEFAULT_REPORTING_DISPLAY_PRESET_ID.to_string(),
        selected_export_preset_id: None,
        display_presets: vec![default_reporting_display_preset()],
    }
}

fn normalize_reporting_state(mut state: ReportingState) -> Result<ReportingState, String> {
    state.version = REPORTING_STATE_VERSION;
    state.selected_display_preset_id = state.selected_display_preset_id.trim().to_string();
    state.selected_export_preset_id = state
        .selected_export_preset_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if state.display_presets.is_empty() {
        return Err("At least one reporting display preset is required.".to_string());
    }

    let mut preset_ids = HashSet::new();
    let mut preset_names = HashSet::new();

    for preset in &mut state.display_presets {
        preset.id = preset.id.trim().to_string();
        preset.name = preset.name.trim().to_string();

        if preset.id.is_empty() {
            return Err("Reporting display preset IDs cannot be empty.".to_string());
        }

        if preset.name.is_empty() {
            return Err("Reporting display preset names cannot be empty.".to_string());
        }

        if preset.name.chars().count() > REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH {
            return Err(format!(
                "Reporting display preset names must be {} characters or fewer.",
                REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH
            ));
        }

        if !preset_ids.insert(preset.id.clone()) {
            return Err("Reporting display preset IDs must be unique.".to_string());
        }

        if !preset_names.insert(preset.name.to_lowercase()) {
            return Err("Reporting display preset names must be unique.".to_string());
        }

        normalize_reporting_display_columns(preset)?;
    }

    if state.selected_display_preset_id.is_empty() {
        return Err("A selected reporting display preset is required.".to_string());
    }

    if !preset_ids.contains(&state.selected_display_preset_id) {
        return Err("The selected reporting display preset does not exist.".to_string());
    }

    Ok(state)
}

fn normalize_reporting_display_columns(preset: &mut ReportingDisplayPreset) -> Result<(), String> {
    if preset.columns.is_empty() {
        preset.columns = default_reporting_display_columns();
    }

    let mut has_day_group = false;
    let mut has_row_total = false;
    for column in &preset.columns {
        match column {
            ReportingDisplayColumn::DayGroup { .. } => has_day_group = true,
            ReportingDisplayColumn::RowTotal { .. } => has_row_total = true,
            ReportingDisplayColumn::Field { .. } => {}
        }
    }

    if !has_day_group {
        preset.columns.push(ReportingDisplayColumn::DayGroup {
            id: "reporting-days".to_string(),
        });
    }

    if !has_row_total {
        preset.columns.push(ReportingDisplayColumn::RowTotal {
            id: "reporting-row-total".to_string(),
        });
    }

    let mut column_ids = HashSet::new();
    let mut field_keys = HashSet::new();
    let mut field_count = 0;
    let mut day_group_count = 0;
    let mut row_total_count = 0;

    for column in &mut preset.columns {
        match column {
            ReportingDisplayColumn::Field { id, field_key } => {
                *id = id.trim().to_string();
                field_count += 1;

                if !field_keys.insert(*field_key) {
                    return Err(
                        "A reporting display preset cannot include the same field twice."
                            .to_string(),
                    );
                }
            }
            ReportingDisplayColumn::DayGroup { id } => {
                *id = id.trim().to_string();
                day_group_count += 1;
            }
            ReportingDisplayColumn::RowTotal { id } => {
                *id = id.trim().to_string();
                row_total_count += 1;
            }
        }

        let column_id = match column {
            ReportingDisplayColumn::Field { id, .. }
            | ReportingDisplayColumn::DayGroup { id }
            | ReportingDisplayColumn::RowTotal { id } => id,
        };

        if column_id.is_empty() {
            return Err("Reporting display preset column IDs cannot be empty.".to_string());
        }

        if !column_ids.insert(column_id.clone()) {
            return Err("Reporting display preset column IDs must be unique.".to_string());
        }
    }

    if field_count == 0 {
        return Err(
            "Each reporting display preset must include at least one field column.".to_string(),
        );
    }

    if day_group_count != 1 {
        return Err("Each reporting display preset must include one day group.".to_string());
    }

    if row_total_count != 1 {
        return Err("Each reporting display preset must include one row total.".to_string());
    }

    Ok(())
}

fn read_reporting_state(connection: &Connection) -> AppResult<ReportingState> {
    let saved_value = db::get_app_setting(connection, APP_SETTING_REPORTING_STATE)?;
    let state = saved_value
        .as_deref()
        .and_then(|value| serde_json::from_str::<ReportingState>(value).ok())
        .and_then(|state| normalize_reporting_state(state).ok())
        .unwrap_or_else(default_reporting_state);

    let serialized_state = serde_json::to_string(&state)?;
    if saved_value.as_deref() != Some(serialized_state.as_str()) {
        db::upsert_app_setting(
            connection,
            APP_SETTING_REPORTING_STATE,
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
        CaptureSourceId::Calendar => "calendar",
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
          "message": "Invalid saved OpenAI model; defaulted to GPT-5.5 Instant.",
          "invalidValue": invalid_value,
          "fallbackModel": OpenAiModelId::default().storage_value(),
          "fallbackApiModel": OpenAiModelId::default().api_name(),
          "fallbackModelLabel": OpenAiModelId::default().display_label(),
        }),
    );
}

fn record_invalid_saved_calendar_bulk_model(
    state: &State<'_, AppState>,
    correlation_id: &str,
    command: &str,
    invalid_value: &str,
) {
    let fallback_model = OpenAiModelId::default_calendar_bulk_model();
    record_backend_event_with_state(
        state,
        correlation_id,
        "settings_model_fallback",
        command,
        "warning",
        None,
        None,
        json!({
          "message": "Invalid saved calendar bulk model; defaulted to GPT-5.5 Instant.",
          "setting": APP_SETTING_CALENDAR_BULK_OPENAI_MODEL,
          "invalidValue": invalid_value,
          "fallbackModel": fallback_model.storage_value(),
          "fallbackApiModel": fallback_model.api_name(),
          "fallbackModelLabel": fallback_model.display_label(),
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

fn timeline_week_bounds(
    date: &str,
    week_start_day: TimelineWeekStartDay,
) -> Result<(String, String), String> {
    let selected_date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "date must be in YYYY-MM-DD format".to_string())?;
    let selected_offset = selected_date.weekday().num_days_from_sunday();
    let week_start_offset = timeline_week_start_offset_from_sunday(week_start_day);
    let days_since_week_start = (selected_offset + 7 - week_start_offset) % 7;
    let week_start = selected_date - Duration::days(days_since_week_start as i64);
    let week_end_exclusive = week_start + Duration::days(7);

    Ok((
        week_start.format("%Y-%m-%d").to_string(),
        week_end_exclusive.format("%Y-%m-%d").to_string(),
    ))
}

fn timeline_week_start_offset_from_sunday(week_start_day: TimelineWeekStartDay) -> u32 {
    match week_start_day {
        TimelineWeekStartDay::Sunday => 0,
        TimelineWeekStartDay::Monday => 1,
        TimelineWeekStartDay::Saturday => 6,
    }
}

fn timeline_week_view_bounds(
    date: &str,
    week_start_day: TimelineWeekStartDay,
) -> Result<(String, String), String> {
    timeline_week_bounds(date, week_start_day)
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

fn weekday_display_name(weekday: Weekday) -> &'static str {
    match weekday {
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
        Weekday::Sun => "Sunday",
    }
}

fn summary_day_header(day_index: usize, iso_date: &str) -> String {
    match NaiveDate::parse_from_str(iso_date.trim(), "%Y-%m-%d") {
        Ok(value) => format!(
            "{} ({})",
            weekday_display_name(value.weekday()),
            value.format("%m/%d")
        ),
        Err(_) => format!("Day {} ({iso_date})", day_index + 1),
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct SummaryExportFreeTextValue {
    row_values: HashMap<String, String>,
    repeat: bool,
    repeat_value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SummaryExportSheetColumnKind {
    Field(SummaryLayoutFieldKey),
    DayHours(usize),
    DayNotes(usize),
    FreeText(SummaryExportFreeTextValue),
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
            SummaryLayoutColumn::Field { field_key, .. } => {
                columns.push(SummaryExportSheetColumn {
                    header: summary_layout_field_label(*field_key).to_string(),
                    kind: SummaryExportSheetColumnKind::Field(*field_key),
                    width: summary_layout_field_width(*field_key),
                    wrap_text: summary_layout_field_wraps(*field_key),
                })
            }
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
            SummaryLayoutColumn::FreeText {
                label,
                row_values,
                repeat,
                repeat_value,
                ..
            } => columns.push(SummaryExportSheetColumn {
                header: label.clone(),
                kind: SummaryExportSheetColumnKind::FreeText(SummaryExportFreeTextValue {
                    row_values: row_values.clone(),
                    repeat: *repeat,
                    repeat_value: repeat_value.clone(),
                }),
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

                columns.push(SummaryExportSheetColumn {
                    header: summary_day_notes_header(summary, resolved_day_index),
                    kind: SummaryExportSheetColumnKind::DayNotes(resolved_day_index),
                    width: 42,
                    wrap_text: true,
                });
            }
            SummaryLayoutColumn::FreeText {
                label,
                row_values,
                repeat,
                repeat_value,
                ..
            } => {
                columns.push(SummaryExportSheetColumn {
                    header: label.clone(),
                    kind: SummaryExportSheetColumnKind::FreeText(SummaryExportFreeTextValue {
                        row_values: row_values.clone(),
                        repeat: *repeat,
                        repeat_value: repeat_value.clone(),
                    }),
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
        SummaryLayoutFieldKey::EngagementCode => format_summary_code_value_for_export(
            row.engagement_code.as_deref(),
            row.is_uncategorized,
        ),
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

fn summary_export_footer_label_column_index(columns: &[SummaryExportSheetColumn]) -> Option<usize> {
    columns.iter().position(|column| {
        !matches!(
            &column.kind,
            SummaryExportSheetColumnKind::DayHours(_)
                | SummaryExportSheetColumnKind::DayNotes(_)
                | SummaryExportSheetColumnKind::RowTotal
        )
    })
}

fn summary_export_row_key(row: &crate::models::TimelineWeeklySummaryRow) -> String {
    if let Some(activity_id) = row
        .activity_id
        .as_ref()
        .map(|candidate| candidate.trim())
        .filter(|candidate| !candidate.is_empty())
    {
        return format!("activity:{activity_id}");
    }

    if row.is_uncategorized {
        if let Some(engagement_id) = row
            .engagement_id
            .as_ref()
            .map(|candidate| candidate.trim())
            .filter(|candidate| !candidate.is_empty())
        {
            return format!("engagement:{engagement_id}:uncategorized");
        }
    }

    "uncategorized".to_string()
}

fn resolve_summary_export_free_text_value(
    free_text: &SummaryExportFreeTextValue,
    row: &crate::models::TimelineWeeklySummaryRow,
) -> String {
    if free_text.repeat {
        return free_text.repeat_value.clone();
    }

    let row_key = summary_export_row_key(row);
    free_text
        .row_values
        .get(&row_key)
        .cloned()
        .unwrap_or_default()
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
            match &column.kind {
                SummaryExportSheetColumnKind::Field(field_key) => {
                    let value = resolve_summary_export_field_value(
                        *field_key,
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
                        .get(*day_index)
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
                        .get(*day_index)
                        .map(|cell| format_summary_notes_for_export(&cell.notes))
                        .unwrap_or_default();
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        notes.as_str(),
                        &wrapped_text_format,
                    )?;
                }
                SummaryExportSheetColumnKind::FreeText(free_text) => {
                    let format = if column.wrap_text {
                        &wrapped_text_format
                    } else {
                        &plain_text_format
                    };
                    let value = resolve_summary_export_free_text_value(free_text, row);
                    worksheet.write_with_format(row_index, excel_column, value.as_str(), format)?;
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
        match &column.kind {
            SummaryExportSheetColumnKind::Field(_) | SummaryExportSheetColumnKind::FreeText(_) => {
                if footer_label_column_index == Some(column_index) {
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        "Day Totals",
                        &header_format,
                    )?;
                } else if column.wrap_text {
                    worksheet.write_with_format(
                        row_index,
                        excel_column,
                        "",
                        &wrapped_text_format,
                    )?;
                } else {
                    worksheet.write_with_format(row_index, excel_column, "", &plain_text_format)?;
                }
            }
            SummaryExportSheetColumnKind::DayHours(day_index) => {
                let total_minutes = summary
                    .day_total_minutes
                    .get(*day_index)
                    .copied()
                    .unwrap_or(0);
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
    llm_sequence_relation: Option<String>,
    llm_duration_source: Option<String>,
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

struct InterpretWriteMetadata<'a> {
    raw_message_id: &'a str,
    raw_text: &'a str,
    interpreted_entries_json: &'a str,
    selected_openai_model: OpenAiModelId,
    capture_source: CaptureSourceId,
    transcription_model: Option<TranscriptionModelId>,
    transcription_duration_ms: Option<i64>,
    confidence_average: f64,
    raw_message_timestamp: i64,
    interpreted_entry_count: i64,
    unique_entry_count: i64,
    saved_entry_count: i64,
    truncated_entry_count: i64,
    contains_multiple_events: bool,
}

struct InterpretWriteOutcome {
    created_entry_ids: Vec<String>,
    touched_month_keys: Vec<String>,
    warnings: Vec<Warning>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedCalendarImportEntry {
    date: String,
    start_minute: i64,
    end_minute: i64,
    duration_minutes: i64,
    description: String,
    extracted_text: String,
    engagement_id: Option<String>,
    activity_id: Option<String>,
    confidence: f64,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MinuteInterval {
    start_minute: i64,
    end_minute: i64,
}

#[derive(Debug, Clone)]
struct ResolvedGapFillRequest {
    date: String,
    window: MinuteInterval,
    activities: Vec<ResolvedGapFillActivity>,
}

#[derive(Debug, Clone)]
struct ResolvedGapFillActivity {
    engagement_ref: Option<String>,
    activity_ref: Option<String>,
    label: String,
    description: String,
    matching_text: String,
    activity_reason: Option<String>,
    alternative_activities: Option<Vec<LlmAlternativeActivity>>,
    confidence: f64,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TimeOffKind {
    Vacation,
    PublicHoliday,
}

impl TimeOffKind {
    fn code(self) -> &'static str {
        match self {
            Self::Vacation => "VACATION",
            Self::PublicHoliday => "HOLIDAY",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Vacation => "Vacation",
            Self::PublicHoliday => "Public Holiday",
        }
    }

    fn storage_value(self) -> &'static str {
        match self {
            Self::Vacation => "vacation",
            Self::PublicHoliday => "holiday",
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedTimeOffRequest {
    kind: TimeOffKind,
    start_date: NaiveDate,
    end_date: NaiveDate,
    description: String,
    confidence: f64,
}

#[derive(Debug, Clone)]
struct GapFillSpan {
    activity_index: usize,
    start_minute: i64,
    end_minute: i64,
}

#[derive(Debug, Clone, Default)]
struct SequencingEntryContext {
    raw_duration: Option<i64>,
    llm_sequence_relation: Option<String>,
    llm_duration_source: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SequencingAdjustment {
    applied: bool,
    reason: Option<&'static str>,
    original_start_minute: Option<i64>,
    original_end_minute: Option<i64>,
    adjusted_start_minute: Option<i64>,
    adjusted_end_minute: Option<i64>,
    duration_minutes: Option<i64>,
    sequence_relation: Option<String>,
    duration_source: Option<String>,
    segment_text: Option<String>,
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

fn write_interpreted_prepared_entries(
    connection: &Connection,
    metadata: InterpretWriteMetadata<'_>,
    prepared_entries: Vec<PreparedEntry>,
    code_context: &CodeContext,
) -> Result<InterpretWriteOutcome, String> {
    db::insert_raw_message(
        connection,
        metadata.raw_message_id,
        metadata.raw_text,
        metadata.interpreted_entries_json,
        metadata.selected_openai_model.storage_value(),
        capture_source_label(metadata.capture_source),
        metadata.transcription_model.map(|model| model.api_name()),
        metadata.transcription_duration_ms,
        metadata.confidence_average,
        metadata.raw_message_timestamp,
        metadata.interpreted_entry_count,
        metadata.unique_entry_count,
        metadata.saved_entry_count,
        metadata.truncated_entry_count,
        metadata.contains_multiple_events,
    )
    .map_err(|error| error.to_string())?;

    let mut created_entry_ids = Vec::new();
    let mut warnings = Vec::new();
    let mut touched_dates = HashSet::<String>::new();

    for (index, prepared_entry) in prepared_entries.into_iter().enumerate() {
        let normalized_entry = prepared_entry.entry;
        let (engagement_id, activity_id) = resolve_ref_ids(&normalized_entry, code_context);

        let entry_id = db::insert_timesheet_entry(
            connection,
            metadata.raw_message_id,
            &normalized_entry,
            engagement_id.as_deref(),
            activity_id.as_deref(),
            prepared_entry.used_activity_fallback,
            prepared_entry.used_temporal_fallback,
            prepared_entry.duration_defaulted,
            prepared_entry.fallback_summary.as_deref(),
            Some(index as i64 + 1),
            Some(metadata.saved_entry_count),
            capture_source_label(metadata.capture_source),
        )
        .map_err(|error| error.to_string())?;

        touched_dates.insert(normalized_entry.date.clone());
        created_entry_ids.push(entry_id.clone());

        if normalized_entry.confidence < db::LOW_CONFIDENCE_THRESHOLD {
            warnings.push(
                db::add_warning(
                    connection,
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
                    connection,
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
        let overlap_warnings =
            db::recompute_overlap_warnings(connection, date).map_err(|error| error.to_string())?;
        warnings.extend(overlap_warnings);
    }

    Ok(InterpretWriteOutcome {
        created_entry_ids,
        touched_month_keys,
        warnings,
    })
}

fn resolve_gap_fill_request(
    request: &LlmGapFillRequest,
    input: &InterpretTextInput,
    reference: &TemporalReference,
    fallback_description: &str,
) -> Option<ResolvedGapFillRequest> {
    let activities = request
        .activities
        .iter()
        .filter_map(|activity| resolve_gap_fill_activity(activity, fallback_description))
        .collect::<Vec<_>>();

    if activities.is_empty() {
        return None;
    }

    let date = request
        .date
        .as_deref()
        .and_then(parse_date)
        .or_else(|| input.selected_date.as_deref().and_then(parse_date))
        .unwrap_or(reference.local_date)
        .format("%Y-%m-%d")
        .to_string();

    Some(ResolvedGapFillRequest {
        date,
        window: resolve_gap_fill_window(request),
        activities,
    })
}

fn resolve_gap_fill_activity(
    activity: &LlmGapFillActivity,
    fallback_description: &str,
) -> Option<ResolvedGapFillActivity> {
    let engagement_ref = trim_optional_text(activity.engagement_ref.as_deref());
    let activity_ref = trim_optional_text(activity.activity_ref.as_deref());
    let label = trim_optional_text(activity.label.as_deref());
    let description = trim_optional_text(activity.description.as_deref());

    if engagement_ref.is_none()
        && activity_ref.is_none()
        && label.is_none()
        && description.is_none()
    {
        return None;
    }

    let label = label
        .or_else(|| description.clone())
        .unwrap_or_else(|| "Gap fill activity".to_string());
    let description = description.clone().unwrap_or_else(|| label.clone());
    let matching_text = [Some(label.as_str()), Some(description.as_str())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let matching_text = if matching_text.trim().is_empty() {
        fallback_description.to_string()
    } else {
        matching_text
    };
    let alternative_activities = activity.alternative_activities.as_ref().map(|activities| {
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

    Some(ResolvedGapFillActivity {
        engagement_ref,
        activity_ref,
        label,
        description,
        matching_text,
        activity_reason: trim_optional_text(activity.activity_reason.as_deref()),
        alternative_activities: alternative_activities
            .and_then(|activities| (!activities.is_empty()).then_some(activities)),
        confidence: normalize_confidence(activity.confidence),
    })
}

fn trim_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_gap_fill_window(request: &LlmGapFillRequest) -> MinuteInterval {
    let start_minute = request
        .start_time
        .as_deref()
        .and_then(parse_time_to_minutes)
        .unwrap_or(DEFAULT_GAP_FILL_START_MINUTE);
    let end_minute = request
        .end_time
        .as_deref()
        .and_then(parse_time_to_minutes)
        .unwrap_or(DEFAULT_GAP_FILL_END_MINUTE);

    normalize_gap_fill_window(start_minute, end_minute).unwrap_or(MinuteInterval {
        start_minute: DEFAULT_GAP_FILL_START_MINUTE,
        end_minute: DEFAULT_GAP_FILL_END_MINUTE,
    })
}

fn normalize_gap_fill_window(start_minute: i64, end_minute: i64) -> Option<MinuteInterval> {
    let start_minute = round_to_nearest_15(start_minute).clamp(0, MINUTES_IN_DAY);
    let end_minute = round_to_nearest_15(end_minute).clamp(0, MINUTES_IN_DAY);

    (end_minute > start_minute).then_some(MinuteInterval {
        start_minute,
        end_minute,
    })
}

fn synthesize_time_off_request_from_text(
    raw_text: &str,
    input: &InterpretTextInput,
    reference: &TemporalReference,
) -> Option<LlmTimeOffRequest> {
    let (normalized, tokens) = normalize_time_off_text(raw_text);
    if !has_time_off_intent(&normalized, &tokens) {
        return None;
    }

    let kind = if has_holiday_intent(&tokens) {
        TimeOffKind::PublicHoliday
    } else {
        TimeOffKind::Vacation
    };
    let anchor_date = input
        .selected_date
        .as_deref()
        .and_then(parse_date)
        .unwrap_or(reference.local_date);
    let (start_date, end_date) = detect_time_off_date_range(raw_text, &tokens, anchor_date);

    Some(LlmTimeOffRequest {
        kind: Some(kind.storage_value().to_string()),
        start_date: Some(start_date.format("%Y-%m-%d").to_string()),
        end_date: Some(end_date.format("%Y-%m-%d").to_string()),
        description: Some(kind.name().to_string()),
        confidence: Some(0.9),
    })
}

fn normalize_time_off_text(raw_text: &str) -> (String, Vec<String>) {
    let normalized = raw_text
        .to_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();
    let tokens = normalized
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();

    (
        format!(
            " {} ",
            normalized.split_whitespace().collect::<Vec<_>>().join(" ")
        ),
        tokens,
    )
}

fn has_time_off_intent(normalized: &str, tokens: &[String]) -> bool {
    let has_explicit_time_off = tokens
        .iter()
        .any(|token| matches!(token.as_str(), "ooo" | "pto" | "vacation"))
        || normalized.contains(" out of office ");

    has_explicit_time_off
        || normalized.contains(" public holiday ")
        || normalized.contains(" on holiday ")
        || (has_holiday_intent(tokens) && has_holiday_date_context(tokens))
}

fn has_holiday_intent(tokens: &[String]) -> bool {
    tokens
        .iter()
        .any(|token| matches!(token.as_str(), "holiday" | "holidays"))
}

fn has_holiday_date_context(tokens: &[String]) -> bool {
    tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "today"
                | "tomorrow"
                | "week"
                | "monday"
                | "mon"
                | "tuesday"
                | "tue"
                | "tues"
                | "wednesday"
                | "wed"
                | "thursday"
                | "thu"
                | "thur"
                | "thurs"
                | "friday"
                | "fri"
                | "saturday"
                | "sat"
                | "sunday"
                | "sun"
        )
    })
}

fn detect_time_off_date_range(
    raw_text: &str,
    tokens: &[String],
    anchor_date: NaiveDate,
) -> (NaiveDate, NaiveDate) {
    if let Some(date) = detect_explicit_iso_date(raw_text) {
        return (date, date);
    }

    if let Some((index, weekday)) = tokens
        .iter()
        .enumerate()
        .find_map(|(index, token)| weekday_from_token(token).map(|weekday| (index, weekday)))
    {
        let force_next = index > 0 && tokens[index - 1] == "next";
        let date = resolve_weekday_date(anchor_date, weekday, force_next);
        return (date, date);
    }

    if contains_token_pair(tokens, "next", "week") {
        return next_workweek_range(anchor_date);
    }

    if contains_token_pair(tokens, "this", "week") {
        return current_workweek_range(anchor_date);
    }

    if tokens.iter().any(|token| token == "tomorrow") {
        let date = anchor_date + Duration::days(1);
        return (date, date);
    }

    if tokens.iter().any(|token| token == "today") {
        return (anchor_date, anchor_date);
    }

    (anchor_date, anchor_date)
}

fn detect_explicit_iso_date(raw_text: &str) -> Option<NaiveDate> {
    raw_text
        .split_whitespace()
        .filter_map(|token| {
            let cleaned =
                token.trim_matches(|value: char| !(value.is_ascii_digit() || value == '-'));
            parse_date(cleaned)
        })
        .next()
}

fn contains_token_pair(tokens: &[String], first: &str, second: &str) -> bool {
    tokens
        .windows(2)
        .any(|window| window[0] == first && window[1] == second)
}

fn weekday_from_token(value: &str) -> Option<Weekday> {
    match value {
        "monday" | "mon" => Some(Weekday::Mon),
        "tuesday" | "tue" | "tues" => Some(Weekday::Tue),
        "wednesday" | "wed" => Some(Weekday::Wed),
        "thursday" | "thu" | "thur" | "thurs" => Some(Weekday::Thu),
        "friday" | "fri" => Some(Weekday::Fri),
        "saturday" | "sat" => Some(Weekday::Sat),
        "sunday" | "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

fn resolve_weekday_date(
    anchor_date: NaiveDate,
    target_weekday: Weekday,
    force_next: bool,
) -> NaiveDate {
    let anchor_offset = anchor_date.weekday().num_days_from_monday() as i64;
    let target_offset = target_weekday.num_days_from_monday() as i64;
    let mut days_until = target_offset - anchor_offset;

    if force_next {
        if days_until <= 0 {
            days_until += 7;
        }
    } else if days_until < 0 {
        days_until += 7;
    }

    anchor_date + Duration::days(days_until)
}

fn current_workweek_range(anchor_date: NaiveDate) -> (NaiveDate, NaiveDate) {
    let current_monday =
        anchor_date - Duration::days(anchor_date.weekday().num_days_from_monday() as i64);
    (current_monday, current_monday + Duration::days(4))
}

fn next_workweek_range(anchor_date: NaiveDate) -> (NaiveDate, NaiveDate) {
    let (current_monday, _) = current_workweek_range(anchor_date);
    let next_monday = current_monday + Duration::days(7);
    (next_monday, next_monday + Duration::days(4))
}

fn resolve_time_off_request(request: &LlmTimeOffRequest) -> Option<ResolvedTimeOffRequest> {
    let kind = parse_time_off_kind(request.kind.as_deref())?;
    let start_date = request
        .start_date
        .as_deref()
        .and_then(parse_date)
        .or_else(|| request.end_date.as_deref().and_then(parse_date))?;
    let end_date = request
        .end_date
        .as_deref()
        .and_then(parse_date)
        .unwrap_or(start_date);
    let (start_date, end_date) = if end_date < start_date {
        (end_date, start_date)
    } else {
        (start_date, end_date)
    };
    let description = request
        .description
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| kind.name().to_string());

    Some(ResolvedTimeOffRequest {
        kind,
        start_date,
        end_date,
        description,
        confidence: normalize_confidence(request.confidence),
    })
}

fn parse_time_off_kind(value: Option<&str>) -> Option<TimeOffKind> {
    let normalized = value?.trim().to_lowercase();
    if normalized.contains("holiday") {
        return Some(TimeOffKind::PublicHoliday);
    }

    if ["vacation", "ooo", "out_of_office", "out of office", "pto"]
        .iter()
        .any(|candidate| normalized == *candidate)
    {
        return Some(TimeOffKind::Vacation);
    }

    None
}

fn prepare_time_off_entries(
    requests: &[ResolvedTimeOffRequest],
    raw_text: &str,
    code_context: &CodeContext,
) -> (Vec<PreparedEntry>, Vec<String>, Vec<Value>) {
    let mut prepared_entries = Vec::new();
    let mut notes = Vec::new();
    let mut details = Vec::new();

    for request in requests {
        let Some((engagement_ref, activity_ref)) =
            resolve_time_off_code_refs(request.kind, code_context)
        else {
            notes.push(format!(
                "Time off request could not find active {} standard code.",
                request.kind.name()
            ));
            details.push(json!({
              "timeOff": true,
              "kind": request.kind.storage_value(),
              "startDate": request.start_date.format("%Y-%m-%d").to_string(),
              "endDate": request.end_date.format("%Y-%m-%d").to_string(),
              "savedEntryCount": 0,
              "reason": "missing_standard_code",
            }));
            continue;
        };

        let mut saved_entry_count = 0;
        let mut skipped_weekend_count = 0;
        let mut date = request.start_date;
        while date <= request.end_date {
            if is_business_day(date) {
                prepared_entries.push(PreparedEntry {
                    entry: NormalizedEntry {
                        date: date.format("%Y-%m-%d").to_string(),
                        start_minute: DEFAULT_TIME_OFF_START_MINUTE,
                        end_minute: DEFAULT_TIME_OFF_END_MINUTE,
                        duration_minutes: DEFAULT_TIME_OFF_END_MINUTE
                            - DEFAULT_TIME_OFF_START_MINUTE,
                        description: request.description.clone(),
                        user_submission_text: raw_text.to_string(),
                        confidence: request.confidence,
                        engagement_ref: Some(engagement_ref.clone()),
                        activity_ref: Some(activity_ref.clone()),
                    },
                    used_activity_fallback: false,
                    used_temporal_fallback: false,
                    duration_defaulted: false,
                    fallback_summary: Some("Time off request applied".to_string()),
                });
                saved_entry_count += 1;
            } else {
                skipped_weekend_count += 1;
            }

            date += Duration::days(1);
        }

        if saved_entry_count == 0 {
            notes.push(format!(
                "Time off request for {} had no business days.",
                request.kind.name()
            ));
        }

        details.push(json!({
          "timeOff": true,
          "kind": request.kind.storage_value(),
          "startDate": request.start_date.format("%Y-%m-%d").to_string(),
          "endDate": request.end_date.format("%Y-%m-%d").to_string(),
          "windowStartMinute": DEFAULT_TIME_OFF_START_MINUTE,
          "windowEndMinute": DEFAULT_TIME_OFF_END_MINUTE,
          "savedEntryCount": saved_entry_count,
          "skippedWeekendCount": skipped_weekend_count,
          "engagementRef": engagement_ref,
          "activityRef": activity_ref,
        }));
    }

    (prepared_entries, notes, details)
}

fn apply_time_off_entry_cap(
    prepared_entries: &mut Vec<PreparedEntry>,
    normalization_notes: &mut Vec<String>,
    normalization_details: &mut Vec<Value>,
) {
    if prepared_entries.len() <= MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE {
        return;
    }

    let dropped_count = prepared_entries.len() - MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE;
    prepared_entries.truncate(MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE);
    normalization_notes.push(format!(
        "Time off request produced too many entries; kept the first {} and dropped {}.",
        MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE, dropped_count
    ));
    normalization_details.push(json!({
      "timeOff": true,
      "savedEntryCap": MAX_TIME_OFF_SAVED_ENTRIES_PER_MESSAGE,
      "droppedEntryCount": dropped_count,
    }));
}

fn resolve_time_off_code_refs(
    kind: TimeOffKind,
    code_context: &CodeContext,
) -> Option<(String, String)> {
    let code = kind.code();
    let name = kind.name();
    let engagement = code_context.engagements.iter().find(|engagement| {
        text_matches_code_or_name(engagement.code.as_deref(), &engagement.name, code, name)
    })?;
    let activity = engagement.activities.iter().find(|activity| {
        text_matches_code_or_name(activity.code.as_deref(), &activity.name, code, name)
    })?;

    Some((
        engagement.engagement_ref.clone(),
        activity.activity_ref.clone(),
    ))
}

fn text_matches_code_or_name(
    candidate_code: Option<&str>,
    candidate_name: &str,
    expected_code: &str,
    expected_name: &str,
) -> bool {
    candidate_code.is_some_and(|code| code.trim().eq_ignore_ascii_case(expected_code))
        || candidate_name.trim().eq_ignore_ascii_case(expected_name)
}

fn is_business_day(date: NaiveDate) -> bool {
    !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

fn prepare_gap_fill_entries(
    request: &ResolvedGapFillRequest,
    existing_entries: &[TimelineEntry],
    raw_text: &str,
    code_context: &CodeContext,
) -> (Vec<PreparedEntry>, Vec<String>, Vec<Value>) {
    let free_intervals = compute_gap_fill_free_intervals(request.window, existing_entries);
    let total_free_minutes = total_interval_minutes(&free_intervals);
    let mut notes = Vec::new();
    let mut details = Vec::new();

    if total_free_minutes <= 0 {
        notes.push(format!(
            "No available gaps between {} and {}.",
            minute_to_hhmm(request.window.start_minute),
            minute_to_hhmm(request.window.end_minute)
        ));
        details.push(json!({
          "gapFill": true,
          "savedEntryCount": 0,
          "savedDate": request.date,
          "windowStartMinute": request.window.start_minute,
          "windowEndMinute": request.window.end_minute,
          "freeIntervals": free_intervals,
          "reason": "no_available_gaps",
        }));
        return (Vec::new(), notes, details);
    }

    let allocations = distribute_gap_fill_minutes(total_free_minutes, request.activities.len());
    let spans = place_gap_fill_spans(&free_intervals, &allocations);
    if spans.is_empty() {
        notes.push(format!(
            "No available 15-minute gaps between {} and {}.",
            minute_to_hhmm(request.window.start_minute),
            minute_to_hhmm(request.window.end_minute)
        ));
        details.push(json!({
          "gapFill": true,
          "savedEntryCount": 0,
          "savedDate": request.date,
          "windowStartMinute": request.window.start_minute,
          "windowEndMinute": request.window.end_minute,
          "freeIntervals": free_intervals,
          "allocations": allocations,
          "reason": "no_usable_snapped_gaps",
        }));
        return (Vec::new(), notes, details);
    }

    let mut prepared_entries = Vec::new();
    for span in spans {
        let Some(activity) = request.activities.get(span.activity_index) else {
            continue;
        };
        let duration_minutes = span.end_minute - span.start_minute;
        if duration_minutes <= 0 {
            continue;
        }

        let mut entry = NormalizedEntry {
            date: request.date.clone(),
            start_minute: span.start_minute,
            end_minute: span.end_minute,
            duration_minutes,
            description: activity.description.clone(),
            user_submission_text: raw_text.to_string(),
            confidence: activity.confidence,
            engagement_ref: activity.engagement_ref.clone(),
            activity_ref: activity.activity_ref.clone(),
        };

        let ref_resolution = reconcile_context_refs(&mut entry, code_context);
        let activity_fallback =
            apply_activity_fallback_if_needed(&mut entry, &activity.matching_text, code_context);
        let global_activity_fallback = apply_global_activity_fallback_if_needed(
            &mut entry,
            &activity.matching_text,
            code_context,
        );
        let prompt_activity_fallback =
            apply_activity_fallback_if_needed(&mut entry, raw_text, code_context);
        let prompt_global_activity_fallback =
            apply_global_activity_fallback_if_needed(&mut entry, raw_text, code_context);

        for note in [
            activity_fallback.note.clone(),
            global_activity_fallback.note.clone(),
            prompt_activity_fallback.note.clone(),
            prompt_global_activity_fallback.note.clone(),
        ]
        .into_iter()
        .flatten()
        {
            notes.push(note);
        }

        if ref_resolution.applied {
            notes.push(format!(
                "Reference resolution applied ({})",
                ref_resolution.reason
            ));
        }

        let used_activity_fallback = activity_fallback.applied
            || global_activity_fallback.applied
            || prompt_activity_fallback.applied
            || prompt_global_activity_fallback.applied;
        let fallback_summary = Some(if used_activity_fallback {
            "Gap fill allocation + activity fallback applied".to_string()
        } else {
            "Gap fill allocation applied".to_string()
        });

        details.push(json!({
          "gapFill": true,
          "activityIndex": span.activity_index + 1,
          "activityLabel": activity.label,
          "activityDescription": activity.description,
          "savedDate": entry.date,
          "savedStartMinute": entry.start_minute,
          "savedEndMinute": entry.end_minute,
          "durationMinutes": entry.duration_minutes,
          "durationDefaulted": true,
          "llmChosenActivityRef": activity.activity_ref,
          "llmActivityReason": activity.activity_reason,
          "llmAlternativeActivities": activity.alternative_activities,
          "originalEngagementRef": ref_resolution.original_engagement_ref,
          "originalActivityRef": ref_resolution.original_activity_ref,
          "savedEngagementRef": entry.engagement_ref,
          "savedActivityRef": entry.activity_ref,
          "savedConfidence": entry.confidence,
          "refResolutionApplied": ref_resolution.applied,
          "refResolutionReason": ref_resolution.reason,
          "resolvedEngagementRef": ref_resolution.resolved_engagement_ref,
          "resolvedActivityRef": ref_resolution.resolved_activity_ref,
          "usedActivityFallback": used_activity_fallback,
          "activityFallbackReason": activity_fallback.reason,
          "globalActivityFallbackReason": global_activity_fallback.reason,
          "promptActivityFallbackReason": prompt_activity_fallback.reason,
          "promptGlobalActivityFallbackReason": prompt_global_activity_fallback.reason,
          "fallbackSummary": fallback_summary,
        }));

        prepared_entries.push(PreparedEntry {
            entry,
            used_activity_fallback,
            used_temporal_fallback: false,
            duration_defaulted: true,
            fallback_summary,
        });
    }

    notes.push(format!(
        "Gap fill applied: distributed {} across {} activit{} between {} and {}.",
        format_minutes_as_duration(total_free_minutes),
        request.activities.len(),
        if request.activities.len() == 1 {
            "y"
        } else {
            "ies"
        },
        minute_to_hhmm(request.window.start_minute),
        minute_to_hhmm(request.window.end_minute),
    ));

    (prepared_entries, notes, details)
}

fn compute_gap_fill_free_intervals(
    window: MinuteInterval,
    existing_entries: &[TimelineEntry],
) -> Vec<MinuteInterval> {
    let mut occupied = existing_entries
        .iter()
        .filter_map(|entry| {
            let start_minute = entry.start_minute.max(window.start_minute);
            let end_minute = entry.end_minute.min(window.end_minute);
            (end_minute > start_minute).then_some(MinuteInterval {
                start_minute,
                end_minute,
            })
        })
        .collect::<Vec<_>>();
    occupied.sort_by_key(|interval| (interval.start_minute, interval.end_minute));

    let mut merged = Vec::<MinuteInterval>::new();
    for interval in occupied {
        if let Some(last) = merged.last_mut() {
            if interval.start_minute <= last.end_minute {
                last.end_minute = last.end_minute.max(interval.end_minute);
                continue;
            }
        }
        merged.push(interval);
    }

    let mut free_intervals = Vec::new();
    let mut cursor = window.start_minute;
    for interval in merged {
        if interval.start_minute > cursor {
            if let Some(free_interval) = snap_free_interval(cursor, interval.start_minute) {
                free_intervals.push(free_interval);
            }
        }
        cursor = cursor.max(interval.end_minute);
    }

    if cursor < window.end_minute {
        if let Some(free_interval) = snap_free_interval(cursor, window.end_minute) {
            free_intervals.push(free_interval);
        }
    }

    free_intervals
}

fn snap_free_interval(start_minute: i64, end_minute: i64) -> Option<MinuteInterval> {
    let start_minute = round_up_to_increment(start_minute, TIME_INCREMENT_MINUTES);
    let end_minute = round_down_to_increment(end_minute, TIME_INCREMENT_MINUTES);
    (end_minute > start_minute).then_some(MinuteInterval {
        start_minute,
        end_minute,
    })
}

fn round_up_to_increment(value: i64, increment: i64) -> i64 {
    value.div_euclid(increment) * increment
        + if value.rem_euclid(increment) == 0 {
            0
        } else {
            increment
        }
}

fn round_down_to_increment(value: i64, increment: i64) -> i64 {
    value.div_euclid(increment) * increment
}

fn total_interval_minutes(intervals: &[MinuteInterval]) -> i64 {
    intervals
        .iter()
        .map(|interval| interval.end_minute - interval.start_minute)
        .sum()
}

fn distribute_gap_fill_minutes(total_minutes: i64, activity_count: usize) -> Vec<i64> {
    if activity_count == 0 || total_minutes < TIME_INCREMENT_MINUTES {
        return vec![0; activity_count];
    }

    let total_units = (total_minutes / TIME_INCREMENT_MINUTES).max(0) as usize;
    let base_units = total_units / activity_count;
    let remainder_units = total_units % activity_count;

    (0..activity_count)
        .map(|index| {
            let units = base_units + usize::from(index < remainder_units);
            units as i64 * TIME_INCREMENT_MINUTES
        })
        .collect()
}

fn place_gap_fill_spans(
    free_intervals: &[MinuteInterval],
    allocations: &[i64],
) -> Vec<GapFillSpan> {
    let mut spans = Vec::new();
    let mut interval_index = 0usize;
    let mut cursor = free_intervals
        .first()
        .map(|interval| interval.start_minute)
        .unwrap_or(0);

    for (activity_index, allocation) in allocations.iter().enumerate() {
        let mut remaining = *allocation;
        while remaining > 0 && interval_index < free_intervals.len() {
            let interval = free_intervals[interval_index];
            if cursor >= interval.end_minute {
                interval_index += 1;
                if let Some(next_interval) = free_intervals.get(interval_index) {
                    cursor = next_interval.start_minute;
                }
                continue;
            }

            cursor = cursor.max(interval.start_minute);
            let chunk = remaining.min(interval.end_minute - cursor);
            if chunk <= 0 {
                break;
            }

            spans.push(GapFillSpan {
                activity_index,
                start_minute: cursor,
                end_minute: cursor + chunk,
            });
            cursor += chunk;
            remaining -= chunk;
        }
    }

    spans
}

fn format_minutes_as_duration(minutes: i64) -> String {
    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;

    match (hours, remaining_minutes) {
        (0, minutes) => format!("{minutes} minutes"),
        (1, 0) => "1 hour".to_string(),
        (hours, 0) => format!("{hours} hours"),
        (1, minutes) => format!("1 hour {minutes} minutes"),
        (hours, minutes) => format!("{hours} hours {minutes} minutes"),
    }
}

fn apply_multi_event_sequence_adjustments(
    entries: &mut [PreparedEntry],
    contexts: &[SequencingEntryContext],
    raw_text: &str,
) -> Vec<SequencingAdjustment> {
    let mut adjustments = vec![SequencingAdjustment::default(); entries.len()];
    if entries.len() < 2 {
        return adjustments;
    }

    let sequence_segments = split_message_into_sequence_segments(raw_text);
    let can_map_segments_to_entries = sequence_segments.len() == entries.len();

    for index in 1..entries.len() {
        let context = contexts.get(index).cloned().unwrap_or_default();
        let segment = can_map_segments_to_entries
            .then(|| sequence_segments.get(index).cloned())
            .flatten();
        let sequence_relation =
            normalize_sequence_relation(context.llm_sequence_relation.as_deref());
        let has_sequence_cue = sequence_relation.as_deref() == Some("starts_after_previous")
            || segment
                .as_deref()
                .is_some_and(segment_starts_with_sequence_connector);

        if !has_sequence_cue {
            continue;
        }

        if segment
            .as_deref()
            .is_some_and(message_has_explicit_clock_time_cue)
        {
            adjustments[index] = SequencingAdjustment {
                reason: Some("independent_explicit_time"),
                sequence_relation,
                duration_source: normalize_duration_source(context.llm_duration_source.as_deref()),
                segment_text: segment,
                ..SequencingAdjustment::default()
            };
            continue;
        }

        let previous_end = entries[index - 1].entry.end_minute;
        if previous_end >= MINUTES_IN_DAY {
            adjustments[index] = SequencingAdjustment {
                reason: Some("previous_entry_ends_at_day_end"),
                sequence_relation,
                duration_source: normalize_duration_source(context.llm_duration_source.as_deref()),
                segment_text: segment,
                ..SequencingAdjustment::default()
            };
            continue;
        }

        let segment_duration = segment.as_deref().and_then(normalized_duration_from_text);
        let normalized_duration_source =
            normalize_duration_source(context.llm_duration_source.as_deref());
        let (duration_minutes, duration_source) = if let Some(duration) = segment_duration {
            (duration, Some("explicit".to_string()))
        } else if normalized_duration_source.as_deref() == Some("explicit")
            && context.raw_duration.is_some_and(|value| value > 0)
        {
            (
                normalize_duration(
                    context
                        .raw_duration
                        .unwrap_or(DEFAULT_FALLBACK_DURATION_MINUTES),
                ),
                normalized_duration_source,
            )
        } else {
            (
                DEFAULT_FALLBACK_DURATION_MINUTES,
                Some("defaulted".to_string()),
            )
        };

        let original_start = entries[index].entry.start_minute;
        let original_end = entries[index].entry.end_minute;
        let (adjusted_start, adjusted_end, adjusted_duration) =
            normalize_snapped_update_window(previous_end, previous_end + duration_minutes);

        entries[index].entry.start_minute = adjusted_start;
        entries[index].entry.end_minute = adjusted_end;
        entries[index].entry.duration_minutes = adjusted_duration;
        entries[index].duration_defaulted = duration_source.as_deref() == Some("defaulted");
        entries[index].used_temporal_fallback = false;
        entries[index].fallback_summary =
            build_fallback_summary(false, entries[index].used_activity_fallback);

        adjustments[index] = SequencingAdjustment {
            applied: true,
            reason: Some("starts_after_previous"),
            original_start_minute: Some(original_start),
            original_end_minute: Some(original_end),
            adjusted_start_minute: Some(adjusted_start),
            adjusted_end_minute: Some(adjusted_end),
            duration_minutes: Some(adjusted_duration),
            sequence_relation,
            duration_source,
            segment_text: segment,
        };
    }

    adjustments
}

fn normalize_sequence_relation(value: Option<&str>) -> Option<String> {
    let value = normalize_metadata_token(value?);
    match value.as_str() {
        "startsafterprevious"
        | "starts_after_previous"
        | "afterprevious"
        | "followingprevious"
        | "followsprevious" => Some("starts_after_previous".to_string()),
        "independent" | "explicit" | "independenttime" | "independent_time" => {
            Some("independent".to_string())
        }
        _ => None,
    }
}

fn normalize_duration_source(value: Option<&str>) -> Option<String> {
    let value = normalize_metadata_token(value?);
    match value.as_str() {
        "explicit" | "userexplicit" | "user_explicit" => Some("explicit".to_string()),
        "defaulted" | "default" => Some("defaulted".to_string()),
        "inferred" | "estimated" => Some("inferred".to_string()),
        _ => None,
    }
}

fn normalize_metadata_token(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect::<String>()
}

fn split_message_into_sequence_segments(raw_text: &str) -> Vec<String> {
    let connector_spans = sequence_connector_spans(raw_text);
    if connector_spans.is_empty() {
        return vec![raw_text.trim().to_string()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect();
    }

    let mut segments = Vec::new();
    let mut segment_start = 0usize;
    for (connector_start, _) in connector_spans {
        if connector_start > segment_start {
            let segment = raw_text[segment_start..connector_start].trim();
            if !segment.is_empty() {
                segments.push(segment.to_string());
            }
        }
        segment_start = connector_start;
    }

    let final_segment = raw_text[segment_start..].trim();
    if !final_segment.is_empty() {
        segments.push(final_segment.to_string());
    }

    segments
}

fn sequence_connector_spans(raw_text: &str) -> Vec<(usize, usize)> {
    let lower = raw_text.to_ascii_lowercase();
    let connector_patterns = ["following that", "after that", "afterwards", "then", "next"];
    let mut spans = Vec::<(usize, usize)>::new();

    for pattern in connector_patterns {
        for (start, _) in lower.match_indices(pattern) {
            let end = start + pattern.len();
            if has_word_boundary(&lower, start, end) {
                spans.push((start, end));
            }
        }
    }

    spans.sort_by_key(|(start, end)| (*start, *end));
    let mut deduped = Vec::<(usize, usize)>::new();
    let mut last_end = 0usize;
    for span in spans {
        if span.0 >= last_end {
            last_end = span.1;
            deduped.push(span);
        }
    }

    deduped
}

fn has_word_boundary(value: &str, start: usize, end: usize) -> bool {
    let previous_is_word = value[..start]
        .chars()
        .next_back()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let next_is_word = value[end..]
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());

    !previous_is_word && !next_is_word
}

fn segment_starts_with_sequence_connector(segment: &str) -> bool {
    let trimmed = segment.trim_start_matches(|character: char| {
        character.is_whitespace() || matches!(character, '.' | ',' | ';' | ':' | '-')
    });
    sequence_connector_spans(trimmed)
        .first()
        .is_some_and(|(start, _)| *start == 0)
}

fn normalized_duration_from_text(raw_text: &str) -> Option<i64> {
    let normalized = raw_text
        .to_lowercase()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();

    for index in 0..tokens.len().saturating_sub(1) {
        let value = tokens[index];
        let unit = tokens[index + 1];
        if !is_duration_value(value) || !is_duration_unit(unit) {
            continue;
        }

        let Some(amount) = duration_value_to_minutes(value, unit) else {
            continue;
        };

        return Some(normalize_duration(amount));
    }

    None
}

fn duration_value_to_minutes(value: &str, unit: &str) -> Option<i64> {
    let amount = match value {
        "a" | "an" | "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        "ten" => 10,
        "half" => return unit_is_hour(unit).then_some(30),
        "quarter" => return unit_is_hour(unit).then_some(15),
        _ => value.parse::<i64>().ok()?,
    };

    if unit_is_hour(unit) {
        Some(amount * 60)
    } else if unit_is_minute(unit) {
        Some(amount)
    } else {
        None
    }
}

fn unit_is_hour(value: &str) -> bool {
    matches!(value, "h" | "hr" | "hrs" | "hour" | "hours")
}

fn unit_is_minute(value: &str) -> bool {
    matches!(value, "m" | "min" | "mins" | "minute" | "minutes")
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

fn session_cache_key_status(
    storage_health: StorageHealth,
    last_error: Option<String>,
) -> KeyStatus {
    let key_source = KeySource::SessionCache;
    let has_open_ai_key = true;
    KeyStatus {
        has_open_ai_key,
        storage_health,
        key_source: key_source.clone(),
        status_level: derive_key_status_level(has_open_ai_key, &key_source),
        last_error,
    }
}

fn no_openai_key_status(storage_health: StorageHealth, last_error: Option<String>) -> KeyStatus {
    let key_source = KeySource::None;
    let has_open_ai_key = false;
    KeyStatus {
        has_open_ai_key,
        storage_health,
        key_source: key_source.clone(),
        status_level: derive_key_status_level(has_open_ai_key, &key_source),
        last_error,
    }
}

fn read_key_status(state: &State<'_, AppState>, open_ai_key_configured: bool) -> KeyStatus {
    if !open_ai_key_configured {
        return if cached_api_key(state).is_some() {
            session_cache_key_status(
                StorageHealth::Ok,
                Some("Using in-memory session key for this app session".to_string()),
            )
        } else {
            no_openai_key_status(StorageHealth::Ok, None)
        };
    }

    let entry = match keyring_entry() {
        Ok(value) => value,
        Err(error) => {
            if let Some(_cached_key) = cached_api_key(state) {
                return session_cache_key_status(
                    StorageHealth::Unavailable,
                    Some(
                        "Keyring unavailable; using in-memory session key for this app session"
                            .to_string(),
                    ),
                );
            }

            return no_openai_key_status(StorageHealth::Unavailable, Some(error.to_string()));
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
                session_cache_key_status(
                    StorageHealth::ReadError,
                    Some(
                        "Keyring returned no entry; using in-memory session key for this app session"
                            .to_string(),
                    ),
                )
            } else {
                no_openai_key_status(StorageHealth::Ok, None)
            }
        }
        Err(error) => {
            if let Some(_cached_key) = cached_api_key(state) {
                session_cache_key_status(
                    StorageHealth::ReadError,
                    Some(format!(
                        "OpenAI API key could not be read from keyring ({error}); using in-memory session key for this app session"
                    )),
                )
            } else {
                no_openai_key_status(
                    StorageHealth::ReadError,
                    Some(format!("OpenAI API key could not be read: {error}")),
                )
            }
        }
    }
}

fn get_openai_api_key(state: &State<'_, AppState>) -> AppResult<String> {
    if let Some(cached_key) = cached_api_key(state) {
        return Ok(cached_key);
    }

    let open_ai_key_configured_marker = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| AppError::Config(state_lock_error()))?;
        read_saved_openai_key_configured_marker(&connection)?
    };

    if matches!(open_ai_key_configured_marker, Some(false)) {
        return Err(AppError::Config(
            "OpenAI API key is not configured".to_string(),
        ));
    }

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

            if open_ai_key_configured_marker.is_none() {
                let connection = state
                    .connection
                    .lock()
                    .map_err(|_| AppError::Config(state_lock_error()))?;
                write_openai_key_configured(&connection, false)?;
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
        if open_ai_key_configured_marker.is_none() {
            let connection = state
                .connection
                .lock()
                .map_err(|_| AppError::Config(state_lock_error()))?;
            write_openai_key_configured(&connection, false)?;
        }

        return Err(AppError::Config(
            "OpenAI API key is configured but empty".to_string(),
        ));
    }

    if open_ai_key_configured_marker.is_none() {
        let connection = state
            .connection
            .lock()
            .map_err(|_| AppError::Config(state_lock_error()))?;
        write_openai_key_configured(&connection, true)?;
    }

    if let Ok(mut cache) = state.api_key_cache.lock() {
        *cache = Some(api_key.trim().to_string());
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

    let (
        open_ai_key_configured_marker,
        selected_open_ai_model,
        invalid_saved_model,
        selected_calendar_bulk_model,
        invalid_saved_calendar_bulk_model,
        selected_transcription_model,
        invalid_saved_transcription_model,
        timeline_preferences,
        calendar_bulk_ignored_keywords,
        calendar_bulk_ignore_all_day_events,
        quick_add_preferences,
        show_diagnostics_tab,
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

        let open_ai_key_configured_marker = match read_saved_openai_key_configured_marker(
            &connection,
        ) {
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
                    json!({ "stage": "read_openai_key_configured_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

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

        let (selected_calendar_bulk_model, invalid_saved_calendar_bulk_model) =
            match read_saved_calendar_bulk_model(&connection) {
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
                        json!({ "stage": "read_calendar_bulk_model_setting", "message": message }),
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

        let timeline_preferences = match read_saved_timeline_preferences(&connection) {
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
                    json!({ "stage": "read_timeline_preferences_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        let (calendar_bulk_ignored_keywords, calendar_bulk_ignore_all_day_events) =
            match read_saved_calendar_bulk_preferences(&connection) {
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
                        json!({ "stage": "read_calendar_bulk_preferences_setting", "message": message }),
                    );
                    return Err(format_command_error(&correlation_id, message));
                }
            };

        let quick_add_preferences = match read_saved_quick_add_preferences(&connection) {
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
                    json!({ "stage": "read_quick_add_preferences_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        let show_diagnostics_tab = match read_saved_show_diagnostics_tab(&connection) {
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
                    json!({ "stage": "read_interface_preferences_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        (
            open_ai_key_configured_marker,
            selected_open_ai_model,
            invalid_saved_model,
            selected_calendar_bulk_model,
            invalid_saved_calendar_bulk_model,
            selected_transcription_model,
            invalid_saved_transcription_model,
            timeline_preferences,
            calendar_bulk_ignored_keywords,
            calendar_bulk_ignore_all_day_events,
            quick_add_preferences,
            show_diagnostics_tab,
        )
    };

    let should_read_keyring = open_ai_key_configured_marker.unwrap_or(true);
    let key_status = read_key_status(&state, should_read_keyring);
    let open_ai_key_configured = open_ai_key_configured_marker.unwrap_or(
        key_status.has_open_ai_key && matches!(key_status.key_source, KeySource::Keyring),
    );

    if open_ai_key_configured_marker.is_none() {
        let marker_result = (|| -> AppResult<()> {
            let connection = state
                .connection
                .lock()
                .map_err(|_| AppError::Config(state_lock_error()))?;
            write_openai_key_configured(&connection, open_ai_key_configured)
        })();

        if let Err(error) = marker_result {
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_warning",
                command,
                "warning",
                Some(duration_ms(started_at)),
                None,
                json!({
                  "stage": "migrate_openai_key_configured_setting",
                  "message": error.to_string(),
                }),
            );
        }
    }

    if let Some(invalid_value) = invalid_saved_model.as_deref() {
        record_invalid_saved_openai_model(&state, &correlation_id, command, invalid_value);
    }

    if let Some(invalid_value) = invalid_saved_calendar_bulk_model.as_deref() {
        record_invalid_saved_calendar_bulk_model(&state, &correlation_id, command, invalid_value);
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
        selected_calendar_bulk_model,
        selected_transcription_model,
        available_transcription_models: transcription_model_options(),
        timeline_exclude_uncategorized_from_daily_totals: timeline_preferences
            .exclude_uncategorized_from_totals,
        timeline_show_uncategorized_daily_total: timeline_preferences.show_uncategorized_total,
        timeline_include_external_in_totals: timeline_preferences.include_external_in_totals,
        timeline_include_internal_in_totals: timeline_preferences.include_internal_in_totals,
        timeline_separate_engagement_type_totals: timeline_preferences
            .separate_engagement_type_totals,
        timeline_week_start_day: timeline_preferences.week_start_day,
        calendar_bulk_ignored_keywords,
        calendar_bulk_ignore_all_day_events,
        quick_add_preferences,
        show_diagnostics_tab,
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
          "openAiKeyConfiguredFlag": open_ai_key_configured,
          "statusLevel": status_level_label(&status.status_level),
          "lastError": status.last_error,
          "selectedOpenAiModel": status.selected_open_ai_model.storage_value(),
          "selectedOpenAiApiModel": status.selected_open_ai_model.api_name(),
          "selectedOpenAiModelLabel": status.selected_open_ai_model.display_label(),
          "availableOpenAiModelCount": status.available_open_ai_models.len(),
          "selectedCalendarBulkModel": status.selected_calendar_bulk_model.storage_value(),
          "selectedCalendarBulkApiModel": status.selected_calendar_bulk_model.api_name(),
          "selectedCalendarBulkModelLabel": status.selected_calendar_bulk_model.display_label(),
          "selectedTranscriptionModel": status.selected_transcription_model.api_name(),
          "selectedTranscriptionModelLabel": status.selected_transcription_model.display_label(),
          "availableTranscriptionModelCount": status.available_transcription_models.len(),
          "timelineExcludeUncategorizedFromDailyTotals": status.timeline_exclude_uncategorized_from_daily_totals,
          "timelineShowUncategorizedDailyTotal": status.timeline_show_uncategorized_daily_total,
          "timelineIncludeExternalInTotals": status.timeline_include_external_in_totals,
          "timelineIncludeInternalInTotals": status.timeline_include_internal_in_totals,
          "timelineSeparateEngagementTypeTotals": status.timeline_separate_engagement_type_totals,
          "timelineWeekStartDay": status.timeline_week_start_day.setting_value(),
          "calendarBulkIgnoredKeywords": status.calendar_bulk_ignored_keywords,
          "calendarBulkIgnoreAllDayEvents": status.calendar_bulk_ignore_all_day_events,
          "quickAddHiddenEngagementCount": status.quick_add_preferences.hidden_engagement_ids.len(),
          "quickAddHiddenActivityCount": status.quick_add_preferences.hidden_activity_ids.len(),
          "showDiagnosticsTab": status.show_diagnostics_tab,
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

            if let Err(error) = (|| -> AppResult<()> {
                let connection = state
                    .connection
                    .lock()
                    .map_err(|_| AppError::Config(state_lock_error()))?;
                write_openai_key_configured(&connection, true)?;
                Ok(())
            })() {
                let message = error.to_string();
                record_backend_event_with_state(
                    &state,
                    &correlation_id,
                    "command_error",
                    command,
                    "error",
                    Some(duration_ms(started_at)),
                    None,
                    json!({ "stage": "save_openai_key_configured_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
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
            selected_model.storage_value(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_OPENAI_MODEL)
            .map_err(|error| error.to_string())?;

        if verified.as_deref() != Some(selected_model.storage_value()) {
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
                  "selectedOpenAiModel": selected_model.storage_value(),
                  "selectedOpenAiApiModel": selected_model.api_name(),
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
                  "selectedOpenAiModel": selected_model.storage_value(),
                  "selectedOpenAiApiModel": selected_model.api_name(),
                  "selectedOpenAiModelLabel": selected_model.display_label(),
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn settings_set_calendar_bulk_model(
    state: State<'_, AppState>,
    input: SettingsSetCalendarBulkModelInput,
) -> Result<(), String> {
    let command = "settings_set_calendar_bulk_model";
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
            APP_SETTING_CALENDAR_BULK_OPENAI_MODEL,
            selected_model.storage_value(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_CALENDAR_BULK_OPENAI_MODEL)
            .map_err(|error| error.to_string())?;

        if verified.as_deref() != Some(selected_model.storage_value()) {
            return Err("Calendar bulk add model setting verification failed".to_string());
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
                  "selectedCalendarBulkModel": selected_model.storage_value(),
                  "selectedCalendarBulkApiModel": selected_model.api_name(),
                  "selectedCalendarBulkModelLabel": selected_model.display_label(),
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
                  "stage": "save_calendar_bulk_model_setting",
                  "message": message,
                  "selectedCalendarBulkModel": selected_model.storage_value(),
                  "selectedCalendarBulkApiModel": selected_model.api_name(),
                  "selectedCalendarBulkModelLabel": selected_model.display_label(),
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
pub fn settings_set_timeline_preferences(
    state: State<'_, AppState>,
    input: SettingsSetTimelinePreferencesInput,
) -> Result<(), String> {
    let command = "settings_set_timeline_preferences";
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

    let preferences = TimelinePreferenceValues {
        exclude_uncategorized_from_totals: input.timeline_exclude_uncategorized_from_daily_totals,
        show_uncategorized_total: input.timeline_show_uncategorized_daily_total,
        include_external_in_totals: input.timeline_include_external_in_totals,
        include_internal_in_totals: input.timeline_include_internal_in_totals,
        separate_engagement_type_totals: input.timeline_separate_engagement_type_totals,
        week_start_day: input.timeline_week_start_day,
    };

    if let Err(message) = validate_timeline_preferences(preferences) {
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
              "stage": "validate_timeline_preferences",
              "message": message,
              "timelineIncludeExternalInTotals": preferences.include_external_in_totals,
              "timelineIncludeInternalInTotals": preferences.include_internal_in_totals,
            }),
        );
        return Err(format_command_error(&correlation_id, message));
    }

    let save_result: Result<(), String> = (|| {
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_EXCLUDE_UNCATEGORIZED_FROM_DAILY_TOTALS,
            bool_app_setting_value(preferences.exclude_uncategorized_from_totals),
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_SHOW_UNCATEGORIZED_DAILY_TOTAL,
            bool_app_setting_value(preferences.show_uncategorized_total),
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_INCLUDE_EXTERNAL_IN_TOTALS,
            bool_app_setting_value(preferences.include_external_in_totals),
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_INCLUDE_INTERNAL_IN_TOTALS,
            bool_app_setting_value(preferences.include_internal_in_totals),
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_SEPARATE_ENGAGEMENT_TYPE_TOTALS,
            bool_app_setting_value(preferences.separate_engagement_type_totals),
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_TIMELINE_WEEK_START_DAY,
            preferences.week_start_day.setting_value(),
        )
        .map_err(|error| error.to_string())?;

        let verified =
            read_saved_timeline_preferences(&connection).map_err(|error| error.to_string())?;
        if verified != preferences {
            return Err("Timeline preferences verification failed".to_string());
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
                  "timelineExcludeUncategorizedFromDailyTotals": preferences.exclude_uncategorized_from_totals,
                  "timelineShowUncategorizedDailyTotal": preferences.show_uncategorized_total,
                  "timelineIncludeExternalInTotals": preferences.include_external_in_totals,
                  "timelineIncludeInternalInTotals": preferences.include_internal_in_totals,
                  "timelineSeparateEngagementTypeTotals": preferences.separate_engagement_type_totals,
                  "timelineWeekStartDay": preferences.week_start_day.setting_value(),
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
                  "stage": "save_timeline_preferences_setting",
                  "message": message,
                  "timelineExcludeUncategorizedFromDailyTotals": preferences.exclude_uncategorized_from_totals,
                  "timelineShowUncategorizedDailyTotal": preferences.show_uncategorized_total,
                  "timelineIncludeExternalInTotals": preferences.include_external_in_totals,
                  "timelineIncludeInternalInTotals": preferences.include_internal_in_totals,
                  "timelineSeparateEngagementTypeTotals": preferences.separate_engagement_type_totals,
                  "timelineWeekStartDay": preferences.week_start_day.setting_value(),
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn settings_set_calendar_bulk_preferences(
    state: State<'_, AppState>,
    input: SettingsSetCalendarBulkPreferencesInput,
) -> Result<(), String> {
    let command = "settings_set_calendar_bulk_preferences";
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

    let ignored_keywords =
        normalize_calendar_bulk_ignored_keywords(&input.calendar_bulk_ignored_keywords);
    let ignore_all_day_events = input.calendar_bulk_ignore_all_day_events;
    let save_result: Result<(), String> = (|| {
        let serialized_keywords =
            serde_json::to_string(&ignored_keywords).map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_CALENDAR_BULK_IGNORED_KEYWORDS,
            &serialized_keywords,
        )
        .map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_CALENDAR_BULK_IGNORE_ALL_DAY_EVENTS,
            bool_app_setting_value(ignore_all_day_events),
        )
        .map_err(|error| error.to_string())?;

        let verified =
            read_saved_calendar_bulk_preferences(&connection).map_err(|error| error.to_string())?;
        if verified != (ignored_keywords.clone(), ignore_all_day_events) {
            return Err("Calendar bulk preferences verification failed".to_string());
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
                  "calendarBulkIgnoredKeywords": ignored_keywords,
                  "calendarBulkIgnoreAllDayEvents": ignore_all_day_events,
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
                  "stage": "save_calendar_bulk_preferences_setting",
                  "message": message,
                  "calendarBulkIgnoreAllDayEvents": ignore_all_day_events,
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn settings_set_quick_add_preferences(
    state: State<'_, AppState>,
    input: SettingsSetQuickAddPreferencesInput,
) -> Result<(), String> {
    let command = "settings_set_quick_add_preferences";
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

    let preferences = normalize_quick_add_preferences(input.quick_add_preferences);
    let save_result: Result<(), String> = (|| {
        let serialized_preferences =
            serde_json::to_string(&preferences).map_err(|error| error.to_string())?;
        db::upsert_app_setting(
            &connection,
            APP_SETTING_QUICK_ADD_PREFERENCES,
            &serialized_preferences,
        )
        .map_err(|error| error.to_string())?;

        let verified =
            read_saved_quick_add_preferences(&connection).map_err(|error| error.to_string())?;
        if verified != preferences {
            return Err("Quick Entry preferences verification failed".to_string());
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
                  "engagementOrderCount": preferences.engagement_order.len(),
                  "hiddenEngagementCount": preferences.hidden_engagement_ids.len(),
                  "activityOrderGroupCount": preferences.activity_order.len(),
                  "hiddenActivityCount": preferences.hidden_activity_ids.len(),
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
                  "stage": "save_quick_add_preferences_setting",
                  "message": message,
                  "engagementOrderCount": preferences.engagement_order.len(),
                  "hiddenEngagementCount": preferences.hidden_engagement_ids.len(),
                  "activityOrderGroupCount": preferences.activity_order.len(),
                  "hiddenActivityCount": preferences.hidden_activity_ids.len(),
                }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn settings_set_interface_preferences(
    state: State<'_, AppState>,
    input: SettingsSetInterfacePreferencesInput,
) -> Result<(), String> {
    let command = "settings_set_interface_preferences";
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

    let show_diagnostics_tab = input.show_diagnostics_tab;
    let save_result: Result<(), String> = (|| {
        db::upsert_app_setting(
            &connection,
            APP_SETTING_SHOW_DIAGNOSTICS_TAB,
            bool_app_setting_value(show_diagnostics_tab),
        )
        .map_err(|error| error.to_string())?;

        let verified =
            read_saved_show_diagnostics_tab(&connection).map_err(|error| error.to_string())?;
        if verified != show_diagnostics_tab {
            return Err("Interface preferences verification failed".to_string());
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
                  "showDiagnosticsTab": show_diagnostics_tab,
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
                  "stage": "save_interface_preferences_setting",
                  "message": message,
                  "showDiagnosticsTab": show_diagnostics_tab,
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
pub fn reporting_state_get(state: State<'_, AppState>) -> Result<ReportingState, String> {
    let command = "reporting_state_get";
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

    match read_reporting_state(&connection) {
        Ok(reporting_state) => {
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
                  "displayPresetCount": reporting_state.display_presets.len(),
                  "selectedDisplayPresetId": reporting_state.selected_display_preset_id,
                  "selectedExportPresetId": reporting_state.selected_export_preset_id,
                }),
            );
            Ok(reporting_state)
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
                json!({ "stage": "read_reporting_state", "message": message }),
            );
            Err(format_command_error(&correlation_id, message))
        }
    }
}

#[tauri::command]
pub fn reporting_state_set(
    state: State<'_, AppState>,
    input: ReportingState,
) -> Result<ReportingState, String> {
    let command = "reporting_state_set";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let normalized_state = normalize_reporting_state(input)
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
            APP_SETTING_REPORTING_STATE,
            serialized_state.as_str(),
        )
        .map_err(|error| error.to_string())?;

        let verified = db::get_app_setting(&connection, APP_SETTING_REPORTING_STATE)
            .map_err(|error| error.to_string())?;
        if verified.as_deref() != Some(serialized_state.as_str()) {
            return Err("Reporting settings save verification failed.".to_string());
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
                  "displayPresetCount": normalized_state.display_presets.len(),
                  "selectedDisplayPresetId": normalized_state.selected_display_preset_id,
                  "selectedExportPresetId": normalized_state.selected_export_preset_id,
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
                  "stage": "save_reporting_state",
                  "message": message,
                  "displayPresetCount": normalized_state.display_presets.len(),
                  "selectedDisplayPresetId": normalized_state.selected_display_preset_id,
                  "selectedExportPresetId": normalized_state.selected_export_preset_id,
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
    let preferences =
        read_saved_timeline_preferences(&connection).map_err(|error| error.to_string())?;
    let (start_date, end_date_exclusive) =
        timeline_week_bounds(&input.date, preferences.week_start_day)?;

    let mut summary =
        db::list_timeline_weekly_summary(&connection, &start_date, &end_date_exclusive)
            .map_err(|error| error.to_string())?;
    apply_timeline_preferences_to_weekly_summary(&mut summary, preferences);

    Ok(summary)
}

#[tauri::command]
pub fn timeline_list_for_week_view(
    state: State<'_, AppState>,
    input: DateInput,
) -> Result<TimelineWeekView, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let preferences =
        read_saved_timeline_preferences(&connection).map_err(|error| error.to_string())?;
    let (start_date, end_date_exclusive) =
        timeline_week_view_bounds(&input.date, preferences.week_start_day)?;
    let week_start = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|_| "date must be in YYYY-MM-DD format".to_string())?;
    let entries =
        db::list_timeline_entries_for_date_range(&connection, &start_date, &end_date_exclusive)
            .map_err(|error| error.to_string())?;
    let days = (0..7)
        .map(|index| TimelineWeekViewDay {
            date: (week_start + Duration::days(index))
                .format("%Y-%m-%d")
                .to_string(),
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
pub fn quick_add_suggestions(
    state: State<'_, AppState>,
    input: QuickAddSuggestionInput,
) -> Result<QuickAddSuggestionResult, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let limit = input.limit.map_or(-1, |value| value.clamp(1, 500));
    let suggestions =
        db::list_quick_add_suggestions(&connection, limit).map_err(|error| error.to_string())?;

    Ok(QuickAddSuggestionResult { suggestions })
}

#[tauri::command]
pub fn summary_export_weekly_excel(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: SummaryExportWeeklyExcelInput,
) -> Result<SummaryExportResult, String> {
    let layout_preset = normalize_summary_layout_preset_for_export(input.layout_preset)?;
    let (summary, engagements) = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        let preferences =
            read_saved_timeline_preferences(&connection).map_err(|error| error.to_string())?;
        let (start_date, end_date_exclusive) =
            timeline_week_bounds(&input.date, preferences.week_start_day)?;
        let mut summary =
            db::list_timeline_weekly_summary(&connection, &start_date, &end_date_exclusive)
                .map_err(|error| error.to_string())?;
        apply_timeline_preferences_to_weekly_summary(&mut summary, preferences);
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

fn normalize_optional_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_manual_create_refs(
    connection: &Connection,
    engagement_id: Option<&str>,
    activity_id: Option<&str>,
) -> Result<(), String> {
    if let Some(activity_id) = activity_id {
        let Some(engagement_id) = engagement_id else {
            return Err("activity requires an engagement".to_string());
        };

        if !db::activity_belongs_to_engagement(connection, engagement_id, activity_id)
            .map_err(|error| error.to_string())?
        {
            return Err("activity must belong to the selected engagement".to_string());
        }

        return Ok(());
    }

    if let Some(engagement_id) = engagement_id {
        if !db::engagement_exists(connection, engagement_id).map_err(|error| error.to_string())? {
            return Err("engagement not found".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
pub fn timeline_create_entry(
    state: State<'_, AppState>,
    input: TimelineCreateInput,
) -> Result<IdResult, String> {
    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    create_manual_timeline_entry(&connection, input)
}

fn create_manual_timeline_entry(
    connection: &Connection,
    input: TimelineCreateInput,
) -> Result<IdResult, String> {
    let date = input.date.trim();
    let (start_minute, end_minute, duration_minutes) =
        validate_manual_update_window(input.start_minute, input.end_minute)?;
    let engagement_id = normalize_optional_id(input.engagement_id.as_deref());
    let activity_id = normalize_optional_id(input.activity_id.as_deref());

    validate_manual_create_refs(connection, engagement_id.as_deref(), activity_id.as_deref())?;

    let id = db::insert_manual_timeline_entry(
        connection,
        date,
        start_minute,
        end_minute,
        duration_minutes,
        input.description.as_deref().unwrap_or(""),
        engagement_id.as_deref(),
        activity_id.as_deref(),
    )
    .map_err(|error| error.to_string())?;

    if engagement_id.is_none() || activity_id.is_none() {
        db::add_warning(
            connection,
            &id,
            WarningType::Unmatched,
            Some("Entry is uncategorized".to_string()),
        )
        .map_err(|error| error.to_string())?;
    }

    let _ = db::recompute_overlap_warnings(connection, date).map_err(|error| error.to_string())?;

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
pub async fn calendar_extract_events(
    state: State<'_, AppState>,
    input: CalendarExtractInput,
) -> Result<CalendarExtractResult, String> {
    let command = "calendar_extract_events";
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
          "timezone": input.timezone,
          "clientTimestampIso": input.client_timestamp_iso,
          "clientLocalDate": input.client_local_date,
          "clientLocalTime": input.client_local_time,
          "selectedDate": input.selected_date.clone(),
          "requestedOpenAiModel": input.open_ai_model.map(|model| model.storage_value()),
          "ignoredKeywordCount": input.ignored_keywords.len(),
          "ignoreAllDayEvents": input.ignore_all_day_events,
        }),
    );

    let image_base64 = normalize_image_base64(&input.image_base64).map_err(|message| {
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "validate_image", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;
    let mime_type = normalize_calendar_image_mime_type(&input.mime_type).map_err(|message| {
        record_backend_event_with_state(
            &state,
            &correlation_id,
            "command_error",
            command,
            "error",
            Some(duration_ms(started_at)),
            None,
            json!({ "stage": "validate_image", "message": message }),
        );
        format_command_error(&correlation_id, message)
    })?;
    let ignored_keywords = normalize_calendar_bulk_ignored_keywords(&input.ignored_keywords);

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

    let (saved_calendar_bulk_model, invalid_saved_calendar_bulk_model, code_context) = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        let (saved_calendar_bulk_model, invalid_saved_calendar_bulk_model) =
            match read_saved_calendar_bulk_model(&connection) {
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
                        json!({ "stage": "read_calendar_bulk_model_setting", "message": message }),
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
                    None,
                    json!({ "stage": "load_code_context", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

        (
            saved_calendar_bulk_model,
            invalid_saved_calendar_bulk_model,
            code_context,
        )
    };

    if let Some(invalid_value) = invalid_saved_calendar_bulk_model.as_deref() {
        record_invalid_saved_calendar_bulk_model(&state, &correlation_id, command, invalid_value);
    }

    let selected_openai_model =
        resolve_requested_openai_model(input.open_ai_model, saved_calendar_bulk_model);
    let llm_started_at = Instant::now();
    let mut llm_attempts = Vec::<openai::LlmAttemptTelemetry>::new();
    let vision_result = openai::extract_calendar_events(
        &state.http_client,
        &api_key,
        selected_openai_model,
        &image_base64,
        &mime_type,
        &input.client_timestamp_iso,
        &input.client_local_date,
        &input.client_local_time,
        input.client_utc_offset_minutes,
        &input.timezone,
        &input.selected_date,
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

    let vision_response = match vision_result {
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
                  "eventCount": response.events.len(),
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
                None,
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

    let selected_date = parse_date(&input.selected_date)
        .or_else(|| parse_date(input.client_local_date.trim()))
        .unwrap_or_else(|| Local::now().date_naive());
    let mut candidates = vision_response
        .events
        .iter()
        .filter_map(|event| {
            build_calendar_extract_candidate(
                event,
                &code_context,
                selected_date,
                &ignored_keywords,
                input.ignore_all_day_events,
            )
        })
        .collect::<Vec<_>>();

    apply_calendar_candidate_overlap_warnings(&mut candidates);
    let ignored_candidate_count = candidates
        .iter()
        .filter(|candidate| candidate.is_ignored)
        .count() as i64;

    record_backend_event_with_state(
        &state,
        &correlation_id,
        "command_success",
        command,
        "ok",
        Some(duration_ms(started_at)),
        None,
        json!({
          "candidateCount": candidates.len(),
          "ignoredCandidateCount": ignored_candidate_count,
          "model": selected_openai_model.api_name(),
          "modelLabel": selected_openai_model.display_label(),
          "llmDurationMs": llm_duration_ms,
        }),
    );

    Ok(CalendarExtractResult {
        correlation_id,
        candidates,
        ignored_candidate_count,
        model_used: selected_openai_model,
        model_used_label: selected_openai_model.display_label().to_string(),
        llm_duration_ms,
    })
}

#[tauri::command]
pub fn calendar_import_entries(
    state: State<'_, AppState>,
    input: CalendarImportInput,
) -> Result<CalendarImportResult, String> {
    let command = "calendar_import_entries";
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
          "entryCount": input.entries.len(),
          "clientTimestampIso": input.client_timestamp_iso,
          "clientLocalDate": input.client_local_date,
          "clientLocalTime": input.client_local_time,
          "timezone": input.timezone,
          "clientUtcOffsetMinutes": input.client_utc_offset_minutes,
        }),
    );

    if input.entries.is_empty() {
        let message = "no calendar entries selected for import";
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

    let prepared_entries = input
        .entries
        .iter()
        .map(validate_calendar_import_entry)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| {
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "command_error",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "stage": "validate_entries", "message": message }),
            );
            format_command_error(&correlation_id, message)
        })?;

    let parsed_timestamp = parse_client_timestamp(&input.client_timestamp_iso);
    let interpreted_entries_json = serde_json::to_string(&prepared_entries)
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;
    let confidence_average = prepared_entries
        .iter()
        .map(|entry| entry.confidence)
        .sum::<f64>()
        / prepared_entries.len() as f64;
    let raw_message_id = Uuid::new_v4().to_string();
    let raw_text = format!("Calendar bulk import ({} events)", prepared_entries.len());

    let connection = state.connection.lock().map_err(|_| state_lock_error())?;
    let (saved_openai_model, invalid_saved_model) =
        match read_saved_calendar_bulk_model(&connection) {
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
                    json!({ "stage": "read_calendar_bulk_model_setting", "message": message }),
                );
                return Err(format_command_error(&correlation_id, message));
            }
        };

    if let Some(invalid_value) = invalid_saved_model.as_deref() {
        record_invalid_saved_calendar_bulk_model(&state, &correlation_id, command, invalid_value);
    }

    connection
        .execute_batch("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let write_result: Result<(Vec<String>, Vec<String>, Vec<Warning>), String> = (|| {
        db::insert_raw_message(
            &connection,
            &raw_message_id,
            &raw_text,
            &interpreted_entries_json,
            saved_openai_model.storage_value(),
            "calendar",
            None,
            None,
            confidence_average,
            parsed_timestamp.timestamp(),
            prepared_entries.len() as i64,
            prepared_entries.len() as i64,
            prepared_entries.len() as i64,
            0,
            prepared_entries.len() > 1,
        )
        .map_err(|error| error.to_string())?;

        let mut created_entry_ids = Vec::<String>::new();
        let mut warnings = Vec::<Warning>::new();
        let mut touched_dates = HashSet::<String>::new();

        for (index, entry) in prepared_entries.iter().enumerate() {
            let normalized_entry = NormalizedEntry {
                date: entry.date.clone(),
                start_minute: entry.start_minute,
                end_minute: entry.end_minute,
                duration_minutes: entry.duration_minutes,
                description: entry.description.clone(),
                user_submission_text: entry.extracted_text.clone(),
                confidence: entry.confidence,
                engagement_ref: None,
                activity_ref: None,
            };
            let entry_id = db::insert_timesheet_entry(
                &connection,
                &raw_message_id,
                &normalized_entry,
                entry.engagement_id.as_deref(),
                entry.activity_id.as_deref(),
                false,
                false,
                false,
                None,
                Some(index as i64 + 1),
                Some(prepared_entries.len() as i64),
                "calendar",
            )
            .map_err(|error| error.to_string())?;

            touched_dates.insert(entry.date.clone());
            created_entry_ids.push(entry_id.clone());

            if entry.confidence < db::LOW_CONFIDENCE_THRESHOLD {
                warnings.push(
                    db::add_warning(
                        &connection,
                        &entry_id,
                        WarningType::LowConfidence,
                        Some(
                            "Calendar extraction confidence is below review threshold".to_string(),
                        ),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }

            if entry.engagement_id.is_none() || entry.activity_id.is_none() {
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

        Ok((created_entry_ids, touched_month_keys, warnings))
    })();

    let (created_entry_ids, touched_month_keys, warnings) = match write_result {
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
                None,
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
        None,
        json!({
          "rawMessageId": raw_message_id,
          "createdEntryCount": created_entry_ids.len(),
          "touchedMonthKeys": touched_month_keys,
          "warningCount": warnings.len(),
          "captureSource": "calendar",
        }),
    );

    Ok(CalendarImportResult {
        correlation_id,
        raw_message_id,
        created_entry_ids,
        touched_month_keys,
        warnings,
    })
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
          "selectedDate": input.selected_date,
          "requestedOpenAiModel": input.open_ai_model.map(|model| model.storage_value()),
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
        input.selected_date.as_deref(),
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

    let mut llm_response = match llm_result {
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
                  "gapFillRequestCount": response.gap_fill_requests.len(),
                  "timeOffRequestCount": response.time_off_requests.len(),
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

    if !llm_response
        .time_off_requests
        .iter()
        .any(|request| resolve_time_off_request(request).is_some())
    {
        if let Some(request) = synthesize_time_off_request_from_text(
            input.raw_text.trim(),
            &input,
            &temporal_reference,
        ) {
            llm_response.time_off_requests.push(request);
        }
    }

    let interpreted_entries_json = serde_json::to_string(&llm_response)
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let resolved_time_off_requests = llm_response
        .time_off_requests
        .iter()
        .filter_map(resolve_time_off_request)
        .collect::<Vec<_>>();

    if !resolved_time_off_requests.is_empty() {
        let mut normalization_notes = Vec::<String>::new();
        if !llm_response.entries.is_empty() {
            normalization_notes.push(
                "Time off request returned with regular entries; ignored regular entries."
                    .to_string(),
            );
        }
        if !llm_response.gap_fill_requests.is_empty() {
            normalization_notes.push(
                "Time off request returned with gap fill requests; ignored gap fill requests."
                    .to_string(),
            );
        }

        let raw_message_id = Uuid::new_v4().to_string();
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;

        connection
            .execute_batch("BEGIN IMMEDIATE TRANSACTION")
            .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

        let write_result: Result<
            (
                InterpretWriteOutcome,
                i64,
                i64,
                i64,
                bool,
                Vec<String>,
                Vec<Value>,
            ),
            String,
        > = (|| {
            let (prepared_entries, time_off_notes, mut normalization_details) =
                prepare_time_off_entries(
                    &resolved_time_off_requests,
                    input.raw_text.trim(),
                    &code_context,
                );
            normalization_notes.extend(time_off_notes);

            let mut prepared_entries = dedupe_prepared_entries(prepared_entries);
            let unique_entry_count = prepared_entries.len() as i64;

            apply_time_off_entry_cap(
                &mut prepared_entries,
                &mut normalization_notes,
                &mut normalization_details,
            );

            let saved_entry_count = prepared_entries.len() as i64;
            let truncated_entry_count = (unique_entry_count - saved_entry_count).max(0);
            let contains_multiple_events = unique_entry_count > 1;
            let confidence_average = if prepared_entries.is_empty() {
                0.5
            } else {
                prepared_entries
                    .iter()
                    .map(|prepared| prepared.entry.confidence)
                    .sum::<f64>()
                    / prepared_entries.len() as f64
            };

            let metadata = InterpretWriteMetadata {
                raw_message_id: &raw_message_id,
                raw_text: input.raw_text.trim(),
                interpreted_entries_json: &interpreted_entries_json,
                selected_openai_model,
                capture_source: input.capture_source.unwrap_or(CaptureSourceId::Text),
                transcription_model: input.transcription_model,
                transcription_duration_ms: input.transcription_duration_ms,
                confidence_average,
                raw_message_timestamp: parsed_timestamp.timestamp(),
                interpreted_entry_count: unique_entry_count,
                unique_entry_count,
                saved_entry_count,
                truncated_entry_count,
                contains_multiple_events,
            };
            let outcome = write_interpreted_prepared_entries(
                &connection,
                metadata,
                prepared_entries,
                &code_context,
            )?;

            Ok((
                outcome,
                unique_entry_count,
                saved_entry_count,
                truncated_entry_count,
                contains_multiple_events,
                normalization_notes,
                normalization_details,
            ))
        })();

        let (
            write_outcome,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            contains_multiple_events,
            normalization_notes,
            normalization_details,
        ) = match write_result {
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
              "createdEntryCount": write_outcome.created_entry_ids.len(),
              "interpretedEntryCount": unique_entry_count,
              "uniqueEntryCount": unique_entry_count,
              "savedEntryCount": saved_entry_count,
              "truncatedEntryCount": truncated_entry_count,
              "containsMultipleEvents": contains_multiple_events,
              "touchedMonthKeys": write_outcome.touched_month_keys.clone(),
              "warningCount": write_outcome.warnings.len(),
              "normalizationFallbackCount": 0,
              "normalizationNotes": normalization_notes.clone(),
              "normalizationDetails": normalization_details.clone(),
              "model": selected_openai_model.api_name(),
              "modelLabel": selected_openai_model.display_label(),
              "captureSource": capture_source_label(input.capture_source.unwrap_or(CaptureSourceId::Text)),
              "transcriptionModel": input.transcription_model.map(|model| model.api_name()),
              "transcriptionDurationMs": input.transcription_duration_ms,
              "llmDurationMs": llm_duration_ms,
              "timeOff": true,
              "timeOffRequestCount": resolved_time_off_requests.len(),
            }),
        );

        return Ok(InterpretResult {
            correlation_id,
            raw_message_id,
            created_entry_ids: write_outcome.created_entry_ids,
            interpreted_entry_count: unique_entry_count,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            contains_multiple_events,
            touched_month_keys: write_outcome.touched_month_keys,
            warnings: write_outcome.warnings,
            normalization_notes,
            model_used: selected_openai_model,
            model_used_label: selected_openai_model.display_label().to_string(),
            llm_duration_ms,
        });
    }

    if let Some(gap_fill_request) = llm_response.gap_fill_requests.iter().find_map(|request| {
        resolve_gap_fill_request(request, &input, &temporal_reference, input.raw_text.trim())
    }) {
        let mut normalization_notes = Vec::<String>::new();
        if !llm_response.entries.is_empty() {
            normalization_notes.push(
                "Gap fill request returned with regular entries; ignored regular entries."
                    .to_string(),
            );
        }

        let raw_message_id = Uuid::new_v4().to_string();
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;

        connection
            .execute_batch("BEGIN IMMEDIATE TRANSACTION")
            .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

        let write_result: Result<
            (
                InterpretWriteOutcome,
                i64,
                i64,
                i64,
                bool,
                usize,
                Vec<String>,
                Vec<Value>,
            ),
            String,
        > = (|| {
            let existing_entries = db::list_timeline_entries(&connection, &gap_fill_request.date)
                .map_err(|error| error.to_string())?;
            let (prepared_entries, gap_notes, mut normalization_details) = prepare_gap_fill_entries(
                &gap_fill_request,
                &existing_entries,
                input.raw_text.trim(),
                &code_context,
            );
            normalization_notes.extend(gap_notes);

            let mut prepared_entries = dedupe_prepared_entries(prepared_entries);
            let unique_entry_count = prepared_entries.len() as i64;

            if prepared_entries.len() > MAX_GAP_FILL_SAVED_ENTRIES_PER_MESSAGE {
                let dropped_count = prepared_entries.len() - MAX_GAP_FILL_SAVED_ENTRIES_PER_MESSAGE;
                prepared_entries.truncate(MAX_GAP_FILL_SAVED_ENTRIES_PER_MESSAGE);
                normalization_notes.push(format!(
                    "Gap fill produced too many entries; kept the first {} and dropped {}.",
                    MAX_GAP_FILL_SAVED_ENTRIES_PER_MESSAGE, dropped_count
                ));
            }

            let saved_entry_count = prepared_entries.len() as i64;
            let truncated_entry_count = (unique_entry_count - saved_entry_count).max(0);
            let contains_multiple_events = unique_entry_count > 1;
            let fallback_count = prepared_entries
                .iter()
                .filter(|entry| entry.used_temporal_fallback)
                .count();
            let confidence_average = if prepared_entries.is_empty() {
                0.5
            } else {
                prepared_entries
                    .iter()
                    .map(|prepared| prepared.entry.confidence)
                    .sum::<f64>()
                    / prepared_entries.len() as f64
            };

            normalization_details.push(json!({
              "gapFill": true,
              "selectedDate": input.selected_date.clone(),
              "savedDate": gap_fill_request.date.clone(),
              "windowStartMinute": gap_fill_request.window.start_minute,
              "windowEndMinute": gap_fill_request.window.end_minute,
              "activityCount": gap_fill_request.activities.len(),
              "uniqueEntryCount": unique_entry_count,
              "savedEntryCount": saved_entry_count,
              "truncatedEntryCount": truncated_entry_count,
            }));

            let metadata = InterpretWriteMetadata {
                raw_message_id: &raw_message_id,
                raw_text: input.raw_text.trim(),
                interpreted_entries_json: &interpreted_entries_json,
                selected_openai_model,
                capture_source: input.capture_source.unwrap_or(CaptureSourceId::Text),
                transcription_model: input.transcription_model,
                transcription_duration_ms: input.transcription_duration_ms,
                confidence_average,
                raw_message_timestamp: parsed_timestamp.timestamp(),
                interpreted_entry_count: gap_fill_request.activities.len() as i64,
                unique_entry_count,
                saved_entry_count,
                truncated_entry_count,
                contains_multiple_events,
            };
            let outcome = write_interpreted_prepared_entries(
                &connection,
                metadata,
                prepared_entries,
                &code_context,
            )?;

            Ok((
                outcome,
                unique_entry_count,
                saved_entry_count,
                truncated_entry_count,
                contains_multiple_events,
                fallback_count,
                normalization_notes,
                normalization_details,
            ))
        })();

        let (
            write_outcome,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            contains_multiple_events,
            fallback_count,
            normalization_notes,
            normalization_details,
        ) = match write_result {
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
              "createdEntryCount": write_outcome.created_entry_ids.len(),
              "interpretedEntryCount": gap_fill_request.activities.len(),
              "uniqueEntryCount": unique_entry_count,
              "savedEntryCount": saved_entry_count,
              "truncatedEntryCount": truncated_entry_count,
              "containsMultipleEvents": contains_multiple_events,
              "touchedMonthKeys": write_outcome.touched_month_keys.clone(),
              "warningCount": write_outcome.warnings.len(),
              "normalizationFallbackCount": fallback_count,
              "normalizationNotes": normalization_notes.clone(),
              "normalizationDetails": normalization_details.clone(),
              "model": selected_openai_model.api_name(),
              "modelLabel": selected_openai_model.display_label(),
              "captureSource": capture_source_label(input.capture_source.unwrap_or(CaptureSourceId::Text)),
              "transcriptionModel": input.transcription_model.map(|model| model.api_name()),
              "transcriptionDurationMs": input.transcription_duration_ms,
              "llmDurationMs": llm_duration_ms,
              "gapFill": true,
            }),
        );

        return Ok(InterpretResult {
            correlation_id,
            raw_message_id,
            created_entry_ids: write_outcome.created_entry_ids,
            interpreted_entry_count: gap_fill_request.activities.len() as i64,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            contains_multiple_events,
            touched_month_keys: write_outcome.touched_month_keys,
            warnings: write_outcome.warnings,
            normalization_notes,
            model_used: selected_openai_model,
            model_used_label: selected_openai_model.display_label().to_string(),
            llm_duration_ms,
        });
    }

    let interpreted_entry_count = llm_response.entries.len() as i64;

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
    let mut entry_normalization_notes = Vec::<Vec<String>>::new();
    let mut normalization_details = Vec::<Value>::new();
    let mut sequencing_contexts = Vec::<SequencingEntryContext>::new();

    for mut result in normalization_results {
        let mut entry_notes = Vec::<String>::new();
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
            entry_notes.push(note);
        }

        if let Some(note) = activity_fallback.note.clone() {
            entry_notes.push(note);
        }

        if let Some(note) = global_activity_fallback.note.clone() {
            entry_notes.push(note);
        }

        if ref_resolution.applied {
            entry_notes.push(format!(
                "Reference resolution applied ({})",
                ref_resolution.reason
            ));
        }

        let used_activity_fallback = activity_fallback.applied || global_activity_fallback.applied;
        let fallback_summary =
            build_fallback_summary(result.used_temporal_fallback, used_activity_fallback);

        let mut normalization_detail = serde_json::Map::new();
        normalization_detail.insert(
            "usedTemporalFallback".to_string(),
            json!(result.used_temporal_fallback),
        );
        normalization_detail.insert("fallbackReason".to_string(), json!(result.fallback_reason));
        normalization_detail.insert(
            "temporalCueType".to_string(),
            json!(temporal_cue_type_label(result.temporal_cue_type)),
        );
        normalization_detail.insert("temporalSource".to_string(), json!(result.temporal_source));
        normalization_detail.insert("llmStartRaw".to_string(), json!(result.raw_start));
        normalization_detail.insert("llmEndRaw".to_string(), json!(result.raw_end));
        normalization_detail.insert("llmDurationRaw".to_string(), json!(result.raw_duration));
        normalization_detail.insert(
            "durationDefaulted".to_string(),
            json!(result.duration_defaulted),
        );
        normalization_detail.insert("savedDate".to_string(), json!(result.entry.date));
        normalization_detail.insert(
            "savedStartMinute".to_string(),
            json!(result.entry.start_minute),
        );
        normalization_detail.insert("savedEndMinute".to_string(), json!(result.entry.end_minute));
        normalization_detail.insert("sequencingApplied".to_string(), json!(false));
        normalization_detail.insert("sequencingReason".to_string(), Value::Null);
        normalization_detail.insert("sequencingOriginalStartMinute".to_string(), Value::Null);
        normalization_detail.insert("sequencingOriginalEndMinute".to_string(), Value::Null);
        normalization_detail.insert("sequencingAdjustedStartMinute".to_string(), Value::Null);
        normalization_detail.insert("sequencingAdjustedEndMinute".to_string(), Value::Null);
        normalization_detail.insert("sequencingDurationMinutes".to_string(), Value::Null);
        normalization_detail.insert(
            "llmSequenceRelation".to_string(),
            json!(result.llm_sequence_relation),
        );
        normalization_detail.insert(
            "llmDurationSource".to_string(),
            json!(result.llm_duration_source),
        );
        normalization_detail.insert(
            "llmChosenActivityRef".to_string(),
            json!(result.llm_activity_ref),
        );
        normalization_detail.insert(
            "llmActivityReason".to_string(),
            json!(result.llm_activity_reason),
        );
        normalization_detail.insert(
            "llmAlternativeActivities".to_string(),
            json!(result.llm_alternative_activities),
        );
        normalization_detail.insert(
            "originalEngagementRef".to_string(),
            json!(ref_resolution.original_engagement_ref),
        );
        normalization_detail.insert(
            "originalActivityRef".to_string(),
            json!(ref_resolution.original_activity_ref),
        );
        normalization_detail.insert(
            "savedEngagementRef".to_string(),
            json!(result.entry.engagement_ref),
        );
        normalization_detail.insert(
            "savedActivityRef".to_string(),
            json!(result.entry.activity_ref),
        );
        normalization_detail.insert(
            "savedConfidence".to_string(),
            json!(result.entry.confidence),
        );
        normalization_detail.insert(
            "refResolutionApplied".to_string(),
            json!(ref_resolution.applied),
        );
        normalization_detail.insert(
            "refResolutionReason".to_string(),
            json!(ref_resolution.reason),
        );
        normalization_detail.insert(
            "resolvedEngagementRef".to_string(),
            json!(ref_resolution.resolved_engagement_ref),
        );
        normalization_detail.insert(
            "resolvedActivityRef".to_string(),
            json!(ref_resolution.resolved_activity_ref),
        );
        normalization_detail.insert(
            "attemptedActivityFallback".to_string(),
            json!(activity_fallback.attempted),
        );
        normalization_detail.insert(
            "usedActivityFallback".to_string(),
            json!(activity_fallback.applied),
        );
        normalization_detail.insert(
            "activityFallbackReason".to_string(),
            json!(activity_fallback.reason),
        );
        normalization_detail.insert(
            "activityFallbackCandidateCount".to_string(),
            json!(activity_fallback.candidate_count),
        );
        normalization_detail.insert(
            "activityFallbackChosenRef".to_string(),
            json!(activity_fallback.chosen_activity_ref),
        );
        normalization_detail.insert(
            "activityFallbackChosenName".to_string(),
            json!(activity_fallback.chosen_activity_name),
        );
        normalization_detail.insert(
            "activityFallbackScore".to_string(),
            json!(activity_fallback.chosen_score),
        );
        normalization_detail.insert(
            "activityFallbackMatchedTerms".to_string(),
            json!(activity_fallback.matched_terms),
        );
        normalization_detail.insert(
            "attemptedGlobalActivityFallback".to_string(),
            json!(global_activity_fallback.attempted),
        );
        normalization_detail.insert(
            "usedGlobalActivityFallback".to_string(),
            json!(global_activity_fallback.applied),
        );
        normalization_detail.insert(
            "globalActivityFallbackReason".to_string(),
            json!(global_activity_fallback.reason),
        );
        normalization_detail.insert(
            "globalActivityFallbackCandidateCount".to_string(),
            json!(global_activity_fallback.candidate_count),
        );
        normalization_detail.insert(
            "globalActivityFallbackChosenEngagementRef".to_string(),
            json!(global_activity_fallback.chosen_engagement_ref),
        );
        normalization_detail.insert(
            "globalActivityFallbackChosenActivityRef".to_string(),
            json!(global_activity_fallback.chosen_activity_ref),
        );
        normalization_detail.insert(
            "globalActivityFallbackChosenActivityName".to_string(),
            json!(global_activity_fallback.chosen_activity_name),
        );
        normalization_detail.insert(
            "globalActivityFallbackScore".to_string(),
            json!(global_activity_fallback.chosen_score),
        );
        normalization_detail.insert(
            "globalActivityFallbackMatchedTerms".to_string(),
            json!(global_activity_fallback.matched_terms),
        );
        normalization_detail.insert(
            "fallbackSummary".to_string(),
            json!(fallback_summary.clone()),
        );
        normalization_details.push(Value::Object(normalization_detail));

        sequencing_contexts.push(SequencingEntryContext {
            raw_duration: result.raw_duration,
            llm_sequence_relation: result.llm_sequence_relation,
            llm_duration_source: result.llm_duration_source,
        });
        entry_normalization_notes.push(entry_notes);
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

    let sequencing_adjustments = apply_multi_event_sequence_adjustments(
        &mut prepared_entries,
        &sequencing_contexts,
        input.raw_text.trim(),
    );

    for (index, adjustment) in sequencing_adjustments.iter().enumerate() {
        if let Some(details) = normalization_details
            .get_mut(index)
            .and_then(Value::as_object_mut)
        {
            let prepared = &prepared_entries[index];
            details.insert(
                "usedTemporalFallback".to_string(),
                json!(prepared.used_temporal_fallback),
            );
            details.insert(
                "durationDefaulted".to_string(),
                json!(prepared.duration_defaulted),
            );
            details.insert(
                "savedStartMinute".to_string(),
                json!(prepared.entry.start_minute),
            );
            details.insert(
                "savedEndMinute".to_string(),
                json!(prepared.entry.end_minute),
            );
            details.insert(
                "fallbackSummary".to_string(),
                json!(prepared.fallback_summary.clone()),
            );
            details.insert("sequencingApplied".to_string(), json!(adjustment.applied));
            details.insert("sequencingReason".to_string(), json!(adjustment.reason));
            details.insert(
                "sequencingOriginalStartMinute".to_string(),
                json!(adjustment.original_start_minute),
            );
            details.insert(
                "sequencingOriginalEndMinute".to_string(),
                json!(adjustment.original_end_minute),
            );
            details.insert(
                "sequencingAdjustedStartMinute".to_string(),
                json!(adjustment.adjusted_start_minute),
            );
            details.insert(
                "sequencingAdjustedEndMinute".to_string(),
                json!(adjustment.adjusted_end_minute),
            );
            details.insert(
                "sequencingDurationMinutes".to_string(),
                json!(adjustment.duration_minutes),
            );
            details.insert(
                "sequencingSequenceRelation".to_string(),
                json!(adjustment.sequence_relation.clone()),
            );
            details.insert(
                "sequencingDurationSource".to_string(),
                json!(adjustment.duration_source.clone()),
            );
            details.insert(
                "sequencingSegmentText".to_string(),
                json!(adjustment.segment_text.clone()),
            );
        }
    }

    for (index, notes) in entry_normalization_notes.into_iter().enumerate() {
        let sequencing_applied = sequencing_adjustments
            .get(index)
            .is_some_and(|adjustment| adjustment.applied);
        for note in notes {
            if sequencing_applied && note.starts_with("Temporal fallback applied") {
                continue;
            }
            normalization_notes.push(note);
        }
        if let Some(adjustment) = sequencing_adjustments
            .get(index)
            .filter(|adjustment| adjustment.applied)
        {
            normalization_notes.push(format!(
                "Sequencing applied: entry {} saved {} - {} after previous entry.",
                index + 1,
                minute_to_hhmm(adjustment.adjusted_start_minute.unwrap_or(0)),
                minute_to_hhmm(adjustment.adjusted_end_minute.unwrap_or(0)),
            ));
        }
    }

    let fallback_count = prepared_entries
        .iter()
        .filter(|entry| entry.used_temporal_fallback)
        .count();

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
            selected_openai_model.storage_value(),
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
    let open_ai_key_configured =
        read_saved_openai_key_configured(&connection).map_err(|error| error.to_string())?;

    let key_status = read_key_status(&state, open_ai_key_configured);

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
    lines.push(format!("keyConfiguredFlag: {}", open_ai_key_configured));
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

fn normalize_image_base64(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("calendar image cannot be empty".to_string());
    }

    let base64 = trimmed
        .split_once(',')
        .filter(|(prefix, _)| prefix.trim_start().starts_with("data:"))
        .map(|(_, payload)| payload)
        .unwrap_or(trimmed)
        .trim();

    if base64.is_empty() {
        return Err("calendar image data is empty".to_string());
    }

    BASE64_STANDARD
        .decode(base64)
        .map_err(|_| "calendar image data must be valid base64".to_string())?;

    Ok(base64.to_string())
}

fn normalize_calendar_image_mime_type(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif" => {
            Ok(if normalized == "image/jpg" {
                "image/jpeg".to_string()
            } else {
                normalized
            })
        }
        _ => Err("calendar image must be PNG, JPEG, WEBP, or GIF".to_string()),
    }
}

fn build_calendar_extract_candidate(
    event: &CalendarVisionEvent,
    code_context: &CodeContext,
    selected_date: NaiveDate,
    ignored_keywords: &[String],
    ignore_all_day_events: bool,
) -> Option<CalendarExtractCandidate> {
    let title = event.title.trim();
    if title.is_empty() {
        return None;
    }

    let details = event.details.as_deref().map(str::trim).unwrap_or("");
    let extracted_text = if details.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n{details}")
    };
    let (date, needs_date_confirmation) = resolve_calendar_event_date(event, selected_date);
    let (start_minute, end_minute, duration_minutes, needs_time_confirmation) =
        resolve_calendar_event_time(event);

    let mut normalized_entry = NormalizedEntry {
        date: date.clone(),
        start_minute,
        end_minute,
        duration_minutes,
        description: title.to_string(),
        user_submission_text: extracted_text.clone(),
        confidence: normalize_confidence(event.confidence),
        engagement_ref: normalize_optional_ref(event.engagement_ref.clone()),
        activity_ref: normalize_optional_ref(event.activity_ref.clone()),
    };

    let ref_resolution = reconcile_context_refs(&mut normalized_entry, code_context);
    let activity_fallback =
        apply_activity_fallback_if_needed(&mut normalized_entry, &extracted_text, code_context);
    let global_activity_fallback = apply_global_activity_fallback_if_needed(
        &mut normalized_entry,
        &extracted_text,
        code_context,
    );

    if ref_resolution.applied || activity_fallback.applied || global_activity_fallback.applied {
        normalized_entry.confidence = normalized_entry
            .confidence
            .min(ACTIVITY_FALLBACK_CONFIDENCE_CAP);
    }

    let (engagement_id, activity_id) = resolve_ref_ids(&normalized_entry, code_context);
    let (engagement_code, engagement_name, activity_code, activity_name) =
        resolve_calendar_candidate_labels(&normalized_entry, code_context);
    let engagement_type = engagement_id
        .as_ref()
        .map(|_| infer_engagement_type_from_code(engagement_code.as_deref()));
    let (is_ignored, ignored_reason) = resolve_calendar_candidate_ignored_state(
        &extracted_text,
        event.is_all_day,
        ignored_keywords,
        ignore_all_day_events,
    );

    let mut warning_flags = Vec::<WarningType>::new();
    if normalized_entry.confidence < db::LOW_CONFIDENCE_THRESHOLD {
        warning_flags.push(WarningType::LowConfidence);
    }
    if engagement_id.is_none() || activity_id.is_none() {
        warning_flags.push(WarningType::Unmatched);
    }

    Some(CalendarExtractCandidate {
        id: Uuid::new_v4().to_string(),
        date,
        start_minute,
        end_minute,
        duration_minutes,
        time_evidence: event
            .time_evidence
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        description: normalized_entry.description,
        extracted_text: extracted_text.clone(),
        source_text: extracted_text,
        confidence: normalized_entry.confidence,
        engagement_id,
        activity_id,
        engagement_code,
        engagement_name,
        engagement_type,
        activity_code,
        activity_name,
        warning_flags,
        is_all_day: event.is_all_day,
        is_ignored,
        ignored_reason,
        needs_date_confirmation,
        needs_time_confirmation,
    })
}

fn resolve_calendar_event_date(
    event: &CalendarVisionEvent,
    selected_date: NaiveDate,
) -> (String, bool) {
    if let Some(date) = event
        .date
        .as_deref()
        .and_then(|value| parse_date(value.trim()))
    {
        return (date.format("%Y-%m-%d").to_string(), false);
    }

    let selected_matches_day = event
        .day_of_month
        .is_some_and(|day| day == selected_date.day() as i64);
    let selected_matches_weekday = event
        .weekday
        .as_deref()
        .is_none_or(|weekday| weekday_matches_date(weekday, selected_date));

    (
        selected_date.format("%Y-%m-%d").to_string(),
        !(selected_matches_day && selected_matches_weekday),
    )
}

fn weekday_matches_date(value: &str, date: NaiveDate) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    let expected = match date.weekday().num_days_from_sunday() {
        0 => ["sun", "sunday"].as_slice(),
        1 => ["mon", "monday"].as_slice(),
        2 => ["tue", "tues", "tuesday"].as_slice(),
        3 => ["wed", "wednesday"].as_slice(),
        4 => ["thu", "thur", "thurs", "thursday"].as_slice(),
        5 => ["fri", "friday"].as_slice(),
        _ => ["sat", "saturday"].as_slice(),
    };

    expected.iter().any(|candidate| normalized == *candidate)
}

fn resolve_calendar_event_time(event: &CalendarVisionEvent) -> (i64, i64, i64, bool) {
    if event.is_all_day {
        return (0, TIME_INCREMENT_MINUTES, TIME_INCREMENT_MINUTES, false);
    }

    let extracted_duration = event
        .duration_minutes
        .and_then(normalize_calendar_duration_minutes);
    let parsed_start = event
        .start_time
        .as_deref()
        .and_then(|value| parse_time_to_minutes(value.trim()));
    let parsed_end = event
        .end_time
        .as_deref()
        .and_then(|value| parse_time_to_minutes(value.trim()));

    match (parsed_start, parsed_end) {
        (Some(start), Some(end)) => {
            let (start, end, duration) = normalize_snapped_update_window(start, end);
            let needs_time_confirmation =
                extracted_duration.is_some_and(|duration_minutes| duration_minutes != duration);
            (start, end, duration, needs_time_confirmation)
        }
        (Some(start), None) => {
            let inferred_duration = extracted_duration.unwrap_or(DEFAULT_FALLBACK_DURATION_MINUTES);
            let (start, end, duration) =
                normalize_snapped_update_window(start, start + inferred_duration);
            let needs_time_confirmation = extracted_duration.is_none_or(|value| value != duration);
            (start, end, duration, needs_time_confirmation)
        }
        (None, Some(end)) => {
            let inferred_duration = extracted_duration.unwrap_or(DEFAULT_FALLBACK_DURATION_MINUTES);
            let (start, end, duration) =
                normalize_snapped_update_window(end - inferred_duration, end);
            let needs_time_confirmation = extracted_duration.is_none_or(|value| value != duration);
            (start, end, duration, needs_time_confirmation)
        }
        (None, None) => {
            let inferred_duration = extracted_duration.unwrap_or(DEFAULT_FALLBACK_DURATION_MINUTES);
            let (start, end, duration) =
                normalize_snapped_update_window(9 * 60, 9 * 60 + inferred_duration);
            (start, end, duration, true)
        }
    }
}

fn normalize_calendar_duration_minutes(value: i64) -> Option<i64> {
    (value > 0).then(|| normalize_duration(value))
}

fn resolve_calendar_candidate_labels(
    entry: &NormalizedEntry,
    code_context: &CodeContext,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let engagement = entry
        .engagement_ref
        .as_deref()
        .and_then(|engagement_ref| find_engagement_by_ref(code_context, engagement_ref));
    let activity = engagement.and_then(|engagement| {
        entry.activity_ref.as_deref().and_then(|activity_ref| {
            engagement
                .activities
                .iter()
                .find(|candidate| candidate.activity_ref.eq_ignore_ascii_case(activity_ref))
        })
    });

    (
        engagement.and_then(|value| value.code.clone()),
        engagement.map(|value| value.name.clone()),
        activity.and_then(|value| value.code.clone()),
        activity.map(|value| value.name.clone()),
    )
}

fn infer_engagement_type_from_code(code: Option<&str>) -> EngagementType {
    match code
        .unwrap_or("")
        .trim()
        .chars()
        .next()
        .map(|character| character.to_ascii_uppercase())
    {
        Some('I') | Some('A') => EngagementType::Internal,
        _ => EngagementType::External,
    }
}

fn resolve_calendar_candidate_ignored_state(
    text: &str,
    is_all_day: bool,
    ignored_keywords: &[String],
    ignore_all_day_events: bool,
) -> (bool, Option<String>) {
    if is_all_day && ignore_all_day_events {
        return (true, Some("All-day event".to_string()));
    }

    let normalized_text = text.to_lowercase();
    if let Some(keyword) = ignored_keywords
        .iter()
        .find(|keyword| !keyword.is_empty() && normalized_text.contains(keyword.as_str()))
    {
        return (true, Some(format!("Matched ignored keyword: {keyword}")));
    }

    (false, None)
}

fn apply_calendar_candidate_overlap_warnings(candidates: &mut [CalendarExtractCandidate]) {
    for index in 0..candidates.len() {
        if candidates[index].is_ignored {
            continue;
        }

        let overlaps = candidates.iter().enumerate().any(|(other_index, other)| {
            index != other_index
                && !other.is_ignored
                && other.date == candidates[index].date
                && other.start_minute < candidates[index].end_minute
                && candidates[index].start_minute < other.end_minute
        });

        if overlaps
            && !candidates[index]
                .warning_flags
                .iter()
                .any(|warning| matches!(warning, WarningType::Overlap))
        {
            candidates[index].warning_flags.push(WarningType::Overlap);
        }
    }
}

fn validate_calendar_import_entry(
    entry: &CalendarImportEntryInput,
) -> Result<PreparedCalendarImportEntry, String> {
    let date = entry.date.trim();
    if parse_date(date).is_none() {
        return Err("calendar import entry date must be YYYY-MM-DD".to_string());
    }

    let (start_minute, end_minute, duration_minutes) =
        validate_manual_update_window(entry.start_minute, entry.end_minute)?;
    let description = entry.description.trim();
    if description.is_empty() {
        return Err("calendar import entry description cannot be empty".to_string());
    }

    Ok(PreparedCalendarImportEntry {
        date: date.to_string(),
        start_minute,
        end_minute,
        duration_minutes,
        description: description.to_string(),
        extracted_text: entry.extracted_text.trim().to_string(),
        engagement_id: entry
            .engagement_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        activity_id: entry
            .activity_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        confidence: normalize_confidence(Some(entry.confidence)),
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
    let llm_sequence_relation = entry
        .sequence_relation
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let llm_duration_source = entry
        .duration_source
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

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

    let should_anchor_duration_to_capture = temporal_cue_type
        == TemporalCueType::ImplicitRecentDuration
        && raw_duration.unwrap_or(0) > 0
        && !has_no_times;

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
    } else if should_anchor_duration_to_capture {
        (
            reference.rounded_end_minute - normalized_duration,
            reference.rounded_end_minute,
            None,
            "derived_from_capture_duration_override",
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
        llm_sequence_relation,
        llm_duration_source,
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
    if message_has_explicit_clock_time_cue(raw_text)
        || message_has_future_planned_cue(raw_text)
        || message_has_contextual_day_or_date_cue(raw_text)
    {
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

fn message_has_contextual_day_or_date_cue(raw_text: &str) -> bool {
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
        if is_contextual_day_or_date_token(token) {
            return true;
        }

        if matches!(*token, "this" | "last" | "next")
            && tokens
                .get(index + 1)
                .is_some_and(|candidate| is_contextual_day_or_date_token(candidate))
        {
            return true;
        }
    }

    false
}

fn is_contextual_day_or_date_token(value: &str) -> bool {
    matches!(
        value,
        "today"
            | "yesterday"
            | "tonight"
            | "morning"
            | "afternoon"
            | "evening"
            | "night"
            | "overnight"
            | "monday"
            | "tuesday"
            | "wednesday"
            | "thursday"
            | "friday"
            | "saturday"
            | "sunday"
            | "week"
            | "month"
    )
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

        if *token == "about"
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
    use rusqlite::Connection;

    use crate::db;
    use crate::models::{
        Activity, ActivityUpsertInput, CalendarImportEntryInput, CalendarVisionEvent,
        CaptureSourceId, CodeContext, ContextActivity, ContextEngagement, Engagement,
        EngagementType, EngagementUpsertInput, InterpretTextInput, KeySource, LlmEntry,
        LlmGapFillActivity, LlmGapFillRequest, LlmTimeOffRequest, NormalizedEntry, OpenAiModelId,
        StatusLevel, SummaryLayoutColumn, SummaryLayoutFieldKey, SummaryLayoutPreset,
        SummaryLayoutState, TimelineCreateInput, TimelineEntry, TimelineTotalBreakdown,
        TimelineWeekStartDay, TimelineWeeklySummary, TimelineWeeklySummaryCell,
        TimelineWeeklySummaryDay, TimelineWeeklySummaryNote, TimelineWeeklySummaryRow,
        TranscriptionModelId, WarningType,
    };
    use crate::openai::LlmAttemptTelemetry;

    use super::{
        apply_activity_fallback_if_needed, apply_global_activity_fallback_if_needed,
        apply_multi_event_sequence_adjustments, apply_time_off_entry_cap,
        apply_timeline_preferences_to_weekly_summary, build_export_metadata_maps,
        build_summary_export_hours_and_notes_sheet_columns,
        build_summary_export_hours_sheet_columns, capture_source_label,
        compute_gap_fill_free_intervals, create_manual_timeline_entry, dedupe_prepared_entries,
        default_summary_layout_state, derive_key_status_level, distribute_gap_fill_minutes,
        llm_attempt_event_status, message_has_contextual_day_or_date_cue,
        message_has_explicit_clock_time_cue, message_has_implicit_recent_duration_cue,
        message_has_relative_duration_cue, normalize_calendar_bulk_ignored_keywords,
        normalize_confidence, normalize_llm_entry, normalize_snapped_update_window,
        normalize_summary_layout_preset_for_export, normalize_summary_layout_state,
        prepare_gap_fill_entries, prepare_time_off_entries, read_saved_calendar_bulk_preferences,
        read_saved_openai_key_configured, read_saved_openai_key_configured_marker,
        read_saved_show_diagnostics_tab, read_saved_timeline_preferences, reconcile_context_refs,
        resolve_calendar_candidate_ignored_state, resolve_calendar_event_date,
        resolve_calendar_event_time, resolve_gap_fill_request, resolve_requested_openai_model,
        resolve_saved_calendar_bulk_model_value, resolve_saved_openai_model_value,
        resolve_saved_transcription_model_value, resolve_summary_export_field_value,
        resolve_summary_export_free_text_value, resolve_time_off_request, round_to_nearest_15,
        summary_day_notes_header, synthesize_time_off_request_from_text, timeline_week_bounds,
        timeline_week_view_bounds, validate_calendar_import_entry, validate_manual_create_refs,
        validate_manual_update_window, validate_timeline_preferences, MinuteInterval,
        PreparedEntry, ResolvedGapFillActivity, ResolvedGapFillRequest, ResolvedTimeOffRequest,
        SequencingEntryContext, SummaryExportSheetColumnKind, TemporalCueType, TemporalReference,
        TimeOffKind, TimelinePreferenceValues, APP_SETTING_OPENAI_KEY_CONFIGURED, MINUTES_IN_DAY,
    };

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        db::run_migrations(&connection).expect("migrations should run");
        connection
    }

    #[test]
    fn settings_defaults_apply_when_no_saved_preferences_exist() {
        let connection = test_connection();

        let timeline_preferences =
            read_saved_timeline_preferences(&connection).expect("timeline defaults should read");
        assert!(timeline_preferences.exclude_uncategorized_from_totals);
        assert!(!timeline_preferences.show_uncategorized_total);
        assert!(timeline_preferences.include_external_in_totals);
        assert!(!timeline_preferences.include_internal_in_totals);
        assert!(timeline_preferences.separate_engagement_type_totals);
        assert_eq!(
            timeline_preferences.week_start_day,
            TimelineWeekStartDay::Saturday
        );

        let (ignored_keywords, ignore_all_day_events) =
            read_saved_calendar_bulk_preferences(&connection)
                .expect("calendar bulk defaults should read");
        assert_eq!(ignored_keywords, vec!["lunch", "focus", "block"]);
        assert!(ignore_all_day_events);

        let show_diagnostics_tab =
            read_saved_show_diagnostics_tab(&connection).expect("interface defaults should read");
        assert!(!show_diagnostics_tab);
    }

    fn test_free_text_column(id: &str, label: &str) -> SummaryLayoutColumn {
        SummaryLayoutColumn::FreeText {
            id: id.to_string(),
            label: label.to_string(),
            row_values: std::collections::HashMap::new(),
            repeat: false,
            repeat_value: String::new(),
            repeat_row_key: None,
        }
    }

    fn create_test_engagement_with_activity(connection: &Connection) -> (String, String) {
        let engagement_id = db::upsert_engagement(
            connection,
            EngagementUpsertInput {
                id: None,
                code: Some("E-100".to_string()),
                name: "Client Audit".to_string(),
                client: Some("Client".to_string()),
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for client audit work.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("engagement saves");
        let activity_id = db::upsert_activity(
            connection,
            ActivityUpsertInput {
                id: None,
                engagement_id: engagement_id.clone(),
                code: Some("461".to_string()),
                name: "Planning".to_string(),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for planning.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("activity saves");

        (engagement_id, activity_id)
    }

    fn prepared_entry_for_test(
        start_minute: i64,
        end_minute: i64,
        duration_minutes: i64,
    ) -> PreparedEntry {
        PreparedEntry {
            entry: NormalizedEntry {
                date: "2026-05-09".to_string(),
                start_minute,
                end_minute,
                duration_minutes,
                description: "Test entry".to_string(),
                user_submission_text: "Test submission".to_string(),
                confidence: 0.9,
                engagement_ref: Some("eng-123".to_string()),
                activity_ref: Some("act-01".to_string()),
            },
            used_activity_fallback: false,
            used_temporal_fallback: false,
            duration_defaulted: false,
            fallback_summary: None,
        }
    }

    fn timeline_entry_for_test(
        id: &str,
        date: &str,
        start_minute: i64,
        end_minute: i64,
    ) -> TimelineEntry {
        TimelineEntry {
            id: id.to_string(),
            date: date.to_string(),
            start_minute,
            end_minute,
            duration_minutes: end_minute - start_minute,
            description: "Existing entry".to_string(),
            user_submission_text: "Existing entry".to_string(),
            source: "manual".to_string(),
            confidence: 1.0,
            engagement_id: None,
            activity_id: None,
            engagement_code: None,
            engagement_name: None,
            engagement_type: None,
            activity_code: None,
            activity_name: None,
            used_activity_fallback: false,
            used_temporal_fallback: false,
            duration_defaulted: false,
            fallback_summary: None,
            source_message_entry_index: None,
            source_message_entry_count: None,
            model_used: None,
            model_used_label: None,
            transcription_model_used: None,
            transcription_model_used_label: None,
            warning_flags: Vec::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn gap_fill_activity_for_test(label: &str) -> ResolvedGapFillActivity {
        ResolvedGapFillActivity {
            engagement_ref: None,
            activity_ref: None,
            label: label.to_string(),
            description: label.to_string(),
            matching_text: label.to_string(),
            activity_reason: None,
            alternative_activities: None,
            confidence: 0.9,
        }
    }

    fn time_off_code_context_for_test() -> CodeContext {
        CodeContext {
            engagements: vec![
                ContextEngagement {
                    id: "vacation-engagement".to_string(),
                    engagement_ref: "eng-001".to_string(),
                    code: Some("VACATION".to_string()),
                    name: "Vacation".to_string(),
                    tags: vec!["ooo".to_string(), "vacation".to_string()],
                    describe_when_to_use: Some("Use for vacation and OOO.".to_string()),
                    activities: vec![ContextActivity {
                        id: "vacation-activity".to_string(),
                        activity_ref: "act-001-001".to_string(),
                        code: Some("VACATION".to_string()),
                        name: "Vacation".to_string(),
                        tags: vec!["ooo".to_string()],
                        describe_when_to_use: Some("Use for vacation and OOO.".to_string()),
                    }],
                },
                ContextEngagement {
                    id: "holiday-engagement".to_string(),
                    engagement_ref: "eng-002".to_string(),
                    code: Some("HOLIDAY".to_string()),
                    name: "Public Holiday".to_string(),
                    tags: vec!["holiday".to_string()],
                    describe_when_to_use: Some("Use for public holidays.".to_string()),
                    activities: vec![ContextActivity {
                        id: "holiday-activity".to_string(),
                        activity_ref: "act-002-001".to_string(),
                        code: Some("HOLIDAY".to_string()),
                        name: "Public Holiday".to_string(),
                        tags: vec!["holiday".to_string()],
                        describe_when_to_use: Some("Use for public holidays.".to_string()),
                    }],
                },
            ],
        }
    }

    fn interpret_input_for_time_off(raw_text: &str) -> InterpretTextInput {
        InterpretTextInput {
            raw_text: raw_text.to_string(),
            client_timestamp_iso: "2026-04-01T12:00:00-07:00".to_string(),
            timezone: "America/Los_Angeles".to_string(),
            client_local_date: "2026-04-01".to_string(),
            client_local_time: "12:00".to_string(),
            client_utc_offset_minutes: -420,
            selected_date: None,
            open_ai_model: None,
            capture_source: None,
            transcription_model: None,
            transcription_duration_ms: None,
        }
    }

    fn calendar_event_for_test() -> CalendarVisionEvent {
        CalendarVisionEvent {
            title: "Client planning".to_string(),
            details: None,
            date: None,
            weekday: None,
            day_of_month: None,
            start_time: Some("09:00".to_string()),
            end_time: Some("10:00".to_string()),
            duration_minutes: Some(60),
            time_evidence: None,
            is_all_day: false,
            engagement_ref: None,
            activity_ref: None,
            confidence: Some(0.9),
            visual_notes: None,
        }
    }

    #[test]
    fn gap_fill_free_intervals_subtract_clamp_and_merge_existing_entries() {
        let window = MinuteInterval {
            start_minute: 9 * 60,
            end_minute: 18 * 60,
        };
        let existing_entries = vec![
            timeline_entry_for_test("before", "2026-04-15", 8 * 60 + 30, 9 * 60 + 30),
            timeline_entry_for_test("overlap-1", "2026-04-15", 10 * 60, 11 * 60),
            timeline_entry_for_test("overlap-2", "2026-04-15", 10 * 60 + 30, 12 * 60),
            timeline_entry_for_test("after", "2026-04-15", 17 * 60 + 30, 19 * 60),
        ];

        let free_intervals = compute_gap_fill_free_intervals(window, &existing_entries);

        assert_eq!(
            free_intervals,
            vec![
                MinuteInterval {
                    start_minute: 9 * 60 + 30,
                    end_minute: 10 * 60,
                },
                MinuteInterval {
                    start_minute: 12 * 60,
                    end_minute: 17 * 60 + 30,
                },
            ]
        );
    }

    #[test]
    fn gap_fill_free_intervals_snap_inward_to_quarter_hours() {
        let window = MinuteInterval {
            start_minute: 9 * 60,
            end_minute: 11 * 60,
        };
        let existing_entries = vec![timeline_entry_for_test(
            "manual",
            "2026-04-15",
            9 * 60 + 7,
            9 * 60 + 52,
        )];

        let free_intervals = compute_gap_fill_free_intervals(window, &existing_entries);

        assert_eq!(
            free_intervals,
            vec![MinuteInterval {
                start_minute: 10 * 60,
                end_minute: 11 * 60,
            }]
        );
    }

    #[test]
    fn gap_fill_distribution_splits_standard_workday_equally() {
        let allocations = distribute_gap_fill_minutes(9 * 60, 3);

        assert_eq!(allocations, vec![3 * 60, 3 * 60, 3 * 60]);
    }

    #[test]
    fn gap_fill_distribution_assigns_remainder_to_earlier_activities() {
        let allocations = distribute_gap_fill_minutes(8 * 60 + 15, 4);

        assert_eq!(allocations, vec![2 * 60 + 15, 2 * 60, 2 * 60, 2 * 60]);
    }

    #[test]
    fn gap_fill_spans_skip_existing_entries_without_overlap() {
        let request = ResolvedGapFillRequest {
            date: "2026-04-15".to_string(),
            window: MinuteInterval {
                start_minute: 9 * 60,
                end_minute: 13 * 60,
            },
            activities: vec![
                gap_fill_activity_for_test("Activity A"),
                gap_fill_activity_for_test("Activity B"),
            ],
        };
        let existing_entries = vec![timeline_entry_for_test(
            "busy",
            "2026-04-15",
            10 * 60,
            11 * 60,
        )];
        let code_context = CodeContext {
            engagements: vec![],
        };

        let (prepared_entries, _notes, _details) = prepare_gap_fill_entries(
            &request,
            &existing_entries,
            "Worked on Activity A and Activity B from 9 to 1",
            &code_context,
        );

        let spans = prepared_entries
            .iter()
            .map(|entry| (entry.entry.start_minute, entry.entry.end_minute))
            .collect::<Vec<_>>();
        assert_eq!(
            spans,
            vec![
                (9 * 60, 10 * 60),
                (11 * 60, 11 * 60 + 30),
                (11 * 60 + 30, 13 * 60),
            ]
        );
        assert!(prepared_entries
            .iter()
            .all(|entry| entry.entry.end_minute <= 10 * 60 || entry.entry.start_minute >= 11 * 60));
    }

    #[test]
    fn gap_fill_no_free_gaps_creates_no_fallback_entry() {
        let request = ResolvedGapFillRequest {
            date: "2026-04-15".to_string(),
            window: MinuteInterval {
                start_minute: 9 * 60,
                end_minute: 18 * 60,
            },
            activities: vec![gap_fill_activity_for_test("Activity A")],
        };
        let existing_entries = vec![timeline_entry_for_test(
            "full-day",
            "2026-04-15",
            9 * 60,
            18 * 60,
        )];
        let code_context = CodeContext {
            engagements: vec![],
        };

        let (prepared_entries, notes, _details) = prepare_gap_fill_entries(
            &request,
            &existing_entries,
            "Fill out my calendar using Activity A",
            &code_context,
        );

        assert!(prepared_entries.is_empty());
        assert!(notes
            .iter()
            .any(|note| note.contains("No available gaps between 09:00 and 18:00")));
    }

    #[test]
    fn gap_fill_request_uses_selected_date_when_llm_date_is_missing() {
        let input = InterpretTextInput {
            raw_text: "Fill out my calendar using Activity A".to_string(),
            client_timestamp_iso: "2026-04-01T18:00:00-07:00".to_string(),
            timezone: "America/Los_Angeles".to_string(),
            client_local_date: "2026-04-01".to_string(),
            client_local_time: "18:00".to_string(),
            client_utc_offset_minutes: -420,
            selected_date: Some("2026-04-15".to_string()),
            open_ai_model: None,
            capture_source: None,
            transcription_model: None,
            transcription_duration_ms: None,
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 4, 1).expect("valid date"),
            rounded_end_minute: 18 * 60,
        };
        let request = LlmGapFillRequest {
            date: None,
            start_time: None,
            end_time: None,
            activities: vec![LlmGapFillActivity {
                engagement_ref: None,
                activity_ref: None,
                label: Some("Activity A".to_string()),
                description: None,
                activity_reason: None,
                alternative_activities: None,
                confidence: Some(0.9),
            }],
        };

        let resolved =
            resolve_gap_fill_request(&request, &input, &reference, input.raw_text.as_str())
                .expect("gap fill request should resolve");

        assert_eq!(resolved.date, "2026-04-15");
        assert_eq!(
            resolved.window,
            MinuteInterval {
                start_minute: 9 * 60,
                end_minute: 18 * 60,
            }
        );
    }

    #[test]
    fn time_off_synthesis_maps_ooo_next_week_to_vacation_workweek() {
        let input = interpret_input_for_time_off("I'm OOO next week");
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 4, 1).expect("valid date"),
            rounded_end_minute: 12 * 60,
        };

        let request = synthesize_time_off_request_from_text(&input.raw_text, &input, &reference)
            .and_then(|request| resolve_time_off_request(&request))
            .expect("OOO should synthesize as time off");

        assert_eq!(request.kind, TimeOffKind::Vacation);
        assert_eq!(
            request.start_date,
            NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date")
        );
        assert_eq!(
            request.end_date,
            NaiveDate::from_ymd_opt(2026, 4, 10).expect("valid date")
        );
    }

    #[test]
    fn time_off_synthesis_maps_vacation_next_week_to_vacation_workweek() {
        let input = interpret_input_for_time_off("I'm on vacation next week");
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 4, 1).expect("valid date"),
            rounded_end_minute: 12 * 60,
        };

        let request = synthesize_time_off_request_from_text(&input.raw_text, &input, &reference)
            .and_then(|request| resolve_time_off_request(&request))
            .expect("vacation should synthesize as time off");

        assert_eq!(request.kind, TimeOffKind::Vacation);
        assert_eq!(
            request.start_date,
            NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date")
        );
        assert_eq!(
            request.end_date,
            NaiveDate::from_ymd_opt(2026, 4, 10).expect("valid date")
        );
    }

    #[test]
    fn time_off_synthesis_maps_ooo_on_friday_to_single_vacation_day() {
        let input = interpret_input_for_time_off("I'm OOO on Friday");
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 4, 1).expect("valid date"),
            rounded_end_minute: 12 * 60,
        };

        let request = synthesize_time_off_request_from_text(&input.raw_text, &input, &reference)
            .and_then(|request| resolve_time_off_request(&request))
            .expect("Friday OOO should synthesize as time off");

        assert_eq!(request.kind, TimeOffKind::Vacation);
        assert_eq!(
            request.start_date,
            NaiveDate::from_ymd_opt(2026, 4, 3).expect("valid date")
        );
        assert_eq!(request.end_date, request.start_date);
    }

    #[test]
    fn time_off_synthesis_maps_holiday_phrase_to_holiday() {
        let input = interpret_input_for_time_off("I'm OOO next Monday for holiday");
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 4, 1).expect("valid date"),
            rounded_end_minute: 12 * 60,
        };

        let request = synthesize_time_off_request_from_text(&input.raw_text, &input, &reference)
            .and_then(|request| resolve_time_off_request(&request))
            .expect("holiday OOO should synthesize as time off");

        assert_eq!(request.kind, TimeOffKind::PublicHoliday);
        assert_eq!(
            request.start_date,
            NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date")
        );
        assert_eq!(request.end_date, request.start_date);
    }

    #[test]
    fn time_off_expansion_creates_nine_to_five_business_day_blocks() {
        let request = ResolvedTimeOffRequest {
            kind: TimeOffKind::Vacation,
            start_date: NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date"),
            end_date: NaiveDate::from_ymd_opt(2026, 4, 10).expect("valid date"),
            description: "Vacation".to_string(),
            confidence: 0.92,
        };

        let (prepared_entries, notes, details) = prepare_time_off_entries(
            &[request],
            "I'm OOO next week",
            &time_off_code_context_for_test(),
        );

        assert!(notes.is_empty());
        assert_eq!(prepared_entries.len(), 5);
        assert_eq!(
            prepared_entries
                .iter()
                .map(|entry| entry.entry.date.as_str())
                .collect::<Vec<_>>(),
            vec![
                "2026-04-06",
                "2026-04-07",
                "2026-04-08",
                "2026-04-09",
                "2026-04-10",
            ]
        );
        assert!(prepared_entries.iter().all(|entry| {
            entry.entry.start_minute == 9 * 60
                && entry.entry.end_minute == 17 * 60
                && entry.entry.duration_minutes == 8 * 60
                && entry.entry.engagement_ref.as_deref() == Some("eng-001")
                && entry.entry.activity_ref.as_deref() == Some("act-001-001")
                && entry.entry.user_submission_text == "I'm OOO next week"
        }));
        assert_eq!(
            details[0]
                .get("savedEntryCount")
                .and_then(|value| value.as_i64()),
            Some(5)
        );
    }

    #[test]
    fn time_off_expansion_skips_weekends_and_keeps_single_friday() {
        let request = ResolvedTimeOffRequest {
            kind: TimeOffKind::Vacation,
            start_date: NaiveDate::from_ymd_opt(2026, 4, 3).expect("valid date"),
            end_date: NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date"),
            description: "Vacation".to_string(),
            confidence: 0.9,
        };

        let (prepared_entries, _notes, details) = prepare_time_off_entries(
            &[request],
            "I'm OOO Friday through Monday",
            &time_off_code_context_for_test(),
        );

        assert_eq!(
            prepared_entries
                .iter()
                .map(|entry| entry.entry.date.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-04-03", "2026-04-06"]
        );
        assert_eq!(
            details[0]
                .get("skippedWeekendCount")
                .and_then(|value| value.as_i64()),
            Some(2)
        );
    }

    #[test]
    fn time_off_expansion_uses_holiday_standard_code_when_requested() {
        let request = ResolvedTimeOffRequest {
            kind: TimeOffKind::PublicHoliday,
            start_date: NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date"),
            end_date: NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date"),
            description: "Public Holiday".to_string(),
            confidence: 0.9,
        };

        let (prepared_entries, notes, _details) = prepare_time_off_entries(
            &[request],
            "I'm OOO next Monday for holiday",
            &time_off_code_context_for_test(),
        );

        assert!(notes.is_empty());
        assert_eq!(prepared_entries.len(), 1);
        assert_eq!(
            prepared_entries[0].entry.engagement_ref.as_deref(),
            Some("eng-002")
        );
        assert_eq!(
            prepared_entries[0].entry.activity_ref.as_deref(),
            Some("act-002-001")
        );
    }

    #[test]
    fn time_off_entry_cap_truncates_long_ranges_with_note() {
        let request = ResolvedTimeOffRequest {
            kind: TimeOffKind::Vacation,
            start_date: NaiveDate::from_ymd_opt(2026, 1, 5).expect("valid date"),
            end_date: NaiveDate::from_ymd_opt(2026, 3, 20).expect("valid date"),
            description: "Vacation".to_string(),
            confidence: 0.9,
        };
        let (mut prepared_entries, mut notes, mut details) = prepare_time_off_entries(
            &[request],
            "I'm OOO for a long time",
            &time_off_code_context_for_test(),
        );

        assert!(prepared_entries.len() > 45);
        apply_time_off_entry_cap(&mut prepared_entries, &mut notes, &mut details);

        assert_eq!(prepared_entries.len(), 45);
        assert!(notes
            .iter()
            .any(|note| note.contains("Time off request produced too many entries")));
        assert!(details.iter().any(|detail| {
            detail
                .get("droppedEntryCount")
                .and_then(|value| value.as_i64())
                .is_some_and(|count| count > 0)
        }));
    }

    #[test]
    fn llm_time_off_request_resolves_reversed_range() {
        let request = LlmTimeOffRequest {
            kind: Some("vacation".to_string()),
            start_date: Some("2026-04-10".to_string()),
            end_date: Some("2026-04-06".to_string()),
            description: None,
            confidence: Some(0.9),
        };

        let resolved = resolve_time_off_request(&request).expect("request resolves");

        assert_eq!(
            resolved.start_date,
            NaiveDate::from_ymd_opt(2026, 4, 6).expect("valid date")
        );
        assert_eq!(
            resolved.end_date,
            NaiveDate::from_ymd_opt(2026, 4, 10).expect("valid date")
        );
    }

    #[test]
    fn calendar_ignored_keywords_normalize_case_split_and_dedupe() {
        let values = vec![
            " Lunch ; Personal ".to_string(),
            "lunch\nFocus".to_string(),
            "  ".to_string(),
        ];

        let normalized = normalize_calendar_bulk_ignored_keywords(&values);

        assert_eq!(normalized, vec!["lunch", "personal", "focus"]);
    }

    #[test]
    fn calendar_ignore_matching_uses_case_insensitive_substrings_and_all_day_flag() {
        let keywords = vec!["lunch".to_string()];

        let (is_ignored, reason) = resolve_calendar_candidate_ignored_state(
            "Client Lunch and prep",
            false,
            &keywords,
            true,
        );
        assert!(is_ignored);
        assert_eq!(reason.as_deref(), Some("Matched ignored keyword: lunch"));

        let (is_ignored, reason) = resolve_calendar_candidate_ignored_state("OOO", true, &[], true);
        assert!(is_ignored);
        assert_eq!(reason.as_deref(), Some("All-day event"));

        let (is_ignored, reason) =
            resolve_calendar_candidate_ignored_state("OOO", true, &[], false);
        assert!(!is_ignored);
        assert!(reason.is_none());
    }

    #[test]
    fn calendar_ambiguous_date_uses_selected_date_only_when_day_matches() {
        let selected_date = NaiveDate::from_ymd_opt(2026, 5, 12).expect("valid selected date");
        let mut event = calendar_event_for_test();
        event.weekday = Some("Tuesday".to_string());
        event.day_of_month = Some(12);

        let (date, needs_confirmation) = resolve_calendar_event_date(&event, selected_date);
        assert_eq!(date, "2026-05-12");
        assert!(!needs_confirmation);

        event.weekday = Some("Wednesday".to_string());
        let (date, needs_confirmation) = resolve_calendar_event_date(&event, selected_date);
        assert_eq!(date, "2026-05-12");
        assert!(needs_confirmation);
    }

    #[test]
    fn calendar_time_resolution_uses_visual_duration_for_short_blocks() {
        let mut event = calendar_event_for_test();
        event.start_time = Some("16:00".to_string());
        event.end_time = None;
        event.duration_minutes = Some(30);

        let (start, end, duration, needs_confirmation) = resolve_calendar_event_time(&event);

        assert_eq!(start, 16 * 60);
        assert_eq!(end, 16 * 60 + 30);
        assert_eq!(duration, 30);
        assert!(!needs_confirmation);
    }

    #[test]
    fn calendar_time_resolution_flags_conflicting_duration_evidence() {
        let mut event = calendar_event_for_test();
        event.start_time = Some("16:00".to_string());
        event.end_time = Some("17:00".to_string());
        event.duration_minutes = Some(30);

        let (start, end, duration, needs_confirmation) = resolve_calendar_event_time(&event);

        assert_eq!(start, 16 * 60);
        assert_eq!(end, 17 * 60);
        assert_eq!(duration, 60);
        assert!(needs_confirmation);
    }

    #[test]
    fn calendar_time_resolution_keeps_consistent_duration_evidence_ready() {
        let mut event = calendar_event_for_test();
        event.start_time = Some("16:00".to_string());
        event.end_time = Some("16:30".to_string());
        event.duration_minutes = Some(30);

        let (start, end, duration, needs_confirmation) = resolve_calendar_event_time(&event);

        assert_eq!(start, 16 * 60);
        assert_eq!(end, 16 * 60 + 30);
        assert_eq!(duration, 30);
        assert!(!needs_confirmation);
    }

    #[test]
    fn calendar_source_serializes_as_calendar() {
        assert_eq!(capture_source_label(CaptureSourceId::Calendar), "calendar");
        assert_eq!(
            serde_json::to_string(&CaptureSourceId::Calendar).expect("serializes"),
            "\"calendar\"",
        );
        assert_eq!(
            serde_json::from_str::<CaptureSourceId>("\"calendar\"").expect("deserializes"),
            CaptureSourceId::Calendar,
        );
    }

    #[test]
    fn manual_create_ref_validation_rejects_activity_from_other_engagement() {
        let connection = test_connection();
        let first_engagement_id = db::upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some("E-100".to_string()),
                name: "First Engagement".to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for first engagement.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("first engagement saves");
        let second_engagement_id = db::upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some("E-200".to_string()),
                name: "Second Engagement".to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for second engagement.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("second engagement saves");
        let activity_id = db::upsert_activity(
            &connection,
            ActivityUpsertInput {
                id: None,
                engagement_id: first_engagement_id.clone(),
                code: Some("461".to_string()),
                name: "Planning".to_string(),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for planning.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("activity saves");

        let error = validate_manual_create_refs(
            &connection,
            Some(second_engagement_id.as_str()),
            Some(activity_id.as_str()),
        )
        .expect_err("mismatch should be rejected");

        assert_eq!(error, "activity must belong to the selected engagement");
    }

    #[test]
    fn manual_create_with_codes_stores_refs_without_unmatched_warning() {
        let connection = test_connection();
        let (engagement_id, activity_id) = create_test_engagement_with_activity(&connection);

        let result = create_manual_timeline_entry(
            &connection,
            TimelineCreateInput {
                date: "2026-04-01".to_string(),
                start_minute: 9 * 60,
                end_minute: 9 * 60 + 30,
                engagement_id: Some(engagement_id.clone()),
                activity_id: Some(activity_id.clone()),
                description: None,
            },
        )
        .expect("manual create succeeds");

        let saved_entry = db::list_timeline_entries(&connection, "2026-04-01")
            .expect("entries load")
            .into_iter()
            .find(|entry| entry.id == result.id)
            .expect("entry exists");

        assert_eq!(saved_entry.source, "manual");
        assert_eq!(saved_entry.description, "");
        assert_eq!(saved_entry.confidence, 1.0);
        assert_eq!(
            saved_entry.engagement_id.as_deref(),
            Some(engagement_id.as_str())
        );
        assert_eq!(
            saved_entry.activity_id.as_deref(),
            Some(activity_id.as_str())
        );
        assert!(!saved_entry.warning_flags.contains(&WarningType::Unmatched));
    }

    #[test]
    fn manual_create_without_codes_adds_unmatched_warning() {
        let connection = test_connection();

        let result = create_manual_timeline_entry(
            &connection,
            TimelineCreateInput {
                date: "2026-04-01".to_string(),
                start_minute: 10 * 60,
                end_minute: 10 * 60 + 30,
                engagement_id: None,
                activity_id: None,
                description: None,
            },
        )
        .expect("manual create succeeds");

        let saved_entry = db::list_timeline_entries(&connection, "2026-04-01")
            .expect("entries load")
            .into_iter()
            .find(|entry| entry.id == result.id)
            .expect("entry exists");

        assert_eq!(saved_entry.source, "manual");
        assert!(saved_entry.warning_flags.contains(&WarningType::Unmatched));
    }

    #[test]
    fn calendar_import_entry_validation_trims_values_and_rejects_empty_descriptions() {
        let entry = CalendarImportEntryInput {
            date: "2026-05-12".to_string(),
            start_minute: 9 * 60,
            end_minute: 10 * 60,
            description: "  Client planning  ".to_string(),
            extracted_text: "  Client planning from Outlook  ".to_string(),
            engagement_id: None,
            activity_id: None,
            confidence: 0.88,
        };

        let prepared = validate_calendar_import_entry(&entry).expect("valid entry");
        assert_eq!(prepared.description, "Client planning");
        assert_eq!(prepared.extracted_text, "Client planning from Outlook");
        assert_eq!(prepared.duration_minutes, 60);

        let invalid = CalendarImportEntryInput {
            description: "   ".to_string(),
            ..entry
        };
        assert!(validate_calendar_import_entry(&invalid).is_err());
    }

    #[test]
    fn rounds_to_nearest_quarter_hour() {
        assert_eq!(round_to_nearest_15(7), 0);
        assert_eq!(round_to_nearest_15(8), 15);
        assert_eq!(round_to_nearest_15(44), 45);
        assert_eq!(round_to_nearest_15(53), 60);
    }

    #[test]
    fn timeline_week_bounds_uses_saturday_start_and_friday_end() {
        let (start, end_exclusive) =
            timeline_week_bounds("2026-03-04", TimelineWeekStartDay::Saturday)
                .expect("valid bounds");
        assert_eq!(start, "2026-02-28");
        assert_eq!(end_exclusive, "2026-03-07");
    }

    #[test]
    fn timeline_week_bounds_can_use_sunday_start() {
        let (start, end_exclusive) =
            timeline_week_bounds("2026-03-04", TimelineWeekStartDay::Sunday).expect("valid bounds");
        assert_eq!(start, "2026-03-01");
        assert_eq!(end_exclusive, "2026-03-08");
    }

    #[test]
    fn timeline_week_bounds_can_use_monday_start() {
        let (start, end_exclusive) =
            timeline_week_bounds("2026-03-04", TimelineWeekStartDay::Monday).expect("valid bounds");
        assert_eq!(start, "2026-03-02");
        assert_eq!(end_exclusive, "2026-03-09");
    }

    #[test]
    fn timeline_week_view_bounds_uses_sunday_start_and_saturday_end() {
        let (start, end_exclusive) =
            timeline_week_view_bounds("2026-04-01", TimelineWeekStartDay::Sunday)
                .expect("valid bounds");
        assert_eq!(start, "2026-03-29");
        assert_eq!(end_exclusive, "2026-04-05");
    }

    #[test]
    fn timeline_week_view_bounds_can_use_saturday_start() {
        let (start, end_exclusive) =
            timeline_week_view_bounds("2026-04-01", TimelineWeekStartDay::Saturday)
                .expect("valid bounds");
        assert_eq!(start, "2026-03-28");
        assert_eq!(end_exclusive, "2026-04-04");
    }

    #[test]
    fn timeline_week_view_bounds_can_use_monday_start() {
        let (start, end_exclusive) =
            timeline_week_view_bounds("2026-04-01", TimelineWeekStartDay::Monday)
                .expect("valid bounds");
        assert_eq!(start, "2026-03-30");
        assert_eq!(end_exclusive, "2026-04-06");
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
    fn openai_key_configured_setting_defaults_to_false() {
        let connection = test_connection();

        assert!(read_saved_openai_key_configured_marker(&connection)
            .expect("missing key marker should resolve")
            .is_none());
        assert!(!read_saved_openai_key_configured(&connection)
            .expect("missing key setting should resolve"));
    }

    #[test]
    fn openai_key_configured_setting_reads_saved_true_value() {
        let connection = test_connection();
        db::upsert_app_setting(&connection, APP_SETTING_OPENAI_KEY_CONFIGURED, "true")
            .expect("setting should save");

        assert!(read_saved_openai_key_configured(&connection)
            .expect("saved key setting should resolve"));
    }

    #[test]
    fn saved_openai_model_defaults_when_missing_or_invalid() {
        let (missing_model, missing_invalid_value) = resolve_saved_openai_model_value(None);
        assert_eq!(missing_model, OpenAiModelId::Gpt55Instant);
        assert!(missing_invalid_value.is_none());

        let (legacy_gpt55_model, legacy_gpt55_invalid_value) =
            resolve_saved_openai_model_value(Some("gpt-5.5".to_string()));
        assert_eq!(legacy_gpt55_model, OpenAiModelId::Gpt55Instant);
        assert!(legacy_gpt55_invalid_value.is_none());

        let (saved_model, saved_invalid_value) =
            resolve_saved_openai_model_value(Some("gpt-5.5-high".to_string()));
        assert_eq!(saved_model, OpenAiModelId::Gpt55High);
        assert!(saved_invalid_value.is_none());

        let (invalid_model, invalid_value) =
            resolve_saved_openai_model_value(Some("gpt-5-nano".to_string()));
        assert_eq!(invalid_model, OpenAiModelId::Gpt55Instant);
        assert_eq!(invalid_value.as_deref(), Some("gpt-5-nano"));
    }

    #[test]
    fn saved_calendar_bulk_model_defaults_to_gpt55_instant_when_missing_or_invalid() {
        let (missing_model, missing_invalid_value) = resolve_saved_calendar_bulk_model_value(None);
        assert_eq!(missing_model, OpenAiModelId::Gpt55Instant);
        assert!(missing_invalid_value.is_none());

        let (saved_model, saved_invalid_value) =
            resolve_saved_calendar_bulk_model_value(Some("gpt-5.5-medium".to_string()));
        assert_eq!(saved_model, OpenAiModelId::Gpt55Medium);
        assert!(saved_invalid_value.is_none());

        let (invalid_model, invalid_value) =
            resolve_saved_calendar_bulk_model_value(Some("gpt-5.4".to_string()));
        assert_eq!(invalid_model, OpenAiModelId::Gpt55Instant);
        assert_eq!(invalid_value.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn requested_openai_model_override_takes_precedence() {
        assert_eq!(
            resolve_requested_openai_model(
                Some(OpenAiModelId::Gpt55High),
                OpenAiModelId::Gpt55Instant
            ),
            OpenAiModelId::Gpt55High
        );
        assert_eq!(
            resolve_requested_openai_model(None, OpenAiModelId::Gpt55Low),
            OpenAiModelId::Gpt55Low
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
        assert_eq!(state.version, 3);
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
                    columns: vec![test_free_text_column("free-text", "Notes")],
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
                    test_free_text_column(" free-text ", " Notes "),
                ],
            }],
        })
        .expect("state should normalize");

        assert_eq!(normalized.version, 3);
        assert_eq!(normalized.selected_preset_id, "preset-a");
        assert_eq!(normalized.presets[0].name, "Working Layout");
        match &normalized.presets[0].columns[2] {
            SummaryLayoutColumn::FreeText {
                id,
                label,
                row_values,
                repeat,
                repeat_value,
                repeat_row_key,
            } => {
                assert_eq!(id, "free-text");
                assert_eq!(label, "Notes");
                assert!(row_values.is_empty());
                assert!(!repeat);
                assert!(repeat_value.is_empty());
                assert!(repeat_row_key.is_none());
            }
            _ => panic!("expected free-text column"),
        }
        assert!(matches!(
            normalized.presets[0].columns[3],
            SummaryLayoutColumn::RowTotal { .. }
        ));
    }

    #[test]
    fn summary_layout_state_defaults_legacy_free_text_metadata() {
        let state: SummaryLayoutState = serde_json::from_value(serde_json::json!({
            "version": 2,
            "selectedPresetId": "preset-a",
            "presets": [{
                "id": "preset-a",
                "name": "Legacy Free Text",
                "columns": [{
                    "kind": "freeText",
                    "id": "free-text",
                    "label": "Client Ref"
                }]
            }]
        }))
        .expect("legacy free-text JSON should deserialize");

        let normalized = normalize_summary_layout_state(state).expect("state should normalize");
        assert_eq!(normalized.version, 3);
        match &normalized.presets[0].columns[0] {
            SummaryLayoutColumn::FreeText {
                row_values,
                repeat,
                repeat_value,
                repeat_row_key,
                ..
            } => {
                assert!(row_values.is_empty());
                assert!(!repeat);
                assert!(repeat_value.is_empty());
                assert!(repeat_row_key.is_none());
            }
            _ => panic!("expected free-text column"),
        }
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
                engagement_type: Some(EngagementType::External),
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
            day_total_breakdowns: vec![
                TimelineTotalBreakdown {
                    primary_minutes: 120,
                    external_minutes: 120,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 60,
                    external_minutes: 60,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 0,
                    external_minutes: 0,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 0,
                    external_minutes: 0,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 0,
                    external_minutes: 0,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 0,
                    external_minutes: 0,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
                TimelineTotalBreakdown {
                    primary_minutes: 0,
                    external_minutes: 0,
                    internal_minutes: 0,
                    uncategorized_minutes: 0,
                },
            ],
            week_total_breakdown: TimelineTotalBreakdown {
                primary_minutes: 180,
                external_minutes: 180,
                internal_minutes: 0,
                uncategorized_minutes: 0,
            },
        }
    }

    fn test_engagements() -> Vec<Engagement> {
        vec![Engagement {
            id: "eng-1".to_string(),
            code: Some("ENG-1".to_string()),
            name: "Client Work".to_string(),
            client: Some("Acme".to_string()),
            engagement_type: EngagementType::External,
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
    fn timeline_preferences_filter_weekly_summary_primary_totals() {
        let mut summary = test_weekly_summary();
        summary.day_total_breakdowns[0] = TimelineTotalBreakdown {
            primary_minutes: 165,
            external_minutes: 120,
            internal_minutes: 30,
            uncategorized_minutes: 15,
        };
        summary.week_total_breakdown = TimelineTotalBreakdown {
            primary_minutes: 225,
            external_minutes: 180,
            internal_minutes: 30,
            uncategorized_minutes: 15,
        };

        apply_timeline_preferences_to_weekly_summary(
            &mut summary,
            TimelinePreferenceValues {
                exclude_uncategorized_from_totals: true,
                show_uncategorized_total: true,
                include_external_in_totals: true,
                include_internal_in_totals: false,
                separate_engagement_type_totals: true,
                week_start_day: TimelineWeekStartDay::Sunday,
            },
        );

        assert_eq!(summary.day_total_minutes[0], 120);
        assert_eq!(summary.day_total_minutes[1], 60);
        assert_eq!(summary.week_total_minutes, 180);
        assert_eq!(summary.week_total_breakdown.external_minutes, 180);
        assert_eq!(summary.week_total_breakdown.internal_minutes, 30);
        assert_eq!(summary.week_total_breakdown.uncategorized_minutes, 15);

        apply_timeline_preferences_to_weekly_summary(
            &mut summary,
            TimelinePreferenceValues {
                exclude_uncategorized_from_totals: false,
                show_uncategorized_total: true,
                include_external_in_totals: true,
                include_internal_in_totals: true,
                separate_engagement_type_totals: true,
                week_start_day: TimelineWeekStartDay::Sunday,
            },
        );

        assert_eq!(summary.day_total_minutes[0], 165);
        assert_eq!(summary.week_total_minutes, 225);
    }

    #[test]
    fn timeline_preferences_reject_disabling_external_and_internal_totals() {
        let error = validate_timeline_preferences(TimelinePreferenceValues {
            exclude_uncategorized_from_totals: true,
            show_uncategorized_total: true,
            include_external_in_totals: false,
            include_internal_in_totals: false,
            separate_engagement_type_totals: true,
            week_start_day: TimelineWeekStartDay::Sunday,
        })
        .expect_err("both included categories cannot be disabled");

        assert_eq!(
            error,
            "at least one of external or internal type codes must be included in totals"
        );
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
                test_free_text_column(" free-text ", " Notes Slot "),
            ],
        })
        .expect("preset should normalize");

        assert_eq!(normalized.id, "preset-a");
        assert_eq!(normalized.name, "Export Layout");
        match &normalized.columns[1] {
            SummaryLayoutColumn::FreeText {
                id,
                label,
                row_values,
                repeat,
                repeat_value,
                repeat_row_key,
            } => {
                assert_eq!(id, "free-text");
                assert_eq!(label, "Notes Slot");
                assert!(row_values.is_empty());
                assert!(!repeat);
                assert!(repeat_value.is_empty());
                assert!(repeat_row_key.is_none());
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
            assert_eq!(
                columns.len(),
                3,
                "{label} preset should keep three export columns"
            );
            assert!(
                matches!(
                    &columns[row_total_index].kind,
                    SummaryExportSheetColumnKind::RowTotal
                ),
                "{label} preset should keep Row Total at the requested position"
            );
        }
    }

    #[test]
    fn hours_and_notes_export_preserves_free_text_columns() {
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
                test_free_text_column("free-text-adjacent", "Custom Notes"),
                SummaryLayoutColumn::Day {
                    id: "day-1".to_string(),
                    day_index: 1,
                },
                SummaryLayoutColumn::Field {
                    id: "field-client-name".to_string(),
                    field_key: SummaryLayoutFieldKey::ClientName,
                },
                test_free_text_column("free-text-later", "Later Blank"),
                SummaryLayoutColumn::RowTotal {
                    id: "row-total".to_string(),
                },
            ],
        };

        let columns = build_summary_export_hours_and_notes_sheet_columns(&summary, &preset);
        assert_eq!(columns.len(), 9);
        assert!(matches!(
            &columns[0].kind,
            SummaryExportSheetColumnKind::Field(SummaryLayoutFieldKey::EngagementCode)
        ));
        assert!(matches!(
            &columns[1].kind,
            SummaryExportSheetColumnKind::DayHours(0)
        ));
        assert!(matches!(
            &columns[2].kind,
            SummaryExportSheetColumnKind::DayNotes(0)
        ));
        assert_eq!(columns[2].header, summary_day_notes_header(&summary, 0));
        assert!(matches!(
            &columns[3].kind,
            SummaryExportSheetColumnKind::FreeText(_)
        ));
        assert_eq!(columns[3].header, "Custom Notes");
        assert!(matches!(
            &columns[4].kind,
            SummaryExportSheetColumnKind::DayHours(1)
        ));
        assert!(matches!(
            &columns[5].kind,
            SummaryExportSheetColumnKind::DayNotes(1)
        ));
        assert!(matches!(
            &columns[6].kind,
            SummaryExportSheetColumnKind::Field(SummaryLayoutFieldKey::ClientName)
        ));
        assert!(matches!(
            &columns[7].kind,
            SummaryExportSheetColumnKind::FreeText(_)
        ));
        assert_eq!(columns[7].header, "Later Blank");
        assert!(matches!(
            &columns[8].kind,
            SummaryExportSheetColumnKind::RowTotal
        ));
    }

    #[test]
    fn summary_export_free_text_uses_per_row_values() {
        let summary = test_weekly_summary();
        let mut row_values = std::collections::HashMap::new();
        row_values.insert("activity:act-1".to_string(), "Ticket ABC".to_string());
        let preset = SummaryLayoutPreset {
            id: "preset-export".to_string(),
            name: "Export".to_string(),
            columns: vec![
                SummaryLayoutColumn::FreeText {
                    id: "free-text-ticket".to_string(),
                    label: "Ticket".to_string(),
                    row_values,
                    repeat: false,
                    repeat_value: "Ignored repeat".to_string(),
                    repeat_row_key: Some("activity:act-1".to_string()),
                },
                SummaryLayoutColumn::RowTotal {
                    id: "row-total".to_string(),
                },
            ],
        };

        let columns = build_summary_export_hours_sheet_columns(&summary, &preset);
        match &columns[0].kind {
            SummaryExportSheetColumnKind::FreeText(free_text) => {
                assert_eq!(
                    resolve_summary_export_free_text_value(free_text, &summary.rows[0]),
                    "Ticket ABC"
                );
            }
            _ => panic!("expected free-text column"),
        }
    }

    #[test]
    fn summary_export_free_text_repeat_value_overrides_per_row_values() {
        let summary = test_weekly_summary();
        let mut row_values = std::collections::HashMap::new();
        row_values.insert("activity:act-1".to_string(), "Per-row value".to_string());
        let preset = SummaryLayoutPreset {
            id: "preset-export".to_string(),
            name: "Export".to_string(),
            columns: vec![
                SummaryLayoutColumn::Day {
                    id: "day-0".to_string(),
                    day_index: 0,
                },
                SummaryLayoutColumn::FreeText {
                    id: "free-text-role".to_string(),
                    label: "Role".to_string(),
                    row_values,
                    repeat: true,
                    repeat_value: "Senior Associate".to_string(),
                    repeat_row_key: Some("activity:act-1".to_string()),
                },
                SummaryLayoutColumn::RowTotal {
                    id: "row-total".to_string(),
                },
            ],
        };

        let columns = build_summary_export_hours_and_notes_sheet_columns(&summary, &preset);
        assert!(matches!(
            &columns[1].kind,
            SummaryExportSheetColumnKind::DayNotes(0)
        ));
        match &columns[2].kind {
            SummaryExportSheetColumnKind::FreeText(free_text) => {
                assert_eq!(
                    resolve_summary_export_free_text_value(free_text, &summary.rows[0]),
                    "Senior Associate"
                );
            }
            _ => panic!("expected free-text column after generated notes column"),
        }
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
            engagement_type: None,
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
            "about to spend 30 minutes on SAP"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "will spend 30 minutes on pcc later"
        ));
    }

    #[test]
    fn implicit_recent_duration_detection_excludes_contextual_day_or_date_wording() {
        assert!(message_has_contextual_day_or_date_cue(
            "this morning I spent 30 minutes on SAP ITGCs"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "this morning I spent 30 minutes on SAP ITGCs"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "yesterday I spent 30 minutes on SAP ITGCs"
        ));
        assert!(!message_has_implicit_recent_duration_cue(
            "tonight 30 minutes on SAP ITGCs"
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
    fn normalization_overrides_llm_times_for_capture_anchored_bare_duration() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-05-09".to_string()),
            start_time: Some("15:10".to_string()),
            end_time: Some("15:40".to_string()),
            duration_minutes: Some(30),
            description: Some("30 minutes to SAP ITGCs".to_string()),
            sequence_relation: None,
            duration_source: None,
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 5, 9).expect("valid date"),
            rounded_end_minute: 885,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "30 minutes to SAP ITGCs.",
            TemporalCueType::ImplicitRecentDuration,
        );

        assert!(!result.used_temporal_fallback);
        assert!(!result.duration_defaulted);
        assert_eq!(
            result.temporal_source,
            "derived_from_capture_duration_override"
        );
        assert_eq!(result.entry.start_minute, 855);
        assert_eq!(result.entry.end_minute, 885);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_overrides_spent_duration_worklog_to_capture_window() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-05-09".to_string()),
            start_time: Some("15:10".to_string()),
            end_time: Some("15:40".to_string()),
            duration_minutes: Some(30),
            description: Some("Spent 30 minutes on SAP".to_string()),
            sequence_relation: None,
            duration_source: None,
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 5, 9).expect("valid date"),
            rounded_end_minute: 885,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "spent 30 minutes on SAP",
            TemporalCueType::ImplicitRecentDuration,
        );

        assert_eq!(
            result.temporal_source,
            "derived_from_capture_duration_override"
        );
        assert_eq!(result.entry.start_minute, 855);
        assert_eq!(result.entry.end_minute, 885);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_keeps_explicit_clock_duration_times() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-05-09".to_string()),
            start_time: Some("15:00".to_string()),
            end_time: Some("15:30".to_string()),
            duration_minutes: Some(30),
            description: Some("30 minutes at 3pm for SAP".to_string()),
            sequence_relation: None,
            duration_source: None,
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 5, 9).expect("valid date"),
            rounded_end_minute: 885,
        };

        let result = normalize_llm_entry(
            &entry,
            &reference,
            "30 minutes at 3pm for SAP",
            TemporalCueType::ExplicitClock,
        );

        assert_eq!(result.temporal_source, "llm_start_end");
        assert_eq!(result.entry.start_minute, 900);
        assert_eq!(result.entry.end_minute, 930);
        assert_eq!(result.entry.duration_minutes, 30);
    }

    #[test]
    fn normalization_does_not_capture_anchor_future_planned_duration() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-05-09".to_string()),
            start_time: Some("15:10".to_string()),
            end_time: Some("15:40".to_string()),
            duration_minutes: Some(30),
            description: Some("Going to spend 30 minutes on SAP".to_string()),
            sequence_relation: None,
            duration_source: None,
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 5, 9).expect("valid date"),
            rounded_end_minute: 885,
        };

        assert!(!message_has_implicit_recent_duration_cue(
            "going to spend 30 minutes on SAP"
        ));

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert_eq!(result.temporal_source, "llm_start_end");
        assert_eq!(result.entry.start_minute, 915);
        assert_eq!(result.entry.end_minute, 945);
    }

    #[test]
    fn normalization_does_not_capture_anchor_contextual_day_part_duration() {
        let entry = LlmEntry {
            engagement_ref: Some("eng-123".to_string()),
            activity_ref: Some("act-01".to_string()),
            date: Some("2026-05-09".to_string()),
            start_time: Some("09:30".to_string()),
            end_time: Some("10:00".to_string()),
            duration_minutes: Some(30),
            description: Some("This morning I spent 30 minutes on SAP".to_string()),
            sequence_relation: None,
            duration_source: None,
            activity_reason: None,
            alternative_activities: None,
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 5, 9).expect("valid date"),
            rounded_end_minute: 885,
        };

        assert!(!message_has_implicit_recent_duration_cue(
            "this morning I spent 30 minutes on SAP"
        ));

        let result = normalize_llm_entry(&entry, &reference, "fallback", TemporalCueType::None);

        assert_eq!(result.temporal_source, "llm_start_end");
        assert_eq!(result.entry.start_minute, 570);
        assert_eq!(result.entry.end_minute, 600);
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
            sequence_relation: None,
            duration_source: None,
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
    fn sequencing_removes_llm_gap_after_that_with_explicit_duration() {
        let mut entries = vec![
            prepared_entry_for_test(930, 960, 30),
            prepared_entry_for_test(990, 1050, 60),
        ];
        let contexts = vec![
            SequencingEntryContext {
                raw_duration: Some(30),
                ..SequencingEntryContext::default()
            },
            SequencingEntryContext {
                raw_duration: Some(60),
                ..SequencingEntryContext::default()
            },
        ];

        let adjustments = apply_multi_event_sequence_adjustments(
            &mut entries,
            &contexts,
            "About to spend 30 minutes with PT on FF ITGCs. After that, an hour on Non-SAP ITGCs.",
        );

        assert!(!adjustments[0].applied);
        assert!(adjustments[1].applied);
        assert_eq!(entries[1].entry.start_minute, 960);
        assert_eq!(entries[1].entry.end_minute, 1020);
        assert_eq!(entries[1].entry.duration_minutes, 60);
        assert!(!entries[1].duration_defaulted);
        assert!(!entries[1].used_temporal_fallback);
    }

    #[test]
    fn sequencing_defaults_missing_followup_duration_to_thirty_minutes() {
        let mut entries = vec![
            prepared_entry_for_test(780, 810, 30),
            PreparedEntry {
                used_temporal_fallback: true,
                fallback_summary: Some("Temporal fallback applied".to_string()),
                ..prepared_entry_for_test(900, 930, 30)
            },
        ];
        let contexts = vec![
            SequencingEntryContext {
                raw_duration: Some(30),
                ..SequencingEntryContext::default()
            },
            SequencingEntryContext {
                raw_duration: Some(60),
                ..SequencingEntryContext::default()
            },
        ];

        let adjustments = apply_multi_event_sequence_adjustments(
            &mut entries,
            &contexts,
            "At 1pm today, I worked on FF ITGcs. Then I worked on PCC report 1.",
        );

        assert!(adjustments[1].applied);
        assert_eq!(entries[1].entry.start_minute, 810);
        assert_eq!(entries[1].entry.end_minute, 840);
        assert_eq!(entries[1].entry.duration_minutes, 30);
        assert!(entries[1].duration_defaulted);
        assert!(!entries[1].used_temporal_fallback);
        assert_eq!(entries[1].fallback_summary, None);
    }

    #[test]
    fn sequencing_preserves_independent_explicit_followup_time() {
        let mut entries = vec![
            prepared_entry_for_test(780, 810, 30),
            prepared_entry_for_test(900, 930, 30),
        ];
        let contexts = vec![
            SequencingEntryContext::default(),
            SequencingEntryContext::default(),
        ];

        let adjustments = apply_multi_event_sequence_adjustments(
            &mut entries,
            &contexts,
            "At 1pm I worked on FF ITGCs. Then at 3pm I worked on PCC report 1.",
        );

        assert!(!adjustments[1].applied);
        assert_eq!(adjustments[1].reason, Some("independent_explicit_time"));
        assert_eq!(entries[1].entry.start_minute, 900);
        assert_eq!(entries[1].entry.end_minute, 930);
    }

    #[test]
    fn sequencing_leaves_non_sequential_multi_event_messages_unchanged() {
        let mut entries = vec![
            prepared_entry_for_test(780, 810, 30),
            prepared_entry_for_test(900, 930, 30),
        ];
        let contexts = vec![
            SequencingEntryContext::default(),
            SequencingEntryContext::default(),
        ];

        let adjustments = apply_multi_event_sequence_adjustments(
            &mut entries,
            &contexts,
            "30 minutes on FF ITGCs and 30 minutes on PCC report 1.",
        );

        assert!(!adjustments[1].applied);
        assert_eq!(entries[1].entry.start_minute, 900);
        assert_eq!(entries[1].entry.end_minute, 930);
    }

    #[test]
    fn sequencing_uses_llm_sequence_metadata_when_segments_do_not_map_cleanly() {
        let mut entries = vec![
            prepared_entry_for_test(780, 810, 30),
            prepared_entry_for_test(900, 930, 30),
            prepared_entry_for_test(960, 990, 30),
        ];
        let contexts = vec![
            SequencingEntryContext::default(),
            SequencingEntryContext::default(),
            SequencingEntryContext {
                llm_sequence_relation: Some("startsAfterPrevious".to_string()),
                llm_duration_source: Some("defaulted".to_string()),
                ..SequencingEntryContext::default()
            },
        ];

        let adjustments = apply_multi_event_sequence_adjustments(
            &mut entries,
            &contexts,
            "At 1pm I worked on FF ITGCs. I also worked on SAP ITGCs. Then I worked on PCC report 1.",
        );

        assert!(!adjustments[1].applied);
        assert!(adjustments[2].applied);
        assert_eq!(entries[2].entry.start_minute, 930);
        assert_eq!(entries[2].entry.end_minute, 960);
        assert!(entries[2].duration_defaulted);
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
