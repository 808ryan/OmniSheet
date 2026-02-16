use std::collections::HashSet;
use std::time::Instant;

use chrono::{DateTime, Local, NaiveDate, NaiveTime, TimeZone};
use keyring::{Entry, Error as KeyringError};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{
    ActivityUpsertInput, ApiKeyInput, DateInput, DiagnosticsBundle, DiagnosticsEvent,
    DiagnosticsListInput, DiagnosticsRecordInput, Engagement, EngagementUpsertInput, IdInput,
    IdResult, InterpretResult, InterpretTextInput, KeySource, LlmEntry, NormalizedEntry,
    RepairSuspiciousEntriesInput, RepairSuspiciousEntriesResult, SettingsStatus, StatusLevel,
    StorageHealth, TimelineEntry, TimelineUpdateInput, Warning, WarningType,
};
use crate::openai;
use crate::state::AppState;

const MINUTES_IN_DAY: i64 = 24 * 60;

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

#[derive(Debug, Clone)]
struct NormalizedEntryResult {
    entry: NormalizedEntry,
    note: Option<String>,
    used_temporal_fallback: bool,
    fallback_reason: Option<String>,
    raw_start: Option<String>,
    raw_end: Option<String>,
    raw_duration: Option<i64>,
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
        status_level_label(&status.status_level),
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

