use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    Activity, ActivityUpsertInput, CodeContext, ContextActivity, ContextEngagement,
    DiagnosticsEvent, Engagement, EngagementUpsertInput, NormalizedEntry, TimelineDaySummary,
    TimelineEntry, Warning, WarningType,
};

pub const LOW_CONFIDENCE_THRESHOLD: f64 = 0.75;
pub const DIAGNOSTICS_RETENTION_DAYS: i64 = 7;

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
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        client TEXT,
        color_hex TEXT,
        tags TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        color_hex TEXT,
        tags TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_unique_code
      ON activities(engagement_id, code);

      CREATE TABLE IF NOT EXISTS raw_messages (
        id TEXT PRIMARY KEY,
        raw_text TEXT NOT NULL,
        interpreted_entries_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        message_timestamp INTEGER NOT NULL,
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
        source TEXT NOT NULL,
        raw_message_id TEXT,
        confidence REAL NOT NULL,
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

    ensure_color_columns(conn)?;

    Ok(())
}

fn ensure_color_columns(conn: &Connection) -> AppResult<()> {
    ensure_column_exists(conn, "engagements", "color_hex", "TEXT")?;
    ensure_column_exists(conn, "activities", "color_hex", "TEXT")?;
    Ok(())
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
    if input.code.trim().is_empty() || input.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "engagement code and name are required".to_string(),
        ));
    }

    let now = current_unix_timestamp();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let color_hex = normalize_color_hex(input.color_hex)?;
    let tags_json = serde_json::to_string(&normalize_tags(input.tags))?;
    let is_active = if input.is_active.unwrap_or(true) {
        1
    } else {
        0
    };

    conn.execute(
        r#"
      INSERT INTO engagements (id, code, name, client, color_hex, tags, is_active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        client = excluded.client,
        color_hex = excluded.color_hex,
        tags = excluded.tags,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    "#,
        params![
            id,
            input.code.trim(),
            input.name.trim(),
            input.client.as_ref().map(|client| client.trim()),
            color_hex,
            tags_json,
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
    if input.engagement_id.trim().is_empty()
        || input.code.trim().is_empty()
        || input.name.trim().is_empty()
    {
        return Err(AppError::InvalidInput(
            "activity engagement, code, and name are required".to_string(),
        ));
    }

    let now = current_unix_timestamp();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let color_hex = normalize_color_hex(input.color_hex)?;
    let tags_json = serde_json::to_string(&normalize_tags(input.tags))?;
    let is_active = if input.is_active.unwrap_or(true) {
        1
    } else {
        0
    };

    conn.execute(
    r#"
      INSERT INTO activities (id, engagement_id, code, name, color_hex, tags, is_active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(id) DO UPDATE SET
        engagement_id = excluded.engagement_id,
        code = excluded.code,
        name = excluded.name,
        color_hex = excluded.color_hex,
        tags = excluded.tags,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    "#,
    params![
      id,
      input.engagement_id.trim(),
      input.code.trim(),
      input.name.trim(),
      color_hex,
      tags_json,
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

pub fn list_engagements(conn: &Connection) -> AppResult<Vec<Engagement>> {
    let mut engagement_statement = conn.prepare(
        r#"
      SELECT id, code, name, client, color_hex, tags, is_active, created_at, updated_at
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
                is_active: row.get::<_, i64>(6)? == 1,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                activities: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut activities_by_engagement: HashMap<String, Vec<Activity>> = HashMap::new();
    let mut activity_statement = conn.prepare(
        r#"
      SELECT id, engagement_id, code, name, color_hex, tags, is_active, created_at, updated_at
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
                is_active: row.get::<_, i64>(6)? == 1,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
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
        .map(|engagement| ContextEngagement {
            code: engagement.code,
            name: engagement.name,
            tags: engagement.tags,
            activities: engagement
                .activities
                .into_iter()
                .filter(|activity| activity.is_active)
                .map(|activity| ContextActivity {
                    code: activity.code,
                    name: activity.name,
                    tags: activity.tags,
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
    confidence: f64,
    message_timestamp: i64,
) -> AppResult<()> {
    let now = current_unix_timestamp();

    conn.execute(
        r#"
      INSERT INTO raw_messages (
        id, raw_text, interpreted_entries_json, confidence,
        status, message_timestamp, created_at
      )
      VALUES (?1, ?2, ?3, ?4, 'processed', ?5, ?6)
    "#,
        params![
            id,
            raw_text.trim(),
            interpreted_entries_json,
            confidence,
            message_timestamp,
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
    source: &str,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = current_unix_timestamp();

    conn.execute(
        r#"
      INSERT INTO timesheet_entries (
        id, engagement_id, activity_id, date, start_minute, end_minute,
        duration_minutes, description, source, raw_message_id, confidence,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
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
            source,
            raw_message_id,
            entry.confidence,
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
        te.source,
        te.confidence,
        te.engagement_id,
        te.activity_id,
        e.code,
        e.name,
        a.code,
        a.name
      FROM timesheet_entries te
      LEFT JOIN engagements e ON e.id = te.engagement_id
      LEFT JOIN activities a ON a.id = te.activity_id
      WHERE te.date = ?1
      ORDER BY te.start_minute
    "#,
    )?;

    let mut entries = statement
        .query_map(params![date], |row| {
            Ok(TimelineEntry {
                id: row.get(0)?,
                date: row.get(1)?,
                start_minute: row.get(2)?,
                end_minute: row.get(3)?,
                duration_minutes: row.get(4)?,
                description: row.get(5)?,
                source: row.get(6)?,
                confidence: row.get(7)?,
                engagement_id: row.get(8)?,
                activity_id: row.get(9)?,
                engagement_code: row.get(10)?,
                engagement_name: row.get(11)?,
                activity_code: row.get(12)?,
                activity_name: row.get(13)?,
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

pub fn resolve_code_ids(
    conn: &Connection,
    engagement_code: Option<&str>,
    activity_code: Option<&str>,
) -> AppResult<(Option<String>, Option<String>)> {
    let Some(engagement_code) = engagement_code else {
        return Ok((None, None));
    };

    let mut engagement_statement =
        conn.prepare("SELECT id FROM engagements WHERE code = ?1 AND is_active = 1")?;
    let engagement_id = match engagement_statement
        .query_row(params![engagement_code], |row| row.get::<_, String>(0))
    {
        Ok(id) => Some(id),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(AppError::Database(error)),
    };

    let Some(engagement_id_value) = &engagement_id else {
        return Ok((None, None));
    };

    let Some(activity_code) = activity_code else {
        return Ok((engagement_id, None));
    };

    let mut activity_statement = conn.prepare(
        "SELECT id FROM activities WHERE engagement_id = ?1 AND code = ?2 AND is_active = 1",
    )?;

    let activity_id = match activity_statement
        .query_row(params![engagement_id_value, activity_code], |row| {
            row.get::<_, String>(0)
        }) {
        Ok(id) => Some(id),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(AppError::Database(error)),
    };

    Ok((engagement_id, activity_id))
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
          WHERE command IN ('settings_get_status', 'settings_set_openai_key') OR event_type = 'key_save_verify'
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
