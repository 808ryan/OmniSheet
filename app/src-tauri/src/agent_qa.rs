use chrono::{Duration, Local, NaiveDate};
use rusqlite::Connection;
use serde_json::json;

use crate::db;
use crate::error::AppResult;
use crate::models::{
    ActivityUpsertInput, CalendarExtractCandidate, CalendarExtractInput, CalendarExtractResult,
    EngagementType, EngagementUpsertInput, NormalizedEntry, OpenAiModelId, SummaryLayoutColumn,
    SummaryLayoutFieldKey, SummaryLayoutPreset, SummaryLayoutState, TranscribeAudioInput,
    TranscribeAudioResult, TranscriptionModelId, WarningType,
};

pub const ORANGE_ENGAGEMENT_ID: &str = "agent-qa-eng-orange-itgc";
pub const INTERNAL_ENGAGEMENT_ID: &str = "agent-qa-eng-internal-admin";
pub const CONTROL_TESTING_ACTIVITY_ID: &str = "agent-qa-act-control-testing";
pub const WALKTHROUGH_ACTIVITY_ID: &str = "agent-qa-act-walkthrough";
pub const INTERNAL_PLANNING_ACTIVITY_ID: &str = "agent-qa-act-internal-planning";

const AGENT_QA_ENV: &str = "OMNISHEET_AGENT_QA";
const AGENT_QA_RESET_ENV: &str = "OMNISHEET_AGENT_QA_RESET";

pub fn is_enabled() -> bool {
    env_flag_enabled(AGENT_QA_ENV)
}

pub fn should_reset_database() -> bool {
    env_flag_enabled(AGENT_QA_RESET_ENV)
}

pub fn reset_and_seed_database(conn: &Connection, session_id: &str) -> AppResult<()> {
    reset_database(conn)?;
    seed_database(conn, session_id, Local::now().date_naive())
}

pub fn seed_reference_data(conn: &Connection) -> AppResult<()> {
    upsert_reference_codes(conn)?;
    upsert_settings(conn)
}

pub fn mock_transcription_result(input: &TranscribeAudioInput) -> TranscribeAudioResult {
    TranscribeAudioResult {
        transcript_text: "QA voice note: 30 minutes testing Orange ITGC controls.".to_string(),
        transcription_model_used: TranscriptionModelId::Gpt4oMiniTranscribe,
        transcription_model_used_label: TranscriptionModelId::Gpt4oMiniTranscribe
            .display_label()
            .to_string(),
        transcription_duration_ms: 12,
        audio_duration_ms: input.duration_ms.max(1),
    }
}

pub fn mock_calendar_extract_result(
    input: &CalendarExtractInput,
    correlation_id: String,
    selected_openai_model: OpenAiModelId,
) -> CalendarExtractResult {
    let selected_date = normalize_seed_date(&input.selected_date)
        .or_else(|| normalize_seed_date(&input.client_local_date))
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string());
    let mut candidates = vec![
        CalendarExtractCandidate {
            id: "agent-qa-calendar-candidate-control".to_string(),
            date: selected_date.clone(),
            start_minute: 11 * 60 + 30,
            end_minute: 12 * 60,
            duration_minutes: 30,
            time_evidence: Some("11:30 AM - 12:00 PM".to_string()),
            description: "QA extracted calendar event - control sync".to_string(),
            extracted_text: "Control sync with Orange".to_string(),
            source_text: "Control sync with Orange, 11:30 AM - 12:00 PM".to_string(),
            confidence: 0.96,
            engagement_id: Some(ORANGE_ENGAGEMENT_ID.to_string()),
            activity_id: Some(WALKTHROUGH_ACTIVITY_ID.to_string()),
            engagement_code: Some("A100".to_string()),
            engagement_name: Some("Orange ITGC".to_string()),
            engagement_type: Some(EngagementType::External),
            activity_code: Some("WALK".to_string()),
            activity_name: Some("Walkthrough".to_string()),
            warning_flags: vec![],
            is_all_day: false,
            is_ignored: false,
            ignored_reason: None,
            needs_date_confirmation: false,
            needs_time_confirmation: false,
        },
        CalendarExtractCandidate {
            id: "agent-qa-calendar-candidate-hold".to_string(),
            date: selected_date,
            start_minute: 0,
            end_minute: 24 * 60,
            duration_minutes: 24 * 60,
            time_evidence: Some("All day".to_string()),
            description: "QA ignored all-day hold".to_string(),
            extracted_text: "Hold - QA all-day event".to_string(),
            source_text: "Hold - QA all-day event".to_string(),
            confidence: 0.91,
            engagement_id: None,
            activity_id: None,
            engagement_code: None,
            engagement_name: None,
            engagement_type: None,
            activity_code: None,
            activity_name: None,
            warning_flags: vec![WarningType::Unmatched],
            is_all_day: true,
            is_ignored: input.ignore_all_day_events,
            ignored_reason: input
                .ignore_all_day_events
                .then(|| "All-day event ignored by preference".to_string()),
            needs_date_confirmation: false,
            needs_time_confirmation: false,
        },
    ];
    let ignored_candidate_count = candidates
        .iter()
        .filter(|candidate| candidate.is_ignored)
        .count() as i64;

    if input.ignore_all_day_events {
        candidates.retain(|candidate| !candidate.is_ignored);
    }

    CalendarExtractResult {
        correlation_id,
        candidates,
        ignored_candidate_count,
        model_used: selected_openai_model,
        model_used_label: selected_openai_model.display_label().to_string(),
        llm_duration_ms: 15,
    }
}

