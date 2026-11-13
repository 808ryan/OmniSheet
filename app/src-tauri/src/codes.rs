//! Portable, codes-only files. Imports deliberately never use upsert operations.
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{Engagement, EngagementType};
use crate::state::AppState;

// Preserve interoperability with code files from earlier versions.
const FORMAT: &str = "omnisheet.codes";
const VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ENGAGEMENTS: usize = 5_000;
const MAX_ACTIVITIES: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodesFile {
    format: String,
    version: u32,
    exported_at: String,
    engagements: Vec<PortableEngagement>,
}

// Explicit field lists keep database IDs, time entries, and personal settings out of exports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableEngagement {
    code: Option<String>,
    name: String,
    client: Option<String>,
    engagement_type: EngagementType,
    color_hex: Option<String>,
    tags: Vec<String>,
    describe_when_to_use: Option<String>,
    is_active: bool,
    activities: Vec<PortableActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableActivity {
    code: Option<String>,
    name: String,
    color_hex: Option<String>,
    tags: Vec<String>,
    describe_when_to_use: Option<String>,
    is_active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodesImportResult {
    added_engagements: usize,
    added_activities: usize,
    skipped_engagements: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodesExportInput {
    engagement_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodesExportResult {
    exported_engagements: usize,
    exported_activities: usize,
}

#[derive(Debug, Hash, PartialEq, Eq)]
enum EngagementKey {
    Code(String),
    NameClient(String, String),
}

fn normalized_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn engagement_key(code: Option<&str>, name: &str, client: Option<&str>) -> EngagementKey {
    match code.map(str::trim).filter(|code| !code.is_empty()) {
        Some(code) => EngagementKey::Code(code.to_lowercase()),
        None => {
            EngagementKey::NameClient(normalized_name(name), normalized_name(client.unwrap_or("")))
        }
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

fn validate_catalog(catalog: &mut CodesFile) -> AppResult<()> {
    if catalog.format != FORMAT {
        return Err(invalid("Choose an WhiteRabbit engagement codes JSON file."));
    }
    if catalog.version != VERSION {
        return Err(invalid(
            "This code file uses an unsupported version. Update WhiteRabbit or export it again.",
        ));
    }
    if chrono::DateTime::parse_from_rfc3339(&catalog.exported_at).is_err() {
        return Err(invalid("The code file has an invalid export date."));
    }
    if catalog.engagements.is_empty() || catalog.engagements.len() > MAX_ENGAGEMENTS {
        return Err(invalid(
            "The file must contain between 1 and 5,000 engagements.",
        ));
    }
    let activity_count: usize = catalog
        .engagements
        .iter()
        .map(|item| item.activities.len())
        .sum();
    if activity_count > MAX_ACTIVITIES {
        return Err(invalid("The file contains more than 50,000 activities."));
    }
    let mut keys = HashSet::new();
    for (index, engagement) in catalog.engagements.iter_mut().enumerate() {
        let position = index + 1;
        engagement.name = engagement.name.trim().to_string();
        if engagement.name.is_empty() {
            return Err(invalid(format!("Engagement {position} needs a name.")));
        }
        engagement.code = db::normalize_optional_code(engagement.code.take());
        engagement.client = engagement
            .client
            .take()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        engagement.color_hex =
            db::normalize_color_hex(engagement.color_hex.take()).map_err(|_| {
                invalid(format!(
                    "Engagement {position} has an invalid color. Use #RRGGBB."
                ))
            })?;
        engagement.tags = db::normalize_tags(std::mem::take(&mut engagement.tags));
        engagement.describe_when_to_use = db::normalize_usage_description(
            engagement.describe_when_to_use.take().unwrap_or_default(),
        )
        .map_err(|_| {
            invalid(format!(
                "Engagement {position} has a description longer than 500 characters."
            ))
        })?;
        if !keys.insert(engagement_key(
            engagement.code.as_deref(),
            &engagement.name,
            engagement.client.as_deref(),
        )) {
            return Err(invalid(format!("Engagement {position} is duplicated within this file. Export each engagement only once.")));
        }
        let mut activity_codes = HashSet::new();
        for (activity_index, activity) in engagement.activities.iter_mut().enumerate() {
            let activity_position = activity_index + 1;
            activity.name = activity.name.trim().to_string();
            if activity.name.is_empty() {
                return Err(invalid(format!(
                    "Activity {activity_position} in engagement {position} needs a name."
                )));
            }
            activity.code = db::normalize_optional_code(activity.code.take());
            if let Some(code) = &activity.code {
                if !activity_codes.insert(code.to_lowercase()) {
                    return Err(invalid(format!(
                        "Engagement {position} contains duplicate activity codes."
                    )));
                }
            }
            activity.color_hex = db::normalize_color_hex(activity.color_hex.take())
                .map_err(|_| invalid(format!("Activity {activity_position} in engagement {position} has an invalid color.")))?;
            activity.tags = db::normalize_tags(std::mem::take(&mut activity.tags));
            activity.describe_when_to_use = db::normalize_usage_description(activity.describe_when_to_use.take().unwrap_or_default())
                .map_err(|_| invalid(format!("Activity {activity_position} in engagement {position} has a description longer than 500 characters.")))?;
        }
    }
    Ok(())
}

fn parse_catalog(bytes: &[u8]) -> AppResult<CodesFile> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(invalid("Choose a code file smaller than 5 MB."));
    }
    // Do not echo file contents or field values into UI errors or diagnostic logs.
    let mut catalog: CodesFile = serde_json::from_slice(bytes).map_err(|error| {
        invalid(format!("Invalid WhiteRabbit code file at line {}, column {}. Use a JSON file exported by WhiteRabbit.", error.line(), error.column()))
    })?;
    validate_catalog(&mut catalog)?;
    Ok(catalog)
}

fn build_catalog(connection: &Connection, engagement_ids: &[String]) -> AppResult<CodesFile> {
    let selected: HashSet<&str> = engagement_ids.iter().map(String::as_str).collect();
    if selected.is_empty() {
        return Err(invalid("Select at least one engagement to export."));
    }
    let engagements: Vec<_> = db::list_engagements(connection)?
        .into_iter()
        .filter(|engagement| selected.contains(engagement.id.as_str()))
        .map(PortableEngagement::from)
        .collect();
    if engagements.len() != selected.len() {
        return Err(invalid("Some selected engagements are no longer available. Close the export dialog and try again."));
    }
    let mut catalog = CodesFile {
        format: FORMAT.to_string(),
        version: VERSION,
        exported_at: Utc::now().to_rfc3339(),
        engagements,
    };
    validate_catalog(&mut catalog)?;
    Ok(catalog)
}

impl From<Engagement> for PortableEngagement {
    fn from(value: Engagement) -> Self {
        Self {
            code: value.code,
            name: value.name,
            client: value.client,
            engagement_type: value.engagement_type,
            color_hex: value.color_hex,
            tags: value.tags,
            describe_when_to_use: value.describe_when_to_use,
            is_active: value.is_active,
            activities: value
                .activities
                .into_iter()
                .map(|activity| PortableActivity {
                    code: activity.code,
                    name: activity.name,
                    color_hex: activity.color_hex,
                    tags: activity.tags,
                    describe_when_to_use: activity.describe_when_to_use,
                    is_active: activity.is_active,
                })
                .collect(),
        }
    }
}

fn import_catalog(
    connection: &mut Connection,
    mut catalog: CodesFile,
) -> AppResult<CodesImportResult> {
    // Validate the entire file before any writes, including records that may be skipped.
    validate_catalog(&mut catalog)?;
    let transaction = connection.transaction()?;
    let mut existing: HashSet<_> = db::list_engagements(&transaction)?
        .iter()
        .map(|item| engagement_key(item.code.as_deref(), &item.name, item.client.as_deref()))
        .collect();
    let mut result = CodesImportResult {
        added_engagements: 0,
        added_activities: 0,
        skipped_engagements: 0,
    };
    let now = db::current_unix_timestamp();
    for engagement in catalog.engagements {
        if !existing.insert(engagement_key(
            engagement.code.as_deref(),
            &engagement.name,
            engagement.client.as_deref(),
        )) {
            result.skipped_engagements += 1;
            continue;
        }
        let engagement_id = Uuid::new_v4().to_string();
        let engagement_type = match engagement.engagement_type {
            EngagementType::External => "external",
            EngagementType::Internal => "internal",
        };
        transaction.execute(
            "INSERT INTO engagements (id, code, name, client, engagement_type, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![engagement_id, engagement.code, engagement.name, engagement.client, engagement_type,
                engagement.color_hex, serde_json::to_string(&engagement.tags)?, engagement.describe_when_to_use, engagement.is_active, now],
        )?;
        result.added_engagements += 1;
        for activity in engagement.activities {
            transaction.execute(
                "INSERT INTO activities (id, engagement_id, code, name, color_hex, tags, describe_when_to_use, is_active, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![Uuid::new_v4().to_string(), engagement_id, activity.code, activity.name, activity.color_hex,
                    serde_json::to_string(&activity.tags)?, activity.describe_when_to_use, activity.is_active, now],
            )?;
            result.added_activities += 1;
        }
    }
    transaction.commit()?;
    Ok(result)
}

// Blocking native dialogs run on Tauri's command worker, never on its UI thread.
#[tauri::command(async)]
pub fn codes_import_file(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<CodesImportResult>, String> {
    let Some(file) = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Import engagement codes")
        .add_filter("WhiteRabbit codes", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "Choose a local JSON file.".to_string())?;
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| {
            "Could not read the code file. Check that it is accessible and try again.".to_string()
        })?;
    let catalog = parse_catalog(&bytes).map_err(|error| error.to_string())?;
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "Storage is busy. Try importing again.".to_string())?;
    import_catalog(&mut connection, catalog)
        .map(Some)
        .map_err(|_| "Could not import codes. No engagements were added. Try again.".to_string())
}

