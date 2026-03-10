use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime};
use keyring::{Entry, Error as KeyringError};
use rust_xlsxwriter::{Format, Workbook, XlsxError};
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{Manager, State};
use uuid::Uuid;

use crate::code_reconciliation::reconcile_codes;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{
    ActivityUpsertInput, ApiKeyInput, CodeContext, ContextActivity, ContextEngagement, DateInput,
    DiagnosticsBundle, DiagnosticsEvent, DiagnosticsListInput, DiagnosticsRecordInput, Engagement,
    EngagementUpsertInput, IdInput, IdResult, InterpretResult, InterpretTextInput, KeySource,
    LlmAlternativeActivity, LlmEntry, NormalizedEntry, SettingsStatus, StatusLevel, StorageHealth,
    SummaryExportResult, TimelineDaySummary, TimelineEntry, TimelineMonthSummaryInput,
    TimelineUpdateInput, TimelineWeeklySummary, TimelineWeeklySummaryNote, Warning, WarningType,
};
use crate::openai;
use crate::state::AppState;

const MINUTES_IN_DAY: i64 = 24 * 60;
const TIME_INCREMENT_MINUTES: i64 = 15;
const DEFAULT_FALLBACK_DURATION_MINUTES: i64 = 30;
const ACTIVITY_FALLBACK_CONFIDENCE_CAP: f64 = 0.60;
const ACTIVITY_MATCH_SCORE_EPSILON: f64 = 1e-6;
const MAX_SAVED_ENTRIES_PER_MESSAGE: usize = 8;
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
        .map(|note| format!("{:.2} Hours: {}", format_minutes_as_hours(note.duration_minutes), note.description))
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

fn write_weekly_hours_sheet(
    workbook: &mut Workbook,
    summary: &TimelineWeeklySummary,
) -> Result<(), XlsxError> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("Weekly Hours")?;
    worksheet.set_freeze_panes(1, 0)?;

    let header_format = Format::new().set_bold();
    let hours_format = Format::new().set_num_format("0.00");

    let mut col: u16 = 0;
    let static_headers = [
        "Engagement Code",
        "Activity Code",
        "Activity Name",
        "Engagement Name",
        "Client Name",
    ];
    for header in static_headers {
        worksheet.write_with_format(0, col, header, &header_format)?;
        col += 1;
    }

    for (day_index, day) in summary.days.iter().enumerate() {
        worksheet.write_with_format(0, col, summary_day_header(day_index, &day.date), &header_format)?;
        col += 1;
    }

    worksheet.write_with_format(0, col, "Row Total", &header_format)?;

    worksheet.set_column_width(0, 16)?;
    worksheet.set_column_width(1, 14)?;
    worksheet.set_column_width(2, 24)?;
    worksheet.set_column_width(3, 24)?;
    worksheet.set_column_width(4, 20)?;
    for day_offset in 0..summary.days.len() {
        worksheet.set_column_width(5 + day_offset as u16, 12)?;
    }
    worksheet.set_column_width(5 + summary.days.len() as u16, 12)?;

    let mut row_index: u32 = 1;
    for row in &summary.rows {
        worksheet.write(row_index, 0, row.engagement_code.as_str())?;
        worksheet.write(row_index, 1, row.activity_code.as_str())?;
        worksheet.write(row_index, 2, row.activity_name.as_str())?;
        worksheet.write(row_index, 3, row.engagement_name.as_str())?;
        let client_name = if row.client_name.trim().is_empty() {
            "-"
        } else {
            row.client_name.as_str()
        };
        worksheet.write(row_index, 4, client_name)?;

        for (day_index, cell) in row.cells.iter().enumerate() {
            worksheet.write_with_format(
                row_index,
                5 + day_index as u16,
                format_minutes_as_hours(cell.total_minutes),
                &hours_format,
            )?;
        }

        worksheet.write_with_format(
            row_index,
            5 + summary.days.len() as u16,
            format_minutes_as_hours(row.row_total_minutes),
            &hours_format,
        )?;

        row_index += 1;
    }

    worksheet.write_with_format(row_index, 0, "Day Totals", &header_format)?;
    for (day_index, total_minutes) in summary.day_total_minutes.iter().enumerate() {
        worksheet.write_with_format(
            row_index,
            5 + day_index as u16,
            format_minutes_as_hours(*total_minutes),
            &hours_format,
        )?;
    }
    worksheet.write_with_format(
        row_index,
        5 + summary.days.len() as u16,
        format_minutes_as_hours(summary.week_total_minutes),
        &hours_format,
    )?;

    Ok(())
}