    if input.api_key.trim().is_empty() {
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
            .set_password(input.api_key.trim())
            .map_err(|error| AppError::Config(format!("failed to store API key: {error}")))?;

        let verified = entry.get_password().map_err(|error| {
            AppError::Config(format!("failed to verify API key storage: {error}"))
        })?;

        if verified.trim().is_empty() {
            return Err(AppError::Config(
                "API key storage verification returned an empty key".to_string(),
            ));
        }

        if verified.trim() != input.api_key.trim() {
            return Err(AppError::Config(
                "API key storage verification failed: value mismatch".to_string(),
            ));
        }

        Ok(())
    })();

    match set_result {
        Ok(()) => {
            if let Ok(mut cache) = state.api_key_cache.lock() {
                *cache = Some(input.api_key.trim().to_string());
            }

            record_backend_event_with_state(
                &state,
                &correlation_id,
                "key_save_verify",
                command,
                "ok",
                Some(duration_ms(started_at)),
                None,
                json!({ "verified": true }),
            );
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "key_save_verify",
                command,
                "error",
                Some(duration_ms(started_at)),
                None,
                json!({ "message": message }),
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
    let details = truncate_for_bundle(&event.details_json, 120);

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
    let has_explicit_time_cue = message_has_explicit_clock_time_cue(input.raw_text.trim());

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
    let llm_response = match openai::interpret_message(
        &state.http_client,
        &api_key,
        input.raw_text.trim(),
        &input.client_timestamp_iso,
        &input.client_local_date,
        &input.client_local_time,
        input.client_utc_offset_minutes,
        &input.timezone,
        &code_context,
    )
    .await
    {
        Ok(response) => {
            record_backend_event_with_state(
                &state,
                &correlation_id,
                "llm_response",
                command,
                "ok",
                Some(duration_ms(llm_started_at)),
                None,
                json!({ "entryCount": response.entries.len() }),
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
                Some(duration_ms(llm_started_at)),
                Some(input.raw_text.trim()),
                json!({ "message": message }),
            );
            return Err(format_command_error(&correlation_id, message));
        }
    };

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
                has_explicit_time_cue,
            )
        })
        .collect::<Vec<_>>();

    let mut normalized_entries = Vec::<NormalizedEntry>::new();
    let mut normalization_notes = Vec::<String>::new();
    let mut normalization_details = Vec::<Value>::new();
    let mut fallback_count = 0;

    for result in normalization_results {
        if let Some(note) = result.note {
            normalization_notes.push(note);
        }

        if result.used_temporal_fallback {
            fallback_count += 1;
        }

        normalization_details.push(json!({
          "usedTemporalFallback": result.used_temporal_fallback,
          "fallbackReason": result.fallback_reason,
          "llmStartRaw": result.raw_start,
          "llmEndRaw": result.raw_end,
          "llmDurationRaw": result.raw_duration,
          "savedDate": result.entry.date,
          "savedStartMinute": result.entry.start_minute,
          "savedEndMinute": result.entry.end_minute,
        }));

        normalized_entries.push(result.entry);
    }

    if normalized_entries.is_empty() {
        normalized_entries.push(fallback_entry(&temporal_reference, input.raw_text.trim()));
        fallback_count += 1;
        let note = format!(
            "No LLM entries returned. Defaulted to {} - {} based on capture time.",
            minute_to_hhmm((temporal_reference.rounded_end_minute - 30).max(0)),
            minute_to_hhmm(temporal_reference.rounded_end_minute)
        );
        normalization_notes.push(note.clone());
        normalization_details.push(json!({
          "usedTemporalFallback": true,
          "fallbackReason": "no_llm_entries",
          "savedDate": temporal_reference.local_date.format("%Y-%m-%d").to_string(),
          "savedStartMinute": (temporal_reference.rounded_end_minute - 30).max(0),
          "savedEndMinute": temporal_reference.rounded_end_minute,
          "note": note,
        }));
    }

    let confidence_average = normalized_entries
        .iter()
        .map(|entry| entry.confidence)
        .sum::<f64>()
        / normalized_entries.len() as f64;

    let raw_message_id = Uuid::new_v4().to_string();
    let mut created_entry_ids = Vec::new();
    let mut warnings: Vec<Warning> = Vec::new();
    let mut touched_dates: HashSet<String> = HashSet::new();

    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    connection
        .execute_batch("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let write_result: Result<(), String> = (|| {
        db::insert_raw_message(
            &connection,
            &raw_message_id,
            input.raw_text.trim(),
            &interpreted_entries_json,
            confidence_average,
            parsed_timestamp.timestamp(),
        )
        .map_err(|error| error.to_string())?;

        for normalized_entry in normalized_entries {
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

        for date in touched_dates {
            let overlap_warnings = db::recompute_overlap_warnings(&connection, &date)
                .map_err(|error| error.to_string())?;
            warnings.extend(overlap_warnings);
        }

        Ok(())
    })();

    if let Err(message) = write_result {
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

#[tauri::command]
pub fn maintenance_repair_suspicious_entries(
    state: State<'_, AppState>,
    input: RepairSuspiciousEntriesInput,
) -> Result<RepairSuspiciousEntriesResult, String> {
    let command = "maintenance_repair_suspicious_entries";
    let correlation_id = Uuid::new_v4().to_string();
    let started_at = Instant::now();
    let limit = input.limit.unwrap_or(200).clamp(1, 1_000);

    let connection = state.connection.lock().map_err(|_| state_lock_error())?;

    #[derive(Debug)]
    struct CandidateEntry {
        id: String,
        date: String,
        start_minute: i64,
        end_minute: i64,
        duration_minutes: i64,
        description: String,
        engagement_id: Option<String>,
        activity_id: Option<String>,
        raw_text: String,
        message_timestamp: i64,
    }

    let mut statement = connection
        .prepare(
            r#"
          SELECT
            te.id,
            te.date,
            te.start_minute,
            te.end_minute,
            te.duration_minutes,
            te.description,
            te.engagement_id,
            te.activity_id,
            rm.raw_text,
            rm.message_timestamp
          FROM timesheet_entries te
          JOIN raw_messages rm ON rm.id = te.raw_message_id
          WHERE te.source = 'text'
          ORDER BY te.created_at DESC
          LIMIT ?1
        "#,
        )
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let candidates = statement
        .query_map(params![limit], |row| {
            Ok(CandidateEntry {
                id: row.get(0)?,
                date: row.get(1)?,
                start_minute: row.get(2)?,
                end_minute: row.get(3)?,
                duration_minutes: row.get(4)?,
                description: row.get(5)?,
                engagement_id: row.get(6)?,
                activity_id: row.get(7)?,
                raw_text: row.get(8)?,
                message_timestamp: row.get(9)?,
            })
        })
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;
    drop(statement);

    let scanned_count = candidates.len() as i64;

    connection
        .execute_batch("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| format_command_error(&correlation_id, error.to_string()))?;

    let repair_result: Result<Vec<String>, String> = (|| {
        let mut repaired_entry_ids = Vec::<String>::new();

        for candidate in candidates {
            if message_has_explicit_clock_time_cue(&candidate.raw_text) {
                continue;
            }

            let Some(reference_timestamp) = Local.timestamp_opt(candidate.message_timestamp, 0).single() else {
                continue;
            };

            let temporal_reference = TemporalReference {
                local_date: reference_timestamp.date_naive(),
                rounded_end_minute: round_to_nearest_30(
                    minutes_from_time(reference_timestamp.time()) as i64,
                )
                .clamp(30, MINUTES_IN_DAY),
            };

            let repaired_entry = fallback_entry(&temporal_reference, &candidate.description);
            let has_large_timing_drift =
                (candidate.start_minute - repaired_entry.start_minute).abs() >= 60
                    || (candidate.end_minute - repaired_entry.end_minute).abs() >= 60;
            let has_date_drift = candidate.date != repaired_entry.date;
            let has_midnight_default = candidate.start_minute == 0 && candidate.end_minute == 30;
            let is_suspicious = has_large_timing_drift || has_date_drift || has_midnight_default;

            if !is_suspicious {
                continue;
            }

            if candidate.date == repaired_entry.date
                && candidate.start_minute == repaired_entry.start_minute
                && candidate.end_minute == repaired_entry.end_minute
                && candidate.duration_minutes == repaired_entry.duration_minutes
            {
                continue;
            }

            db::update_timeline_entry(
                &connection,
                &candidate.id,
                &repaired_entry.date,
                repaired_entry.start_minute,
                repaired_entry.end_minute,
                repaired_entry.duration_minutes,
                &candidate.description,
                candidate.engagement_id.as_deref(),
                candidate.activity_id.as_deref(),
            )
            .map_err(|error| error.to_string())?;

            db::clear_entry_warnings(
                &connection,
                &candidate.id,
                &[WarningType::Overlap, WarningType::Unmatched],
            )
            .map_err(|error| error.to_string())?;

            if candidate.engagement_id.is_none() || candidate.activity_id.is_none() {
                db::add_warning(
                    &connection,
                    &candidate.id,
                    WarningType::Unmatched,
                    Some("Entry is uncategorized".to_string()),
                )
                .map_err(|error| error.to_string())?;
            }

            let _ = db::recompute_overlap_warnings(&connection, &candidate.date)
                .map_err(|error| error.to_string())?;
            if candidate.date != repaired_entry.date {
                let _ = db::recompute_overlap_warnings(&connection, &repaired_entry.date)
                    .map_err(|error| error.to_string())?;
            }

            repaired_entry_ids.push(candidate.id);
        }

        Ok(repaired_entry_ids)
    })();

    let repaired_entry_ids = match repair_result {
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

    let result = RepairSuspiciousEntriesResult {
        scanned_count,
        repaired_count: repaired_entry_ids.len() as i64,
        repaired_entry_ids: repaired_entry_ids.clone(),
    };

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
          "scannedCount": result.scanned_count,
          "repairedCount": result.repaired_count,
          "repairedEntryIds": result.repaired_entry_ids,
        }),
    );

    Ok(result)
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
    let local_date = parse_date(input.client_local_date.trim()).unwrap_or_else(|| parsed_timestamp.date_naive());
    let local_time = parse_time(input.client_local_time.trim()).unwrap_or_else(|| parsed_timestamp.time());
    let rounded_end_minute =
        round_to_nearest_30(minutes_from_time(local_time) as i64).clamp(30, MINUTES_IN_DAY);

    TemporalReference {
        local_date,
        rounded_end_minute,
    }
}

