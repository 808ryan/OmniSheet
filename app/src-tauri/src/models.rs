use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OpenAiModelId {
    #[serde(rename = "gpt-5.4")]
    Gpt54,
    #[serde(rename = "gpt-5.4-mini")]
    Gpt54Mini,
    #[serde(rename = "gpt-5-nano")]
    Gpt5Nano,
    #[serde(rename = "gpt-4.1-nano")]
    Gpt41Nano,
}

impl Default for OpenAiModelId {
    fn default() -> Self {
        Self::Gpt5Nano
    }
}

impl OpenAiModelId {
    pub const ALL: [Self; 4] = [
        Self::Gpt54,
        Self::Gpt54Mini,
        Self::Gpt5Nano,
        Self::Gpt41Nano,
    ];

    pub fn default_calendar_bulk_model() -> Self {
        Self::Gpt54
    }

    pub fn api_name(self) -> &'static str {
        match self {
            Self::Gpt54 => "gpt-5.4",
            Self::Gpt54Mini => "gpt-5.4-mini",
            Self::Gpt5Nano => "gpt-5-nano",
            Self::Gpt41Nano => "gpt-4.1-nano",
        }
    }

    pub fn display_label(self) -> &'static str {
        match self {
            Self::Gpt54 => "GPT-5.4",
            Self::Gpt54Mini => "GPT-5.4 Mini",
            Self::Gpt5Nano => "GPT-5 Nano",
            Self::Gpt41Nano => "GPT-4.1 Nano",
        }
    }

    pub fn from_api_name(value: &str) -> Option<Self> {
        match value.trim() {
            "gpt-5.4" => Some(Self::Gpt54),
            "gpt-5.4-mini" => Some(Self::Gpt54Mini),
            "gpt-5-nano" => Some(Self::Gpt5Nano),
            "gpt-4.1-nano" => Some(Self::Gpt41Nano),
            _ => None,
        }
    }

    pub fn options() -> Vec<OpenAiModelOption> {
        Self::ALL
            .into_iter()
            .map(|model| OpenAiModelOption {
                id: model,
                label: model.display_label().to_string(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngagementType {
    External,
    Internal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTotalBreakdown {
    pub primary_minutes: i64,
    pub external_minutes: i64,
    pub internal_minutes: i64,
    pub uncategorized_minutes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TranscriptionModelId {
    #[serde(rename = "gpt-4o-mini-transcribe")]
    Gpt4oMiniTranscribe,
    #[serde(rename = "whisper-1")]
    Whisper1,
}

impl Default for TranscriptionModelId {
    fn default() -> Self {
        Self::Gpt4oMiniTranscribe
    }
}

impl TranscriptionModelId {
    pub const ALL: [Self; 2] = [Self::Gpt4oMiniTranscribe, Self::Whisper1];

    pub fn api_name(self) -> &'static str {
        match self {
            Self::Gpt4oMiniTranscribe => "gpt-4o-mini-transcribe",
            Self::Whisper1 => "whisper-1",
        }
    }

    pub fn display_label(self) -> &'static str {
        match self {
            Self::Gpt4oMiniTranscribe => "GPT-4o Mini Transcribe",
            Self::Whisper1 => "Whisper",
        }
    }

    pub fn from_api_name(value: &str) -> Option<Self> {
        match value.trim() {
            "gpt-4o-mini-transcribe" => Some(Self::Gpt4oMiniTranscribe),
            "whisper-1" => Some(Self::Whisper1),
            _ => None,
        }
    }

    pub fn options() -> Vec<TranscriptionModelOption> {
        Self::ALL
            .into_iter()
            .map(|model| TranscriptionModelOption {
                id: model,
                label: model.display_label().to_string(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSourceId {
    Text,
    Voice,
    Calendar,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiModelOption {
    pub id: OpenAiModelId,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelOption {
    pub id: TranscriptionModelId,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetOpenAiModelInput {
    pub model: OpenAiModelId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetCalendarBulkModelInput {
    pub model: OpenAiModelId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetTranscriptionModelInput {
    pub model: TranscriptionModelId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetTimelinePreferencesInput {
    pub timeline_exclude_uncategorized_from_daily_totals: bool,
    pub timeline_show_uncategorized_daily_total: bool,
    pub timeline_include_external_in_totals: bool,
    pub timeline_include_internal_in_totals: bool,
    pub timeline_separate_engagement_type_totals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetCalendarBulkPreferencesInput {
    pub calendar_bulk_ignored_keywords: Vec<String>,
    pub calendar_bulk_ignore_all_day_events: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddPreferences {
    pub engagement_order: Vec<String>,
    pub hidden_engagement_ids: Vec<String>,
    pub activity_order: HashMap<String, Vec<String>>,
    pub hidden_activity_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetQuickAddPreferencesInput {
    pub quick_add_preferences: QuickAddPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStatus {
    pub has_open_ai_key: bool,
    pub storage_health: StorageHealth,
    pub key_source: KeySource,
    pub status_level: StatusLevel,
    pub last_error: Option<String>,
    pub selected_open_ai_model: OpenAiModelId,
    pub available_open_ai_models: Vec<OpenAiModelOption>,
    pub selected_calendar_bulk_model: OpenAiModelId,
    pub selected_transcription_model: TranscriptionModelId,
    pub available_transcription_models: Vec<TranscriptionModelOption>,
    pub timeline_exclude_uncategorized_from_daily_totals: bool,
    pub timeline_show_uncategorized_daily_total: bool,
    pub timeline_include_external_in_totals: bool,
    pub timeline_include_internal_in_totals: bool,
    pub timeline_separate_engagement_type_totals: bool,
    pub calendar_bulk_ignored_keywords: Vec<String>,
    pub calendar_bulk_ignore_all_day_events: bool,
    pub quick_add_preferences: QuickAddPreferences,
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
    pub code: Option<String>,
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
    pub code: Option<String>,
    pub name: String,
    pub client: Option<String>,
    pub engagement_type: EngagementType,
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
    pub code: Option<String>,
    pub name: String,
    pub client: Option<String>,
    pub engagement_type: Option<EngagementType>,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: String,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpsertInput {
    pub id: Option<String>,
    pub engagement_id: String,
    pub code: Option<String>,
    pub name: String,
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
    pub describe_when_to_use: String,
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
    pub open_ai_model: Option<OpenAiModelId>,
    pub capture_source: Option<CaptureSourceId>,
    pub transcription_model: Option<TranscriptionModelId>,
    pub transcription_duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioInput {
    pub audio_base64: String,
    pub mime_type: String,
    pub duration_ms: i64,
    pub capture_timestamp_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioResult {
    pub transcript_text: String,
    pub transcription_model_used: TranscriptionModelId,
    pub transcription_model_used_label: String,
    pub transcription_duration_ms: i64,
    pub audio_duration_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MicrophonePermissionStatus {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePermissionResult {
    pub status: MicrophonePermissionStatus,
    pub requested: bool,
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
    pub model_used: OpenAiModelId,
    pub model_used_label: String,
    pub llm_duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExtractInput {
    pub image_base64: String,
    pub mime_type: String,
    pub client_timestamp_iso: String,
    pub timezone: String,
    pub client_local_date: String,
    pub client_local_time: String,
    pub client_utc_offset_minutes: i64,
    pub selected_date: String,
    pub open_ai_model: Option<OpenAiModelId>,
    pub ignored_keywords: Vec<String>,
    pub ignore_all_day_events: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExtractResult {
    pub correlation_id: String,
    pub candidates: Vec<CalendarExtractCandidate>,
    pub ignored_candidate_count: i64,
    pub model_used: OpenAiModelId,
    pub model_used_label: String,
    pub llm_duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExtractCandidate {
    pub id: String,
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub duration_minutes: i64,
    pub time_evidence: Option<String>,
    pub description: String,
    pub extracted_text: String,
    pub source_text: String,
    pub confidence: f64,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub engagement_code: Option<String>,
    pub engagement_name: Option<String>,
    pub engagement_type: Option<EngagementType>,
    pub activity_code: Option<String>,
    pub activity_name: Option<String>,
    pub warning_flags: Vec<WarningType>,
    pub is_all_day: bool,
    pub is_ignored: bool,
    pub ignored_reason: Option<String>,
    pub needs_date_confirmation: bool,
    pub needs_time_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarImportInput {
    pub client_timestamp_iso: String,
    pub timezone: String,
    pub client_local_date: String,
    pub client_local_time: String,
    pub client_utc_offset_minutes: i64,
    pub entries: Vec<CalendarImportEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarImportEntryInput {
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub description: String,
    pub extracted_text: String,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarImportResult {
    pub correlation_id: String,
    pub raw_message_id: String,
    pub created_entry_ids: Vec<String>,
    pub touched_month_keys: Vec<String>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarVisionResponse {
    pub events: Vec<CalendarVisionEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarVisionEvent {
    pub title: String,
    pub details: Option<String>,
    pub date: Option<String>,
    pub weekday: Option<String>,
    pub day_of_month: Option<i64>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_minutes: Option<i64>,
    pub time_evidence: Option<String>,
    pub is_all_day: bool,
    pub engagement_ref: Option<String>,
    pub activity_ref: Option<String>,
    pub confidence: Option<f64>,
    pub visual_notes: Option<String>,
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
    pub engagement_type: Option<EngagementType>,
    pub activity_code: Option<String>,
    pub activity_name: Option<String>,
    pub used_activity_fallback: bool,
    pub used_temporal_fallback: bool,
    pub duration_defaulted: bool,
    pub fallback_summary: Option<String>,
    pub source_message_entry_index: Option<i64>,
    pub source_message_entry_count: Option<i64>,
    pub model_used: Option<OpenAiModelId>,
    pub model_used_label: Option<String>,
    pub transcription_model_used: Option<TranscriptionModelId>,
    pub transcription_model_used_label: Option<String>,
    pub warning_flags: Vec<WarningType>,
    pub created_at: i64,
    pub updated_at: i64,
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
    pub day_total_breakdowns: Vec<TimelineTotalBreakdown>,
    pub week_total_breakdown: TimelineTotalBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryDay {
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeeklySummaryRow {
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub engagement_code: Option<String>,
    pub activity_code: Option<String>,
    pub activity_name: String,
    pub engagement_name: String,
    pub client_name: String,
    pub engagement_type: Option<EngagementType>,
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
pub struct TimelineWeekView {
    pub week_start_date: String,
    pub week_end_date: String,
    pub days: Vec<TimelineWeekViewDay>,
    pub entries: Vec<TimelineEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineWeekViewDay {
    pub date: String,
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
pub struct SummaryExportWeeklyExcelInput {
    pub date: String,
    pub layout_preset: SummaryLayoutPreset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SummaryLayoutFieldKey {
    EngagementCode,
    EngagementName,
    ClientName,
    EngagementTags,
    EngagementUsage,
    ActivityCode,
    ActivityName,
    ActivityTags,
    ActivityUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SummaryLayoutColumn {
    Field {
        id: String,
        #[serde(rename = "fieldKey", alias = "field_key")]
        field_key: SummaryLayoutFieldKey,
    },
    Day {
        id: String,
        #[serde(rename = "dayIndex", alias = "day_index")]
        day_index: u8,
    },
    FreeText {
        id: String,
        label: String,
        #[serde(rename = "rowValues", alias = "row_values", default)]
        row_values: HashMap<String, String>,
        #[serde(default)]
        repeat: bool,
        #[serde(rename = "repeatValue", alias = "repeat_value", default)]
        repeat_value: String,
        #[serde(rename = "repeatRowKey", alias = "repeat_row_key", default)]
        repeat_row_key: Option<String>,
    },
    RowTotal {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryLayoutPreset {
    pub id: String,
    pub name: String,
    pub columns: Vec<SummaryLayoutColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryLayoutState {
    pub version: i64,
    pub selected_preset_id: String,
    pub presets: Vec<SummaryLayoutPreset>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportingViewMode {
    Table,
    ActivityDetail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportingDisplayDensity {
    Compact,
    Comfortable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportingRowLabelMode {
    Combined,
    Separate,
    ActivityOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportingDisplayPreset {
    pub id: String,
    pub name: String,
    pub density: ReportingDisplayDensity,
    pub row_label_mode: ReportingRowLabelMode,
    pub show_codes: bool,
    pub show_client: bool,
    pub show_engagement_type: bool,
    pub show_empty_days: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportingState {
    pub version: i64,
    pub selected_view_mode: ReportingViewMode,
    pub selected_display_preset_id: String,
    pub selected_export_preset_id: Option<String>,
    pub display_presets: Vec<ReportingDisplayPreset>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineUpdateMode {
    Manual,
    Drag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineUpdateInput {
    pub id: String,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub mode: TimelineUpdateMode,
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineCreateInput {
    pub date: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub engagement_id: Option<String>,
    pub activity_id: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddSuggestionInput {
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddSuggestion {
    pub engagement_id: String,
    pub activity_id: String,
    pub usage_count: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddSuggestionResult {
    pub suggestions: Vec<QuickAddSuggestion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdResult {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResult {
    pub week_start_date: String,
    pub week_end_date: String,
    pub submissions: Vec<HistorySubmission>,
    pub entries: Vec<TimelineEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySubmission {
    pub id: String,
    pub raw_text: String,
    pub capture_source: String,
    pub status: String,
    pub message_timestamp: i64,
    pub created_at: i64,
    pub interpreted_entry_count: i64,
    pub unique_entry_count: i64,
    pub saved_entry_count: i64,
    pub truncated_entry_count: i64,
    pub contains_multiple_events: bool,
    pub confidence: f64,
    pub model_used: Option<OpenAiModelId>,
    pub model_used_label: Option<String>,
    pub transcription_model_used: Option<TranscriptionModelId>,
    pub transcription_model_used_label: Option<String>,
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
    #[serde(skip_serializing)]
    pub id: String,
    pub engagement_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub name: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub describe_when_to_use: Option<String>,
    pub activities: Vec<ContextActivity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextActivity {
    #[serde(skip_serializing)]
    pub id: String,
    pub activity_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
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
    pub engagement_ref: Option<String>,
    pub activity_ref: Option<String>,
    pub date: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_minutes: Option<i64>,
    pub description: Option<String>,
    pub sequence_relation: Option<String>,
    pub duration_source: Option<String>,
    pub activity_reason: Option<String>,
    pub alternative_activities: Option<Vec<LlmAlternativeActivity>>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmAlternativeActivity {
    pub activity_ref: String,
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
    pub engagement_ref: Option<String>,
    pub activity_ref: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{
        CodeContext, ContextActivity, ContextEngagement, OpenAiModelId, SummaryLayoutColumn,
        SummaryLayoutFieldKey, TranscriptionModelId,
    };

    #[test]
    fn openai_model_default_and_labels_match_expected_values() {
        let default_model = OpenAiModelId::default();

        assert_eq!(default_model, OpenAiModelId::Gpt5Nano);
        assert_eq!(default_model.api_name(), "gpt-5-nano");
        assert_eq!(default_model.display_label(), "GPT-5 Nano");
        assert_eq!(
            OpenAiModelId::default_calendar_bulk_model(),
            OpenAiModelId::Gpt54
        );
        assert_eq!(OpenAiModelId::Gpt54.api_name(), "gpt-5.4");
        assert_eq!(OpenAiModelId::Gpt54.display_label(), "GPT-5.4");
        assert_eq!(OpenAiModelId::Gpt54Mini.api_name(), "gpt-5.4-mini");
        assert_eq!(OpenAiModelId::Gpt54Mini.display_label(), "GPT-5.4 Mini");
        assert_eq!(OpenAiModelId::Gpt41Nano.display_label(), "GPT-4.1 Nano");
    }

    #[test]
    fn openai_model_serialization_round_trips_supported_ids() {
        let serialized = serde_json::to_string(&OpenAiModelId::Gpt41Nano)
            .expect("model serialization should work");
        assert_eq!(serialized, "\"gpt-4.1-nano\"");

        let parsed: OpenAiModelId =
            serde_json::from_str("\"gpt-5-nano\"").expect("model deserialization should work");
        assert_eq!(parsed, OpenAiModelId::Gpt5Nano);
        assert_eq!(
            OpenAiModelId::from_api_name("gpt-4.1-nano"),
            Some(OpenAiModelId::Gpt41Nano)
        );
        assert_eq!(
            OpenAiModelId::from_api_name("gpt-5.4"),
            Some(OpenAiModelId::Gpt54)
        );
        assert_eq!(
            OpenAiModelId::from_api_name("gpt-5.4-mini"),
            Some(OpenAiModelId::Gpt54Mini)
        );
        assert_eq!(OpenAiModelId::from_api_name("gpt-4.1"), None);

        let options = OpenAiModelId::options();
        assert!(options
            .iter()
            .any(|option| option.id == OpenAiModelId::Gpt54));
        assert!(options
            .iter()
            .any(|option| option.id == OpenAiModelId::Gpt54Mini));
    }

    #[test]
    fn transcription_model_default_and_labels_match_expected_values() {
        let default_model = TranscriptionModelId::default();

        assert_eq!(default_model, TranscriptionModelId::Gpt4oMiniTranscribe);
        assert_eq!(default_model.api_name(), "gpt-4o-mini-transcribe");
        assert_eq!(default_model.display_label(), "GPT-4o Mini Transcribe");
        assert_eq!(TranscriptionModelId::Whisper1.display_label(), "Whisper");
    }

    #[test]
    fn transcription_model_serialization_round_trips_supported_ids() {
        let serialized = serde_json::to_string(&TranscriptionModelId::Whisper1)
            .expect("model serialization should work");
        assert_eq!(serialized, "\"whisper-1\"");

        let parsed: TranscriptionModelId = serde_json::from_str("\"gpt-4o-mini-transcribe\"")
            .expect("model deserialization should work");
        assert_eq!(parsed, TranscriptionModelId::Gpt4oMiniTranscribe);
        assert_eq!(
            TranscriptionModelId::from_api_name("whisper-1"),
            Some(TranscriptionModelId::Whisper1)
        );
        assert_eq!(
            TranscriptionModelId::from_api_name("gpt-4o-transcribe"),
            None
        );
    }

    #[test]
    fn context_serialization_omits_null_usage_description_fields() {
        let context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-id-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: None,
                name: "Example Engagement".to_string(),
                tags: vec!["example".to_string()],
                describe_when_to_use: None,
                activities: vec![ContextActivity {
                    id: "activity-id-1".to_string(),
                    activity_ref: "act-001".to_string(),
                    code: None,
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

        assert_eq!(
            engagement
                .get("engagementRef")
                .and_then(Value::as_str)
                .expect("engagement ref should exist"),
            "eng-001"
        );
        assert!(!engagement.contains_key("id"));
        assert!(!engagement.contains_key("code"));
        assert!(!engagement.contains_key("describeWhenToUse"));

        let activity = engagement
            .get("activities")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(Value::as_object)
            .expect("activity should exist");

        assert_eq!(
            activity
                .get("activityRef")
                .and_then(Value::as_str)
                .expect("activity ref should exist"),
            "act-001"
        );
        assert!(!activity.contains_key("id"));
        assert!(!activity.contains_key("code"));
        assert!(!activity.contains_key("describeWhenToUse"));
    }

    #[test]
    fn context_serialization_includes_non_null_usage_description_fields() {
        let context = CodeContext {
            engagements: vec![ContextEngagement {
                id: "engagement-id-1".to_string(),
                engagement_ref: "eng-001".to_string(),
                code: Some("E-001".to_string()),
                name: "Example Engagement".to_string(),
                tags: vec!["example".to_string()],
                describe_when_to_use: Some("Use for client example work.".to_string()),
                activities: vec![ContextActivity {
                    id: "activity-id-1".to_string(),
                    activity_ref: "act-001".to_string(),
                    code: Some("A-001".to_string()),
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
        assert_eq!(
            engagement
                .get("code")
                .and_then(Value::as_str)
                .expect("engagement code should exist"),
            "E-001"
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
        assert_eq!(
            activity
                .get("code")
                .and_then(Value::as_str)
                .expect("activity code should exist"),
            "A-001"
        );
    }

    #[test]
    fn summary_layout_column_serializes_and_deserializes_camel_case_variant_fields() {
        let column = SummaryLayoutColumn::Field {
            id: "field-1".to_string(),
            field_key: SummaryLayoutFieldKey::EngagementName,
        };

        let serialized = serde_json::to_value(&column).expect("column serialization should work");
        let serialized_object = serialized
            .as_object()
            .expect("column should serialize to an object");
        assert_eq!(
            serialized_object
                .get("fieldKey")
                .and_then(Value::as_str)
                .expect("fieldKey should exist"),
            "engagementName"
        );
        assert!(!serialized_object.contains_key("field_key"));

        let parsed: SummaryLayoutColumn = serde_json::from_value(serde_json::json!({
            "kind": "day",
            "id": "day-1",
            "dayIndex": 1
        }))
        .expect("camelCase payload should deserialize");

        match parsed {
            SummaryLayoutColumn::Day { day_index, .. } => assert_eq!(day_index, 1),
            _ => panic!("expected day column"),
        }

        let parsed_row_total: SummaryLayoutColumn = serde_json::from_value(serde_json::json!({
            "kind": "rowTotal",
            "id": "row-total"
        }))
        .expect("row total payload should deserialize");

        match parsed_row_total {
            SummaryLayoutColumn::RowTotal { id } => assert_eq!(id, "row-total"),
            _ => panic!("expected row total column"),
        }
    }
}
