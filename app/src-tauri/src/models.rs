use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStatus {
    pub has_open_ai_key: bool,
    pub storage_health: StorageHealth,
    pub key_source: KeySource,
    pub status_level: StatusLevel,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageHealth {
    Ok,
    Unavailable,
    ReadError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Keyring,
    SessionCache,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusLevel {
    Ok,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub engagement_id: String,
    pub code: String,
    pub name: String,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: Option<String>,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Engagement {
    pub id: String,
    pub code: String,
    pub name: String,
    pub client: Option<String>,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: Option<String>,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngagementUpsertInput {
    pub id: Option<String>,
    pub code: String,
    pub name: String,
    pub client: Option<String>,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpsertInput {
    pub id: Option<String>,
    pub engagement_id: String,
    pub code: String,
    pub name: String,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdInput {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateInput {
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMonthSummaryInput {
    pub month: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpretTextInput {
    pub raw_text: String,
    pub client_timestamp_iso: String,
    pub timezone: String,
    pub client_local_date: String,
    pub client_local_time: String,
    pub client_utc_offset_minutes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpretResult {
    pub correlation_id: String,
    pub raw_message_id: String,
    pub created_entry_ids: Vec<String>,
    pub interpreted_entry_count: i64,
    pub unique_entry_count: i64,
    pub saved_entry_count: i64,
    pub truncated_entry_count: i64,
    pub contains_multiple_events: bool,
    pub touched_month_keys: Vec<String>,
    pub warnings: Vec<Warning>,
    pub normalization_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WarningType {
    LowConfidence,
    Overlap,
    Unmatched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub warning_type: WarningType,
    pub entry_id: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub id: String,
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub duration_minutes: i64,
    pub description: String,
    pub user_submission_text: String,
    pub source: String,
    pub confidence: f64,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub engagement_code: Option<String>,
    pub engagement_name: Option<String>,
    pub activity_code: Option<String>,
    pub activity_name: Option<String>,
    pub used_activity_fallback: bool,
    pub used_temporal_fallback: bool,
    pub duration_defaulted: bool,
    pub fallback_summary: Option<String>,
    pub source_message_entry_index: Option<i64>,
    pub source_message_entry_count: Option<i64>,
    pub warning_flags: Vec<WarningType>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDaySummary {
    pub date: String,
    pub entry_count: i64,
    pub total_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummary {
    pub week_start_date: String,
    pub week_end_date: String,
    pub days: Vec<TimelineWeeklySummaryDay>,
    pub rows: Vec<TimelineWeeklySummaryRow>,
    pub day_total_minutes: Vec<i64>,
    pub week_total_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryDay {
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryRow {
    pub engagement_code: String,
    pub activity_code: String,
    pub activity_name: String,
    pub engagement_name: String,
    pub client_name: String,
    pub is_uncategorized: bool,
    pub cells: Vec<TimelineWeeklySummaryCell>,
    pub row_total_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryCell {
    pub total_minutes: i64,
    pub notes: Vec<TimelineWeeklySummaryNote>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryNote {
    pub start_minute: i64,
    pub end_minute: i64,
    pub duration_minutes: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryExportResult {
    pub file_path: String,
    pub file_name: String,
    pub auto_open_attempted: bool,
    pub auto_open_succeeded: bool,
    pub auto_open_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineUpdateInput {
    pub id: String,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdResult {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsListInput {
    pub limit: Option<i64>,
    pub filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRecordInput {
    pub correlation_id: String,
    pub layer: String,
    pub event_type: String,
    pub command: Option<String>,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub message_text: Option<String>,
    pub details_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsEvent {
    pub id: String,
    pub timestamp: i64,
    pub session_id: String,
    pub correlation_id: String,
    pub layer: String,
    pub event_type: String,
    pub command: Option<String>,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub message_text: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeContext {
    pub engagements: Vec<ContextEngagement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEngagement {
    pub code: String,
    pub name: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub describe_when_to_use: Option<String>,
    pub activities: Vec<ContextActivity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextActivity {
    pub code: String,
    pub name: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub describe_when_to_use: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    pub entries: Vec<LlmEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmEntry {
    pub engagement_code: Option<String>,
    pub activity_code: Option<String>,
    pub date: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_minutes: Option<i64>,
    pub description: Option<String>,
    pub activity_reason: Option<String>,
    pub alternative_activities: Option<Vec<LlmAlternativeActivity>>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmAlternativeActivity {
    pub activity_code: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct NormalizedEntry {
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub duration_minutes: i64,
    pub description: String,
    pub user_submission_text: String,
    pub confidence: f64,
    pub engagement_code: Option<String>,
    pub activity_code: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{CodeContext, ContextActivity, ContextEngagement};

    #[test]
    fn context_serialization_omits_null_usage_description_fields() {
        let context = CodeContext {
            engagements: vec![ContextEngagement {
                code: "E-001".to_string(),
                name: "Example Engagement".to_string(),
                tags: vec!["example".to_string()],
                describe_when_to_use: None,
                activities: vec![ContextActivity {
                    code: "A-001".to_string(),
                    name: "Example Activity".to_string(),
                    tags: vec!["task".to_string()],
                    describe_when_to_use: None,
                }],
            }],
        };

        let serialized = serde_json::to_value(&context).expect("context serialization should work");
        let engagement = serialized
            .get("engagements")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(Value::as_object)
            .expect("engagement should exist");

        assert!(!engagement.contains_key("describeWhenToUse"));

        let activity = engagement
            .get("activities")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(Value::as_object)
            .expect("activity should exist");

        assert!(!activity.contains_key("describeWhenToUse"));
    }

    #[test]
    fn context_serialization_includes_non_null_usage_description_fields() {
        let context = CodeContext {
            engagements: vec![ContextEngagement {
                code: "E-001".to_string(),
                name: "Example Engagement".to_string(),
                tags: vec!["example".to_string()],
                describe_when_to_use: Some("Use for client example work.".to_string()),
                activities: vec![ContextActivity {
                    code: "A-001".to_string(),
                    name: "Example Activity".to_string(),
                    tags: vec!["task".to_string()],
                    describe_when_to_use: Some("Use for walkthrough sessions.".to_string()),
                }],
            }],
        };

        let serialized = serde_json::to_value(&context).expect("context serialization should work");
        let engagement = serialized
            .get("engagements")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(Value::as_object)
            .expect("engagement should exist");

        assert_eq!(
            engagement
                .get("describeWhenToUse")
                .and_then(Value::as_str)
                .expect("engagement description should exist"),
            "Use for client example work."
        );

        let activity = engagement
            .get("activities")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(Value::as_object)
            .expect("activity should exist");

        assert_eq!(
            activity
                .get("describeWhenToUse")
                .and_then(Value::as_str)
                .expect("activity description should exist"),
            "Use for walkthrough sessions."
        );
    }
}
