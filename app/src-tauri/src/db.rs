use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, Params};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    ActiveTimer, Activity, ActivityUpsertInput, CodeContext, ContextActivity, ContextEngagement,
    DiagnosticsEvent, Engagement, EngagementType, EngagementUpsertInput, NormalizedEntry,
    OpenAiModelId, QuickAddSuggestion, TimelineDaySummary, TimelineEntry, TimelineTotalBreakdown,
    TimelineWeeklySummary, TimelineWeeklySummaryCell, TimelineWeeklySummaryDay,
    TimelineWeeklySummaryNote, TimelineWeeklySummaryRow, TranscriptionModelId, Warning,
    WarningType,
};

pub const LOW_CONFIDENCE_THRESHOLD: f64 = 0.75;
pub const DIAGNOSTICS_RETENTION_DAYS: i64 = 7;
const MAX_USAGE_DESCRIPTION_LENGTH: usize = 500;
const STANDARD_TIME_OFF_CODES_SEEDED_SETTING: &str = "standard_time_off_codes_seeded_v2";
const APPLE_FY26_CODES_SEEDED_SETTING: &str = "apple_fy26_codes_seeded_v2";
const APPLE_FY26_ACTIVITIES_JSON: &str = include_str!("seed_data/apple_fy26_activities.json");

#[derive(Clone, Copy)]
struct StandardTimeOffDefinition {
    engagement_id: &'static str,
    activity_id: &'static str,
    engagement_code: &'static str,
    legacy_engagement_code: &'static str,
    activity_code: &'static str,
    legacy_activity_code: &'static str,
    name: &'static str,
    engagement_color_hex: &'static str,
    activity_color_hex: Option<&'static str>,
    engagement_tags: &'static [&'static str],
    activity_tags: &'static [&'static str],
    describe_when_to_use: &'static str,
}

#[derive(Deserialize)]
struct SeedActivityDefinition {
    code: String,
    name: String,
}

const STANDARD_TIME_OFF_DEFINITIONS: [StandardTimeOffDefinition; 2] = [
    StandardTimeOffDefinition {
        engagement_id: "standard-vacation-engagement",
        activity_id: "standard-vacation-activity",
        engagement_code: "A-US010015",
        legacy_engagement_code: "VACATION",
        activity_code: "0000",
        legacy_activity_code: "VACATION",
        name: "Vacation",
        engagement_color_hex: "#BABABA",
        activity_color_hex: None,
        engagement_tags: &["ooo", "out of office", "pto", "vacation", "time off"],
        activity_tags: &["ooo", "out of office", "pto", "vacation", "time off"],
        describe_when_to_use: "Use for vacation, PTO, OOO, out of office, and personal time off days.",
    },
    StandardTimeOffDefinition {
        engagement_id: "standard-public-holiday-engagement",
        activity_id: "standard-public-holiday-activity",
        engagement_code: "A-US010002",
        legacy_engagement_code: "HOLIDAY",
        activity_code: "0000",
        legacy_activity_code: "HOLIDAY",
        name: "Public Holiday",
        engagement_color_hex: "#BABABA",
        activity_color_hex: None,
        engagement_tags: &[],
        activity_tags: &["holiday", "public holiday", "observed holiday"],
        describe_when_to_use: "Use for public holidays, observed holidays, and OOO time specifically taken for a holiday.",
    },
];

pub fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn init_database(app: &AppHandle) -> AppResult<Connection> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(format!("failed to resolve app data dir: {error}")))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|error| AppError::Config(format!("failed to create app data dir: {error}")))?;

    let db_path = app_data_dir.join("omnisheet.db");
    let connection = Connection::open(db_path)?;
    run_migrations(&connection)?;
    prune_old_diagnostics(&connection, DIAGNOSTICS_RETENTION_DAYS)?;
    Ok(connection)
}

pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS engagements (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        client TEXT,
        engagement_type TEXT NOT NULL DEFAULT 'external',
        color_hex TEXT,
        tags TEXT NOT NULL,
        describe_when_to_use TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL,
        code TEXT,
        name TEXT NOT NULL,
        color_hex TEXT,
        tags TEXT NOT NULL,
        describe_when_to_use TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_engagements_unique_code
      ON engagements(code)
      WHERE code IS NOT NULL AND length(trim(code)) > 0;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_unique_code
      ON activities(engagement_id, code)
      WHERE code IS NOT NULL AND length(trim(code)) > 0;

      CREATE TABLE IF NOT EXISTS raw_messages (
        id TEXT PRIMARY KEY,
        raw_text TEXT NOT NULL,
        interpreted_entries_json TEXT NOT NULL,
        open_ai_model TEXT,
        capture_source TEXT NOT NULL DEFAULT 'text',
        transcription_model TEXT,
        transcription_duration_ms INTEGER,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        message_timestamp INTEGER NOT NULL,
        interpreted_entry_count INTEGER NOT NULL DEFAULT 0,
        unique_entry_count INTEGER NOT NULL DEFAULT 0,
        saved_entry_count INTEGER NOT NULL DEFAULT 0,
        truncated_entry_count INTEGER NOT NULL DEFAULT 0,
        contains_multiple_events INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timesheet_entries (
        id TEXT PRIMARY KEY,
        engagement_id TEXT,
        activity_id TEXT,
        date TEXT NOT NULL,
        start_minute INTEGER NOT NULL,
        end_minute INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        description TEXT NOT NULL,
        user_submission_text TEXT,
        source TEXT NOT NULL,
        raw_message_id TEXT,
        confidence REAL NOT NULL,
        used_activity_fallback INTEGER NOT NULL DEFAULT 0,
        used_temporal_fallback INTEGER NOT NULL DEFAULT 0,
        duration_defaulted INTEGER NOT NULL DEFAULT 0,
        fallback_summary TEXT,
        source_message_entry_index INTEGER,
        source_message_entry_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE SET NULL,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE SET NULL,
        FOREIGN KEY (raw_message_id) REFERENCES raw_messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_timesheet_entries_date ON timesheet_entries(date);
      CREATE INDEX IF NOT EXISTS idx_timesheet_entries_engagement_activity_created_at
      ON timesheet_entries(engagement_id, activity_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_timesheet_entries_date_start_created
      ON timesheet_entries(date, start_minute, created_at);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_timer (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        engagement_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_minute INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS entry_warnings (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        warning_type TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (entry_id) REFERENCES timesheet_entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entry_warnings_entry_id ON entry_warnings(entry_id);
      CREATE INDEX IF NOT EXISTS idx_entry_warnings_warning_type ON entry_warnings(warning_type);

      CREATE TABLE IF NOT EXISTS diagnostics_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        event_type TEXT NOT NULL,
        command TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        message_text TEXT,
        details_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_diagnostics_events_timestamp ON diagnostics_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_events_correlation ON diagnostics_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_events_status ON diagnostics_events(status);
    "#,
    )?;

    ensure_expected_columns(conn)?;
    migrate_optional_user_code_schema(conn)?;
    ensure_optional_code_indexes(conn)?;
    ensure_standard_time_off_codes(conn)?;
    ensure_apple_fy26_codes(conn)?;

    Ok(())
}

fn ensure_expected_columns(conn: &Connection) -> AppResult<()> {
    let had_engagement_type = column_exists(conn, "engagements", "engagement_type")?;
    ensure_column_exists(
        conn,
        "engagements",
        "engagement_type",
        "TEXT NOT NULL DEFAULT 'external'",
    )?;
    ensure_engagement_type_values(conn, !had_engagement_type)?;
    ensure_column_exists(conn, "engagements", "color_hex", "TEXT")?;
    ensure_column_exists(conn, "engagements", "describe_when_to_use", "TEXT")?;
    ensure_column_exists(conn, "activities", "color_hex", "TEXT")?;
    ensure_column_exists(conn, "activities", "describe_when_to_use", "TEXT")?;
    ensure_column_exists(
        conn,
        "timesheet_entries",
        "used_activity_fallback",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(
        conn,
        "timesheet_entries",
        "used_temporal_fallback",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(
        conn,
        "timesheet_entries",
        "duration_defaulted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(conn, "timesheet_entries", "fallback_summary", "TEXT")?;
    ensure_column_exists(conn, "timesheet_entries", "user_submission_text", "TEXT")?;
    ensure_column_exists(
        conn,
        "timesheet_entries",
        "source_message_entry_index",
        "INTEGER",
    )?;
    ensure_column_exists(
        conn,
        "timesheet_entries",
        "source_message_entry_count",
        "INTEGER",
    )?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "interpreted_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(conn, "raw_messages", "open_ai_model", "TEXT")?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "capture_source",
        "TEXT NOT NULL DEFAULT 'text'",
    )?;
    ensure_column_exists(conn, "raw_messages", "transcription_model", "TEXT")?;
    ensure_column_exists(conn, "raw_messages", "transcription_duration_ms", "INTEGER")?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "unique_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "saved_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "truncated_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column_exists(
        conn,
        "raw_messages",
        "contains_multiple_events",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn migrate_optional_user_code_schema(conn: &Connection) -> AppResult<()> {
    let engagements_code_not_null = column_is_not_null(conn, "engagements", "code")?;
    let activities_code_not_null = column_is_not_null(conn, "activities", "code")?;

    if !engagements_code_not_null && !activities_code_not_null {
        return Ok(());
    }

    conn.execute_batch(
        r#"
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE TRANSACTION;

      CREATE TABLE engagements_new (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        client TEXT,
        engagement_type TEXT NOT NULL DEFAULT 'external',
        color_hex TEXT,
        tags TEXT NOT NULL,
        describe_when_to_use TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO engagements_new (
        id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      SELECT
        id,
        NULLIF(TRIM(code), ''),
        name,
        client,
        CASE
          WHEN engagement_type IN ('external', 'internal') THEN engagement_type
          WHEN lower(substr(trim(code), 1, 1)) IN ('i', 'a') THEN 'internal'
          ELSE 'external'
        END,
        color_hex,
        tags,
        describe_when_to_use,
        is_active,
        created_at,
        updated_at
      FROM engagements;

      CREATE TABLE activities_new (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL,
        code TEXT,
        name TEXT NOT NULL,
        color_hex TEXT,
        tags TEXT NOT NULL,
        describe_when_to_use TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
      );

      INSERT INTO activities_new (
        id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      SELECT
        id,
        engagement_id,
        NULLIF(TRIM(code), ''),
        name,
        color_hex,
        tags,
        describe_when_to_use,
        is_active,
        created_at,
        updated_at
      FROM activities;

      DROP TABLE activities;
      DROP TABLE engagements;

      ALTER TABLE engagements_new RENAME TO engagements;
      ALTER TABLE activities_new RENAME TO activities;

      COMMIT;
      PRAGMA foreign_keys = ON;
    "#,
    )?;

    Ok(())
}

fn ensure_optional_code_indexes(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
      CREATE UNIQUE INDEX IF NOT EXISTS idx_engagements_unique_code
      ON engagements(code)
      WHERE code IS NOT NULL AND length(trim(code)) > 0;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_unique_code
      ON activities(engagement_id, code)
      WHERE code IS NOT NULL AND length(trim(code)) > 0;
    "#,
    )?;

    Ok(())
}

fn column_is_not_null(conn: &Connection, table_name: &str, column_name: &str) -> AppResult<bool> {
    let query = format!("PRAGMA table_info({table_name})");
    let mut statement = conn.prepare(&query)?;
    let mut rows = statement.query([])?;

    while let Some(row) = rows.next()? {
        let candidate_name: String = row.get(1)?;
        if candidate_name == column_name {
            let is_not_null: i64 = row.get(3)?;
            return Ok(is_not_null == 1);
        }
    }

    Ok(false)
}

fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> AppResult<bool> {
    let query = format!("PRAGMA table_info({table_name})");
    let mut statement = conn.prepare(&query)?;
    let mut rows = statement.query([])?;

    while let Some(row) = rows.next()? {
        let candidate_name: String = row.get(1)?;
        if candidate_name == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn ensure_column_exists(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_type: &str,
) -> AppResult<()> {
    let query = format!("PRAGMA table_info({table_name})");
    let mut statement = conn.prepare(&query)?;
    let mut rows = statement.query([])?;

    let mut column_exists = false;
    while let Some(row) = rows.next()? {
        let candidate_name: String = row.get(1)?;
        if candidate_name == column_name {
            column_exists = true;
            break;
        }
    }

    if !column_exists {
        let alter_statement =
            format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}");
        conn.execute_batch(&alter_statement)?;
    }

    Ok(())
}

fn ensure_engagement_type_values(
    conn: &Connection,
    should_backfill_from_code: bool,
) -> AppResult<()> {
    if should_backfill_from_code {
        conn.execute_batch(
            r#"
            UPDATE engagements
            SET engagement_type = CASE
              WHEN lower(substr(trim(code), 1, 1)) IN ('i', 'a') THEN 'internal'
              ELSE 'external'
            END;
            "#,
        )?;
    }

    conn.execute_batch(
        r#"
        UPDATE engagements
        SET engagement_type = 'external'
        WHERE engagement_type IS NULL
          OR engagement_type NOT IN ('external', 'internal')
          OR trim(engagement_type) = '';
        "#,
    )?;

    Ok(())
}

fn ensure_standard_time_off_codes(conn: &Connection) -> AppResult<()> {
    if get_app_setting(conn, STANDARD_TIME_OFF_CODES_SEEDED_SETTING)?.as_deref() == Some("1") {
        return Ok(());
    }

    for definition in STANDARD_TIME_OFF_DEFINITIONS {
        let engagement_id = ensure_standard_time_off_engagement(conn, definition)?;
        ensure_standard_time_off_activity(conn, definition, &engagement_id)?;
    }

    upsert_app_setting(conn, STANDARD_TIME_OFF_CODES_SEEDED_SETTING, "1")?;
    Ok(())
}

fn ensure_standard_time_off_engagement(
    conn: &Connection,
    definition: StandardTimeOffDefinition,
) -> AppResult<String> {
    let name_key = definition.name.to_ascii_lowercase();
    let existing_id = conn
        .query_row(
            r#"
            SELECT id
            FROM engagements
            WHERE upper(trim(COALESCE(code, ''))) = ?1
               OR upper(trim(COALESCE(code, ''))) = ?3
               OR lower(trim(name)) = ?2
            ORDER BY
              CASE
                WHEN upper(trim(COALESCE(code, ''))) = ?1 THEN 0
                WHEN upper(trim(COALESCE(code, ''))) = ?3 THEN 1
                ELSE 2
              END,
              created_at ASC
            LIMIT 1
            "#,
            params![
                definition.engagement_code,
                name_key,
                definition.legacy_engagement_code
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if let Some(id) = existing_id {
        let now = current_unix_timestamp();
        let tags_json = serde_json::to_string(&definition.engagement_tags)?;
        let can_set_code =
            !engagement_code_exists_elsewhere(conn, definition.engagement_code, &id)?;
        if can_set_code {
            conn.execute(
                r#"
                UPDATE engagements
                SET code = ?2,
                    engagement_type = 'internal',
                    color_hex = COALESCE(color_hex, ?3),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?4
                      ELSE tags
                    END,
                    describe_when_to_use = COALESCE(NULLIF(trim(describe_when_to_use), ''), ?5),
                    is_active = 1,
                    updated_at = ?6
                WHERE id = ?1
                "#,
                params![
                    id,
                    definition.engagement_code,
                    definition.engagement_color_hex,
                    tags_json,
                    definition.describe_when_to_use,
                    now,
                ],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE engagements
                SET engagement_type = 'internal',
                    color_hex = COALESCE(color_hex, ?2),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?3
                      ELSE tags
                    END,
                    describe_when_to_use = COALESCE(NULLIF(trim(describe_when_to_use), ''), ?4),
                    is_active = 1,
                    updated_at = ?5
                WHERE id = ?1
                "#,
                params![
                    id,
                    definition.engagement_color_hex,
                    tags_json,
                    definition.describe_when_to_use,
                    now,
                ],
            )?;
        }

        return Ok(id);
    }

    let now = current_unix_timestamp();
    let tags_json = serde_json::to_string(&definition.engagement_tags)?;
    conn.execute(
        r#"
        INSERT INTO engagements (
          id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, NULL, 'internal', ?4, ?5, ?6, 1, ?7, ?7)
        "#,
        params![
            definition.engagement_id,
            definition.engagement_code,
            definition.name,
            definition.engagement_color_hex,
            tags_json,
            definition.describe_when_to_use,
            now,
        ],
    )?;

    Ok(definition.engagement_id.to_string())
}

fn ensure_standard_time_off_activity(
    conn: &Connection,
    definition: StandardTimeOffDefinition,
    engagement_id: &str,
) -> AppResult<String> {
    let name_key = definition.name.to_ascii_lowercase();
    let existing_id = conn
        .query_row(
            r#"
            SELECT id
            FROM activities
            WHERE engagement_id = ?1
              AND (
                upper(trim(COALESCE(code, ''))) = ?2
                OR upper(trim(COALESCE(code, ''))) = ?4
                OR lower(trim(name)) = ?3
              )
            ORDER BY
              CASE
                WHEN upper(trim(COALESCE(code, ''))) = ?2 THEN 0
                WHEN upper(trim(COALESCE(code, ''))) = ?4 THEN 1
                ELSE 2
              END,
              created_at ASC
            LIMIT 1
            "#,
            params![
                engagement_id,
                definition.activity_code,
                name_key,
                definition.legacy_activity_code
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if let Some(id) = existing_id {
        let now = current_unix_timestamp();
        let tags_json = serde_json::to_string(&definition.activity_tags)?;
        let can_set_code =
            !activity_code_exists_elsewhere(conn, engagement_id, definition.activity_code, &id)?;
        if can_set_code {
            conn.execute(
                r#"
                UPDATE activities
                SET code = ?3,
                    color_hex = COALESCE(color_hex, ?4),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?5
                      ELSE tags
                    END,
                    describe_when_to_use = COALESCE(NULLIF(trim(describe_when_to_use), ''), ?6),
                    is_active = 1,
                    updated_at = ?7
                WHERE id = ?1
                  AND engagement_id = ?2
                "#,
                params![
                    id,
                    engagement_id,
                    definition.activity_code,
                    definition.activity_color_hex,
                    tags_json,
                    definition.describe_when_to_use,
                    now,
                ],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE activities
                SET color_hex = COALESCE(color_hex, ?3),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?4
                      ELSE tags
                    END,
                    describe_when_to_use = COALESCE(NULLIF(trim(describe_when_to_use), ''), ?5),
                    is_active = 1,
                    updated_at = ?6
                WHERE id = ?1
                  AND engagement_id = ?2
                "#,
                params![
                    id,
                    engagement_id,
                    definition.activity_color_hex,
                    tags_json,
                    definition.describe_when_to_use,
                    now,
                ],
            )?;
        }

        return Ok(id);
    }

    let now = current_unix_timestamp();
    let tags_json = serde_json::to_string(&definition.activity_tags)?;
    conn.execute(
        r#"
        INSERT INTO activities (
          id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
        "#,
        params![
            definition.activity_id,
            engagement_id,
            definition.activity_code,
            definition.name,
            definition.activity_color_hex,
            tags_json,
            definition.describe_when_to_use,
            now,
        ],
    )?;

    Ok(definition.activity_id.to_string())
}

fn ensure_apple_fy26_codes(conn: &Connection) -> AppResult<()> {
    if get_app_setting(conn, APPLE_FY26_CODES_SEEDED_SETTING)?.as_deref() == Some("1") {
        return Ok(());
    }

    let engagement_id = ensure_apple_fy26_engagement(conn)?;
    let activities: Vec<SeedActivityDefinition> = serde_json::from_str(APPLE_FY26_ACTIVITIES_JSON)?;
    for activity in &activities {
        ensure_apple_fy26_activity(conn, &engagement_id, activity)?;
    }

    upsert_app_setting(conn, APPLE_FY26_CODES_SEEDED_SETTING, "1")?;
    Ok(())
}

fn ensure_apple_fy26_engagement(conn: &Connection) -> AppResult<String> {
    const APPLE_ENGAGEMENT_ID: &str = "apple-fy26-engagement";
    const APPLE_ENGAGEMENT_CODE: &str = "E-69306633";
    const APPLE_ENGAGEMENT_NAME: &str = "Apple FY26";
    const APPLE_CLIENT: &str = "Apple";
    const APPLE_COLOR_HEX: &str = "#1F7AFF";
    const OLD_APPLE_USAGE: &str = "Use for Apple FY26 engagement work.";
    const APPLE_USAGE: &str = "Used for activities related to the Apple SOX audit.";

    let mut existing_id = find_engagement_id_by_code(conn, APPLE_ENGAGEMENT_CODE)?;
    if existing_id.is_none() {
        for name in ["Apple FY26", "Apple ITGC"] {
            existing_id = find_engagement_id_by_name(conn, name)?;
            if existing_id.is_some() {
                break;
            }
        }
    }

    let tags_json = serde_json::to_string(&Vec::<String>::new())?;
    if let Some(id) = existing_id {
        let now = current_unix_timestamp();
        let can_set_code = !engagement_code_exists_elsewhere(conn, APPLE_ENGAGEMENT_CODE, &id)?;
        if can_set_code {
            conn.execute(
                r#"
                UPDATE engagements
                SET code = ?2,
                    name = CASE
                      WHEN lower(trim(name)) = 'apple itgc' THEN ?3
                      ELSE name
                    END,
                    client = COALESCE(NULLIF(trim(client), ''), ?4),
                    engagement_type = 'external',
                    color_hex = COALESCE(color_hex, ?5),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?6
                      ELSE tags
                    END,
                    describe_when_to_use = CASE
                      WHEN describe_when_to_use IS NULL
                        OR trim(describe_when_to_use) = ''
                        OR trim(describe_when_to_use) = ?8
                      THEN ?7
                      ELSE describe_when_to_use
                    END,
                    is_active = 1,
                    updated_at = ?9
                WHERE id = ?1
                "#,
                params![
                    id,
                    APPLE_ENGAGEMENT_CODE,
                    APPLE_ENGAGEMENT_NAME,
                    APPLE_CLIENT,
                    APPLE_COLOR_HEX,
                    tags_json,
                    APPLE_USAGE,
                    OLD_APPLE_USAGE,
                    now,
                ],
            )?;
        } else {
            conn.execute(
                r#"
                UPDATE engagements
                SET name = CASE
                      WHEN lower(trim(name)) = 'apple itgc' THEN ?2
                      ELSE name
                    END,
                    client = COALESCE(NULLIF(trim(client), ''), ?3),
                    engagement_type = 'external',
                    color_hex = COALESCE(color_hex, ?4),
                    tags = CASE
                      WHEN trim(tags) = '' OR tags = '[]' THEN ?5
                      ELSE tags
                    END,
                    describe_when_to_use = CASE
                      WHEN describe_when_to_use IS NULL
                        OR trim(describe_when_to_use) = ''
                        OR trim(describe_when_to_use) = ?7
                      THEN ?6
                      ELSE describe_when_to_use
                    END,
                    is_active = 1,
                    updated_at = ?8
                WHERE id = ?1
                "#,
                params![
                    id,
                    APPLE_ENGAGEMENT_NAME,
                    APPLE_CLIENT,
                    APPLE_COLOR_HEX,
                    tags_json,
                    APPLE_USAGE,
                    OLD_APPLE_USAGE,
                    now,
                ],
            )?;
        }

        return Ok(id);
    }

    let now = current_unix_timestamp();
    conn.execute(
        r#"
        INSERT INTO engagements (
          id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, 'external', ?5, ?6, ?7, 1, ?8, ?8)
        "#,
        params![
            APPLE_ENGAGEMENT_ID,
            APPLE_ENGAGEMENT_CODE,
            APPLE_ENGAGEMENT_NAME,
            APPLE_CLIENT,
            APPLE_COLOR_HEX,
            tags_json,
            APPLE_USAGE,
            now,
        ],
    )?;

    Ok(APPLE_ENGAGEMENT_ID.to_string())
}

fn ensure_apple_fy26_activity(
    conn: &Connection,
    engagement_id: &str,
    definition: &SeedActivityDefinition,
) -> AppResult<String> {
    let code = definition.code.trim().to_ascii_uppercase();
    let name = definition.name.trim();
    if code.is_empty() || name.is_empty() {
        return Err(AppError::Config(
            "Apple FY26 seed activities require code and name".to_string(),
        ));
    }

    let existing_id = conn
        .query_row(
            r#"
            SELECT id
            FROM activities
            WHERE engagement_id = ?1
              AND upper(trim(COALESCE(code, ''))) = ?2
            ORDER BY created_at ASC
            LIMIT 1
            "#,
            params![engagement_id, code],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if let Some(id) = existing_id {
        let now = current_unix_timestamp();
        conn.execute(
            r#"
            UPDATE activities
            SET name = ?3,
                tags = CASE
                  WHEN trim(tags) = '' THEN '[]'
                  ELSE tags
                END,
                is_active = 1,
                updated_at = ?4
            WHERE id = ?1
              AND engagement_id = ?2
            "#,
            params![id, engagement_id, name, now],
        )?;

        return Ok(id);
    }

    let now = current_unix_timestamp();
    let id = seed_activity_id("apple-fy26-activity", &code);
    conn.execute(
        r#"
        INSERT INTO activities (
          id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, NULL, '[]', NULL, 1, ?5, ?5)
        "#,
        params![id, engagement_id, code, name, now],
    )?;

    Ok(id)
}

fn seed_activity_id(prefix: &str, code: &str) -> String {
    let normalized_code = code
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect::<String>();
    format!("{prefix}-{normalized_code}")
}

fn find_engagement_id_by_code(conn: &Connection, code: &str) -> AppResult<Option<String>> {
    let id = conn
        .query_row(
            r#"
            SELECT id
            FROM engagements
            WHERE upper(trim(COALESCE(code, ''))) = ?1
            ORDER BY created_at ASC
            LIMIT 1
            "#,
            params![code.trim().to_ascii_uppercase()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(id)
}

fn find_engagement_id_by_name(conn: &Connection, name: &str) -> AppResult<Option<String>> {
    let id = conn
        .query_row(
            r#"
            SELECT id
            FROM engagements
            WHERE lower(trim(name)) = ?1
            ORDER BY created_at ASC
            LIMIT 1
            "#,
            params![name.trim().to_ascii_lowercase()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(id)
}

fn engagement_code_exists_elsewhere(
    conn: &Connection,
    code: &str,
    current_id: &str,
) -> AppResult<bool> {
    let exists = conn.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM engagements
          WHERE upper(trim(COALESCE(code, ''))) = ?1
            AND id <> ?2
        )
        "#,
        params![code, current_id],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(exists == 1)
}

fn activity_code_exists_elsewhere(
    conn: &Connection,
    engagement_id: &str,
    code: &str,
    current_id: &str,
) -> AppResult<bool> {
    let exists = conn.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM activities
          WHERE engagement_id = ?1
            AND upper(trim(COALESCE(code, ''))) = ?2
            AND id <> ?3
        )
        "#,
        params![engagement_id, code, current_id],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(exists == 1)
}

pub fn upsert_engagement(conn: &Connection, input: EngagementUpsertInput) -> AppResult<String> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "engagement name is required".to_string(),
        ));
    }
    let now = current_unix_timestamp();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let code = normalize_optional_code(input.code);
    let engagement_type = input
        .engagement_type
        .unwrap_or_else(|| infer_engagement_type_from_code(code.as_deref()));
    let engagement_type = engagement_type_db_value(engagement_type);
    let color_hex = normalize_color_hex(input.color_hex)?;
    let tags_json = serde_json::to_string(&normalize_tags(input.tags))?;
    let describe_when_to_use = normalize_usage_description(input.describe_when_to_use)?;
    let is_active = if input.is_active.unwrap_or(true) {
        1
    } else {
        0
    };

    conn.execute(
        r#"
      INSERT INTO engagements (
        id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        client = excluded.client,
        engagement_type = excluded.engagement_type,
        color_hex = excluded.color_hex,
        tags = excluded.tags,
        describe_when_to_use = excluded.describe_when_to_use,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    "#,
        params![
            id,
            code,
            input.name.trim(),
            input.client.as_ref().map(|client| client.trim()),
            engagement_type,
            color_hex,
            tags_json,
            describe_when_to_use,
            is_active,
            now,
        ],
    )?;

    Ok(id)
}

pub fn delete_engagement(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM engagements WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn upsert_activity(conn: &Connection, input: ActivityUpsertInput) -> AppResult<String> {
    if input.engagement_id.trim().is_empty() || input.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "activity engagement and name are required".to_string(),
        ));
    }
    let now = current_unix_timestamp();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let code = normalize_optional_code(input.code);
    let color_hex = normalize_color_hex(input.color_hex)?;
    let tags_json = serde_json::to_string(&normalize_tags(input.tags))?;
    let describe_when_to_use = normalize_usage_description(input.describe_when_to_use)?;
    let is_active = if input.is_active.unwrap_or(true) {
        1
    } else {
        0
    };

    conn.execute(
    r#"
      INSERT INTO activities (
        id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      ON CONFLICT(id) DO UPDATE SET
        engagement_id = excluded.engagement_id,
        code = excluded.code,
        name = excluded.name,
        color_hex = excluded.color_hex,
        tags = excluded.tags,
        describe_when_to_use = excluded.describe_when_to_use,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    "#,
        params![
      id,
      input.engagement_id.trim(),
      code,
      input.name.trim(),
      color_hex,
      tags_json,
      describe_when_to_use,
      is_active,
      now,
    ],
  )?;

    Ok(id)
}

pub fn delete_activity(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM activities WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_timeline_entry(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM timesheet_entries WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn engagement_exists(conn: &Connection, engagement_id: &str) -> AppResult<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM engagements WHERE id = ?1)",
        params![engagement_id],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(exists == 1)
}

pub fn activity_belongs_to_engagement(
    conn: &Connection,
    engagement_id: &str,
    activity_id: &str,
) -> AppResult<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM activities WHERE id = ?1 AND engagement_id = ?2)",
        params![activity_id, engagement_id],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(exists == 1)
}

pub fn get_app_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(value)
}

pub fn upsert_app_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        r#"
        INSERT INTO app_settings (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![key, value],
    )?;

    Ok(())
}

pub fn list_engagements(conn: &Connection) -> AppResult<Vec<Engagement>> {
    let mut engagement_statement = conn.prepare(
        r#"
      SELECT id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      FROM engagements
      ORDER BY name COLLATE NOCASE
    "#,
    )?;

    let mut engagements: Vec<Engagement> = engagement_statement
        .query_map([], |row| {
            let code = row.get::<_, Option<String>>(1)?;
            let engagement_type_raw = row.get::<_, Option<String>>(4)?;
            let tags_json: String = row.get(6)?;
            let tags = parse_tags(&tags_json).unwrap_or_default();
            Ok(Engagement {
                id: row.get(0)?,
                engagement_type: db_value_to_engagement_type(
                    engagement_type_raw.as_deref(),
                    code.as_deref(),
                ),
                code,
                name: row.get(2)?,
                client: row.get(3)?,
                color_hex: row.get(5)?,
                tags,
                describe_when_to_use: row.get(7)?,
                is_active: row.get::<_, i64>(8)? == 1,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                activities: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut activities_by_engagement: HashMap<String, Vec<Activity>> = HashMap::new();
    let mut activity_statement = conn.prepare(
        r#"
      SELECT id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      FROM activities
      ORDER BY name COLLATE NOCASE
    "#,
    )?;

    for activity in activity_statement
        .query_map([], |row| {
            let tags_json: String = row.get(5)?;
            let tags = parse_tags(&tags_json).unwrap_or_default();

            Ok(Activity {
                id: row.get(0)?,
                engagement_id: row.get(1)?,
                code: row.get(2)?,
                name: row.get(3)?,
                color_hex: row.get(4)?,
                tags,
                describe_when_to_use: row.get(6)?,
                is_active: row.get::<_, i64>(7)? == 1,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    {
        activities_by_engagement
            .entry(activity.engagement_id.clone())
            .or_default()
            .push(activity);
    }

    for engagement in &mut engagements {
        if let Some(activities) = activities_by_engagement.remove(&engagement.id) {
            engagement.activities = activities;
        }
    }

    Ok(engagements)
}

pub fn list_quick_add_suggestions(
    conn: &Connection,
    limit: i64,
) -> AppResult<Vec<QuickAddSuggestion>> {
    let safe_limit = if limit < 1 { -1 } else { limit.clamp(1, 500) };
    let mut statement = conn.prepare(
        r#"
      SELECT
        e.id AS engagement_id,
        a.id AS activity_id,
        COUNT(te.id) AS usage_count,
        MAX(te.created_at) AS last_used_at
      FROM activities a
      INNER JOIN engagements e ON e.id = a.engagement_id
      LEFT JOIN timesheet_entries te
        ON te.engagement_id = e.id
       AND te.activity_id = a.id
      WHERE e.is_active = 1
        AND a.is_active = 1
      GROUP BY e.id, a.id
      ORDER BY
        usage_count DESC,
        last_used_at IS NULL ASC,
        last_used_at DESC,
        e.name COLLATE NOCASE ASC,
        COALESCE(e.code, '') COLLATE NOCASE ASC,
        a.name COLLATE NOCASE ASC,
        COALESCE(a.code, '') COLLATE NOCASE ASC,
        a.id ASC
      LIMIT ?1
    "#,
    )?;

    let suggestions = statement
        .query_map(params![safe_limit], |row| {
            Ok(QuickAddSuggestion {
                engagement_id: row.get(0)?,
                activity_id: row.get(1)?,
                usage_count: row.get(2)?,
                last_used_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(suggestions)
}

pub fn load_code_context(conn: &Connection) -> AppResult<CodeContext> {
    let engagements = list_engagements(conn)?;
    let contexts = engagements
        .into_iter()
        .filter(|engagement| engagement.is_active)
        .enumerate()
        .map(|(engagement_index, engagement)| ContextEngagement {
            id: engagement.id,
            engagement_ref: format!("eng-{:03}", engagement_index + 1),
            code: engagement.code,
            name: engagement.name,
            tags: engagement.tags,
            describe_when_to_use: engagement.describe_when_to_use,
            activities: engagement
                .activities
                .into_iter()
                .filter(|activity| activity.is_active)
                .enumerate()
                .map(|(activity_index, activity)| ContextActivity {
                    id: activity.id,
                    activity_ref: format!(
                        "act-{:03}-{:03}",
                        engagement_index + 1,
                        activity_index + 1
                    ),
                    code: activity.code,
                    name: activity.name,
                    tags: activity.tags,
                    describe_when_to_use: activity.describe_when_to_use,
                })
                .collect(),
        })
        .collect();

    Ok(CodeContext {
        engagements: contexts,
    })
}

pub fn insert_raw_message(
    conn: &Connection,
    id: &str,
    raw_text: &str,
    interpreted_entries_json: &str,
    open_ai_model: &str,
    capture_source: &str,
    transcription_model: Option<&str>,
    transcription_duration_ms: Option<i64>,
    confidence: f64,
    message_timestamp: i64,
    interpreted_entry_count: i64,
    unique_entry_count: i64,
    saved_entry_count: i64,
    truncated_entry_count: i64,
    contains_multiple_events: bool,
) -> AppResult<()> {
    let now = current_unix_timestamp();

    conn.execute(
        r#"
      INSERT INTO raw_messages (
        id, raw_text, interpreted_entries_json, open_ai_model, capture_source,
        transcription_model, transcription_duration_ms, confidence,
        status, message_timestamp, interpreted_entry_count, unique_entry_count,
        saved_entry_count, truncated_entry_count, contains_multiple_events, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'processed', ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    "#,
        params![
            id,
            raw_text.trim(),
            interpreted_entries_json,
            open_ai_model,
            capture_source,
            transcription_model,
            transcription_duration_ms,
            confidence,
            message_timestamp,
            interpreted_entry_count,
            unique_entry_count,
            saved_entry_count,
            truncated_entry_count,
            if contains_multiple_events { 1 } else { 0 },
            now,
        ],
    )?;

    Ok(())
}

pub fn insert_timesheet_entry(
    conn: &Connection,
    raw_message_id: &str,
    entry: &NormalizedEntry,
    engagement_id: Option<&str>,
    activity_id: Option<&str>,
    used_activity_fallback: bool,
    used_temporal_fallback: bool,
    duration_defaulted: bool,
    fallback_summary: Option<&str>,
    source_message_entry_index: Option<i64>,
    source_message_entry_count: Option<i64>,
    source: &str,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = current_unix_timestamp();

    conn.execute(
        r#"
      INSERT INTO timesheet_entries (
        id, engagement_id, activity_id, date, start_minute, end_minute,
        duration_minutes, description, user_submission_text, source, raw_message_id, confidence,
        used_activity_fallback, used_temporal_fallback, duration_defaulted,
        fallback_summary, source_message_entry_index, source_message_entry_count, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
    "#,
        params![
            id,
            engagement_id,
            activity_id,
            entry.date,
            entry.start_minute,
            entry.end_minute,
            entry.duration_minutes,
            entry.description,
            entry.user_submission_text,
            source,
            raw_message_id,
            entry.confidence,
            if used_activity_fallback { 1 } else { 0 },
            if used_temporal_fallback { 1 } else { 0 },
            if duration_defaulted { 1 } else { 0 },
            fallback_summary,
            source_message_entry_index,
            source_message_entry_count,
            now,
        ],
    )?;

    Ok(id)
}

pub fn insert_manual_timeline_entry(
    conn: &Connection,
    date: &str,
    start_minute: i64,
    end_minute: i64,
    duration_minutes: i64,
    description: &str,
    engagement_id: Option<&str>,
    activity_id: Option<&str>,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = current_unix_timestamp();

    conn.execute(
        r#"
      INSERT INTO timesheet_entries (
        id, engagement_id, activity_id, date, start_minute, end_minute,
        duration_minutes, description, user_submission_text, source, raw_message_id, confidence,
        used_activity_fallback, used_temporal_fallback, duration_defaulted,
        fallback_summary, source_message_entry_index, source_message_entry_count, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'Manual Entry', 'manual', NULL, 1.0, 0, 0, 0, NULL, NULL, NULL, ?9, ?9)
    "#,
        params![
            id,
            engagement_id,
            activity_id,
            date,
            start_minute,
            end_minute,
            duration_minutes,
            description.trim(),
            now,
        ],
    )?;

    Ok(id)
}

pub fn get_active_timer(conn: &Connection) -> AppResult<Option<ActiveTimer>> {
    conn.query_row(
        r#"
      SELECT
        at.engagement_id,
        at.activity_id,
        e.code,
        e.name,
        e.color_hex,
        a.code,
        a.name,
        a.color_hex,
        at.start_date,
        at.start_minute,
        at.started_at,
        at.description
      FROM active_timer at
      INNER JOIN engagements e ON e.id = at.engagement_id
      INNER JOIN activities a ON a.id = at.activity_id
      WHERE at.singleton_id = 1
    "#,
        [],
        |row| {
            Ok(ActiveTimer {
                engagement_id: row.get(0)?,
                activity_id: row.get(1)?,
                engagement_code: row.get(2)?,
                engagement_name: row.get(3)?,
                engagement_color_hex: row.get(4)?,
                activity_code: row.get(5)?,
                activity_name: row.get(6)?,
                activity_color_hex: row.get(7)?,
                start_date: row.get(8)?,
                start_minute: row.get(9)?,
                started_at: row.get(10)?,
                description: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(AppError::from)
}

pub fn insert_active_timer(
    conn: &Connection,
    engagement_id: &str,
    activity_id: &str,
    start_date: &str,
    start_minute: i64,
    description: &str,
) -> AppResult<()> {
    conn.execute(
        r#"
      INSERT INTO active_timer (
        singleton_id, engagement_id, activity_id, start_date, start_minute, started_at, description
      )
      VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
    "#,
        params![
            engagement_id,
            activity_id,
            start_date,
            start_minute,
            current_unix_timestamp(),
            description.trim(),
        ],
    )?;

    Ok(())
}

pub fn clear_active_timer(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM active_timer WHERE singleton_id = 1", [])?;
    Ok(())
}

pub fn add_warning(
    conn: &Connection,
    entry_id: &str,
    warning_type: WarningType,
    detail: Option<String>,
) -> AppResult<Warning> {
    let id = Uuid::new_v4().to_string();
    let warning_type_value = warning_type_to_db_value(&warning_type);

    conn.execute(
        r#"
      INSERT INTO entry_warnings (id, entry_id, warning_type, detail, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
    "#,
        params![
            id,
            entry_id,
            warning_type_value,
            detail,
            current_unix_timestamp()
        ],
    )?;

    Ok(Warning {
        warning_type,
        entry_id: entry_id.to_string(),
        detail,
    })
}

pub fn clear_entry_warnings(
    conn: &Connection,
    entry_id: &str,
    warning_types: &[WarningType],
) -> AppResult<()> {
    if warning_types.is_empty() {
        return Ok(());
    }

    let warning_type_values = warning_types
        .iter()
        .map(warning_type_to_db_value)
        .collect::<Vec<_>>();

    let sql = format!(
        "DELETE FROM entry_warnings WHERE entry_id = ?1 AND warning_type IN ({})",
        warning_type_values
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 2))
            .collect::<Vec<_>>()
            .join(",")
    );

    let mut parameters: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(warning_type_values.len() + 1);
    parameters.push(&entry_id);
    for value in &warning_type_values {
        parameters.push(value);
    }

    conn.execute(&sql, parameters.as_slice())?;

    Ok(())
}

pub fn recompute_overlap_warnings(conn: &Connection, date: &str) -> AppResult<Vec<Warning>> {
    conn.execute(
        r#"
      DELETE FROM entry_warnings
      WHERE warning_type = 'overlap'
        AND entry_id IN (SELECT id FROM timesheet_entries WHERE date = ?1)
    "#,
        params![date],
    )?;

    let mut statement = conn.prepare(
        r#"
      SELECT id, start_minute, end_minute
      FROM timesheet_entries
      WHERE date = ?1
      ORDER BY start_minute, end_minute
    "#,
    )?;

    let entries = statement
        .query_map(params![date], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut overlap_ids: HashSet<String> = HashSet::new();

    for index in 0..entries.len() {
        let (current_id, _current_start, current_end) = &entries[index];

        for candidate in entries.iter().skip(index + 1) {
            let (candidate_id, candidate_start, _candidate_end) = candidate;
            if candidate_start < current_end {
                overlap_ids.insert(current_id.clone());
                overlap_ids.insert(candidate_id.clone());
            } else {
                break;
            }
        }
    }

    let mut warnings = Vec::new();
    for entry_id in overlap_ids {
        warnings.push(add_warning(
            conn,
            &entry_id,
            WarningType::Overlap,
            Some(format!("Overlaps another entry on {date}")),
        )?);
    }

    Ok(warnings)
}

fn collect_timeline_entries<P>(
    conn: &Connection,
    query: &str,
    params: P,
) -> AppResult<Vec<TimelineEntry>>
where
    P: Params,
{
    let mut statement = conn.prepare(query)?;

    let mut entries = statement
        .query_map(params, |row| {
            let model_used = row
                .get::<_, Option<String>>(22)?
                .and_then(|value| OpenAiModelId::from_api_name(&value));
            let transcription_model_used = row
                .get::<_, Option<String>>(23)?
                .and_then(|value| TranscriptionModelId::from_api_name(&value));
            let engagement_id = row.get::<_, Option<String>>(9)?;
            let engagement_code = row.get::<_, Option<String>>(11)?;
            let engagement_type_raw = row.get::<_, Option<String>>(13)?;
            let engagement_type = engagement_id.as_ref().map(|_| {
                db_value_to_engagement_type(
                    engagement_type_raw.as_deref(),
                    engagement_code.as_deref(),
                )
            });

            Ok(TimelineEntry {
                id: row.get(0)?,
                date: row.get(1)?,
                start_minute: row.get(2)?,
                end_minute: row.get(3)?,
                duration_minutes: row.get(4)?,
                description: row.get(5)?,
                user_submission_text: row.get(6)?,
                source: row.get(7)?,
                confidence: row.get(8)?,
                engagement_id,
                activity_id: row.get(10)?,
                engagement_code,
                engagement_name: row.get(12)?,
                engagement_type,
                activity_code: row.get(14)?,
                activity_name: row.get(15)?,
                used_activity_fallback: row.get::<_, i64>(16)? == 1,
                used_temporal_fallback: row.get::<_, i64>(17)? == 1,
                duration_defaulted: row.get::<_, i64>(18)? == 1,
                fallback_summary: row.get(19)?,
                source_message_entry_index: row.get(20)?,
                source_message_entry_count: row.get(21)?,
                model_used,
                model_used_label: model_used.map(|model| model.display_label().to_string()),
                transcription_model_used,
                transcription_model_used_label: transcription_model_used
                    .map(|model| model.display_label().to_string()),
                warning_flags: Vec::new(),
                created_at: row.get(24)?,
                updated_at: row.get(25)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for entry in &mut entries {
        entry.warning_flags = list_warning_flags(conn, &entry.id)?;
    }

    Ok(entries)
}

pub fn list_timeline_entries(conn: &Connection, date: &str) -> AppResult<Vec<TimelineEntry>> {
    collect_timeline_entries(
        conn,
        r#"
      SELECT
        te.id,
        te.date,
        te.start_minute,
        te.end_minute,
        te.duration_minutes,
        te.description,
        COALESCE(te.user_submission_text, rm.raw_text, '') AS user_submission_text,
        te.source,
        te.confidence,
        te.engagement_id,
        te.activity_id,
        e.code,
        e.name,
        e.engagement_type,
        a.code,
        a.name,
        te.used_activity_fallback,
        te.used_temporal_fallback,
        te.duration_defaulted,
        te.fallback_summary,
        te.source_message_entry_index,
        te.source_message_entry_count,
        rm.open_ai_model,
        rm.transcription_model,
        te.created_at,
        te.updated_at
      FROM timesheet_entries te
      LEFT JOIN engagements e ON e.id = te.engagement_id
      LEFT JOIN activities a ON a.id = te.activity_id
      LEFT JOIN raw_messages rm ON rm.id = te.raw_message_id
      WHERE te.date = ?1
      ORDER BY te.start_minute, te.end_minute, te.id
    "#,
        params![date],
    )
}

pub fn list_timeline_entries_for_date_range(
    conn: &Connection,
    start_date: &str,
    end_date_exclusive: &str,
) -> AppResult<Vec<TimelineEntry>> {
    collect_timeline_entries(
        conn,
        r#"
      SELECT
        te.id,
        te.date,
        te.start_minute,
        te.end_minute,
        te.duration_minutes,
        te.description,
        COALESCE(te.user_submission_text, rm.raw_text, '') AS user_submission_text,
        te.source,
        te.confidence,
        te.engagement_id,
        te.activity_id,
        e.code,
        e.name,
        e.engagement_type,
        a.code,
        a.name,
        te.used_activity_fallback,
        te.used_temporal_fallback,
        te.duration_defaulted,
        te.fallback_summary,
        te.source_message_entry_index,
        te.source_message_entry_count,
        rm.open_ai_model,
        rm.transcription_model,
        te.created_at,
        te.updated_at
      FROM timesheet_entries te
      LEFT JOIN engagements e ON e.id = te.engagement_id
      LEFT JOIN activities a ON a.id = te.activity_id
      LEFT JOIN raw_messages rm ON rm.id = te.raw_message_id
      WHERE te.date >= ?1 AND te.date < ?2
      ORDER BY te.date, te.start_minute, te.end_minute, te.id
    "#,
        params![start_date, end_date_exclusive],
    )
}

pub fn list_timeline_day_summaries_for_month(
    conn: &Connection,
    start_date: &str,
    end_date_exclusive: &str,
) -> AppResult<Vec<TimelineDaySummary>> {
    let mut statement = conn.prepare(
        r#"
      SELECT
        te.date,
        COUNT(te.id) AS entry_count,
        COALESCE(SUM(te.duration_minutes), 0) AS total_minutes
      FROM timesheet_entries te
      WHERE te.date >= ?1 AND te.date < ?2
      GROUP BY te.date
      ORDER BY te.date
    "#,
    )?;

    let rows = statement
        .query_map(params![start_date, end_date_exclusive], |row| {
            Ok(TimelineDaySummary {
                date: row.get(0)?,
                entry_count: row.get(1)?,
                total_minutes: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct WeeklySummaryRowKey {
    engagement_id: Option<String>,
    activity_id: Option<String>,
    engagement_code: Option<String>,
    activity_code: Option<String>,
    activity_name: String,
    engagement_name: String,
    client_name: String,
    engagement_type: Option<EngagementType>,
    is_uncategorized: bool,
}

#[derive(Debug, Clone)]
struct WeeklySummaryRowAccumulator {
    engagement_id: Option<String>,
    activity_id: Option<String>,
    engagement_code: Option<String>,
    activity_code: Option<String>,
    activity_name: String,
    engagement_name: String,
    client_name: String,
    engagement_type: Option<EngagementType>,
    is_uncategorized: bool,
    day_minutes: [i64; 7],
    day_notes: [Vec<TimelineWeeklySummaryNote>; 7],
}

pub fn list_timeline_weekly_summary(
    conn: &Connection,
    start_date: &str,
    end_date_exclusive: &str,
) -> AppResult<TimelineWeeklySummary> {
    let week_start = NaiveDate::parse_from_str(start_date, "%Y-%m-%d").map_err(|_| {
        AppError::InvalidInput("start_date must be in YYYY-MM-DD format".to_string())
    })?;

    let mut statement = conn.prepare(
        r#"
      SELECT
        te.date,
        te.start_minute,
        te.end_minute,
        te.duration_minutes,
        te.description,
        te.engagement_id,
        te.activity_id,
        e.code,
        e.name,
        e.client,
        e.engagement_type,
        a.code,
        a.name
      FROM timesheet_entries te
      LEFT JOIN engagements e ON e.id = te.engagement_id
      LEFT JOIN activities a ON a.id = te.activity_id
      WHERE te.date >= ?1 AND te.date < ?2
      ORDER BY te.date, te.start_minute, te.id
    "#,
    )?;

    let mut rows_by_key: HashMap<WeeklySummaryRowKey, WeeklySummaryRowAccumulator> = HashMap::new();

    let query_rows = statement.query_map(params![start_date, end_date_exclusive], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    })?;

    for row in query_rows {
        let (
            date,
            start_minute,
            end_minute,
            duration_minutes,
            description,
            engagement_id_raw,
            activity_id_raw,
            engagement_code_raw,
            engagement_name_raw,
            client_name_raw,
            engagement_type_raw,
            activity_code_raw,
            activity_name_raw,
        ) = row?;

        let parsed_date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| {
            AppError::InvalidInput(format!("timesheet entry contains invalid date: {date}"))
        })?;
        let day_index = (parsed_date - week_start).num_days();
        if !(0..=6).contains(&day_index) {
            continue;
        }
        let day_index = day_index as usize;

        let engagement_code_trimmed = engagement_code_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let activity_code_trimmed = activity_code_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let engagement_name_trimmed = engagement_name_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let activity_name_trimmed = activity_name_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let client_name_trimmed = client_name_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let engagement_id = engagement_id_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let activity_id = activity_id_raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let is_uncategorized = engagement_id.is_none() || activity_id.is_none();

        let engagement_code = engagement_code_trimmed.map(|value| value.to_string());
        let engagement_type = engagement_id.as_ref().map(|_| {
            db_value_to_engagement_type(engagement_type_raw.as_deref(), engagement_code_trimmed)
        });
        let activity_code = activity_code_trimmed.map(|value| value.to_string());
        let activity_name = activity_name_trimmed.unwrap_or("Uncategorized").to_string();
        let engagement_name = engagement_name_trimmed
            .unwrap_or("Uncategorized")
            .to_string();
        let client_name = client_name_trimmed.unwrap_or("").to_string();

        let key = WeeklySummaryRowKey {
            engagement_id: engagement_id.clone(),
            activity_id: activity_id.clone(),
            engagement_code: engagement_code.clone(),
            activity_code: activity_code.clone(),
            activity_name: activity_name.clone(),
            engagement_name: engagement_name.clone(),
            client_name: client_name.clone(),
            engagement_type,
            is_uncategorized,
        };

        let accumulator = rows_by_key
            .entry(key)
            .or_insert_with(|| WeeklySummaryRowAccumulator {
                engagement_id: engagement_id.clone(),
                activity_id: activity_id.clone(),
                engagement_code: engagement_code.clone(),
                activity_code: activity_code.clone(),
                activity_name: activity_name.clone(),
                engagement_name: engagement_name.clone(),
                client_name: client_name.clone(),
                engagement_type,
                is_uncategorized,
                day_minutes: [0; 7],
                day_notes: std::array::from_fn(|_| Vec::new()),
            });

        accumulator.day_minutes[day_index] += duration_minutes;
        accumulator.day_notes[day_index].push(TimelineWeeklySummaryNote {
            start_minute,
            end_minute,
            duration_minutes,
            description: if description.trim().is_empty() {
                "No description provided.".to_string()
            } else {
                description.trim().to_string()
            },
        });
    }

    let mut rows = rows_by_key
        .into_values()
        .map(|accumulator| {
            let cells = (0..7)
                .map(|index| TimelineWeeklySummaryCell {
                    total_minutes: accumulator.day_minutes[index],
                    notes: accumulator.day_notes[index].clone(),
                })
                .collect::<Vec<_>>();

            TimelineWeeklySummaryRow {
                engagement_id: accumulator.engagement_id,
                activity_id: accumulator.activity_id,
                engagement_code: accumulator.engagement_code,
                activity_code: accumulator.activity_code,
                activity_name: accumulator.activity_name,
                engagement_name: accumulator.engagement_name,
                client_name: accumulator.client_name,
                engagement_type: accumulator.engagement_type,
                is_uncategorized: accumulator.is_uncategorized,
                row_total_minutes: accumulator.day_minutes.iter().sum(),
                cells,
            }
        })
        .collect::<Vec<_>>();

    rows.sort_by(|left, right| {
        if left.is_uncategorized != right.is_uncategorized {
            return if left.is_uncategorized {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            };
        }

        left.engagement_code
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &right
                    .engagement_code
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase(),
            )
            .then_with(|| {
                left.activity_code
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&right.activity_code.as_deref().unwrap_or("").to_lowercase())
            })
            .then_with(|| {
                left.engagement_name
                    .to_lowercase()
                    .cmp(&right.engagement_name.to_lowercase())
            })
            .then_with(|| {
                left.activity_name
                    .to_lowercase()
                    .cmp(&right.activity_name.to_lowercase())
            })
    });

    let mut day_total_breakdowns = vec![empty_timeline_total_breakdown(); 7];
    for row in &rows {
        for (index, cell) in row.cells.iter().enumerate() {
            add_weekly_summary_minutes_to_breakdown(
                &mut day_total_breakdowns[index],
                row.is_uncategorized,
                row.engagement_type,
                cell.total_minutes,
            );
        }
    }
    for breakdown in &mut day_total_breakdowns {
        finalize_raw_timeline_total_breakdown(breakdown);
    }
    let mut week_total_breakdown = empty_timeline_total_breakdown();
    for breakdown in &day_total_breakdowns {
        week_total_breakdown.external_minutes += breakdown.external_minutes;
        week_total_breakdown.internal_minutes += breakdown.internal_minutes;
        week_total_breakdown.uncategorized_minutes += breakdown.uncategorized_minutes;
    }
    finalize_raw_timeline_total_breakdown(&mut week_total_breakdown);
    let day_total_minutes = day_total_breakdowns
        .iter()
        .map(|breakdown| breakdown.primary_minutes)
        .collect::<Vec<_>>();
    let week_total_minutes = week_total_breakdown.primary_minutes;

    let days = (0..7)
        .map(|index| TimelineWeeklySummaryDay {
            date: (week_start + chrono::Duration::days(index as i64))
                .format("%Y-%m-%d")
                .to_string(),
        })
        .collect::<Vec<_>>();

    let week_end_date = days
        .last()
        .map(|day| day.date.clone())
        .unwrap_or_else(|| start_date.to_string());

    Ok(TimelineWeeklySummary {
        week_start_date: start_date.to_string(),
        week_end_date,
        days,
        rows,
        day_total_minutes,
        week_total_minutes,
        day_total_breakdowns,
        week_total_breakdown,
    })
}

fn empty_timeline_total_breakdown() -> TimelineTotalBreakdown {
    TimelineTotalBreakdown {
        primary_minutes: 0,
        external_minutes: 0,
        internal_minutes: 0,
        uncategorized_minutes: 0,
    }
}

fn add_weekly_summary_minutes_to_breakdown(
    breakdown: &mut TimelineTotalBreakdown,
    is_uncategorized: bool,
    engagement_type: Option<EngagementType>,
    minutes: i64,
) {
    if minutes <= 0 {
        return;
    }

    if is_uncategorized {
        breakdown.uncategorized_minutes += minutes;
        return;
    }

    match engagement_type.unwrap_or(EngagementType::External) {
        EngagementType::External => breakdown.external_minutes += minutes,
        EngagementType::Internal => breakdown.internal_minutes += minutes,
    }
}

fn finalize_raw_timeline_total_breakdown(breakdown: &mut TimelineTotalBreakdown) {
    breakdown.primary_minutes =
        breakdown.external_minutes + breakdown.internal_minutes + breakdown.uncategorized_minutes;
}

pub fn list_warning_flags(conn: &Connection, entry_id: &str) -> AppResult<Vec<WarningType>> {
    let mut statement = conn.prepare(
        "SELECT warning_type FROM entry_warnings WHERE entry_id = ?1 ORDER BY warning_type",
    )?;

    let warning_flags = statement
        .query_map(params![entry_id], |row| {
            let warning_type: String = row.get(0)?;
            Ok(db_value_to_warning_type(&warning_type))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(warning_flags)
}

pub fn update_timeline_entry(
    conn: &Connection,
    id: &str,
    date: &str,
    start_minute: i64,
    end_minute: i64,
    duration_minutes: i64,
    description: &str,
    engagement_id: Option<&str>,
    activity_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        r#"
      UPDATE timesheet_entries
      SET engagement_id = ?2,
          activity_id = ?3,
          date = ?4,
          start_minute = ?5,
          end_minute = ?6,
          duration_minutes = ?7,
          description = ?8,
          updated_at = ?9
      WHERE id = ?1
    "#,
        params![
            id,
            engagement_id,
            activity_id,
            date,
            start_minute,
            end_minute,
            duration_minutes,
            description.trim(),
            current_unix_timestamp(),
        ],
    )?;

    Ok(())
}

pub fn get_entry_date(conn: &Connection, entry_id: &str) -> AppResult<Option<String>> {
    let mut statement = conn.prepare("SELECT date FROM timesheet_entries WHERE id = ?1")?;
    let result = statement.query_row(params![entry_id], |row| row.get::<_, String>(0));

    match result {
        Ok(date) => Ok(Some(date)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(AppError::Database(error)),
    }
}

pub fn prune_old_diagnostics(conn: &Connection, retention_days: i64) -> AppResult<()> {
    let normalized_days = retention_days.max(1);
    let cutoff_timestamp = current_unix_timestamp() - (normalized_days * 24 * 60 * 60);
    conn.execute(
        "DELETE FROM diagnostics_events WHERE timestamp < ?1",
        params![cutoff_timestamp],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn insert_diagnostics_event(
    conn: &Connection,
    session_id: &str,
    correlation_id: &str,
    layer: &str,
    event_type: &str,
    command: Option<&str>,
    status: &str,
    duration_ms: Option<i64>,
    message_text: Option<&str>,
    details_json: &str,
) -> AppResult<DiagnosticsEvent> {
    let event = DiagnosticsEvent {
        id: Uuid::new_v4().to_string(),
        timestamp: current_unix_timestamp(),
        session_id: session_id.to_string(),
        correlation_id: correlation_id.to_string(),
        layer: layer.to_string(),
        event_type: event_type.to_string(),
        command: command.map(|value| value.to_string()),
        status: status.to_string(),
        duration_ms,
        message_text: message_text.map(|value| value.trim().to_string()),
        details_json: details_json.to_string(),
    };

    conn.execute(
        r#"
      INSERT INTO diagnostics_events (
        id,
        timestamp,
        session_id,
        correlation_id,
        layer,
        event_type,
        command,
        status,
        duration_ms,
        message_text,
        details_json
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    "#,
        params![
            event.id,
            event.timestamp,
            event.session_id,
            event.correlation_id,
            event.layer,
            event.event_type,
            event.command,
            event.status,
            event.duration_ms,
            event.message_text,
            event.details_json,
        ],
    )?;

    Ok(event)
}

pub fn list_diagnostics_events(
    conn: &Connection,
    limit: i64,
    filter: Option<&str>,
) -> AppResult<Vec<DiagnosticsEvent>> {
    let normalized_limit = limit.clamp(1, 500);

    let (query, parameters): (&str, Vec<&dyn rusqlite::ToSql>) = match filter {
        Some("errors") => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          WHERE status = 'error'
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
        Some("warnings") => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          WHERE status = 'warning'
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
        Some("capture") => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          WHERE command IN ('interpret_text_message', 'transcribe_audio_clip')
             OR event_type LIKE 'llm_%'
             OR event_type LIKE 'transcription_%'
             OR event_type LIKE 'voice_%'
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
        Some("settings") => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          WHERE command IN (
            'settings_get_status',
            'settings_set_openai_key',
            'settings_set_openai_model',
            'settings_set_timeline_preferences',
            'settings_set_interface_preferences',
            'settings_set_transcription_model'
          ) OR event_type = 'key_save_verify'
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
        _ => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
    };

    let mut statement = conn.prepare(query)?;
    let events = statement
        .query_map(parameters.as_slice(), |row| {
            Ok(DiagnosticsEvent {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                session_id: row.get(2)?,
                correlation_id: row.get(3)?,
                layer: row.get(4)?,
                event_type: row.get(5)?,
                command: row.get(6)?,
                status: row.get(7)?,
                duration_ms: row.get(8)?,
                message_text: row.get(9)?,
                details_json: row.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(events)
}

fn normalize_color_hex(raw_value: Option<String>) -> AppResult<Option<String>> {
    let Some(value) = raw_value else {
        return Ok(None);
    };

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = trimmed.to_uppercase();
    let is_valid = candidate.len() == 7
        && candidate.starts_with('#')
        && candidate[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit());

    if !is_valid {
        return Err(AppError::InvalidInput(
            "colorHex must be a valid #RRGGBB value".to_string(),
        ));
    }

    Ok(Some(candidate))
}

fn normalize_optional_code(raw_value: Option<String>) -> Option<String> {
    raw_value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
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

fn engagement_type_db_value(engagement_type: EngagementType) -> &'static str {
    match engagement_type {
        EngagementType::External => "external",
        EngagementType::Internal => "internal",
    }
}

fn db_value_to_engagement_type(value: Option<&str>, code: Option<&str>) -> EngagementType {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "internal" => EngagementType::Internal,
        "external" => EngagementType::External,
        _ => infer_engagement_type_from_code(code),
    }
}

fn normalize_usage_description(raw_value: String) -> AppResult<Option<String>> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed.chars().count() > MAX_USAGE_DESCRIPTION_LENGTH {
        return Err(AppError::InvalidInput(format!(
            "describeWhenToUse must be {} characters or fewer",
            MAX_USAGE_DESCRIPTION_LENGTH
        )));
    }

    Ok(Some(trimmed.to_string()))
}

fn parse_tags(tags_json: &str) -> Option<Vec<String>> {
    serde_json::from_str::<Vec<String>>(tags_json)
        .ok()
        .map(normalize_tags)
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>()
}

fn warning_type_to_db_value(warning_type: &WarningType) -> &'static str {
    match warning_type {
        WarningType::LowConfidence => "low_confidence",
        WarningType::Overlap => "overlap",
        WarningType::Unmatched => "unmatched",
    }
}

fn db_value_to_warning_type(value: &str) -> WarningType {
    match value {
        "low_confidence" => WarningType::LowConfidence,
        "overlap" => WarningType::Overlap,
        "unmatched" => WarningType::Unmatched,
        _ => WarningType::Unmatched,
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{
        current_unix_timestamp, get_app_setting, insert_manual_timeline_entry, insert_raw_message,
        insert_timesheet_entry, list_engagements, list_quick_add_suggestions,
        list_timeline_entries, list_timeline_entries_for_date_range, list_timeline_weekly_summary,
        run_migrations, upsert_activity, upsert_app_setting, upsert_engagement,
    };
    use crate::models::{
        ActivityUpsertInput, EngagementType, EngagementUpsertInput, NormalizedEntry, OpenAiModelId,
        TranscriptionModelId,
    };

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        run_migrations(&connection).expect("migrations should run");
        connection
    }

    fn create_test_engagement(
        connection: &Connection,
        code: &str,
        name: &str,
        is_active: bool,
    ) -> String {
        upsert_engagement(
            connection,
            EngagementUpsertInput {
                id: None,
                code: Some(code.to_string()),
                name: name.to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: format!("Use for {name}."),
                is_active: Some(is_active),
            },
        )
        .expect("engagement should save")
    }

    fn create_test_activity(
        connection: &Connection,
        engagement_id: &str,
        code: &str,
        name: &str,
        is_active: bool,
    ) -> String {
        upsert_activity(
            connection,
            ActivityUpsertInput {
                id: None,
                engagement_id: engagement_id.to_string(),
                code: Some(code.to_string()),
                name: name.to_string(),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: format!("Use for {name}."),
                is_active: Some(is_active),
            },
        )
        .expect("activity should save")
    }

    fn normalized_entry_for_date(date: &str) -> NormalizedEntry {
        NormalizedEntry {
            date: date.to_string(),
            start_minute: 540,
            end_minute: 570,
            duration_minutes: 30,
            description: "Suggestion entry".to_string(),
            user_submission_text: "Suggestion entry".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        }
    }

    #[test]
    fn engagement_upsert_allows_missing_code() {
        let connection = test_connection();

        let engagement_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: None,
                name: "No Code Engagement".to_string(),
                client: None,
                engagement_type: None,
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use when the user has no external code.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("engagement should save without a code");

        let engagements = list_engagements(&connection).expect("engagements should load");
        let saved = engagements
            .into_iter()
            .find(|engagement| engagement.id == engagement_id)
            .expect("saved engagement should exist");

        assert!(saved.code.is_none());
        assert_eq!(saved.name, "No Code Engagement");
        assert_eq!(saved.engagement_type, EngagementType::External);
    }

    #[test]
    fn code_upserts_allow_empty_usage_guidance() {
        let connection = test_connection();

        let engagement_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some("E-Optional".to_string()),
                name: "Optional Guidance Engagement".to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "   ".to_string(),
                is_active: Some(true),
            },
        )
        .expect("engagement should save with blank usage guidance");

        let activity_id = upsert_activity(
            &connection,
            ActivityUpsertInput {
                id: None,
                engagement_id: engagement_id.clone(),
                code: Some("OPT".to_string()),
                name: "Optional Guidance Activity".to_string(),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "".to_string(),
                is_active: Some(true),
            },
        )
        .expect("activity should save with blank usage guidance");

        let engagements = list_engagements(&connection).expect("engagements should load");
        let saved = engagements
            .into_iter()
            .find(|engagement| engagement.id == engagement_id)
            .expect("saved engagement should exist");
        let saved_activity = saved
            .activities
            .iter()
            .find(|activity| activity.id == activity_id)
            .expect("saved activity should exist");

        assert!(saved.describe_when_to_use.is_none());
        assert!(saved_activity.describe_when_to_use.is_none());
    }

    #[test]
    fn engagement_upsert_infers_type_from_code_when_missing() {
        let connection = test_connection();

        let internal_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some(" i-100 ".to_string()),
                name: "Internal Work".to_string(),
                client: None,
                engagement_type: None,
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for internal work.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("internal engagement should save");

        let admin_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some("A-200".to_string()),
                name: "Admin Work".to_string(),
                client: None,
                engagement_type: None,
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for admin work.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("admin engagement should save");

        let engagements = list_engagements(&connection).expect("engagements should load");
        let internal = engagements
            .iter()
            .find(|engagement| engagement.id == internal_id)
            .expect("internal engagement should exist");
        let admin = engagements
            .iter()
            .find(|engagement| engagement.id == admin_id)
            .expect("admin engagement should exist");

        assert_eq!(internal.engagement_type, EngagementType::Internal);
        assert_eq!(admin.engagement_type, EngagementType::Internal);
    }

    #[test]
    fn engagement_upsert_preserves_manual_type_override() {
        let connection = test_connection();

        let engagement_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: Some("I-Manual-External".to_string()),
                name: "Manual External".to_string(),
                client: None,
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for external work despite the code.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("engagement should save");

        let saved = list_engagements(&connection)
            .expect("engagements should load")
            .into_iter()
            .find(|engagement| engagement.id == engagement_id)
            .expect("saved engagement should exist");

        assert_eq!(saved.engagement_type, EngagementType::External);
    }

    #[test]
    fn migrations_backfill_engagement_type_from_existing_codes() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE engagements (
                  id TEXT PRIMARY KEY,
                  code TEXT,
                  name TEXT NOT NULL,
                  client TEXT,
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                INSERT INTO engagements (
                  id, code, name, client, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES
                  ('eng-internal', 'A-100', 'Admin', NULL, NULL, '[]', 'Use for admin.', 1, 0, 0),
                  ('eng-external', 'E-100', 'External', NULL, NULL, '[]', 'Use for external.', 1, 0, 0);
                "#,
            )
            .expect("legacy schema should load");

        run_migrations(&connection).expect("migrations should run");

        let engagements = list_engagements(&connection).expect("engagements should load");
        let admin = engagements
            .iter()
            .find(|engagement| engagement.id == "eng-internal")
            .expect("admin engagement should exist");
        let external = engagements
            .iter()
            .find(|engagement| engagement.id == "eng-external")
            .expect("external engagement should exist");

        assert_eq!(admin.engagement_type, EngagementType::Internal);
        assert_eq!(external.engagement_type, EngagementType::External);
    }

    #[test]
    fn app_settings_round_trip_saved_value() {
        let connection = test_connection();

        assert_eq!(
            get_app_setting(&connection, "openai_model").expect("settings lookup should work"),
            None
        );

        upsert_app_setting(&connection, "openai_model", "gpt-5.5-high")
            .expect("setting should save");

        assert_eq!(
            get_app_setting(&connection, "openai_model").expect("settings lookup should work"),
            Some("gpt-5.5-high".to_string())
        );
    }

    #[test]
    fn migrations_seed_standard_time_off_code_pairs() {
        let connection = test_connection();

        let engagements = list_engagements(&connection).expect("engagements should load");
        let vacation = engagements
            .iter()
            .find(|engagement| engagement.code.as_deref() == Some("A-US010015"))
            .expect("vacation engagement should be seeded");
        let holiday = engagements
            .iter()
            .find(|engagement| engagement.code.as_deref() == Some("A-US010002"))
            .expect("holiday engagement should be seeded");

        assert_eq!(vacation.name, "Vacation");
        assert_eq!(vacation.engagement_type, EngagementType::Internal);
        assert!(vacation.is_active);
        assert!(vacation.activities.iter().any(|activity| {
            activity.code.as_deref() == Some("0000")
                && activity.name == "Vacation"
                && activity.is_active
        }));

        assert_eq!(holiday.name, "Public Holiday");
        assert_eq!(holiday.engagement_type, EngagementType::Internal);
        assert!(holiday.is_active);
        assert!(holiday.activities.iter().any(|activity| {
            activity.code.as_deref() == Some("0000")
                && activity.name == "Public Holiday"
                && activity.is_active
        }));
    }

    #[test]
    fn migrations_do_not_duplicate_standard_time_off_code_pairs() {
        let connection = test_connection();

        run_migrations(&connection).expect("second migration should run");

        let engagement_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM engagements WHERE code IN ('A-US010015', 'A-US010002')",
                [],
                |row| row.get(0),
            )
            .expect("engagement count should load");
        let activity_count: i64 = connection
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM activities a
                INNER JOIN engagements e ON e.id = a.engagement_id
                WHERE e.code IN ('A-US010015', 'A-US010002')
                  AND a.code = '0000'
                "#,
                [],
                |row| row.get(0),
            )
            .expect("activity count should load");

        assert_eq!(engagement_count, 2);
        assert_eq!(activity_count, 2);
    }

    #[test]
    fn migrations_reuse_existing_matching_standard_time_off_records() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE engagements (
                  id TEXT PRIMARY KEY,
                  code TEXT,
                  name TEXT NOT NULL,
                  client TEXT,
                  engagement_type TEXT NOT NULL DEFAULT 'external',
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE activities (
                  id TEXT PRIMARY KEY,
                  engagement_id TEXT NOT NULL,
                  code TEXT,
                  name TEXT NOT NULL,
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
                );

                CREATE TABLE app_settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                INSERT INTO engagements (
                  id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES (
                  'existing-vacation', 'VACATION', 'Existing Vacation', NULL, 'external', NULL, '[]', NULL, 0, 1, 1
                );

                INSERT INTO activities (
                  id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES (
                  'existing-vacation-activity', 'existing-vacation', 'VACATION', 'Existing Vacation Activity', NULL, '[]', NULL, 0, 1, 1
                );
                "#,
            )
            .expect("existing tables should be created");

        run_migrations(&connection).expect("migrations should run");

        let vacation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM engagements WHERE upper(trim(code)) = 'A-US010015'",
                [],
                |row| row.get(0),
            )
            .expect("vacation count should load");
        let legacy_vacation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM engagements WHERE upper(trim(code)) = 'VACATION'",
                [],
                |row| row.get(0),
            )
            .expect("legacy vacation count should load");
        let existing_status: (String, String, i64) = connection
            .query_row(
                "SELECT code, engagement_type, is_active FROM engagements WHERE id = 'existing-vacation'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("existing engagement should load");
        let existing_activity: (String, i64) = connection
            .query_row(
                "SELECT code, is_active FROM activities WHERE id = 'existing-vacation-activity'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("existing activity should load");

        assert_eq!(vacation_count, 1);
        assert_eq!(legacy_vacation_count, 0);
        assert_eq!(
            existing_status,
            ("A-US010015".to_string(), "internal".to_string(), 1)
        );
        assert_eq!(existing_activity, ("0000".to_string(), 1));
    }

    #[test]
    fn migrations_seed_apple_fy26_engagement_activities() {
        let connection = test_connection();

        let engagements = list_engagements(&connection).expect("engagements should load");
        let apple = engagements
            .iter()
            .find(|engagement| engagement.code.as_deref() == Some("E-69306633"))
            .expect("Apple FY26 engagement should be seeded");

        assert_eq!(apple.name, "Apple FY26");
        assert_eq!(apple.client.as_deref(), Some("Apple"));
        assert_eq!(
            apple.describe_when_to_use.as_deref(),
            Some("Used for activities related to the Apple SOX audit.")
        );
        assert_eq!(apple.engagement_type, EngagementType::External);
        assert!(apple.is_active);
        assert_eq!(apple.activities.len(), 225);

        for code in ["0000", "0350", "DID5", "SDC1", "T303", "0643"] {
            assert!(
                apple
                    .activities
                    .iter()
                    .any(|activity| activity.code.as_deref() == Some(code)),
                "expected Apple FY26 activity code {code}"
            );
        }

        let itgc_activity = apple
            .activities
            .iter()
            .find(|activity| activity.code.as_deref() == Some("0350"))
            .expect("ITGC activity should be seeded");
        assert_eq!(itgc_activity.name, "RSK - ITGC - Non-SAP");
    }

    #[test]
    fn migrations_reuse_existing_apple_itgc_engagement() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE engagements (
                  id TEXT PRIMARY KEY,
                  code TEXT,
                  name TEXT NOT NULL,
                  client TEXT,
                  engagement_type TEXT NOT NULL DEFAULT 'external',
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE activities (
                  id TEXT PRIMARY KEY,
                  engagement_id TEXT NOT NULL,
                  code TEXT,
                  name TEXT NOT NULL,
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
                );

                CREATE TABLE app_settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                INSERT INTO engagements (
                  id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES (
                  'existing-apple', NULL, 'Apple ITGC', NULL, 'external', NULL, '[]', NULL, 0, 1, 1
                );

                INSERT INTO activities (
                  id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES (
                  'existing-apple-activity-0350', 'existing-apple', '0350', 'Old ITGC Name', NULL, '[]', NULL, 0, 1, 1
                );
                "#,
            )
            .expect("existing tables should be created");

        run_migrations(&connection).expect("migrations should run");

        let existing_apple: (String, String, String, i64) = connection
            .query_row(
                "SELECT code, name, client, is_active FROM engagements WHERE id = 'existing-apple'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("existing Apple engagement should load");
        let apple_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM engagements WHERE upper(trim(code)) = 'E-69306633'",
                [],
                |row| row.get(0),
            )
            .expect("Apple engagement count should load");
        let apple_activity_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM activities WHERE engagement_id = 'existing-apple'",
                [],
                |row| row.get(0),
            )
            .expect("Apple activity count should load");
        let updated_activity: (String, i64) = connection
            .query_row(
                "SELECT name, is_active FROM activities WHERE id = 'existing-apple-activity-0350'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("existing Apple activity should load");

        assert_eq!(
            existing_apple,
            (
                "E-69306633".to_string(),
                "Apple FY26".to_string(),
                "Apple".to_string(),
                1
            )
        );
        assert_eq!(apple_count, 1);
        assert_eq!(apple_activity_count, 225);
        assert_eq!(updated_activity, ("RSK - ITGC - Non-SAP".to_string(), 1));
    }

    #[test]
    fn migrations_upgrade_old_default_apple_usage_guidance() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE engagements (
                  id TEXT PRIMARY KEY,
                  code TEXT,
                  name TEXT NOT NULL,
                  client TEXT,
                  engagement_type TEXT NOT NULL DEFAULT 'external',
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE activities (
                  id TEXT PRIMARY KEY,
                  engagement_id TEXT NOT NULL,
                  code TEXT,
                  name TEXT NOT NULL,
                  color_hex TEXT,
                  tags TEXT NOT NULL,
                  describe_when_to_use TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
                );

                CREATE TABLE app_settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                INSERT INTO engagements (
                  id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
                )
                VALUES
                  (
                    'existing-apple-default', 'E-69306633', 'Apple FY26', 'Apple', 'external', NULL, '[]',
                    'Use for Apple FY26 engagement work.', 1, 1, 1
                  ),
                  (
                    'existing-apple-custom', 'E-CUSTOM', 'Custom Apple', 'Apple', 'external', NULL, '[]',
                    'Keep this custom guidance.', 1, 1, 1
                  );

                INSERT INTO app_settings (key, value)
                VALUES ('apple_fy26_codes_seeded_v1', '1');
                "#,
            )
            .expect("existing tables should be created");

        run_migrations(&connection).expect("migrations should run");

        let upgraded_usage: String = connection
            .query_row(
                "SELECT describe_when_to_use FROM engagements WHERE id = 'existing-apple-default'",
                [],
                |row| row.get(0),
            )
            .expect("upgraded Apple usage should load");
        let custom_usage: String = connection
            .query_row(
                "SELECT describe_when_to_use FROM engagements WHERE id = 'existing-apple-custom'",
                [],
                |row| row.get(0),
            )
            .expect("custom Apple usage should load");
        let v2_setting = get_app_setting(&connection, "apple_fy26_codes_seeded_v2")
            .expect("seed setting lookup should work");

        assert_eq!(
            upgraded_usage,
            "Used for activities related to the Apple SOX audit."
        );
        assert_eq!(custom_usage, "Keep this custom guidance.");
        assert_eq!(v2_setting.as_deref(), Some("1"));
    }

    #[test]
    fn quick_add_suggestions_count_usage_across_entry_sources() {
        let connection = test_connection();
        let engagement_id =
            create_test_engagement(&connection, "QA-COUNT", "Quick Entry Count", true);
        let activity_id = create_test_activity(
            &connection,
            &engagement_id,
            "COUNT",
            "Counted Activity",
            true,
        );

        for source in ["text", "voice", "calendar"] {
            let raw_message_id = format!("raw-{source}");
            insert_raw_message(
                &connection,
                &raw_message_id,
                "worked on counted activity",
                "{\"entries\":[]}",
                "gpt-5.5-instant",
                source,
                None,
                None,
                0.8,
                current_unix_timestamp(),
                1,
                1,
                1,
                0,
                false,
            )
            .expect("raw message should save");

            insert_timesheet_entry(
                &connection,
                &raw_message_id,
                &normalized_entry_for_date("2026-04-01"),
                Some(&engagement_id),
                Some(&activity_id),
                false,
                false,
                false,
                None,
                Some(1),
                Some(1),
                source,
            )
            .expect("timesheet entry should save");
        }

        insert_manual_timeline_entry(
            &connection,
            "2026-04-01",
            600,
            630,
            30,
            "",
            Some(&engagement_id),
            Some(&activity_id),
        )
        .expect("manual entry should save");

        let suggestions =
            list_quick_add_suggestions(&connection, 12).expect("suggestions should load");
        let suggestion = suggestions
            .iter()
            .find(|candidate| candidate.activity_id == activity_id)
            .expect("used activity should be suggested");

        assert_eq!(suggestion.engagement_id, engagement_id);
        assert_eq!(suggestion.usage_count, 4);
        assert!(suggestion.last_used_at.is_some());
    }

    #[test]
    fn quick_add_suggestions_exclude_inactive_engagements_and_activities() {
        let connection = test_connection();
        let active_engagement_id =
            create_test_engagement(&connection, "QA-ACTIVE", "Active Engagement", true);
        let active_activity_id = create_test_activity(
            &connection,
            &active_engagement_id,
            "ACTIVE",
            "Active Activity",
            true,
        );
        let inactive_activity_id = create_test_activity(
            &connection,
            &active_engagement_id,
            "INACTIVE-ACT",
            "Inactive Activity",
            false,
        );
        let inactive_engagement_id =
            create_test_engagement(&connection, "QA-INACTIVE", "Inactive Engagement", false);
        let inactive_engagement_activity_id = create_test_activity(
            &connection,
            &inactive_engagement_id,
            "INACTIVE-ENG",
            "Inactive Engagement Activity",
            true,
        );

        for (index, (engagement_id, activity_id)) in [
            (&active_engagement_id, &active_activity_id),
            (&active_engagement_id, &inactive_activity_id),
            (&inactive_engagement_id, &inactive_engagement_activity_id),
        ]
        .into_iter()
        .enumerate()
        {
            insert_manual_timeline_entry(
                &connection,
                "2026-04-02",
                540 + (index as i64 * 30),
                570 + (index as i64 * 30),
                30,
                "",
                Some(engagement_id),
                Some(activity_id),
            )
            .expect("manual entry should save");
        }

        let suggestions =
            list_quick_add_suggestions(&connection, 12).expect("suggestions should load");

        assert!(suggestions
            .iter()
            .any(|candidate| candidate.activity_id == active_activity_id));
        assert!(!suggestions
            .iter()
            .any(|candidate| candidate.activity_id == inactive_activity_id));
        assert!(!suggestions
            .iter()
            .any(|candidate| candidate.activity_id == inactive_engagement_activity_id));
    }

    #[test]
    fn quick_add_suggestions_sort_by_usage_count_then_recent_use() {
        let connection = test_connection();
        let engagement_id =
            create_test_engagement(&connection, "QA-SORT", "Quick Entry Sort", true);
        let high_count_activity_id =
            create_test_activity(&connection, &engagement_id, "HIGH", "High Count", true);
        let recent_activity_id =
            create_test_activity(&connection, &engagement_id, "RECENT", "Recent Tie", true);
        let older_activity_id =
            create_test_activity(&connection, &engagement_id, "OLDER", "Older Tie", true);

        let high_first_id = insert_manual_timeline_entry(
            &connection,
            "2026-04-03",
            540,
            570,
            30,
            "",
            Some(&engagement_id),
            Some(&high_count_activity_id),
        )
        .expect("manual entry should save");
        let high_second_id = insert_manual_timeline_entry(
            &connection,
            "2026-04-03",
            570,
            600,
            30,
            "",
            Some(&engagement_id),
            Some(&high_count_activity_id),
        )
        .expect("manual entry should save");
        let older_entry_id = insert_manual_timeline_entry(
            &connection,
            "2026-04-03",
            600,
            630,
            30,
            "",
            Some(&engagement_id),
            Some(&older_activity_id),
        )
        .expect("manual entry should save");
        let recent_entry_id = insert_manual_timeline_entry(
            &connection,
            "2026-04-03",
            630,
            660,
            30,
            "",
            Some(&engagement_id),
            Some(&recent_activity_id),
        )
        .expect("manual entry should save");

        for (entry_id, timestamp) in [
            (high_first_id, 100),
            (high_second_id, 110),
            (older_entry_id, 200),
            (recent_entry_id, 300),
        ] {
            connection
                .execute(
                    "UPDATE timesheet_entries SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![timestamp, entry_id],
                )
                .expect("entry timestamp should update");
        }

        let suggestions =
            list_quick_add_suggestions(&connection, 3).expect("suggestions should load");
        let activity_ids = suggestions
            .iter()
            .map(|suggestion| suggestion.activity_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            activity_ids,
            vec![
                high_count_activity_id.as_str(),
                recent_activity_id.as_str(),
                older_activity_id.as_str(),
            ],
        );
    }

    #[test]
    fn quick_add_suggestions_include_zero_usage_active_activity_fallbacks() {
        let connection = test_connection();
        let engagement_id =
            create_test_engagement(&connection, "QA-FILL", "Quick Entry Fill", true);
        let used_activity_id =
            create_test_activity(&connection, &engagement_id, "USED", "Used Activity", true);
        let unused_activity_id = create_test_activity(
            &connection,
            &engagement_id,
            "UNUSED",
            "Unused Activity",
            true,
        );
        let second_unused_activity_id = create_test_activity(
            &connection,
            &engagement_id,
            "UNUSED2",
            "Second Unused Activity",
            true,
        );

        insert_manual_timeline_entry(
            &connection,
            "2026-04-04",
            540,
            570,
            30,
            "",
            Some(&engagement_id),
            Some(&used_activity_id),
        )
        .expect("manual entry should save");

        let suggestions =
            list_quick_add_suggestions(&connection, 500).expect("suggestions should load");

        assert!(suggestions.len() >= 3);
        assert_eq!(suggestions[0].activity_id, used_activity_id);
        assert_eq!(suggestions[0].usage_count, 1);
        assert!(suggestions.iter().any(|suggestion| {
            suggestion.activity_id == unused_activity_id && suggestion.usage_count == 0
        }));
        assert!(suggestions.iter().any(|suggestion| {
            suggestion.activity_id == second_unused_activity_id && suggestion.usage_count == 0
        }));
    }

    #[test]
    fn timeline_entries_include_model_provenance_from_raw_message() {
        let connection = test_connection();

        insert_raw_message(
            &connection,
            "raw-model",
            "worked on controls testing",
            "{\"entries\":[]}",
            "gpt-5.5-medium",
            "text",
            None,
            None,
            0.8,
            current_unix_timestamp(),
            1,
            1,
            1,
            0,
            false,
        )
        .expect("raw message should save");

        let entry = NormalizedEntry {
            date: "2026-03-15".to_string(),
            start_minute: 540,
            end_minute: 570,
            duration_minutes: 30,
            description: "Control testing".to_string(),
            user_submission_text: "Control testing".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        };

        insert_timesheet_entry(
            &connection,
            "raw-model",
            &entry,
            None,
            None,
            false,
            false,
            false,
            None,
            Some(1),
            Some(1),
            "text",
        )
        .expect("timesheet entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-15")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(saved_entry.model_used, Some(OpenAiModelId::Gpt55Medium));
        assert_eq!(
            saved_entry.model_used_label.as_deref(),
            Some("GPT-5.5 Medium")
        );
    }

    #[test]
    fn timeline_entries_hide_model_provenance_when_raw_message_has_no_model() {
        let connection = test_connection();
        let now = current_unix_timestamp();

        connection
            .execute(
                r#"
                INSERT INTO raw_messages (
                  id, raw_text, interpreted_entries_json, open_ai_model, capture_source,
                  transcription_model, transcription_duration_ms, confidence,
                  status, message_timestamp, interpreted_entry_count, unique_entry_count,
                  saved_entry_count, truncated_entry_count, contains_multiple_events, created_at
                )
                VALUES (?1, ?2, ?3, NULL, 'text', NULL, NULL, ?4, 'processed', ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
                rusqlite::params![
                    "raw-null-model",
                    "worked on controls testing",
                    "{\"entries\":[]}",
                    0.8,
                    now,
                    1,
                    1,
                    1,
                    0,
                    0,
                    now,
                ],
            )
            .expect("raw message should save with null model");

        let entry = NormalizedEntry {
            date: "2026-03-16".to_string(),
            start_minute: 600,
            end_minute: 630,
            duration_minutes: 30,
            description: "Control testing".to_string(),
            user_submission_text: "Control testing".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        };

        insert_timesheet_entry(
            &connection,
            "raw-null-model",
            &entry,
            None,
            None,
            false,
            false,
            false,
            None,
            Some(1),
            Some(1),
            "text",
        )
        .expect("timesheet entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-16")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(saved_entry.model_used, None);
        assert_eq!(saved_entry.model_used_label, None);
    }

    #[test]
    fn timeline_entries_ignore_invalid_historical_model_values() {
        let connection = test_connection();

        insert_raw_message(
            &connection,
            "raw-invalid-model",
            "worked on controls testing",
            "{\"entries\":[]}",
            "legacy-model",
            "text",
            None,
            None,
            0.8,
            current_unix_timestamp(),
            1,
            1,
            1,
            0,
            false,
        )
        .expect("raw message should save");

        let entry = NormalizedEntry {
            date: "2026-03-17".to_string(),
            start_minute: 660,
            end_minute: 690,
            duration_minutes: 30,
            description: "Control testing".to_string(),
            user_submission_text: "Control testing".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        };

        insert_timesheet_entry(
            &connection,
            "raw-invalid-model",
            &entry,
            None,
            None,
            false,
            false,
            false,
            None,
            Some(1),
            Some(1),
            "text",
        )
        .expect("timesheet entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-17")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(saved_entry.model_used, None);
        assert_eq!(saved_entry.model_used_label, None);
    }

    #[test]
    fn timeline_entries_include_transcription_model_for_voice_sources() {
        let connection = test_connection();

        insert_raw_message(
            &connection,
            "raw-voice",
            "worked on controls testing",
            "{\"entries\":[]}",
            "gpt-5.5-instant",
            "voice",
            Some("whisper-1"),
            Some(1800),
            0.8,
            current_unix_timestamp(),
            1,
            1,
            1,
            0,
            false,
        )
        .expect("raw message should save");

        let entry = NormalizedEntry {
            date: "2026-03-18".to_string(),
            start_minute: 720,
            end_minute: 750,
            duration_minutes: 30,
            description: "Voice captured testing".to_string(),
            user_submission_text: "Voice captured testing".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        };

        insert_timesheet_entry(
            &connection,
            "raw-voice",
            &entry,
            None,
            None,
            false,
            false,
            false,
            None,
            Some(1),
            Some(1),
            "voice",
        )
        .expect("timesheet entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-18")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(
            saved_entry.transcription_model_used,
            Some(TranscriptionModelId::Whisper1)
        );
        assert_eq!(
            saved_entry.transcription_model_used_label.as_deref(),
            Some("Whisper")
        );
    }

    #[test]
    fn manual_timeline_entry_uses_manual_defaults() {
        let connection = test_connection();

        insert_manual_timeline_entry(&connection, "2026-03-19", 600, 630, 30, "", None, None)
            .expect("manual timeline entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-19")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(saved_entry.source, "manual");
        assert_eq!(saved_entry.description, "");
        assert_eq!(saved_entry.user_submission_text, "Manual Entry");
        assert_eq!(saved_entry.confidence, 1.0);
        assert_eq!(saved_entry.source_message_entry_index, None);
        assert_eq!(saved_entry.source_message_entry_count, None);
    }

    #[test]
    fn manual_timeline_entry_can_store_categorized_refs() {
        let connection = test_connection();
        let engagement_id = upsert_engagement(
            &connection,
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
        let activity_id = upsert_activity(
            &connection,
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

        insert_manual_timeline_entry(
            &connection,
            "2026-03-20",
            600,
            630,
            30,
            "Planning",
            Some(&engagement_id),
            Some(&activity_id),
        )
        .expect("manual timeline entry should save");

        let saved_entry = list_timeline_entries(&connection, "2026-03-20")
            .expect("entries should load")
            .into_iter()
            .next()
            .expect("entry should exist");

        assert_eq!(saved_entry.source, "manual");
        assert_eq!(saved_entry.description, "Planning");
        assert_eq!(
            saved_entry.engagement_id.as_deref(),
            Some(engagement_id.as_str())
        );
        assert_eq!(
            saved_entry.activity_id.as_deref(),
            Some(activity_id.as_str())
        );
        assert_eq!(saved_entry.warning_flags, Vec::new());
    }

    #[test]
    fn timeline_entries_for_range_include_week_entries_in_date_order() {
        let connection = test_connection();

        insert_manual_timeline_entry(
            &connection,
            "2026-03-30",
            540,
            570,
            30,
            "Monday task",
            None,
            None,
        )
        .expect("first entry should save");
        insert_manual_timeline_entry(
            &connection,
            "2026-03-29",
            600,
            630,
            30,
            "Sunday task",
            None,
            None,
        )
        .expect("second entry should save");
        insert_manual_timeline_entry(
            &connection,
            "2026-04-01",
            480,
            510,
            30,
            "Wednesday task",
            None,
            None,
        )
        .expect("third entry should save");

        let entries = list_timeline_entries_for_date_range(&connection, "2026-03-29", "2026-04-05")
            .expect("range entries should load");

        let ordered_descriptions = entries
            .iter()
            .map(|entry| (entry.date.as_str(), entry.description.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            ordered_descriptions,
            vec![
                ("2026-03-29", "Sunday task"),
                ("2026-03-30", "Monday task"),
                ("2026-04-01", "Wednesday task"),
            ]
        );
    }

    #[test]
    fn weekly_summary_keeps_categorized_rows_when_codes_are_blank() {
        let connection = test_connection();

        let engagement_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: None,
                name: "Client Work".to_string(),
                client: Some("Example Client".to_string()),
                engagement_type: Some(EngagementType::External),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for client delivery work.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("engagement should save");

        let activity_id = upsert_activity(
            &connection,
            ActivityUpsertInput {
                id: None,
                engagement_id: engagement_id.clone(),
                code: None,
                name: "Fieldwork".to_string(),
                color_hex: None,
                tags: vec![],
                describe_when_to_use: "Use for fieldwork activity.".to_string(),
                is_active: Some(true),
            },
        )
        .expect("activity should save");

        insert_raw_message(
            &connection,
            "raw-1",
            "worked on client walkthrough",
            "{\"entries\":[]}",
            "gpt-5.5-instant",
            "text",
            None,
            None,
            0.8,
            current_unix_timestamp(),
            1,
            1,
            1,
            0,
            false,
        )
        .expect("raw message should save");

        let entry = NormalizedEntry {
            date: "2026-03-02".to_string(),
            start_minute: 540,
            end_minute: 600,
            duration_minutes: 60,
            description: "Client walkthrough".to_string(),
            user_submission_text: "Client walkthrough".to_string(),
            confidence: 0.9,
            engagement_ref: None,
            activity_ref: None,
        };

        insert_timesheet_entry(
            &connection,
            "raw-1",
            &entry,
            Some(&engagement_id),
            Some(&activity_id),
            false,
            false,
            false,
            None,
            Some(1),
            Some(1),
            "text",
        )
        .expect("timesheet entry should save");

        let summary = list_timeline_weekly_summary(&connection, "2026-02-28", "2026-03-07")
            .expect("summary should load");
        let row = summary.rows.first().expect("summary row should exist");

        assert!(!row.is_uncategorized);
        assert_eq!(row.engagement_type, Some(EngagementType::External));
        assert!(row.engagement_code.is_none());
        assert!(row.activity_code.is_none());
        assert_eq!(row.engagement_name, "Client Work");
        assert_eq!(row.activity_name, "Fieldwork");
        assert_eq!(summary.week_total_breakdown.external_minutes, 60);
        assert_eq!(summary.week_total_breakdown.internal_minutes, 0);
        assert_eq!(summary.week_total_breakdown.uncategorized_minutes, 0);
    }
}