fn normalize_seed_date(value: &str) -> Option<String> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn reset_database(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        DELETE FROM entry_warnings;
        DELETE FROM timesheet_entries;
        DELETE FROM raw_messages;
        DELETE FROM activities;
        DELETE FROM engagements;
        DELETE FROM app_settings;
        DELETE FROM diagnostics_events;
        "#,
    )?;
    Ok(())
}

fn seed_database(conn: &Connection, session_id: &str, selected_date: NaiveDate) -> AppResult<()> {
    upsert_reference_codes(conn)?;
    upsert_settings(conn)?;
    seed_timeline_entries(conn, selected_date)?;
    seed_diagnostics(conn, session_id)?;
    Ok(())
}

fn upsert_reference_codes(conn: &Connection) -> AppResult<()> {
    db::upsert_engagement(
        conn,
        EngagementUpsertInput {
            id: Some(ORANGE_ENGAGEMENT_ID.to_string()),
            code: Some("A100".to_string()),
            name: "Orange ITGC".to_string(),
            client: Some("Orange".to_string()),
            engagement_type: Some(EngagementType::External),
            color_hex: Some("#1F7AFF".to_string()),
            tags: vec!["qa".to_string(), "external".to_string()],
            describe_when_to_use:
                "Use for external ITGC control testing, walkthroughs, and evidence review."
                    .to_string(),
            is_active: Some(true),
        },
    )?;

    db::upsert_engagement(
        conn,
        EngagementUpsertInput {
            id: Some(INTERNAL_ENGAGEMENT_ID.to_string()),
            code: Some("I200".to_string()),
            name: "Internal Admin".to_string(),
            client: Some("OmniSheet".to_string()),
            engagement_type: Some(EngagementType::Internal),
            color_hex: Some("#0F766E".to_string()),
            tags: vec!["qa".to_string(), "internal".to_string()],
            describe_when_to_use: "Use for internal planning, admin, and QA review activities."
                .to_string(),
            is_active: Some(true),
        },
    )?;

    db::upsert_activity(
        conn,
        ActivityUpsertInput {
            id: Some(CONTROL_TESTING_ACTIVITY_ID.to_string()),
            engagement_id: ORANGE_ENGAGEMENT_ID.to_string(),
            code: Some("CTRL".to_string()),
            name: "Control Testing".to_string(),
            color_hex: Some("#2563EB".to_string()),
            tags: vec!["testing".to_string(), "qa".to_string()],
            describe_when_to_use: "Use for testing ITGC controls and reviewing support."
                .to_string(),
            is_active: Some(true),
        },
    )?;

    db::upsert_activity(
        conn,
        ActivityUpsertInput {
            id: Some(WALKTHROUGH_ACTIVITY_ID.to_string()),
            engagement_id: ORANGE_ENGAGEMENT_ID.to_string(),
            code: Some("WALK".to_string()),
            name: "Walkthrough".to_string(),
            color_hex: Some("#7C3AED".to_string()),
            tags: vec!["walkthrough".to_string(), "qa".to_string()],
            describe_when_to_use:
                "Use for walkthrough calls, process understanding, and design review.".to_string(),
            is_active: Some(true),
        },
    )?;

    db::upsert_activity(
        conn,
        ActivityUpsertInput {
            id: Some(INTERNAL_PLANNING_ACTIVITY_ID.to_string()),
            engagement_id: INTERNAL_ENGAGEMENT_ID.to_string(),
            code: Some("PLAN".to_string()),
            name: "Planning".to_string(),
            color_hex: Some("#059669".to_string()),
            tags: vec!["planning".to_string(), "qa".to_string()],
            describe_when_to_use: "Use for planning the workday and reviewing the Agent QA loop."
                .to_string(),
            is_active: Some(true),
        },
    )?;

    Ok(())
}

