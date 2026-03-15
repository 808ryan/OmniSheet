use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    Activity, ActivityUpsertInput, CodeContext, ContextActivity, ContextEngagement,
    DiagnosticsEvent, Engagement, EngagementUpsertInput, NormalizedEntry, OpenAiModelId,
    TimelineDaySummary, TimelineEntry, TimelineWeeklySummary, TimelineWeeklySummaryCell,
    TimelineWeeklySummaryDay, TimelineWeeklySummaryNote, TimelineWeeklySummaryRow, Warning,
    WarningType,
};

pub const LOW_CONFIDENCE_THRESHOLD: f64 = 0.75;
pub const DIAGNOSTICS_RETENTION_DAYS: i64 = 7;
const MAX_USAGE_DESCRIPTION_LENGTH: usize = 500;

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

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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

    Ok(())
}

fn ensure_expected_columns(conn: &Connection) -> AppResult<()> {
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
        color_hex TEXT,
        tags TEXT NOT NULL,
        describe_when_to_use TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO engagements_new (
        id, code, name, client, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      SELECT
        id,
        NULLIF(TRIM(code), ''),
        name,
        client,
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
      DROP INDEX IF EXISTS idx_engagements_unique_code;
      DROP INDEX IF EXISTS idx_activities_unique_code;

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

pub fn upsert_engagement(conn: &Connection, input: EngagementUpsertInput) -> AppResult<String> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "engagement name is required".to_string(),
        ));
    }
    if input.describe_when_to_use.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "engagement usage guidance is required".to_string(),
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
      INSERT INTO engagements (
        id, code, name, client, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        client = excluded.client,
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
    if input.describe_when_to_use.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "activity usage guidance is required".to_string(),
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
      SELECT id, code, name, client, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at
      FROM engagements
      ORDER BY name COLLATE NOCASE
    "#,
    )?;

    let mut engagements: Vec<Engagement> = engagement_statement
        .query_map([], |row| {
            let tags_json: String = row.get(5)?;
            let tags = parse_tags(&tags_json).unwrap_or_default();
            Ok(Engagement {
                id: row.get(0)?,
                code: row.get(1)?,
                name: row.get(2)?,
                client: row.get(3)?,
                color_hex: row.get(4)?,
                tags,
                describe_when_to_use: row.get(6)?,
                is_active: row.get::<_, i64>(7)? == 1,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
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
        id, raw_text, interpreted_entries_json, open_ai_model, confidence,
        status, message_timestamp, interpreted_entry_count, unique_entry_count,
        saved_entry_count, truncated_entry_count, contains_multiple_events, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, 'processed', ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    "#,
        params![
            id,
            raw_text.trim(),
            interpreted_entries_json,
            open_ai_model,
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

pub fn list_timeline_entries(conn: &Connection, date: &str) -> AppResult<Vec<TimelineEntry>> {
    let mut statement = conn.prepare(
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
        a.code,
        a.name,
        te.used_activity_fallback,
        te.used_temporal_fallback,
        te.duration_defaulted,
        te.fallback_summary,
        te.source_message_entry_index,
        te.source_message_entry_count,
        rm.open_ai_model
      FROM timesheet_entries te
      LEFT JOIN engagements e ON e.id = te.engagement_id
      LEFT JOIN activities a ON a.id = te.activity_id
      LEFT JOIN raw_messages rm ON rm.id = te.raw_message_id
      WHERE te.date = ?1
      ORDER BY te.start_minute
    "#,
    )?;

    let mut entries = statement
        .query_map(params![date], |row| {
            let model_used = row
                .get::<_, Option<String>>(21)?
                .and_then(|value| OpenAiModelId::from_api_name(&value));

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
                engagement_id: row.get(9)?,
                activity_id: row.get(10)?,
                engagement_code: row.get(11)?,
                engagement_name: row.get(12)?,
                activity_code: row.get(13)?,
                activity_name: row.get(14)?,
                used_activity_fallback: row.get::<_, i64>(15)? == 1,
                used_temporal_fallback: row.get::<_, i64>(16)? == 1,
                duration_defaulted: row.get::<_, i64>(17)? == 1,
                fallback_summary: row.get(18)?,
                source_message_entry_index: row.get(19)?,
                source_message_entry_count: row.get(20)?,
                model_used,
                model_used_label: model_used.map(|model| model.display_label().to_string()),
                warning_flags: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for entry in &mut entries {
        entry.warning_flags = list_warning_flags(conn, &entry.id)?;
    }

    Ok(entries)
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
    is_uncategorized: bool,
}

#[derive(Debug, Clone)]
struct WeeklySummaryRowAccumulator {
    engagement_code: Option<String>,
    activity_code: Option<String>,
    activity_name: String,
    engagement_name: String,
    client_name: String,
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
            is_uncategorized,
        };

        let accumulator = rows_by_key
            .entry(key)
            .or_insert_with(|| WeeklySummaryRowAccumulator {
                engagement_code: engagement_code.clone(),
                activity_code: activity_code.clone(),
                activity_name: activity_name.clone(),
                engagement_name: engagement_name.clone(),
                client_name: client_name.clone(),
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
                engagement_code: accumulator.engagement_code,
                activity_code: accumulator.activity_code,
                activity_name: accumulator.activity_name,
                engagement_name: accumulator.engagement_name,
                client_name: accumulator.client_name,
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

    let mut day_total_minutes = vec![0; 7];
    for row in &rows {
        for (index, cell) in row.cells.iter().enumerate() {
            day_total_minutes[index] += cell.total_minutes;
        }
    }
    let week_total_minutes = day_total_minutes.iter().sum();

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
    })
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
          WHERE command = 'interpret_text_message' OR event_type LIKE 'llm_%'
          ORDER BY timestamp DESC
          LIMIT ?1
        "#,
            vec![&normalized_limit],
        ),
        Some("settings") => (
            r#"
          SELECT id, timestamp, session_id, correlation_id, layer, event_type, command, status, duration_ms, message_text, details_json
          FROM diagnostics_events
          WHERE command IN ('settings_get_status', 'settings_set_openai_key', 'settings_set_openai_model') OR event_type = 'key_save_verify'
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

fn normalize_usage_description(raw_value: String) -> AppResult<String> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "usage guidance is required".to_string(),
        ));
    }

    if trimmed.chars().count() > MAX_USAGE_DESCRIPTION_LENGTH {
        return Err(AppError::InvalidInput(format!(
            "describeWhenToUse must be {} characters or fewer",
            MAX_USAGE_DESCRIPTION_LENGTH
        )));
    }

    Ok(trimmed.to_string())
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
        current_unix_timestamp, get_app_setting, insert_raw_message, insert_timesheet_entry,
        list_engagements, list_timeline_entries, list_timeline_weekly_summary, run_migrations,
        upsert_activity, upsert_app_setting, upsert_engagement,
    };
    use crate::models::{
        ActivityUpsertInput, EngagementUpsertInput, NormalizedEntry, OpenAiModelId,
    };

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        run_migrations(&connection).expect("migrations should run");
        connection
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
    }

    #[test]
    fn app_settings_round_trip_saved_value() {
        let connection = test_connection();

        assert_eq!(
            get_app_setting(&connection, "openai_model").expect("settings lookup should work"),
            None
        );

        upsert_app_setting(&connection, "openai_model", "gpt-4.1-nano")
            .expect("setting should save");

        assert_eq!(
            get_app_setting(&connection, "openai_model").expect("settings lookup should work"),
            Some("gpt-4.1-nano".to_string())
        );
    }

    #[test]
    fn timeline_entries_include_model_provenance_from_raw_message() {
        let connection = test_connection();

        insert_raw_message(
            &connection,
            "raw-model",
            "worked on controls testing",
            "{\"entries\":[]}",
            "gpt-5-nano",
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

        assert_eq!(saved_entry.model_used, Some(OpenAiModelId::Gpt5Nano));
        assert_eq!(saved_entry.model_used_label.as_deref(), Some("GPT-5 Nano"));
    }

    #[test]
    fn timeline_entries_hide_model_provenance_when_raw_message_has_no_model() {
        let connection = test_connection();
        let now = current_unix_timestamp();

        connection
            .execute(
                r#"
                INSERT INTO raw_messages (
                  id, raw_text, interpreted_entries_json, open_ai_model, confidence,
                  status, message_timestamp, interpreted_entry_count, unique_entry_count,
                  saved_entry_count, truncated_entry_count, contains_multiple_events, created_at
                )
                VALUES (?1, ?2, ?3, NULL, ?4, 'processed', ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
    fn weekly_summary_keeps_categorized_rows_when_codes_are_blank() {
        let connection = test_connection();

        let engagement_id = upsert_engagement(
            &connection,
            EngagementUpsertInput {
                id: None,
                code: None,
                name: "Client Work".to_string(),
                client: Some("Example Client".to_string()),
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
            "gpt-5-nano",
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
        assert!(row.engagement_code.is_none());
        assert!(row.activity_code.is_none());
        assert_eq!(row.engagement_name, "Client Work");
        assert_eq!(row.activity_name, "Fieldwork");
    }
}
