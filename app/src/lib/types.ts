export type WarningType = 'low_confidence' | 'overlap' | 'unmatched'
export type OpenAiModelId = 'gpt-5-nano' | 'gpt-4.1-nano'

export interface OpenAiModelOption {
  id: OpenAiModelId
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

export interface SummaryExportResult {
  filePath: string
  fileName: string
  autoOpenAttempted: boolean
  autoOpenSucceeded: boolean
  autoOpenError: string | null
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

export interface SettingsStatus {
  hasOpenAiKey: boolean
  storageHealth: 'ok' | 'unavailable' | 'read_error'
  keySource: 'keyring' | 'session_cache' | 'none'
  statusLevel: 'ok' | 'warning' | 'error'
  lastError: string | null
  selectedOpenAiModel: OpenAiModelId
  availableOpenAiModels: OpenAiModelOption[]
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