fn write_weekly_hours_and_notes_sheet(
    workbook: &mut Workbook,
    summary: &TimelineWeeklySummary,
) -> Result<(), XlsxError> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("Weekly Hours + Notes")?;
    worksheet.set_freeze_panes(1, 0)?;

    let header_format = Format::new().set_bold();
    let hours_format = Format::new().set_num_format("0.00");
    let notes_format = Format::new().set_text_wrap();

    let mut col: u16 = 0;
    let static_headers = [
        "Engagement Code",
        "Activity Code",
        "Activity Name",
        "Engagement Name",
        "Client Name",
    ];
    for header in static_headers {
        worksheet.write_with_format(0, col, header, &header_format)?;
        col += 1;
    }

    for (day_index, day) in summary.days.iter().enumerate() {
        let header = summary_day_header(day_index, &day.date);
        worksheet.write_with_format(0, col, format!("{header} Hours"), &header_format)?;
        col += 1;
        worksheet.write_with_format(0, col, format!("{header} Notes"), &header_format)?;
        col += 1;
    }

    worksheet.write_with_format(0, col, "Row Total", &header_format)?;

    worksheet.set_column_width(0, 16)?;
    worksheet.set_column_width(1, 14)?;
    worksheet.set_column_width(2, 24)?;
    worksheet.set_column_width(3, 24)?;
    worksheet.set_column_width(4, 20)?;
    for day_index in 0..summary.days.len() {
        let base_col = 5 + (day_index as u16 * 2);
        worksheet.set_column_width(base_col, 12)?;
        worksheet.set_column_width(base_col + 1, 42)?;
    }
    worksheet.set_column_width(5 + (summary.days.len() as u16 * 2), 12)?;

    let mut row_index: u32 = 1;
    for row in &summary.rows {
        worksheet.write(row_index, 0, row.engagement_code.as_str())?;
        worksheet.write(row_index, 1, row.activity_code.as_str())?;
        worksheet.write(row_index, 2, row.activity_name.as_str())?;
        worksheet.write(row_index, 3, row.engagement_name.as_str())?;
        let client_name = if row.client_name.trim().is_empty() {
            "-"
        } else {
            row.client_name.as_str()
        };
        worksheet.write(row_index, 4, client_name)?;

        for (day_index, cell) in row.cells.iter().enumerate() {
            let hours_col = 5 + (day_index as u16 * 2);
            let notes_col = hours_col + 1;
            worksheet.write_with_format(
                row_index,
                hours_col,
                format_minutes_as_hours(cell.total_minutes),
                &hours_format,
            )?;
            worksheet.write_with_format(
                row_index,
                notes_col,
                format_summary_notes_for_export(&cell.notes),
                &notes_format,
            )?;
        }

        worksheet.write_with_format(
            row_index,
            5 + (summary.days.len() as u16 * 2),
            format_minutes_as_hours(row.row_total_minutes),
            &hours_format,
        )?;

        row_index += 1;
    }

    worksheet.write_with_format(row_index, 0, "Day Totals", &header_format)?;
    for (day_index, total_minutes) in summary.day_total_minutes.iter().enumerate() {
        let day_hours_col = 5 + (day_index as u16 * 2);
        worksheet.write_with_format(
            row_index,
            day_hours_col,
            format_minutes_as_hours(*total_minutes),
            &hours_format,
        )?;
    }
    worksheet.write_with_format(
        row_index,
        5 + (summary.days.len() as u16 * 2),
        format_minutes_as_hours(summary.week_total_minutes),
        &hours_format,
    )?;

    Ok(())
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
    None,
}

