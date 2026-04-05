export type WarningType = 'low_confidence' | 'overlap' | 'unmatched'
export type OpenAiModelId = 'gpt-5-nano' | 'gpt-4.1-nano'
export type TranscriptionModelId = 'gpt-4o-mini-transcribe' | 'whisper-1'
export type CaptureSourceId = 'text' | 'voice'

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

export interface Engagement {
  id: string
  code: string | null
  name: string
  client: string | null
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
}

export interface SettingsStatus {
  hasOpenAiKey: boolean
  storageHealth: 'ok' | 'unavailable' | 'read_error'
  keySource: 'keyring' | 'session_cache' | 'none'
  statusLevel: 'ok' | 'warning' | 'error'
  lastError: string | null
  selectedOpenAiModel: OpenAiModelId
  availableOpenAiModels: OpenAiModelOption[]
  selectedTranscriptionModel: TranscriptionModelId
  availableTranscriptionModels: TranscriptionModelOption[]
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