fn fallback_entry(reference: &TemporalReference, raw_text: &str) -> NormalizedEntry {
    let date = reference.local_date.format("%Y-%m-%d").to_string();
    let end_minute = reference.rounded_end_minute;
    let start_minute = (end_minute - 30).max(0);

    NormalizedEntry {
        date,
        start_minute,
        end_minute,
        duration_minutes: end_minute - start_minute,
        description: raw_text.to_string(),
        confidence: 0.5,
        engagement_code: None,
        activity_code: None,
    }
}

fn normalize_llm_entry(
    entry: &LlmEntry,
    reference: &TemporalReference,
    fallback_description: &str,
    has_explicit_time_cue: bool,
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

    let parsed_start = raw_start.as_deref().and_then(parse_time_to_minutes);
    let parsed_end = raw_end.as_deref().and_then(parse_time_to_minutes);

    let fallback_start = (reference.rounded_end_minute - 30).max(0);
    let fallback_end = reference.rounded_end_minute;
    let normalized_duration = raw_duration
        .filter(|value| *value > 0)
        .map(normalize_duration)
        .unwrap_or(30);

    let has_invalid_duration = matches!(raw_duration, Some(value) if value <= 0);
    let has_midnight_zero_tuple = matches!(
        (parsed_start, parsed_end, raw_duration),
        (Some(0), Some(0), Some(value)) if value <= 0
    );
    let has_no_times = parsed_start.is_none() && parsed_end.is_none();
    let should_use_fallback = !has_explicit_time_cue
        || has_invalid_duration
        || has_midnight_zero_tuple
        || (has_explicit_time_cue && has_no_times);

    let (start_minute, end_minute, fallback_reason) = if should_use_fallback {
        let reason = if !has_explicit_time_cue {
            "no_explicit_time_cue"
        } else if has_invalid_duration {
            "invalid_duration"
        } else if has_midnight_zero_tuple {
            "invalid_midnight_default"
        } else {
            "unable_to_parse_explicit_time"
        };

        (fallback_start, fallback_end, Some(reason.to_string()))
    } else {
        let (candidate_start, candidate_end) = match (parsed_start, parsed_end) {
        (Some(start), Some(end)) => (start, end),
        (Some(start), None) => (start, start + normalized_duration),
        (None, Some(end)) => (end - normalized_duration, end),
            (None, None) => (fallback_start, fallback_end),
        };
        (candidate_start, candidate_end, None)
    };

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
            confidence: normalize_confidence(entry.confidence),
            engagement_code: entry.engagement_code.clone(),
            activity_code: entry.activity_code.clone(),
        },
        note,
        used_temporal_fallback: should_use_fallback,
        fallback_reason,
        raw_start,
        raw_end,
        raw_duration,
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

