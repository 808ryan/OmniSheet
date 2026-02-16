use std::collections::HashSet;

use chrono::{DateTime, Local, NaiveDate, NaiveTime};
use keyring::Entry;
use tauri::State;
use uuid::Uuid;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{
    ActivityUpsertInput, ApiKeyInput, DateInput, Engagement, EngagementUpsertInput, IdInput,
    IdResult, InterpretResult, InterpretTextInput, LlmEntry, NormalizedEntry, SettingsStatus,
    TimelineEntry, TimelineUpdateInput, Warning, WarningType,
};
use crate::openai;
use crate::state::AppState;

const MINUTES_IN_DAY: i64 = 24 * 60;

fn state_lock_error() -> String {
    "application state lock poisoned".to_string()
}

fn keyring_entry() -> AppResult<Entry> {
    Entry::new("OmniSheet", "openai_api_key")
        .map_err(|error| AppError::Config(format!("failed to open keyring entry: {error}")))
}

fn get_openai_api_key() -> AppResult<String> {
    let entry = keyring_entry()?;
    let api_key = entry
        .get_password()
        .map_err(|error| AppError::Config(format!("OpenAI API key is not configured: {error}")))?;

    if api_key.trim().is_empty() {
        return Err(AppError::Config(
            "OpenAI API key is configured but empty".to_string(),
        ));
    }

    Ok(api_key)
}

#[tauri::command]
pub fn settings_get_status() -> Result<SettingsStatus, String> {
    let has_open_ai_key = keyring_entry()
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|error| AppError::Config(format!("OpenAI API key not found: {error}")))
        })
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    Ok(SettingsStatus { has_open_ai_key })
}

#[tauri::command]
pub fn settings_set_openai_key(input: ApiKeyInput) -> Result<(), String> {
    if input.api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    keyring_entry()
        .and_then(|entry| {
            entry
                .set_password(input.api_key.trim())
                .map_err(|error| AppError::Config(format!("failed to store API key: {error}")))
        })
        .map_err(|error| error.to_string())
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

#[tauri::command]
pub async fn interpret_text_message(
    state: State<'_, AppState>,
    input: InterpretTextInput,
) -> Result<InterpretResult, String> {
    if input.raw_text.trim().is_empty() {
        return Err("message cannot be empty".to_string());
    }

    let parsed_timestamp = parse_client_timestamp(&input.client_timestamp_iso);
    let api_key = get_openai_api_key().map_err(|error| error.to_string())?;

    let code_context = {
        let connection = state.connection.lock().map_err(|_| state_lock_error())?;
        db::load_code_context(&connection).map_err(|error| error.to_string())?
    };

    let llm_response = openai::interpret_message(
        &state.http_client,
        &api_key,
        input.raw_text.trim(),
        &input.client_timestamp_iso,
        &input.timezone,
        &code_context,
    )
    .await
    .map_err(|error| error.to_string())?;

    let interpreted_entries_json =
        serde_json::to_string(&llm_response).map_err(|error| error.to_string())?;

    let mut normalized_entries = llm_response
        .entries
        .iter()
        .map(|entry| normalize_llm_entry(entry, parsed_timestamp, input.raw_text.trim()))
        .collect::<Vec<_>>();

    if normalized_entries.is_empty() {
        normalized_entries.push(fallback_entry(parsed_timestamp, input.raw_text.trim()));
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
        .map_err(|error| error.to_string())?;

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

    if let Err(error) = write_result {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(error);
    }

    connection
        .execute_batch("COMMIT")
        .map_err(|error| error.to_string())?;

    Ok(InterpretResult {
        raw_message_id,
        created_entry_ids,
        warnings,
    })
}

fn parse_client_timestamp(timestamp: &str) -> DateTime<Local> {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.with_timezone(&Local))
        .unwrap_or_else(|_| Local::now())
}

fn fallback_entry(reference_timestamp: DateTime<Local>, raw_text: &str) -> NormalizedEntry {
    let date = reference_timestamp.format("%Y-%m-%d").to_string();
    let end_minute = round_to_nearest_30(minutes_from_time(reference_timestamp.time()) as i64)
        .clamp(30, MINUTES_IN_DAY);
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
    reference_timestamp: DateTime<Local>,
    fallback_description: &str,
) -> NormalizedEntry {
    let date = entry
        .date
        .as_deref()
        .and_then(parse_date)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| reference_timestamp.format("%Y-%m-%d").to_string());

    let fallback_end = round_to_nearest_30(minutes_from_time(reference_timestamp.time()) as i64)
        .clamp(30, MINUTES_IN_DAY);
    let fallback_duration = 30;

    let entry_duration = entry.duration_minutes.unwrap_or(fallback_duration);
    let normalized_duration = normalize_duration(entry_duration);

    let parsed_start = entry.start_time.as_deref().and_then(parse_time_to_minutes);
    let parsed_end = entry.end_time.as_deref().and_then(parse_time_to_minutes);

    let (start_minute, end_minute) = match (parsed_start, parsed_end) {
        (Some(start), Some(end)) => (start, end),
        (Some(start), None) => (start, start + normalized_duration),
        (None, Some(end)) => (end - normalized_duration, end),
        (None, None) => (fallback_end - normalized_duration, fallback_end),
    };

    let (normalized_start, normalized_end, duration_minutes) =
        normalize_update_window(start_minute, end_minute);

    NormalizedEntry {
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
        confidence: entry.confidence.unwrap_or(0.5).clamp(0.0, 1.0),
        engagement_code: entry.engagement_code.clone(),
        activity_code: entry.activity_code.clone(),
    }
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn parse_time_to_minutes(value: &str) -> Option<i64> {
    parse_time(value).map(|time| minutes_from_time(time) as i64)
}

fn parse_time(value: &str) -> Option<NaiveTime> {
    ["%H:%M", "%H:%M:%S", "%I:%M %p", "%I %p"]
        .iter()
        .find_map(|format| NaiveTime::parse_from_str(value, format).ok())
}

fn minutes_from_time(value: NaiveTime) -> u32 {
    value.hour() * 60 + value.minute()
}

fn round_to_nearest_30(value: i64) -> i64 {
    ((value as f64 / 30.0).round() as i64) * 30
}

fn normalize_duration(duration: i64) -> i64 {
    let rounded = round_to_nearest_30(duration.max(30));
    rounded.clamp(30, MINUTES_IN_DAY)
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
    use chrono::Local;

    use super::{normalize_update_window, round_to_nearest_30};

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
}
