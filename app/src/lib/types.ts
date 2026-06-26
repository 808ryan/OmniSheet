export type WarningType = 'low_confidence' | 'overlap' | 'unmatched'
export type OpenAiModelId = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5-nano' | 'gpt-4.1-nano'
export type TranscriptionModelId = 'gpt-4o-mini-transcribe' | 'whisper-1'
export type CaptureSourceId = 'text' | 'voice' | 'calendar'
export type TimelineWeekStartDay = 'saturday' | 'sunday' | 'monday'

export interface OpenAiModelOption {
  id: OpenAiModelId
  label: string
}

export interface TranscriptionModelOption {
  id: TranscriptionModelId
  label: string
}

export interface Activity {
  id: string
  engagementId: string
  code: string | null
  name: string
  colorHex: string | null
  tags: string[]
  describeWhenToUse: string | null
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export type EngagementType = 'external' | 'internal'

export interface Engagement {
  id: string
  code: string | null
  name: string
  client: string | null
  engagementType: EngagementType
  colorHex: string | null
  tags: string[]
  describeWhenToUse: string | null
  isActive: boolean
  createdAt: number
  updatedAt: number
  activities: Activity[]
}

export interface EngagementUpsertInput {
  id?: string
  code?: string | null
  name: string
  client?: string | null
  engagementType?: EngagementType
  colorHex?: string | null
  tags: string[]
  describeWhenToUse: string
  isActive?: boolean
}

export interface ActivityUpsertInput {
  id?: string
  engagementId: string
  code?: string | null
  name: string
  colorHex?: string | null
  tags: string[]
  describeWhenToUse: string
  isActive?: boolean
}

export interface IdResult {
  id: string
}

export interface DateInput {
  date: string
}

export interface TimelineMonthSummaryInput {
  month: string
}

export interface InterpretTextInput {
  rawText: string
  clientTimestampIso: string
  timezone: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
  openAiModel?: OpenAiModelId
  captureSource?: CaptureSourceId
  transcriptionModel?: TranscriptionModelId
  transcriptionDurationMs?: number
}

export interface TranscribeAudioInput {
  audioBase64: string
  mimeType: string
  durationMs: number
  captureTimestampIso: string
}

export interface TranscribeAudioResult {
  transcriptText: string
  transcriptionModelUsed: TranscriptionModelId
  transcriptionModelUsedLabel: string
  transcriptionDurationMs: number
  audioDurationMs: number
}

export type MicrophonePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not_determined'
  | 'unsupported'

export interface MicrophonePermissionResult {
  status: MicrophonePermissionStatus
  requested: boolean
}

export interface Warning {
  warningType: WarningType
  entryId: string
  detail?: string
}

export interface InterpretResult {
  correlationId: string
  rawMessageId: string
  createdEntryIds: string[]
  interpretedEntryCount: number
  uniqueEntryCount: number
  savedEntryCount: number
  truncatedEntryCount: number
  containsMultipleEvents: boolean
  touchedMonthKeys: string[]
  warnings: Warning[]
  normalizationNotes: string[]
  modelUsed: OpenAiModelId
  modelUsedLabel: string
  llmDurationMs: number
}

export interface TimelineEntry {
  id: string
  date: string
  startMinute: number
  endMinute: number
  durationMinutes: number
  description: string
  userSubmissionText: string
  source: string
  confidence: number
  engagementId: string | null
  activityId: string | null
  engagementCode: string | null
  engagementName: string | null
  engagementType: EngagementType | null
  activityCode: string | null
  activityName: string | null
  usedActivityFallback: boolean
  usedTemporalFallback: boolean
  durationDefaulted: boolean
  fallbackSummary: string | null
  sourceMessageEntryIndex: number | null
  sourceMessageEntryCount: number | null
  modelUsed: OpenAiModelId | null
  modelUsedLabel: string | null
  transcriptionModelUsed: TranscriptionModelId | null
  transcriptionModelUsedLabel: string | null
  warningFlags: WarningType[]
  createdAt: number
  updatedAt: number
}

export interface TimelineDaySummary {
  date: string
  entryCount: number
  totalMinutes: number
}

export interface TimelineWeeklySummary {
  weekStartDate: string
  weekEndDate: string
  days: TimelineWeeklySummaryDay[]
  rows: TimelineWeeklySummaryRow[]
  dayTotalMinutes: number[]
  weekTotalMinutes: number
  dayTotalBreakdowns: TimelineTotalBreakdown[]
  weekTotalBreakdown: TimelineTotalBreakdown
}

export interface TimelineTotalBreakdown {
  primaryMinutes: number
  externalMinutes: number
  internalMinutes: number
  uncategorizedMinutes: number
}

export interface TimelineWeeklySummaryDay {
  date: string
}

export interface TimelineWeeklySummaryRow {
  engagementId: string | null
  activityId: string | null
  engagementCode: string | null
  activityCode: string | null
  activityName: string
  engagementName: string
  clientName: string
  engagementType: EngagementType | null
  isUncategorized: boolean
  cells: TimelineWeeklySummaryCell[]
  rowTotalMinutes: number
}

export interface TimelineWeeklySummaryCell {
  totalMinutes: number
  notes: TimelineWeeklySummaryNote[]
}

export interface TimelineWeeklySummaryNote {
  startMinute: number
  endMinute: number
  durationMinutes: number
  description: string
}

export interface TimelineWeekView {
  weekStartDate: string
  weekEndDate: string
  days: TimelineWeekViewDay[]
  entries: TimelineEntry[]
}

export interface TimelineWeekViewDay {
  date: string
}

export interface SummaryExportResult {
  filePath: string
  fileName: string
  autoOpenAttempted: boolean
  autoOpenSucceeded: boolean
  autoOpenError: string | null
}

export type SummaryLayoutFieldKey =
  | 'engagementCode'
  | 'engagementName'
  | 'clientName'
  | 'engagementTags'
  | 'engagementUsage'
  | 'activityCode'
  | 'activityName'
  | 'activityTags'
  | 'activityUsage'

export type SummaryLayoutColumn =
  | {
    kind: 'field'
    id: string
    fieldKey: SummaryLayoutFieldKey
  }
  | {
    kind: 'day'
    id: string
    dayIndex: number
  }
  | {
    kind: 'freeText'
    id: string
    label: string
    rowValues: Record<string, string>
    repeat: boolean
    repeatValue: string
    repeatRowKey: string | null
  }
  | {
    kind: 'rowTotal'
    id: string
  }

export interface SummaryLayoutPreset {
  id: string
  name: string
  columns: SummaryLayoutColumn[]
}

export interface SummaryExportWeeklyExcelInput {
  date: string
  layoutPreset: SummaryLayoutPreset
}

export interface SummaryLayoutState {
  version: number
  selectedPresetId: string
  presets: SummaryLayoutPreset[]
}

export type ReportingViewMode = 'table' | 'activityDetail'
export type ReportingDisplayDensity = 'compact' | 'comfortable'
export type ReportingRowLabelMode = 'combined' | 'separate' | 'activityOnly'
export type ReportingDisplayFieldKey =
  | 'details'
  | 'engagement'
  | 'activity'
  | 'client'
  | 'engagementType'
  | 'engagementCode'
  | 'activityCode'
  | 'engagementTags'
  | 'activityTags'
  | 'engagementUsage'
  | 'activityUsage'

export type ReportingDisplayColumn =
  | {
    kind: 'field'
    id: string
    fieldKey: ReportingDisplayFieldKey
  }
  | {
    kind: 'dayGroup'
    id: string
  }
  | {
    kind: 'rowTotal'
    id: string
  }

export interface ReportingDisplayPreset {
  id: string
  name: string
  density: ReportingDisplayDensity
  rowLabelMode: ReportingRowLabelMode
  showCodes: boolean
  showClient: boolean
  showEngagementType: boolean
  showEmptyDays: boolean
  columns: ReportingDisplayColumn[]
}

export interface ReportingState {
  version: number
  selectedViewMode: ReportingViewMode
  selectedDisplayPresetId: string
  selectedExportPresetId: string | null
  displayPresets: ReportingDisplayPreset[]
}

export interface TimelineUpdateInput {
  id: string
  engagementId: string | null
  activityId: string | null
  mode: 'manual' | 'drag'
  date: string
  startMinute: number
  endMinute: number
  description: string
}

export interface TimelineCreateInput {
  date: string
  startMinute: number
  endMinute: number
  engagementId?: string | null
  activityId?: string | null
  description?: string | null
}

export interface QuickAddSuggestionInput {
  limit?: number
}

export interface QuickAddSuggestion {
  engagementId: string
  activityId: string
  usageCount: number
  lastUsedAt: number | null
}

export interface QuickAddSuggestionResult {
  suggestions: QuickAddSuggestion[]
}

export interface QuickAddPreferences {
  engagementOrder: string[]
  hiddenEngagementIds: string[]
  activityOrder: Record<string, string[]>
  hiddenActivityIds: string[]
}

export interface SettingsStatus {
  hasOpenAiKey: boolean
  storageHealth: 'ok' | 'unavailable' | 'read_error'
  keySource: 'keyring' | 'session_cache' | 'none'
  statusLevel: 'ok' | 'warning' | 'error'
  lastError: string | null
  selectedOpenAiModel: OpenAiModelId
  availableOpenAiModels: OpenAiModelOption[]
  selectedCalendarBulkModel: OpenAiModelId
  selectedTranscriptionModel: TranscriptionModelId
  availableTranscriptionModels: TranscriptionModelOption[]
  timelineExcludeUncategorizedFromDailyTotals: boolean
  timelineShowUncategorizedDailyTotal: boolean
  timelineIncludeExternalInTotals: boolean
  timelineIncludeInternalInTotals: boolean
  timelineSeparateEngagementTypeTotals: boolean
  timelineWeekStartDay: TimelineWeekStartDay
  calendarBulkIgnoredKeywords: string[]
  calendarBulkIgnoreAllDayEvents: boolean
  quickAddPreferences: QuickAddPreferences
  showDiagnosticsTab: boolean
}

export interface SettingsTimelinePreferencesInput {
  timelineExcludeUncategorizedFromDailyTotals: boolean
  timelineShowUncategorizedDailyTotal: boolean
  timelineIncludeExternalInTotals: boolean
  timelineIncludeInternalInTotals: boolean
  timelineSeparateEngagementTypeTotals: boolean
  timelineWeekStartDay: TimelineWeekStartDay
}

export interface SettingsCalendarBulkPreferencesInput {
  calendarBulkIgnoredKeywords: string[]
  calendarBulkIgnoreAllDayEvents: boolean
}

export interface SettingsQuickAddPreferencesInput {
  quickAddPreferences: QuickAddPreferences
}

export interface SettingsInterfacePreferencesInput {
  showDiagnosticsTab: boolean
}

export interface CalendarExtractInput {
  imageBase64: string
  mimeType: string
  clientTimestampIso: string
  timezone: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
  selectedDate: string
  openAiModel?: OpenAiModelId
  ignoredKeywords: string[]
  ignoreAllDayEvents: boolean
}

export interface CalendarExtractResult {
  correlationId: string
  candidates: CalendarExtractCandidate[]
  ignoredCandidateCount: number
  modelUsed: OpenAiModelId
  modelUsedLabel: string
  llmDurationMs: number
}

export interface CalendarExtractCandidate {
  id: string
  date: string
  startMinute: number
  endMinute: number
  durationMinutes: number
  timeEvidence: string | null
  description: string
  extractedText: string
  sourceText: string
  confidence: number
  engagementId: string | null
  activityId: string | null
  engagementCode: string | null
  engagementName: string | null
  engagementType?: EngagementType | null
  activityCode: string | null
  activityName: string | null
  warningFlags: WarningType[]
  isAllDay: boolean
  isIgnored: boolean
  ignoredReason: string | null
  needsDateConfirmation: boolean
  needsTimeConfirmation: boolean
}

export interface CalendarImportInput {
  clientTimestampIso: string
  timezone: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
  entries: CalendarImportEntryInput[]
}

export interface CalendarImportEntryInput {
  date: string
  startMinute: number
  endMinute: number
  description: string
  extractedText: string
  engagementId: string | null
  activityId: string | null
  confidence: number
}

export interface CalendarImportResult {
  correlationId: string
  rawMessageId: string
  createdEntryIds: string[]
  touchedMonthKeys: string[]
  warnings: Warning[]
}

export interface DiagnosticsListInput {
  limit?: number
  filter?: string
}

export interface DiagnosticsEvent {
  id: string
  timestamp: number
  sessionId: string
  correlationId: string
  layer: string
  eventType: string
  command: string | null
  status: string
  durationMs: number | null
  messageText: string | null
  detailsJson: string
}

export interface DiagnosticsBundle {
  text: string
}

export interface DiagnosticsRecordInput {
  correlationId: string
  layer: string
  eventType: string
  command?: string
  status: string
  durationMs?: number
  messageText?: string
  detailsJson?: string
}

export interface AppCommandErrorShape {
  code: string
  command: string
  correlationId: string
  message: string
}
