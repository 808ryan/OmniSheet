import type {
  Activity,
  ActivityUpsertInput,
  CalendarExtractCandidate,
  CalendarExtractInput,
  CalendarExtractResult,
  CalendarImportInput,
  CalendarImportResult,
  CaptureSourceId,
  DateInput,
  DiagnosticsEvent,
  DiagnosticsListInput,
  DiagnosticsRecordInput,
  Engagement,
  EngagementType,
  EngagementUpsertInput,
  HistoryListResult,
  IdResult,
  InterpretResult,
  InterpretTextInput,
  OpenAiModelId,
  QuickAddSuggestion,
  QuickAddSuggestionInput,
  QuickAddSuggestionResult,
  SettingsCalendarBulkPreferencesInput,
  SettingsStatus,
  SettingsTimelinePreferencesInput,
  SummaryExportResult,
  SummaryExportWeeklyExcelInput,
  SummaryLayoutState,
  TimelineCreateInput,
  TimelineDaySummary,
  TimelineEntry,
  TimelineMonthSummaryInput,
  TimelineTotalBreakdown,
  TimelineUpdateInput,
  TimelineWeekView,
  TimelineWeeklySummary,
  TimelineWeeklySummaryCell,
  TimelineWeeklySummaryRow,
  TranscribeAudioInput,
  TranscribeAudioResult,
  TranscriptionModelId,
  Warning,
  WarningType,
} from './types'

const ORANGE_ENGAGEMENT_ID = 'agent-qa-eng-orange-itgc'
const INTERNAL_ENGAGEMENT_ID = 'agent-qa-eng-internal-admin'
const CONTROL_TESTING_ACTIVITY_ID = 'agent-qa-act-control-testing'
const WALKTHROUGH_ACTIVITY_ID = 'agent-qa-act-walkthrough'
const INTERNAL_PLANNING_ACTIVITY_ID = 'agent-qa-act-internal-planning'

interface HistorySubmissionSeed {
  id: string
  rawText: string
  captureSource: CaptureSourceId
  status: string
  messageTimestamp: number
  createdAt: number
  interpretedEntryCount: number
  uniqueEntryCount: number
  savedEntryCount: number
  truncatedEntryCount: number
  containsMultipleEvents: boolean
  confidence: number
  modelUsed: OpenAiModelId | null
  modelUsedLabel: string | null
  transcriptionModelUsed: TranscriptionModelId | null
  transcriptionModelUsedLabel: string | null
}

interface MockState {
  engagements: Engagement[]
  entries: TimelineEntry[]
  submissions: HistorySubmissionSeed[]
  diagnostics: DiagnosticsEvent[]
  settings: SettingsStatus
  summaryLayoutState: SummaryLayoutState
  nextId: number
}

export async function mockInvokeCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const state = getMockState()

  switch (command) {
    case 'settings_get_status':
      return clone(state.settings) as T
    case 'settings_set_openai_key':
      state.settings.hasOpenAiKey = true
      state.settings.keySource = 'session_cache'
      return undefined as T
    case 'settings_set_openai_model':
      state.settings.selectedOpenAiModel = inputOf<{ model: OpenAiModelId }>(args).model
      return undefined as T
    case 'settings_set_calendar_bulk_model':
      state.settings.selectedCalendarBulkModel = inputOf<{ model: OpenAiModelId }>(args).model
      return undefined as T
    case 'settings_set_transcription_model':
      state.settings.selectedTranscriptionModel = inputOf<{ model: TranscriptionModelId }>(args).model
      return undefined as T
    case 'settings_set_timeline_preferences':
      applyTimelinePreferences(state, inputOf<SettingsTimelinePreferencesInput>(args))
      return undefined as T
    case 'settings_set_calendar_bulk_preferences':
      applyCalendarPreferences(state, inputOf<SettingsCalendarBulkPreferencesInput>(args))
      return undefined as T
    case 'summary_layout_state_get':
      return clone(state.summaryLayoutState) as T
    case 'summary_layout_state_set':
      state.summaryLayoutState = clone(inputOf<SummaryLayoutState>(args))
      return clone(state.summaryLayoutState) as T
    case 'engagement_list':
      return clone(state.engagements) as T
    case 'engagement_upsert':
      return upsertEngagement(state, inputOf<EngagementUpsertInput>(args)) as T
    case 'engagement_delete':
      deleteEngagement(state, inputOf<{ id: string }>(args).id)
      return undefined as T
    case 'activity_upsert':
      return upsertActivity(state, inputOf<ActivityUpsertInput>(args)) as T
    case 'activity_delete':
      deleteActivity(state, inputOf<{ id: string }>(args).id)
      return undefined as T
    case 'timeline_list_for_date':
      return listEntriesForDate(state, inputOf<DateInput>(args).date) as T
    case 'timeline_month_summary':
      return monthSummary(state, inputOf<TimelineMonthSummaryInput>(args)) as T
    case 'timeline_weekly_summary':
      return weeklySummary(state, inputOf<DateInput>(args).date) as T
    case 'timeline_list_for_week_view':
      return weekView(state, inputOf<DateInput>(args).date) as T
    case 'history_list':
      return historyList(state, inputOf<DateInput>(args).date) as T
    case 'quick_add_suggestions':
      return quickAddSuggestions(state, inputOf<QuickAddSuggestionInput>(args)) as T
    case 'summary_export_weekly_excel':
      return summaryExport(inputOf<SummaryExportWeeklyExcelInput>(args)) as T
    case 'timeline_update_entry':
      updateEntry(state, inputOf<TimelineUpdateInput>(args))
      return undefined as T
    case 'timeline_create_entry':
      return createEntry(state, inputOf<TimelineCreateInput>(args)) as T
    case 'timeline_delete_entry':
      deleteEntry(state, inputOf<{ id: string }>(args).id)
      return undefined as T
    case 'calendar_extract_events':
      return calendarExtract(state, inputOf<CalendarExtractInput>(args)) as T
    case 'calendar_import_entries':
      return calendarImport(state, inputOf<CalendarImportInput>(args)) as T
    case 'transcribe_audio_clip':
      return transcribeAudio(inputOf<TranscribeAudioInput>(args)) as T
    case 'voice_request_microphone_permission':
      return { status: 'granted', requested: false } as T
    case 'interpret_text_message':
      return interpretText(state, inputOf<InterpretTextInput>(args)) as T
    case 'diagnostics_record_frontend_event':
      recordFrontendDiagnostic(state, inputOf<DiagnosticsRecordInput>(args))
      return undefined as T
    case 'diagnostics_list':
      return diagnosticsList(state, inputOf<DiagnosticsListInput>(args)) as T
    case 'diagnostics_copy_bundle':
      return { text: diagnosticsBundleText(state) } as T
    case 'quick_add_hide_window':
    case 'quick_add_show_main_window':
      return undefined as T
    default:
      throw new Error(`Agent mock command is not implemented: ${command}`)
  }
}