fn round_to_nearest_30(value: i64) -> i64 {
    ((value as f64 / 30.0).round() as i64) * 30
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
    let rounded = round_to_nearest_30(duration.max(30));
    rounded.clamp(30, MINUTES_IN_DAY)
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
    let mut normalized_start = round_to_nearest_30(start_minute).clamp(0, MINUTES_IN_DAY);
    let mut normalized_end = round_to_nearest_30(end_minute).clamp(0, MINUTES_IN_DAY);

    if normalized_end <= normalized_start {
        normalized_end = (normalized_start + 30).min(MINUTES_IN_DAY);
    }

    if normalized_end == MINUTES_IN_DAY && normalized_end - normalized_start < 30 {
        normalized_start = (MINUTES_IN_DAY - 30).max(0);
    }

    let duration_minutes = (normalized_end - normalized_start).max(30);
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

    use crate::models::{KeySource, LlmEntry, StatusLevel};

    use super::{
        derive_key_status_level, message_has_explicit_clock_time_cue, normalize_confidence,
        normalize_llm_entry, normalize_update_window, round_to_nearest_30, TemporalReference,
    };

    #[test]
    fn rounds_to_nearest_half_hour() {
        assert_eq!(round_to_nearest_30(14), 0);
        assert_eq!(round_to_nearest_30(15), 30);
        assert_eq!(round_to_nearest_30(44), 30);
        assert_eq!(round_to_nearest_30(45), 60);
    }

    #[test]
    fn update_window_enforces_minimum_half_hour() {
        let (start, end, duration) = normalize_update_window(150, 150);
        assert_eq!(start, 150);
        assert_eq!(end, 180);
        assert_eq!(duration, 30);
    }

    #[test]
    fn update_window_clamps_to_day_end() {
        let (start, end, duration) = normalize_update_window(1439, 1600);
        assert_eq!(start, 1410);
        assert_eq!(end, 1440);
        assert_eq!(duration, 30);
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
        assert!(message_has_explicit_clock_time_cue("reviewed controls at 14:10"));
        assert!(!message_has_explicit_clock_time_cue(
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
            confidence: Some(0.7),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", false);

        assert!(result.used_temporal_fallback);
        assert_eq!(result.entry.start_minute, 1290);
        assert_eq!(result.entry.end_minute, 1320);
        assert_eq!(result.entry.duration_minutes, 30);
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
            confidence: Some(0.9),
        };
        let reference = TemporalReference {
            local_date: NaiveDate::from_ymd_opt(2026, 2, 15).expect("valid date"),
            rounded_end_minute: 1320,
        };

        let result = normalize_llm_entry(&entry, &reference, "fallback", true);

        assert!(!result.used_temporal_fallback);
        assert_eq!(result.entry.start_minute, 780);
        assert_eq!(result.entry.end_minute, 810);
    }
}