fn upsert_settings(conn: &Connection) -> AppResult<()> {
    db::upsert_app_setting(conn, "openai_model", "gpt-5-nano")?;
    db::upsert_app_setting(conn, "calendar_bulk_openai_model", "gpt-5.4")?;
    db::upsert_app_setting(conn, "openai_transcription_model", "gpt-4o-mini-transcribe")?;
    db::upsert_app_setting(
        conn,
        "timeline_exclude_uncategorized_from_daily_totals",
        "true",
    )?;
    db::upsert_app_setting(conn, "timeline_show_uncategorized_daily_total", "true")?;
    db::upsert_app_setting(conn, "timeline_include_external_in_totals", "true")?;
    db::upsert_app_setting(conn, "timeline_include_internal_in_totals", "true")?;
    db::upsert_app_setting(conn, "timeline_separate_engagement_type_totals", "true")?;
    db::upsert_app_setting(
        conn,
        "calendar_bulk_ignored_keywords",
        &serde_json::to_string(&vec!["lunch", "hold"])?,
    )?;
    db::upsert_app_setting(conn, "calendar_bulk_ignore_all_day_events", "true")?;
    db::upsert_app_setting(
        conn,
        "summary_layout_state",
        &serde_json::to_string(&summary_layout_state())?,
    )?;
    Ok(())
}

fn summary_layout_state() -> SummaryLayoutState {
    SummaryLayoutState {
        version: 2,
        selected_preset_id: "agent-qa-summary".to_string(),
        presets: vec![SummaryLayoutPreset {
            id: "agent-qa-summary".to_string(),
            name: "Agent QA".to_string(),
            columns: vec![
                SummaryLayoutColumn::Field {
                    id: "agent-qa-engagement-code".to_string(),
                    field_key: SummaryLayoutFieldKey::EngagementCode,
                },
                SummaryLayoutColumn::Field {
                    id: "agent-qa-activity-code".to_string(),
                    field_key: SummaryLayoutFieldKey::ActivityCode,
                },
                SummaryLayoutColumn::Field {
                    id: "agent-qa-activity-name".to_string(),
                    field_key: SummaryLayoutFieldKey::ActivityName,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-0".to_string(),
                    day_index: 0,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-1".to_string(),
                    day_index: 1,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-2".to_string(),
                    day_index: 2,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-3".to_string(),
                    day_index: 3,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-4".to_string(),
                    day_index: 4,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-5".to_string(),
                    day_index: 5,
                },
                SummaryLayoutColumn::Day {
                    id: "agent-qa-day-6".to_string(),
                    day_index: 6,
                },
                SummaryLayoutColumn::RowTotal {
                    id: "agent-qa-row-total".to_string(),
                },
            ],
        }],
    }
}