function inputOf<T>(args: Record<string, unknown>): T {
  return args.input as T
}

let mockState: MockState | null = null

function getMockState(): MockState {
  if (!mockState) {
    mockState = createInitialState()
  }

  return mockState
}

function createInitialState(): MockState {
  const today = formatDate(new Date())
  const yesterday = formatDate(shiftDate(today, -1))
  const now = currentUnixTimestamp()
  const engagements = seedEngagements(now)
  const state: MockState = {
    engagements,
    entries: [],
    submissions: [
      {
        id: 'agent-qa-history-message',
        rawText: 'QA seeded history submission',
        captureSource: 'text',
        status: 'processed',
        messageTimestamp: now - 900,
        createdAt: now - 900,
        interpretedEntryCount: 1,
        uniqueEntryCount: 1,
        savedEntryCount: 1,
        truncatedEntryCount: 0,
        containsMultipleEvents: false,
        confidence: 0.98,
        modelUsed: 'gpt-5-nano',
        modelUsedLabel: 'GPT-5 Nano',
        transcriptionModelUsed: null,
        transcriptionModelUsedLabel: null,
      },
    ],
    diagnostics: [
      diagnostic('agent-qa-seed', 'backend', 'agent_qa_seed', 'agent_qa_seed', 'ok', {
        message: 'Agent QA mock data loaded.',
      }),
      diagnostic('agent-qa-browser-smoke', 'frontend', 'agent_qa_ready', 'agent_qa_browser', 'ok', {
        message: 'Agent QA browser smoke fixture is ready.',
      }),
    ],
    settings: defaultSettings(),
    summaryLayoutState: defaultSummaryLayoutState(),
    nextId: 1,
  }

  state.entries.push(
    makeEntry(state, {
      id: 'agent-qa-entry-control',
      date: today,
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      description: 'QA seeded control walkthrough',
      engagementId: ORANGE_ENGAGEMENT_ID,
      activityId: CONTROL_TESTING_ACTIVITY_ID,
      source: 'manual',
    }),
    makeEntry(state, {
      id: 'agent-qa-entry-screenshot',
      date: today,
      startMinute: 10 * 60 + 30,
      endMinute: 11 * 60 + 15,
      description: 'QA seeded screenshot review',
      engagementId: ORANGE_ENGAGEMENT_ID,
      activityId: WALKTHROUGH_ACTIVITY_ID,
      source: 'manual',
    }),
    makeEntry(state, {
      id: 'agent-qa-entry-planning',
      date: today,
      startMinute: 13 * 60,
      endMinute: 13 * 60 + 45,
      description: 'QA seeded internal planning',
      engagementId: INTERNAL_ENGAGEMENT_ID,
      activityId: INTERNAL_PLANNING_ACTIVITY_ID,
      source: 'manual',
    }),
    makeEntry(state, {
      id: 'agent-qa-entry-uncategorized',
      date: today,
      startMinute: 14 * 60,
      endMinute: 14 * 60 + 30,
      description: 'QA seeded uncategorized follow-up',
      engagementId: null,
      activityId: null,
      source: 'manual',
      warningFlags: ['unmatched'],
    }),
    makeEntry(state, {
      id: 'agent-qa-entry-history',
      date: yesterday,
      startMinute: 15 * 60,
      endMinute: 15 * 60 + 30,
      description: 'QA seeded interpreted history entry',
      engagementId: ORANGE_ENGAGEMENT_ID,
      activityId: CONTROL_TESTING_ACTIVITY_ID,
      source: 'text',
      userSubmissionText: 'QA seeded history submission',
      modelUsed: 'gpt-5-nano',
      modelUsedLabel: 'GPT-5 Nano',
    }),
  )

  return state
}