fn temporal_cue_type_label(value: TemporalCueType) -> &'static str {
    match value {
        TemporalCueType::ExplicitClock => "explicit_clock",
        TemporalCueType::RelativeDuration => "relative_duration",
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
    llm_activity_code: Option<String>,
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
    chosen_activity_code: Option<String>,
    chosen_activity_name: Option<String>,
    chosen_score: Option<f64>,
    matched_terms: Vec<String>,
    note: Option<String>,
}

#[derive(Debug, Clone)]
struct ActivityCandidateMatch {
    code: String,
    name: String,
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
        entry.entry.engagement_code.as_deref().unwrap_or(""),
        entry.entry.activity_code.as_deref().unwrap_or(""),
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

    let status = SettingsStatus {
        has_open_ai_key: key_status.has_open_ai_key,
        storage_health: key_status.storage_health.clone(),
        key_source: key_status.key_source.clone(),
        status_level: key_status.status_level.clone(),
        last_error: key_status.last_error.clone(),
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
pub fn summary_export_weekly_excel(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: DateInput,
) -> Result<SummaryExportResult, String> {
    let (start_date, end_date_exclusive) = timeline_week_bounds(&input.date)?;
    let summary = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        db::list_timeline_weekly_summary(&connection, &start_date, &end_date_exclusive)
            .map_err(|error| error.to_string())?
    };

    let week_end_date = summary.week_end_date.clone();
    let downloads_dir = resolve_downloads_dir(&app)?;
    let base_name = format!(
        "OmniSheet_Weekly_Summary_{}_to_{}",
        summary.week_start_date, week_end_date
    );
    let file_path = choose_export_file_path(&downloads_dir, &base_name);

    let mut workbook = Workbook::new();
    write_weekly_hours_sheet(&mut workbook, &summary)
        .map_err(|error| format!("failed to build Weekly Hours sheet: {error}"))?;
    write_weekly_hours_and_notes_sheet(&mut workbook, &summary)
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

    let (start_minute, end_minute, duration_minutes) =
        normalize_update_window(input.start_minute, input.end_minute);

    db::update_timeline_entry(
        &connection,
        &input.id,
        input.date.trim(),
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

    if input.date != previous_date {
        let _ = db::recompute_overlap_warnings(&connection, input.date.trim())
            .map_err(|error| error.to_string())?;
    }

    Ok(())
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

    let code_context = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        match db::load_code_context(&connection) {
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
        }
    };

    let llm_started_at = Instant::now();
    let mut llm_attempts = Vec::<openai::LlmAttemptTelemetry>::new();
    let llm_result = openai::interpret_message(
        &state.http_client,
        &api_key,
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

    record_llm_attempt_events(&state, &correlation_id, command, &llm_attempts);
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
        let code_reconciliation = reconcile_codes(&mut result.entry, &code_context);
        let activity_fallback = apply_activity_fallback_if_needed(
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

        if code_reconciliation.applied {
            normalization_notes.push(format!(
                "Code reconciliation applied ({})",
                code_reconciliation.reason.as_str()
            ));
        }

        if result.used_temporal_fallback {
            fallback_count += 1;
        }

        let used_activity_fallback = activity_fallback.applied;
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
          "llmChosenActivityCode": result.llm_activity_code,
          "llmActivityReason": result.llm_activity_reason,
          "llmAlternativeActivities": result.llm_alternative_activities,
          "originalEngagementCode": code_reconciliation.original_engagement_code,
          "originalActivityCode": code_reconciliation.original_activity_code,
          "savedEngagementCode": result.entry.engagement_code,
          "savedActivityCode": result.entry.activity_code,
          "savedConfidence": result.entry.confidence,
          "reconciliationApplied": code_reconciliation.applied,
          "reconciliationReason": code_reconciliation.reason.as_str(),
          "reconciliationAmbiguousCandidateCount": code_reconciliation.ambiguous_candidate_count,
          "reconciledEngagementCode": code_reconciliation.reconciled_engagement_code,
          "reconciledActivityCode": code_reconciliation.reconciled_activity_code,
          "attemptedActivityFallback": activity_fallback.attempted,
          "usedActivityFallback": activity_fallback.applied,
          "activityFallbackReason": activity_fallback.reason,
          "activityFallbackCandidateCount": activity_fallback.candidate_count,
          "activityFallbackChosenCode": activity_fallback.chosen_activity_code,
          "activityFallbackChosenName": activity_fallback.chosen_activity_name,
          "activityFallbackScore": activity_fallback.chosen_score,
          "activityFallbackMatchedTerms": activity_fallback.matched_terms,
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
          "llmChosenActivityCode": null,
          "llmActivityReason": null,
          "llmAlternativeActivities": null,
          "originalEngagementCode": null,
          "originalActivityCode": null,
          "reconciliationApplied": false,
          "reconciliationReason": null,
          "reconciliationAmbiguousCandidateCount": 0,
          "reconciledEngagementCode": null,
          "reconciledActivityCode": null,
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
            let (engagement_id, activity_id) = db::resolve_code_ids(
                &connection,
                normalized_entry.engagement_code.as_deref(),
                normalized_entry.activity_code.as_deref(),
            )
            .map_err(|error| error.to_string())?;

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
                "text",
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
        engagement_code: None,
        activity_code: None,
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
    let llm_activity_code = entry
        .activity_code
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
                let activity_code = activity.activity_code.trim();
                let reason = activity.reason.trim();
                if activity_code.is_empty() || reason.is_empty() {
                    return None;
                }

                Some(LlmAlternativeActivity {
                    activity_code: activity_code.to_string(),
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
                if temporal_cue_type == TemporalCueType::RelativeDuration
                    && raw_duration.unwrap_or(0) > 0
                {
                    (
                        reference.rounded_end_minute - normalized_duration,
                        reference.rounded_end_minute,
                        None,
                        "derived_from_duration",
                    )
                } else {
                    let reason = if temporal_cue_type == TemporalCueType::ExplicitClock {
                        "unable_to_parse_explicit_time"
                    } else if temporal_cue_type == TemporalCueType::RelativeDuration {
                        "unable_to_derive_relative_duration"
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
        normalize_update_window(start_minute, end_minute);

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
            engagement_code: entry.engagement_code.clone(),
            activity_code: entry.activity_code.clone(),
        },
        note,
        used_temporal_fallback: should_use_fallback,
        duration_defaulted,
        fallback_reason,
        raw_start,
        raw_end,
        raw_duration,
        llm_activity_code,
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
    if entry.activity_code.is_some() {
        return ActivityFallbackDecision::default();
    }

    let Some(engagement_code) = entry.engagement_code.as_deref() else {
        return ActivityFallbackDecision::default();
    };

    let mut decision = ActivityFallbackDecision {
        attempted: true,
        ..ActivityFallbackDecision::default()
    };

    let Some(engagement) = code_context
        .engagements
        .iter()
        .find(|candidate| candidate.code.eq_ignore_ascii_case(engagement_code))
    else {
        decision.reason = Some("engagement_not_found_in_context".to_string());
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

    entry.activity_code = Some(candidate.code.clone());
    entry.confidence = entry.confidence.min(ACTIVITY_FALLBACK_CONFIDENCE_CAP);

    decision.applied = true;
    decision.reason = Some("engagement_known_activity_missing".to_string());
    decision.chosen_activity_code = Some(candidate.code.clone());
    decision.chosen_activity_name = Some(candidate.name.clone());
    decision.chosen_score = Some(candidate.score);
    decision.matched_terms = candidate.matched_terms.clone();
    decision.note = Some(format!(
        "Activity fallback applied: selected {} ({}) for {} using activity name/tag similarity.",
        candidate.code, candidate.name, engagement.code
    ));

    decision
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

    candidate.code < current.code
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
        code: activity.code.clone(),
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

fn normalize_update_window(start_minute: i64, end_minute: i64) -> (i64, i64, i64) {
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
        CodeContext, ContextActivity, ContextEngagement, KeySource, LlmEntry, NormalizedEntry,
        StatusLevel,
    };
    use crate::openai::LlmAttemptTelemetry;

    use super::{
        apply_activity_fallback_if_needed, dedupe_prepared_entries, derive_key_status_level,
        llm_attempt_event_status, message_has_explicit_clock_time_cue,
        message_has_relative_duration_cue, normalize_confidence, normalize_llm_entry,
        normalize_update_window, round_to_nearest_15, timeline_week_bounds, PreparedEntry,
        TemporalCueType, TemporalReference,
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
    fn update_window_enforces_minimum_quarter_hour() {
        let (start, end, duration) = normalize_update_window(150, 150);
        assert_eq!(start, 150);
        assert_eq!(end, 165);
        assert_eq!(duration, 15);
    }

    #[test]
    fn update_window_clamps_to_day_end() {
        let (start, end, duration) = normalize_update_window(1439, 1600);
        assert_eq!(start, 1425);
        assert_eq!(end, 1440);
        assert_eq!(duration, 15);
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
    fn normalization_falls_back_to_capture_window_when_no_time_cue() {
        let entry = LlmEntry {
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
    fn normalization_falls_back_for_duration_without_relative_or_clock_cue() {
        let entry = LlmEntry {
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
            engagement_code: Some("E-123".to_string()),
            activity_code: Some("ACT-01".to_string()),
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
                code: "E-69306633".to_string(),
                name: "PCC SOC2".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        code: "0001".to_string(),
                        name: "Report 1".to_string(),
                        tags: vec!["PCC".to_string(), "detail review".to_string()],
                        describe_when_to_use: Some(
                            "Use for reporting and detailed review work.".to_string(),
                        ),
                    },
                    ContextActivity {
                        code: "0006".to_string(),
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
            engagement_code: Some("E-69306633".to_string()),
            activity_code: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "Just got home from a 4 hour flight from Reno for the PCC data center visit",
            &code_context,
        );

        assert!(decision.attempted);
        assert!(decision.applied);
        assert_eq!(entry.activity_code.as_deref(), Some("0001"));
        assert!(entry.confidence <= 0.60);
        assert_eq!(decision.chosen_activity_code.as_deref(), Some("0001"));
    }

    #[test]
    fn activity_fallback_keeps_null_when_no_similarity_signal_exists() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                code: "E-1".to_string(),
                name: "Example".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        code: "1000".to_string(),
                        name: "Testing".to_string(),
                        tags: vec!["controls".to_string()],
                        describe_when_to_use: None,
                    },
                    ContextActivity {
                        code: "2000".to_string(),
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
            engagement_code: Some("E-1".to_string()),
            activity_code: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "completely unrelated phrase with no overlap",
            &code_context,
        );

        assert!(decision.attempted);
        assert!(!decision.applied);
        assert_eq!(decision.reason.as_deref(), Some("no_similarity_signal"));
        assert!(entry.activity_code.is_none());
        assert_eq!(entry.confidence, 0.85);
    }

    #[test]
    fn activity_fallback_can_use_description_guidance_without_tag_overlap() {
        let code_context = CodeContext {
            engagements: vec![ContextEngagement {
                code: "E-2".to_string(),
                name: "Client Work".to_string(),
                tags: vec![],
                describe_when_to_use: None,
                activities: vec![
                    ContextActivity {
                        code: "A-10".to_string(),
                        name: "Fieldwork".to_string(),
                        tags: vec![],
                        describe_when_to_use: Some(
                            "Use when performing walkthrough meetings with client stakeholders."
                                .to_string(),
                        ),
                    },
                    ContextActivity {
                        code: "A-20".to_string(),
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
            engagement_code: Some("E-2".to_string()),
            activity_code: None,
        };

        let decision = apply_activity_fallback_if_needed(
            &mut entry,
            "Met with client stakeholders for a walkthrough meeting",
            &code_context,
        );

        assert!(decision.applied);
        assert_eq!(entry.activity_code.as_deref(), Some("A-10"));
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
                engagement_code: Some("E-1".to_string()),
                activity_code: Some("A-1".to_string()),
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
                engagement_code: Some("E-1".to_string()),
                activity_code: Some("A-1".to_string()),
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
                engagement_code: Some("E-1".to_string()),
                activity_code: Some("A-1".to_string()),
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