#[tauri::command(async)]
pub fn codes_export_file(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    input: CodesExportInput,
) -> Result<Option<CodesExportResult>, String> {
    let catalog = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "Storage is busy. Try exporting again.".to_string())?;
        build_catalog(&connection, &input.engagement_ids).map_err(|error| error.to_string())?
    };
    let bytes = serde_json::to_vec_pretty(&catalog)
        .map_err(|_| "Could not prepare the code file.".to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(
            "The selected codes exceed 5 MB. Export fewer engagements at a time.".to_string(),
        );
    }
    let Some(file) = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export engagement codes")
        .add_filter("WhiteRabbit codes", &["json"])
        .set_file_name(format!(
            "WhiteRabbit-codes-{}.json",
            Utc::now().format("%Y-%m-%d")
        ))
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let mut path = file
        .into_path()
        .map_err(|_| "Choose a local save location.".to_string())?;
    if path.extension().is_none() {
        path.set_extension("json");
    }
    fs::write(path, bytes).map_err(|_| {
        "Could not save the code file. Choose a writable location and try again.".to_string()
    })?;
    Ok(Some(CodesExportResult {
        exported_engagements: catalog.engagements.len(),
        exported_activities: catalog
            .engagements
            .iter()
            .map(|item| item.activities.len())
            .sum(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        db::run_migrations(&connection).unwrap();
        connection
    }

    fn engagement(code: Option<&str>, name: &str) -> Value {
        json!({
            "code": code, "name": name, "client": "Fictional client", "engagementType": "external",
            "colorHex": "#123ABC", "tags": ["example"], "describeWhenToUse": "Fictional usage",
            "isActive": false,
            "activities": [{
                "code": "A01", "name": "Example activity", "colorHex": null,
                "tags": ["example activity"], "describeWhenToUse": "Example guidance", "isActive": false
            }]
        })
    }

    fn file(engagements: Vec<Value>) -> Value {
        json!({"format": FORMAT, "version": VERSION, "exportedAt": "2026-11-07T12:00:00Z", "engagements": engagements})
    }

    fn catalog(engagements: Vec<Value>) -> CodesFile {
        parse_catalog(&serde_json::to_vec(&file(engagements)).unwrap()).unwrap()
    }

    fn snapshot(connection: &Connection) -> Value {
        serde_json::to_value(db::list_engagements(connection).unwrap()).unwrap()
    }

    #[test]
    fn selective_export_round_trips_all_code_metadata_with_fresh_ids() {
        let mut source = connection();
        import_catalog(
            &mut source,
            catalog(vec![
                engagement(Some("EXAMPLE-01"), "Example one"),
                engagement(Some("EXAMPLE-02"), "Example two"),
            ]),
        )
        .unwrap();
        let original = db::list_engagements(&source)
            .unwrap()
            .into_iter()
            .find(|item| item.code.as_deref() == Some("EXAMPLE-01"))
            .unwrap();
        db::upsert_app_setting(&source, "private_test_setting", "PRIVATE_SETTING_MARKER").unwrap();
        db::insert_manual_timeline_entry(
            &source,
            "2026-11-07",
            480,
            540,
            60,
            "PRIVATE_ENTRY_MARKER",
            Some(&original.id),
            Some(&original.activities[0].id),
        )
        .unwrap();
        let exported = build_catalog(&source, &[original.id.clone()]).unwrap();
        let bytes = serde_json::to_vec(&exported).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains("PRIVATE_SETTING_MARKER"));
        assert!(!text.contains("PRIVATE_ENTRY_MARKER"));
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["engagements"].as_array().unwrap().len(), 1);
        assert_eq!(json["engagements"][0]["code"], "EXAMPLE-01");
        assert!(json["engagements"][0].get("id").is_none());
        assert!(json["engagements"][0].get("createdAt").is_none());
        assert!(json["engagements"][0]["activities"][0]
            .get("engagementId")
            .is_none());
        assert!(json["engagements"][0]["activities"][0].get("id").is_none());
        // The entire envelope has only the allowlisted codes fields.
        assert_eq!(json.as_object().unwrap().len(), 4);
        assert_eq!(json["engagements"][0].as_object().unwrap().len(), 9);
        assert_eq!(
            json["engagements"][0]["activities"][0]
                .as_object()
                .unwrap()
                .len(),
            6
        );

        let mut target = connection();
        let result = import_catalog(&mut target, parse_catalog(&bytes).unwrap()).unwrap();
        assert_eq!(result.added_engagements, 1);
        assert_eq!(result.added_activities, 1);
        let imported = db::list_engagements(&target)
            .unwrap()
            .into_iter()
            .find(|item| item.code == original.code)
            .unwrap();
        assert_ne!(imported.id, original.id);
        assert_ne!(imported.activities[0].id, original.activities[0].id);
        assert_eq!(
            serde_json::to_value(PortableEngagement::from(imported)).unwrap(),
            serde_json::to_value(PortableEngagement::from(original)).unwrap()
        );
    }

    #[test]
    fn skips_existing_engagement_and_all_nested_activities_without_updates() {
        let mut connection = connection();
        import_catalog(
            &mut connection,
            catalog(vec![engagement(Some("EXAMPLE"), "Original name")]),
        )
        .unwrap();
        let original = db::list_engagements(&connection)
            .unwrap()
            .into_iter()
            .find(|item| item.code.as_deref() == Some("EXAMPLE"))
            .unwrap();
        db::insert_manual_timeline_entry(
            &connection,
            "2026-11-07",
            480,
            540,
            60,
            "Private test entry",
            Some(&original.id),
            Some(&original.activities[0].id),
        )
        .unwrap();
        let before = snapshot(&connection);
        let entries_before =
            serde_json::to_value(db::list_timeline_entries(&connection, "2026-11-07").unwrap())
                .unwrap();
        let mut incoming = engagement(Some(" example "), "Changed name");
        incoming["isActive"] = json!(true);
        incoming["activities"][0]["code"] = json!("NEW-ACTIVITY");
        let result = import_catalog(&mut connection, catalog(vec![incoming])).unwrap();
        assert_eq!(result.added_engagements, 0);
        assert_eq!(result.added_activities, 0);
        assert_eq!(result.skipped_engagements, 1);
        assert_eq!(snapshot(&connection), before);
        assert_eq!(
            serde_json::to_value(db::list_timeline_entries(&connection, "2026-11-07").unwrap())
                .unwrap(),
            entries_before
        );
    }

    #[test]
    fn repeated_imports_skip_duplicates_and_preserve_unrelated_records() {
        let mut connection = connection();
        let before = db::list_engagements(&connection).unwrap();
        let incoming = catalog(vec![engagement(Some("EXAMPLE"), "Example")]);
        let first = import_catalog(&mut connection, incoming.clone()).unwrap();
        assert_eq!(first.added_engagements, 1);
        let saved = snapshot(&connection);
        let second = import_catalog(&mut connection, incoming).unwrap();
        assert_eq!(second.skipped_engagements, 1);
        assert_eq!(snapshot(&connection), saved);
        for record in before {
            let after = db::list_engagements(&connection)
                .unwrap()
                .into_iter()
                .find(|item| item.id == record.id)
                .unwrap();
            assert_eq!(
                serde_json::to_value(record).unwrap(),
                serde_json::to_value(after).unwrap()
            );
        }
    }

    #[test]
    fn no_code_matching_uses_normalized_name_and_client_but_distinct_codes_stay_distinct() {
        let mut connection = connection();
        import_catalog(
            &mut connection,
            catalog(vec![engagement(None, "Example  Project")]),
        )
        .unwrap();
        let mut duplicate = engagement(Some("  "), " example project ");
        duplicate["client"] = json!(" FICTIONAL   CLIENT ");
        let result = import_catalog(&mut connection, catalog(vec![duplicate])).unwrap();
        assert_eq!(result.skipped_engagements, 1);
        let result = import_catalog(
            &mut connection,
            catalog(vec![
                engagement(Some("EXAMPLE-1"), "Example Project"),
                engagement(Some("EXAMPLE-2"), "Example Project"),
            ]),
        )
        .unwrap();
        assert_eq!(result.added_engagements, 2);
    }

    #[test]
    fn activity_failure_rolls_back_all_new_engagements_and_activities() {
        let mut connection = connection();
        let before = snapshot(&connection);
        connection.execute_batch("CREATE TRIGGER reject_test_activity BEFORE INSERT ON activities
            WHEN NEW.name = 'Rejected test activity' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        let mut second = engagement(Some("EXAMPLE-2"), "Example two");
        second["activities"][0]["name"] = json!("Rejected test activity");
        let result = import_catalog(
            &mut connection,
            catalog(vec![engagement(Some("EXAMPLE-1"), "Example one"), second]),
        );
        assert!(result.is_err());
        assert_eq!(snapshot(&connection), before);
    }

    #[test]
    fn invalid_later_record_is_rejected_before_any_insert() {
        let mut connection = connection();
        let before = snapshot(&connection);
        let mut incoming = catalog(vec![
            engagement(Some("EXAMPLE-1"), "Example one"),
            engagement(Some("EXAMPLE-2"), "Example two"),
        ]);
        incoming.engagements[1].activities[0].color_hex = Some("bad color".into());
        assert!(import_catalog(&mut connection, incoming).is_err());
        assert_eq!(snapshot(&connection), before);
    }

    #[test]
    fn rejects_bad_versions_shapes_duplicates_and_invalid_values_without_echoing_contents() {
        let good = file(vec![engagement(Some("EXAMPLE"), "Example")]);
        let mut cases = Vec::new();
        let mut value = good.clone();
        value["version"] = json!(99);
        cases.push(value);
        let mut value = good.clone();
        value["format"] = json!("other.file");
        cases.push(value);
        let mut value = good.clone();
        value["exportedAt"] = json!("yesterday");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["id"] = json!("not-accepted");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["name"] = json!(" ");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["isActive"] = json!("yes");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["engagementType"] = json!("unknown");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["describeWhenToUse"] = json!("x".repeat(501));
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["activities"][0]["colorHex"] = json!("#GGGGGG");
        cases.push(value);
        let mut value = good.clone();
        value["engagements"][0]["activities"]
            .as_array_mut()
            .unwrap()
            .push(good["engagements"][0]["activities"][0].clone());
        cases.push(value);
        cases.push(file(vec![
            engagement(Some("EXAMPLE"), "One"),
            engagement(Some(" example "), "Two"),
        ]));
        cases.push(file(vec![
            engagement(None, "Example"),
            engagement(None, " example "),
        ]));
        cases.push(file(vec![]));
        for value in cases {
            assert!(parse_catalog(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        assert!(parse_catalog(b"not json").is_err());
        let error = parse_catalog(br#"{"format":"PRIVATE_CONTENT"}"#)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("PRIVATE_CONTENT"));
        assert!(parse_catalog(&vec![b' '; MAX_FILE_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn export_rejects_empty_and_stale_selections() {
        let connection = connection();
        assert!(build_catalog(&connection, &[]).is_err());
        assert!(build_catalog(&connection, &["missing-id".into()]).is_err());
    }
}