function seedEngagements(timestamp: number): Engagement[] {
  return [
    {
      id: ORANGE_ENGAGEMENT_ID,
      code: 'A100',
      name: 'Orange ITGC',
      client: 'Orange',
      engagementType: 'external',
      colorHex: '#1F7AFF',
      tags: ['qa', 'external'],
      describeWhenToUse: 'Use for external ITGC control testing, walkthroughs, and evidence review.',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      activities: [
        {
          id: CONTROL_TESTING_ACTIVITY_ID,
          engagementId: ORANGE_ENGAGEMENT_ID,
          code: 'CTRL',
          name: 'Control Testing',
          colorHex: '#2563EB',
          tags: ['testing', 'qa'],
          describeWhenToUse: 'Use for testing ITGC controls and reviewing support.',
          isActive: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: WALKTHROUGH_ACTIVITY_ID,
          engagementId: ORANGE_ENGAGEMENT_ID,
          code: 'WALK',
          name: 'Walkthrough',
          colorHex: '#7C3AED',
          tags: ['walkthrough', 'qa'],
          describeWhenToUse: 'Use for walkthrough calls, process understanding, and design review.',
          isActive: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
    {
      id: INTERNAL_ENGAGEMENT_ID,
      code: 'I200',
      name: 'Internal Admin',
      client: 'OmniSheet',
      engagementType: 'internal',
      colorHex: '#0F766E',
      tags: ['qa', 'internal'],
      describeWhenToUse: 'Use for internal planning, admin, and QA review activities.',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      activities: [
        {
          id: INTERNAL_PLANNING_ACTIVITY_ID,
          engagementId: INTERNAL_ENGAGEMENT_ID,
          code: 'PLAN',
          name: 'Planning',
          colorHex: '#059669',
          tags: ['planning', 'qa'],
          describeWhenToUse: 'Use for planning the workday and reviewing the Agent QA loop.',
          isActive: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ]
}

function defaultSettings(): SettingsStatus {
  return {
    hasOpenAiKey: true,
    storageHealth: 'ok',
    keySource: 'session_cache',
    statusLevel: 'ok',
    lastError: null,
    selectedOpenAiModel: 'gpt-5-nano',
    availableOpenAiModels: [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'gpt-5-nano', label: 'GPT-5 Nano' },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    ],
    selectedCalendarBulkModel: 'gpt-5.4',
    selectedTranscriptionModel: 'gpt-4o-mini-transcribe',
    availableTranscriptionModels: [
      { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
      { id: 'whisper-1', label: 'Whisper' },
    ],
    timelineExcludeUncategorizedFromDailyTotals: true,
    timelineShowUncategorizedDailyTotal: true,
    timelineIncludeExternalInTotals: true,
    timelineIncludeInternalInTotals: true,
    timelineSeparateEngagementTypeTotals: true,
    calendarBulkIgnoredKeywords: ['lunch', 'hold'],
    calendarBulkIgnoreAllDayEvents: true,
  }
}

function defaultSummaryLayoutState(): SummaryLayoutState {
  return {
    version: 2,
    selectedPresetId: 'agent-qa-summary',
    presets: [
      {
        id: 'agent-qa-summary',
        name: 'Agent QA',
        columns: [
          { kind: 'field', id: 'agent-qa-engagement-code', fieldKey: 'engagementCode' },
          { kind: 'field', id: 'agent-qa-activity-code', fieldKey: 'activityCode' },
          { kind: 'field', id: 'agent-qa-activity-name', fieldKey: 'activityName' },
          { kind: 'day', id: 'agent-qa-day-0', dayIndex: 0 },
          { kind: 'day', id: 'agent-qa-day-1', dayIndex: 1 },
          { kind: 'day', id: 'agent-qa-day-2', dayIndex: 2 },
          { kind: 'day', id: 'agent-qa-day-3', dayIndex: 3 },
          { kind: 'day', id: 'agent-qa-day-4', dayIndex: 4 },
          { kind: 'day', id: 'agent-qa-day-5', dayIndex: 5 },
          { kind: 'day', id: 'agent-qa-day-6', dayIndex: 6 },
          { kind: 'rowTotal', id: 'agent-qa-row-total' },
        ],
      },
    ],
  }
}

function makeEntry(
  state: Pick<MockState, 'engagements'>,
  input: {
    id: string
    date: string
    startMinute: number
    endMinute: number
    description: string
    engagementId: string | null
    activityId: string | null
    source: string
    userSubmissionText?: string
    warningFlags?: WarningType[]
    modelUsed?: OpenAiModelId | null
    modelUsedLabel?: string | null
  },
): TimelineEntry {
  const engagement = input.engagementId ? findEngagement(state, input.engagementId) : null
  const activity = input.activityId ? findActivity(state, input.activityId) : null
  const timestamp = currentUnixTimestamp()

  return {
    id: input.id,
    date: input.date,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    durationMinutes: input.endMinute - input.startMinute,
    description: input.description,
    userSubmissionText: input.userSubmissionText ?? 'Manual Entry',
    source: input.source,
    confidence: input.warningFlags?.includes('low_confidence') ? 0.6 : 1,
    engagementId: input.engagementId,
    activityId: input.activityId,
    engagementCode: engagement?.code ?? null,
    engagementName: engagement?.name ?? null,
    engagementType: engagement?.engagementType ?? null,
    activityCode: activity?.code ?? null,
    activityName: activity?.name ?? null,
    usedActivityFallback: false,
    usedTemporalFallback: false,
    durationDefaulted: false,
    fallbackSummary: null,
    sourceMessageEntryIndex: null,
    sourceMessageEntryCount: null,
    modelUsed: input.modelUsed ?? null,
    modelUsedLabel: input.modelUsedLabel ?? null,
    transcriptionModelUsed: null,
    transcriptionModelUsedLabel: null,
    warningFlags: input.warningFlags ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function listEntriesForDate(state: MockState, date: string): TimelineEntry[] {
  return clone(
    state.entries
      .filter((entry) => entry.date === date)
      .sort((left, right) => left.startMinute - right.startMinute),
  )
}

function monthSummary(state: MockState, input: TimelineMonthSummaryInput): TimelineDaySummary[] {
  const prefix = `${input.month}-`
  const byDate = new Map<string, TimelineDaySummary>()

  for (const entry of state.entries) {
    if (!entry.date.startsWith(prefix)) {
      continue
    }

    const existing = byDate.get(entry.date) ?? {
      date: entry.date,
      entryCount: 0,
      totalMinutes: 0,
    }
    existing.entryCount += 1
    existing.totalMinutes += entry.durationMinutes
    byDate.set(entry.date, existing)
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function weekView(state: MockState, date: string): TimelineWeekView {
  const weekStart = weekStartFor(date, 0)
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: formatDate(shiftDate(weekStart, index)),
  }))
  const daySet = new Set(days.map((day) => day.date))

  return {
    weekStartDate: days[0].date,
    weekEndDate: days[6].date,
    days,
    entries: clone(
      state.entries
        .filter((entry) => daySet.has(entry.date))
        .sort((left, right) => left.date.localeCompare(right.date) || left.startMinute - right.startMinute),
    ),
  }
}

function weeklySummary(state: MockState, date: string): TimelineWeeklySummary {
  const weekStart = weekStartFor(date, 6)
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: formatDate(shiftDate(weekStart, index)),
  }))
  const dayIndexByDate = new Map(days.map((day, index) => [day.date, index]))
  const rowsByKey = new Map<string, TimelineWeeklySummaryRow>()
  const emptyCells = (): TimelineWeeklySummaryCell[] =>
    Array.from({ length: 7 }, () => ({ totalMinutes: 0, notes: [] }))

  for (const entry of state.entries) {
    const dayIndex = dayIndexByDate.get(entry.date)
    if (dayIndex === undefined) {
      continue
    }

    const key = `${entry.engagementId ?? 'uncategorized'}:${entry.activityId ?? 'uncategorized'}`
    let row = rowsByKey.get(key)
    if (!row) {
      row = {
        engagementId: entry.engagementId,
        activityId: entry.activityId,
        engagementCode: entry.engagementCode,
        activityCode: entry.activityCode,
        activityName: entry.activityName ?? 'Uncategorized',
        engagementName: entry.engagementName ?? 'Uncategorized',
        clientName: entry.engagementId ? findEngagement(state, entry.engagementId)?.client ?? '-' : '-',
        engagementType: entry.engagementType,
        isUncategorized: !entry.engagementId || !entry.activityId,
        cells: emptyCells(),
        rowTotalMinutes: 0,
      }
      rowsByKey.set(key, row)
    }

    row.cells[dayIndex].totalMinutes += entry.durationMinutes
    row.cells[dayIndex].notes.push({
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
      durationMinutes: entry.durationMinutes,
      description: entry.description,
    })
    row.rowTotalMinutes += entry.durationMinutes
  }

  const rows = [...rowsByKey.values()].sort((left, right) =>
    `${left.engagementCode ?? ''} ${left.activityCode ?? ''}`.localeCompare(
      `${right.engagementCode ?? ''} ${right.activityCode ?? ''}`,
    ),
  )
  const dayTotalBreakdowns = Array.from({ length: 7 }, (_, dayIndex) => {
    const breakdown = emptyBreakdown()
    for (const row of rows) {
      addBreakdownMinutes(breakdown, row, row.cells[dayIndex].totalMinutes)
    }
    return finalizeBreakdown(breakdown)
  })
  const weekTotalBreakdown = finalizeBreakdown(
    dayTotalBreakdowns.reduce(
      (total, breakdown) => ({
        primaryMinutes: 0,
        externalMinutes: total.externalMinutes + breakdown.externalMinutes,
        internalMinutes: total.internalMinutes + breakdown.internalMinutes,
        uncategorizedMinutes: total.uncategorizedMinutes + breakdown.uncategorizedMinutes,
      }),
      emptyBreakdown(),
    ),
  )

  return {
    weekStartDate: days[0].date,
    weekEndDate: days[6].date,
    days,
    rows,
    dayTotalMinutes: dayTotalBreakdowns.map((breakdown) => breakdown.primaryMinutes),
    weekTotalMinutes: weekTotalBreakdown.primaryMinutes,
    dayTotalBreakdowns,
    weekTotalBreakdown,
  }
}

function historyList(state: MockState, date: string): HistoryListResult {
  const weekStart = weekStartFor(date, 6)
  const days = Array.from({ length: 7 }, (_, index) => formatDate(shiftDate(weekStart, index)))
  const daySet = new Set(days)

  return {
    weekStartDate: days[0],
    weekEndDate: days[6],
    submissions: clone(state.submissions),
    entries: clone(
      state.entries
        .filter((entry) => daySet.has(entry.date))
        .sort((left, right) => right.createdAt - left.createdAt),
    ),
  }
}

function quickAddSuggestions(
  state: MockState,
  input: QuickAddSuggestionInput = {},
): QuickAddSuggestionResult {
  const limit = Math.max(1, Math.min(100, input.limit ?? 12))
  const suggestionByKey = new Map<string, QuickAddSuggestion>()

  for (const engagement of state.engagements) {
    if (!engagement.isActive) {
      continue
    }

    for (const activity of engagement.activities) {
      if (!activity.isActive) {
        continue
      }

      suggestionByKey.set(`${engagement.id}:${activity.id}`, {
        engagementId: engagement.id,
        activityId: activity.id,
        usageCount: 0,
        lastUsedAt: null,
      })
    }
  }

  for (const entry of state.entries) {
    if (!entry.engagementId || !entry.activityId) {
      continue
    }

    const key = `${entry.engagementId}:${entry.activityId}`
    const suggestion = suggestionByKey.get(key)
    if (!suggestion) {
      continue
    }

    suggestion.usageCount += 1
    suggestion.lastUsedAt = Math.max(suggestion.lastUsedAt ?? 0, entry.createdAt)
  }

  const suggestions = [...suggestionByKey.values()].sort((left, right) => {
    if (left.usageCount !== right.usageCount) {
      return right.usageCount - left.usageCount
    }

    if ((left.lastUsedAt ?? 0) !== (right.lastUsedAt ?? 0)) {
      return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
    }

    const leftEngagement = findEngagement(state, left.engagementId)
    const rightEngagement = findEngagement(state, right.engagementId)
    const leftActivity = findActivity(state, left.activityId)
    const rightActivity = findActivity(state, right.activityId)
    return `${leftEngagement?.name ?? ''} ${leftEngagement?.code ?? ''} ${leftActivity?.name ?? ''} ${leftActivity?.code ?? ''}`
      .localeCompare(
        `${rightEngagement?.name ?? ''} ${rightEngagement?.code ?? ''} ${rightActivity?.name ?? ''} ${rightActivity?.code ?? ''}`,
      )
  })

  return { suggestions: clone(suggestions.slice(0, limit)) }
}

function upsertEngagement(state: MockState, input: EngagementUpsertInput): IdResult {
  const timestamp = currentUnixTimestamp()
  const id = input.id ?? nextMockId(state, 'eng')
  const existing = findEngagement(state, id)
  const next: Engagement = {
    id,
    code: input.code?.trim() || null,
    name: input.name.trim(),
    client: input.client?.trim() || null,
    engagementType: input.engagementType ?? inferEngagementType(input.code),
    colorHex: input.colorHex?.trim() || null,
    tags: input.tags,
    describeWhenToUse: input.describeWhenToUse.trim(),
    isActive: input.isActive ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    activities: existing?.activities ?? [],
  }

  state.engagements = existing
    ? state.engagements.map((engagement) => (engagement.id === id ? next : engagement))
    : [...state.engagements, next]
  refreshEntryMetadata(state)
  return { id }
}

function upsertActivity(state: MockState, input: ActivityUpsertInput): IdResult {
  const timestamp = currentUnixTimestamp()
  const engagement = findEngagement(state, input.engagementId)
  if (!engagement) {
    throw new Error('activity engagement not found')
  }

  const id = input.id ?? nextMockId(state, 'act')
  const existing = engagement.activities.find((activity) => activity.id === id)
  const next: Activity = {
    id,
    engagementId: input.engagementId,
    code: input.code?.trim() || null,
    name: input.name.trim(),
    colorHex: input.colorHex?.trim() || null,
    tags: input.tags,
    describeWhenToUse: input.describeWhenToUse.trim(),
    isActive: input.isActive ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }

  engagement.activities = existing
    ? engagement.activities.map((activity) => (activity.id === id ? next : activity))
    : [...engagement.activities, next]
  refreshEntryMetadata(state)
  return { id }
}

function deleteEngagement(state: MockState, id: string): void {
  state.engagements = state.engagements.filter((engagement) => engagement.id !== id)
  for (const entry of state.entries) {
    if (entry.engagementId === id) {
      entry.engagementId = null
      entry.activityId = null
      entry.warningFlags = uniqueWarnings([...entry.warningFlags, 'unmatched'])
    }
  }
  refreshEntryMetadata(state)
}

function deleteActivity(state: MockState, id: string): void {
  for (const engagement of state.engagements) {
    engagement.activities = engagement.activities.filter((activity) => activity.id !== id)
  }
  for (const entry of state.entries) {
    if (entry.activityId === id) {
      entry.activityId = null
      entry.warningFlags = uniqueWarnings([...entry.warningFlags, 'unmatched'])
    }
  }
  refreshEntryMetadata(state)
}

function updateEntry(state: MockState, input: TimelineUpdateInput): void {
  const entry = state.entries.find((candidate) => candidate.id === input.id)
  if (!entry) {
    throw new Error('timeline entry not found')
  }

  entry.date = input.date
  entry.startMinute = input.startMinute
  entry.endMinute = input.endMinute
  entry.durationMinutes = input.endMinute - input.startMinute
  entry.description = input.description.trim()
  entry.engagementId = input.engagementId
  entry.activityId = input.activityId
  entry.warningFlags = !input.engagementId || !input.activityId ? ['unmatched'] : []
  entry.updatedAt = currentUnixTimestamp()
  refreshEntryMetadata(state)
}

function createEntry(state: MockState, input: TimelineCreateInput): IdResult {
  const id = nextMockId(state, 'entry')
  state.entries.push(
    makeEntry(state, {
      id,
      date: input.date,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      description: input.description?.trim() || '',
      engagementId: input.engagementId ?? null,
      activityId: input.activityId ?? null,
      source: 'manual',
      warningFlags: !input.engagementId || !input.activityId ? ['unmatched'] : [],
    }),
  )
  return { id }
}

function deleteEntry(state: MockState, id: string): void {
  state.entries = state.entries.filter((entry) => entry.id !== id)
}

function calendarExtract(state: MockState, input: CalendarExtractInput): CalendarExtractResult {
  const selectedDate = normalizeDate(input.selectedDate) ?? normalizeDate(input.clientLocalDate) ?? formatDate(new Date())
  const candidates: CalendarExtractCandidate[] = [
    {
      id: 'agent-qa-calendar-candidate-control',
      date: selectedDate,
      startMinute: 11 * 60 + 30,
      endMinute: 12 * 60,
      durationMinutes: 30,
      timeEvidence: '11:30 AM - 12:00 PM',
      description: 'QA extracted calendar event - control sync',
      extractedText: 'Control sync with Orange',
      sourceText: 'Control sync with Orange, 11:30 AM - 12:00 PM',
      confidence: 0.96,
      engagementId: ORANGE_ENGAGEMENT_ID,
      activityId: WALKTHROUGH_ACTIVITY_ID,
      engagementCode: 'A100',
      engagementName: 'Orange ITGC',
      engagementType: 'external',
      activityCode: 'WALK',
      activityName: 'Walkthrough',
      warningFlags: [],
      isAllDay: false,
      isIgnored: false,
      ignoredReason: null,
      needsDateConfirmation: false,
      needsTimeConfirmation: false,
    },
  ]
  state.diagnostics.unshift(diagnostic(nextMockId(state, 'diag'), 'backend', 'command_success', 'calendar_extract_events', 'ok', {
    agentQa: true,
    candidateCount: candidates.length,
  }))
  return {
    correlationId: nextMockId(state, 'cid'),
    candidates,
    ignoredCandidateCount: input.ignoreAllDayEvents ? 1 : 0,
    modelUsed: state.settings.selectedCalendarBulkModel,
    modelUsedLabel: modelLabel(state.settings.selectedCalendarBulkModel),
    llmDurationMs: 15,
  }
}

function calendarImport(state: MockState, input: CalendarImportInput): CalendarImportResult {
  const rawMessageId = nextMockId(state, 'calendar-message')
  const createdEntryIds = input.entries.map((entry, index) => {
    const id = nextMockId(state, 'calendar-entry')
    state.entries.push(
      makeEntry(state, {
        id,
        date: entry.date,
        startMinute: entry.startMinute,
        endMinute: entry.endMinute,
        description: entry.description,
        engagementId: entry.engagementId,
        activityId: entry.activityId,
        source: 'calendar',
        userSubmissionText: entry.extractedText,
        warningFlags: entry.confidence < 0.75 ? ['low_confidence'] : [],
        modelUsed: state.settings.selectedCalendarBulkModel,
        modelUsedLabel: modelLabel(state.settings.selectedCalendarBulkModel),
      }),
    )
    return index >= 0 ? id : id
  })
  const warnings = createdEntryIds.flatMap((entryId): Warning[] => {
    const entry = state.entries.find((candidate) => candidate.id === entryId)
    return (entry?.warningFlags ?? []).map((warningType) => ({
      warningType,
      entryId,
      detail: 'Agent QA mock calendar import warning.',
    }))
  })
  state.submissions.unshift({
    id: rawMessageId,
    rawText: `Calendar bulk import (${createdEntryIds.length} events)`,
    captureSource: 'calendar',
    status: 'processed',
    messageTimestamp: currentUnixTimestamp(),
    createdAt: currentUnixTimestamp(),
    interpretedEntryCount: createdEntryIds.length,
    uniqueEntryCount: createdEntryIds.length,
    savedEntryCount: createdEntryIds.length,
    truncatedEntryCount: 0,
    containsMultipleEvents: createdEntryIds.length > 1,
    confidence: 0.96,
    modelUsed: state.settings.selectedCalendarBulkModel,
    modelUsedLabel: modelLabel(state.settings.selectedCalendarBulkModel),
    transcriptionModelUsed: null,
    transcriptionModelUsedLabel: null,
  })
  return {
    correlationId: nextMockId(state, 'cid'),
    rawMessageId,
    createdEntryIds,
    touchedMonthKeys: uniqueStrings(input.entries.map((entry) => entry.date.slice(0, 7))),
    warnings,
  }
}

function transcribeAudio(input: TranscribeAudioInput): TranscribeAudioResult {
  return {
    transcriptText: 'QA voice note: 30 minutes testing Orange ITGC controls.',
    transcriptionModelUsed: 'gpt-4o-mini-transcribe',
    transcriptionModelUsedLabel: 'GPT-4o Mini Transcribe',
    transcriptionDurationMs: 12,
    audioDurationMs: Math.max(1, input.durationMs),
  }
}

function interpretText(state: MockState, input: InterpretTextInput): InterpretResult {
  const rawMessageId = nextMockId(state, 'message')
  const entryId = nextMockId(state, 'entry')
  const date = normalizeDate(input.clientLocalDate) ?? formatDate(new Date())
  state.entries.push(
    makeEntry(state, {
      id: entryId,
      date,
      startMinute: 16 * 60,
      endMinute: 16 * 60 + 30,
      description: `QA interpreted: ${input.rawText.trim()}`,
      engagementId: ORANGE_ENGAGEMENT_ID,
      activityId: CONTROL_TESTING_ACTIVITY_ID,
      source: input.captureSource ?? 'text',
      userSubmissionText: input.rawText.trim(),
      modelUsed: input.openAiModel ?? state.settings.selectedOpenAiModel,
      modelUsedLabel: modelLabel(input.openAiModel ?? state.settings.selectedOpenAiModel),
    }),
  )
  state.submissions.unshift({
    id: rawMessageId,
    rawText: input.rawText.trim(),
    captureSource: input.captureSource ?? 'text',
    status: 'processed',
    messageTimestamp: currentUnixTimestamp(),
    createdAt: currentUnixTimestamp(),
    interpretedEntryCount: 1,
    uniqueEntryCount: 1,
    savedEntryCount: 1,
    truncatedEntryCount: 0,
    containsMultipleEvents: false,
    confidence: 0.97,
    modelUsed: input.openAiModel ?? state.settings.selectedOpenAiModel,
    modelUsedLabel: modelLabel(input.openAiModel ?? state.settings.selectedOpenAiModel),
    transcriptionModelUsed: input.transcriptionModel ?? null,
    transcriptionModelUsedLabel: input.transcriptionModel ? transcriptionModelLabel(input.transcriptionModel) : null,
  })
  return {
    correlationId: nextMockId(state, 'cid'),
    rawMessageId,
    createdEntryIds: [entryId],
    interpretedEntryCount: 1,
    uniqueEntryCount: 1,
    savedEntryCount: 1,
    truncatedEntryCount: 0,
    containsMultipleEvents: false,
    touchedMonthKeys: [date.slice(0, 7)],
    warnings: [],
    normalizationNotes: ['Agent QA mock interpretation used deterministic fixture.'],
    modelUsed: input.openAiModel ?? state.settings.selectedOpenAiModel,
    modelUsedLabel: modelLabel(input.openAiModel ?? state.settings.selectedOpenAiModel),
    llmDurationMs: 10,
  }
}

function diagnosticsList(state: MockState, input: DiagnosticsListInput): DiagnosticsEvent[] {
  const filter = input.filter ?? 'all'
  let events = state.diagnostics
  if (filter === 'errors') {
    events = events.filter((event) => event.status === 'error')
  } else if (filter === 'warnings') {
    events = events.filter((event) => event.status === 'warning')
  } else if (filter === 'capture') {
    events = events.filter((event) =>
      event.command === 'interpret_text_message'
      || event.command === 'transcribe_audio_clip'
      || event.command === 'calendar_extract_events',
    )
  } else if (filter === 'settings') {
    events = events.filter((event) => event.command?.startsWith('settings_'))
  }

  return clone(events.slice(0, input.limit ?? 100))
}

function recordFrontendDiagnostic(state: MockState, input: DiagnosticsRecordInput): void {
  state.diagnostics.unshift({
    id: nextMockId(state, 'diag'),
    timestamp: currentUnixTimestamp(),
    sessionId: 'agent-qa-browser-session',
    correlationId: input.correlationId,
    layer: input.layer || 'frontend',
    eventType: input.eventType || 'event',
    command: input.command ?? null,
    status: input.status || 'ok',
    durationMs: input.durationMs ?? null,
    messageText: input.messageText ?? null,
    detailsJson: input.detailsJson ?? '{}',
  })
}

function diagnosticsBundleText(state: MockState): string {
  return [
    '# OmniSheet Diagnostics Bundle',
    `generatedAt: ${new Date().toISOString()}`,
    'sessionId: agent-qa-browser-session',
    'agentQa: true',
    '',
    ...state.diagnostics.slice(0, 20).map((event) =>
      `- ts=${event.timestamp} layer=${event.layer} type=${event.eventType} status=${event.status} cmd=${event.command ?? '-'}`,
    ),
  ].join('\n')
}

function summaryExport(input: SummaryExportWeeklyExcelInput): SummaryExportResult {
  return {
    filePath: `C:\\OmniSheetAgentQA\\OmniSheet_Weekly_Summary_${input.date}.xlsx`,
    fileName: `OmniSheet_Weekly_Summary_${input.date}.xlsx`,
    autoOpenAttempted: false,
    autoOpenSucceeded: false,
    autoOpenError: null,
  }
}

function applyTimelinePreferences(state: MockState, input: SettingsTimelinePreferencesInput): void {
  state.settings.timelineExcludeUncategorizedFromDailyTotals = input.timelineExcludeUncategorizedFromDailyTotals
  state.settings.timelineShowUncategorizedDailyTotal = input.timelineShowUncategorizedDailyTotal
  state.settings.timelineIncludeExternalInTotals = input.timelineIncludeExternalInTotals
  state.settings.timelineIncludeInternalInTotals = input.timelineIncludeInternalInTotals
  state.settings.timelineSeparateEngagementTypeTotals = input.timelineSeparateEngagementTypeTotals
}

function applyCalendarPreferences(state: MockState, input: SettingsCalendarBulkPreferencesInput): void {
  state.settings.calendarBulkIgnoredKeywords = input.calendarBulkIgnoredKeywords
  state.settings.calendarBulkIgnoreAllDayEvents = input.calendarBulkIgnoreAllDayEvents
}

function refreshEntryMetadata(state: MockState): void {
  state.entries = state.entries.map((entry) => {
    const engagement = entry.engagementId ? findEngagement(state, entry.engagementId) : null
    const activity = entry.activityId ? findActivity(state, entry.activityId) : null
    return {
      ...entry,
      engagementCode: engagement?.code ?? null,
      engagementName: engagement?.name ?? null,
      engagementType: engagement?.engagementType ?? null,
      activityCode: activity?.code ?? null,
      activityName: activity?.name ?? null,
    }
  })
}

function findEngagement(state: Pick<MockState, 'engagements'>, id: string): Engagement | null {
  return state.engagements.find((engagement) => engagement.id === id) ?? null
}

function findActivity(state: Pick<MockState, 'engagements'>, id: string): Activity | null {
  for (const engagement of state.engagements) {
    const activity = engagement.activities.find((candidate) => candidate.id === id)
    if (activity) {
      return activity
    }
  }

  return null
}

function inferEngagementType(code: string | null | undefined): EngagementType {
  const first = code?.trim().charAt(0).toUpperCase()
  return first === 'I' || first === 'A' ? 'internal' : 'external'
}

function emptyBreakdown(): TimelineTotalBreakdown {
  return {
    primaryMinutes: 0,
    externalMinutes: 0,
    internalMinutes: 0,
    uncategorizedMinutes: 0,
  }
}

function addBreakdownMinutes(
  breakdown: TimelineTotalBreakdown,
  row: TimelineWeeklySummaryRow,
  minutes: number,
): void {
  if (minutes <= 0) {
    return
  }

  if (row.isUncategorized) {
    breakdown.uncategorizedMinutes += minutes
  } else if (row.engagementType === 'internal') {
    breakdown.internalMinutes += minutes
  } else {
    breakdown.externalMinutes += minutes
  }
}

function finalizeBreakdown(breakdown: TimelineTotalBreakdown): TimelineTotalBreakdown {
  return {
    ...breakdown,
    primaryMinutes: breakdown.externalMinutes + breakdown.internalMinutes + breakdown.uncategorizedMinutes,
  }
}

function diagnostic(
  correlationId: string,
  layer: string,
  eventType: string,
  command: string | null,
  status: string,
  details: Record<string, unknown>,
): DiagnosticsEvent {
  return {
    id: `diag-${correlationId}`,
    timestamp: currentUnixTimestamp(),
    sessionId: 'agent-qa-browser-session',
    correlationId,
    layer,
    eventType,
    command,
    status,
    durationMs: 1,
    messageText: null,
    detailsJson: JSON.stringify(details),
  }
}

function modelLabel(model: OpenAiModelId): string {
  switch (model) {
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.4-mini':
      return 'GPT-5.4 Mini'
    case 'gpt-4.1-nano':
      return 'GPT-4.1 Nano'
    case 'gpt-5-nano':
    default:
      return 'GPT-5 Nano'
  }
}

function transcriptionModelLabel(model: TranscriptionModelId): string {
  return model === 'whisper-1' ? 'Whisper' : 'GPT-4o Mini Transcribe'
}

function nextMockId(state: MockState, prefix: string): string {
  const id = `${prefix}-${state.nextId}`
  state.nextId += 1
  return id
}

function currentUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function weekStartFor(date: string, startDay: number): string {
  const value = parseDate(date)
  const dayDelta = (value.getDay() - startDay + 7) % 7
  return formatDate(shiftDate(formatDate(value), -dayDelta))
}

function normalizeDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return null
  }

  return formatDate(parseDate(value))
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function shiftDate(value: string, dayDelta: number): Date {
  const date = parseDate(value)
  date.setDate(date.getDate() + dayDelta)
  return date
}

function formatDate(value: Date): string {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function uniqueWarnings(values: WarningType[]): WarningType[] {
  return [...new Set(values)]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