fn seed_timeline_entries(conn: &Connection, selected_date: NaiveDate) -> AppResult<()> {
    let selected_date = selected_date.format("%Y-%m-%d").to_string();

    db::insert_manual_timeline_entry(
        conn,
        &selected_date,
        9 * 60,
        10 * 60,
        60,
        "QA seeded control walkthrough",
        Some(ORANGE_ENGAGEMENT_ID),
        Some(CONTROL_TESTING_ACTIVITY_ID),
    )?;
    db::insert_manual_timeline_entry(
        conn,
        &selected_date,
        10 * 60 + 30,
        11 * 60 + 15,
        45,
        "QA seeded screenshot review",
        Some(ORANGE_ENGAGEMENT_ID),
        Some(WALKTHROUGH_ACTIVITY_ID),
    )?;
    db::insert_manual_timeline_entry(
        conn,
        &selected_date,
        13 * 60,
        13 * 60 + 45,
        45,
        "QA seeded internal planning",
        Some(INTERNAL_ENGAGEMENT_ID),
        Some(INTERNAL_PLANNING_ACTIVITY_ID),
    )?;

    let uncategorized_id = db::insert_manual_timeline_entry(
        conn,
        &selected_date,
        14 * 60,
        14 * 60 + 30,
        30,
        "QA seeded uncategorized follow-up",
        None,
        None,
    )?;
    db::add_warning(
        conn,
        &uncategorized_id,
        WarningType::Unmatched,
        Some("Agent QA seed leaves this entry uncategorized for review-state testing.".to_string()),
    )?;

    let prior_date = (Local::now().date_naive() - Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let raw_message_id = "agent-qa-history-message";
    db::insert_raw_message(
        conn,
        raw_message_id,
        "QA seeded history submission",
        &json!({ "agentQa": true, "entryCount": 1 }).to_string(),
        "gpt-5-nano",
        "text",
        None,
        None,
        0.98,
        db::current_unix_timestamp() - 900,
        1,
        1,
        1,
        0,
        false,
    )?;
    db::insert_timesheet_entry(
        conn,
        raw_message_id,
        &NormalizedEntry {
            date: prior_date,
            start_minute: 15 * 60,
            end_minute: 15 * 60 + 30,
            duration_minutes: 30,
            description: "QA seeded interpreted history entry".to_string(),
            user_submission_text: "QA seeded history submission".to_string(),
            confidence: 0.98,
            engagement_ref: None,
            activity_ref: None,
        },
        Some(ORANGE_ENGAGEMENT_ID),
        Some(CONTROL_TESTING_ACTIVITY_ID),
        false,
        false,
        false,
        None,
        Some(1),
        Some(1),
        "text",
    )?;

    db::recompute_overlap_warnings(conn, &selected_date)?;
    Ok(())
}

fn seed_diagnostics(conn: &Connection, session_id: &str) -> AppResult<()> {
    db::insert_diagnostics_event(
        conn,
        session_id,
        "agent-qa-seed",
        "backend",
        "agent_qa_seed",
        Some("agent_qa_seed"),
        "ok",
        Some(1),
        None,
        &json!({ "message": "Agent QA seed data loaded." }).to_string(),
    )?;
    db::insert_diagnostics_event(
        conn,
        session_id,
        "agent-qa-browser-smoke",
        "frontend",
        "agent_qa_ready",
        Some("agent_qa_browser"),
        "ok",
        Some(1),
        None,
        &json!({ "message": "Agent QA browser smoke fixture is ready." }).to_string(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        db::run_migrations(&connection).expect("migrations should run");
        connection
    }

    #[test]
    fn reset_and_seed_database_creates_reference_data_and_entries() {
        let connection = test_connection();
        seed_database(
            &connection,
            "test-session",
            NaiveDate::from_ymd_opt(2026, 6, 21).expect("valid date"),
        )
        .expect("seed should succeed");

        let engagements = db::list_engagements(&connection).expect("engagements should load");
        assert_eq!(engagements.len(), 2);
        assert!(engagements
            .iter()
            .any(|engagement| engagement.id == ORANGE_ENGAGEMENT_ID));

        let entries = db::list_timeline_entries(&connection, "2026-06-21")
            .expect("timeline entries should load");
        assert_eq!(entries.len(), 4);
        assert!(entries
            .iter()
            .any(|entry| entry.description == "QA seeded control walkthrough"));
    }

    #[test]
    fn reset_clears_existing_data_before_seed() {
        let connection = test_connection();
        db::upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: Some("temporary-engagement".to_string()),
                code: Some("TMP".to_string()),
                name: "Temporary".to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Temporary data".to_string(),
                is_active: Some(true),
            },
        )
        .expect("temporary engagement should insert");

        reset_and_seed_database(&connection, "test-session").expect("reset and seed should pass");

        let engagements = db::list_engagements(&connection).expect("engagements should load");
        assert!(!engagements
            .iter()
            .any(|engagement| engagement.id == "temporary-engagement"));
        assert!(engagements
            .iter()
            .any(|engagement| engagement.id == ORANGE_ENGAGEMENT_ID));
    }

    #[test]
    fn mock_transcription_result_is_deterministic() {
        let result = mock_transcription_result(&TranscribeAudioInput {
            audio_base64: "abc".to_string(),
            mime_type: "audio/webm".to_string(),
            duration_ms: 1200,
            capture_timestamp_iso: "2026-06-21T12:00:00Z".to_string(),
        });

        assert_eq!(
            result.transcript_text,
            "QA voice note: 30 minutes testing Orange ITGC controls."
        );
        assert_eq!(result.audio_duration_ms, 1200);
    }

    #[test]
    fn mock_calendar_extract_result_uses_selected_date_and_ignores_all_day() {
        let result = mock_calendar_extract_result(
            &CalendarExtractInput {
                image_base64: "mock".to_string(),
                mime_type: "image/png".to_string(),
                client_timestamp_iso: "2026-06-21T12:00:00Z".to_string(),
                timezone: "America/Los_Angeles".to_string(),
                client_local_date: "2026-06-21".to_string(),
                client_local_time: "12:00".to_string(),
                client_utc_offset_minutes: -420,
                selected_date: "2026-06-22".to_string(),
                open_ai_model: None,
                ignored_keywords: vec![],
                ignore_all_day_events: true,
            },
            "test-correlation".to_string(),
            OpenAiModelId::Gpt54,
        );

        assert_eq!(result.correlation_id, "test-correlation");
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].date, "2026-06-22");
        assert_eq!(result.ignored_candidate_count, 1);
    }
}
