export type WarningType = 'low_confidence' | 'overlap' | 'unmatched'

export interface Activity {
  id: string
  engagementId: string
  code: string
  name: string
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
  tags: string[]
  isActive?: boolean
}

export interface ActivityUpsertInput {
  id?: string
  engagementId: string
  code: string
  name: string
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
}

export interface Warning {
  warningType: WarningType
  entryId: string
  detail?: string
}

export interface InterpretResult {
  rawMessageId: string
  createdEntryIds: string[]
  warnings: Warning[]
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
}
