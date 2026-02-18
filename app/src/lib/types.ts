export type WarningType = 'low_confidence' | 'overlap' | 'unmatched'

export interface Activity {
  id: string
  engagementId: string
  code: string
  name: string
  colorHex: string | null
  tags: string[]
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export interface Engagement {
  id: string
  code: string
  name: string
  client: string | null
  colorHex: string | null
  tags: string[]
  isActive: boolean
  createdAt: number
  updatedAt: number
  activities: Activity[]
}

export interface EngagementUpsertInput {
  id?: string
  code: string
  name: string
  client?: string | null
  colorHex?: string | null
  tags: string[]
  isActive?: boolean
}

export interface ActivityUpsertInput {
  id?: string
  engagementId: string
  code: string
  name: string
  colorHex?: string | null
  tags: string[]
  isActive?: boolean
}

export interface IdResult {
  id: string
}

export interface DateInput {
  date: string
}

export interface InterpretTextInput {
  rawText: string
  clientTimestampIso: string
  timezone: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
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
  warnings: Warning[]
  normalizationNotes: string[]
}

export interface TimelineEntry {
  id: string
  date: string
  startMinute: number
  endMinute: number
  durationMinutes: number
  description: string
  source: string
  confidence: number
  engagementId: string | null
  activityId: string | null
  engagementCode: string | null
  engagementName: string | null
  activityCode: string | null
  activityName: string | null
  warningFlags: WarningType[]
}

export interface TimelineUpdateInput {
  id: string
  engagementId: string | null
  activityId: string | null
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

export interface RepairSuspiciousEntriesInput {
  limit?: number
}

export interface RepairSuspiciousEntriesResult {
  scannedCount: number
  repairedCount: number
  repairedEntryIds: string[]
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
