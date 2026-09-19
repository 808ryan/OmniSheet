import { invoke } from '@tauri-apps/api/core'

import { isTauriRuntime } from './runtime'
import type {
  ActiveTimer,
  ActivityUpsertInput,
  AppCommandErrorShape,
  CalendarExtractInput,
  CalendarExtractResult,
  CalendarImportInput,
  CalendarImportResult,
  DateInput,
  DiagnosticsBundle,
  DiagnosticsEvent,
  DiagnosticsListInput,
  DiagnosticsRecordInput,
  Engagement,
  EngagementUpsertInput,
  IdResult,
  InterpretResult,
  InterpretTextInput,
  MicrophonePermissionResult,
  OpenAiModelId,
  QuickAddSuggestionInput,
  QuickAddSuggestionResult,
  ReportingState,
  SettingsStatus,
  SettingsCalendarBulkPreferencesInput,
  SettingsInterfacePreferencesInput,
  SettingsQuickAddPreferencesInput,
  SettingsTimelinePreferencesInput,
  SummaryExportResult,
  SummaryExportWeeklyExcelInput,
  SummaryLayoutState,
  TranscribeAudioInput,
  TranscribeAudioResult,
  TranscriptionModelId,
  TimelineDaySummary,
  TimelineCreateInput,
  TimelineEntry,
  TimelineWeekView,
  TimelineWeeklySummary,
  TimelineMonthSummaryInput,
  TimelineUpdateInput,
  TimerStartFromEntryInput,
  TimerStartFromEntryResult,
  TimerStartInput,
  TimerStopInput,
  TimerStopResult,
  TimerUpdateInput,
} from './types'

export class AppCommandError extends Error implements AppCommandErrorShape {
  code: string
  command: string
  correlationId: string

  constructor({
    code,
    command,
    correlationId,
    message,
  }: AppCommandErrorShape) {
    super(message)
    this.name = 'AppCommandError'
    this.code = code
    this.command = command
    this.correlationId = correlationId
  }
}

export function isAppCommandError(value: unknown): value is AppCommandError {
  return value instanceof AppCommandError
}

interface InvokeCommandOptions {
  messageText?: string
}

const SLOW_FRONTEND_COMMAND_THRESHOLD_MS = 1000
const ALWAYS_LOG_FRONTEND_SUCCESS_COMMANDS = new Set([
  'interpret_text_message',
  'transcribe_audio_clip',
  'calendar_extract_events',
  'calendar_import_entries',
  'summary_export_weekly_excel',
  'diagnostics_copy_bundle',
])

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }

  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}

async function recordFrontendDiagnostic(input: DiagnosticsRecordInput): Promise<void> {
  if (!isTauriRuntime()) {
    return
  }

  try {
    await invoke('diagnostics_record_frontend_event', { input })
  } catch {
    // Diagnostics logging should never block UX.
  }
}

export function diagnosticsRecordFrontendEvent(input: DiagnosticsRecordInput): Promise<void> {
  return recordFrontendDiagnostic(input)
}

function shouldLogFrontendCommandSuccess(command: string, durationMs: number): boolean {
  return (
    durationMs >= SLOW_FRONTEND_COMMAND_THRESHOLD_MS
    || ALWAYS_LOG_FRONTEND_SUCCESS_COMMANDS.has(command)
  )
}

function recordFrontendDiagnosticInBackground(input: DiagnosticsRecordInput): void {
  void recordFrontendDiagnostic(input)
}

async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: InvokeCommandOptions,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Tauri runtime is required. Use `npm run tauri dev`.')
  }

  const correlationId = generateCorrelationId()
  const startedAt = performance.now()

  try {
    const result = await invoke<T>(command, args)
    const durationMs = Math.round(performance.now() - startedAt)

    if (shouldLogFrontendCommandSuccess(command, durationMs)) {
      recordFrontendDiagnosticInBackground({
        correlationId,
        layer: 'frontend',
        eventType: 'command_success',
        command,
        status: 'ok',
        durationMs,
        messageText: options?.messageText,
        detailsJson: JSON.stringify({
          durationMs,
          slowThresholdMs: SLOW_FRONTEND_COMMAND_THRESHOLD_MS,
          alwaysLogged: ALWAYS_LOG_FRONTEND_SUCCESS_COMMANDS.has(command),
        }),
      })
    }

    return result
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt)
    const message = extractErrorMessage(error)

    await recordFrontendDiagnostic({
      correlationId,
      layer: 'frontend',
      eventType: 'command_error',
      command,
      status: 'error',
      durationMs,
      messageText: options?.messageText,
      detailsJson: JSON.stringify({ durationMs, message }),
    })

    throw new AppCommandError({
      code: 'COMMAND_FAILED',
      command,
      correlationId,
      message,
    })
  }
}

export function settingsGetStatus(): Promise<SettingsStatus> {
  return invokeCommand<SettingsStatus>('settings_get_status')
}

export function settingsSetOpenAiKey(apiKey: string): Promise<void> {
  return invokeCommand<void>('settings_set_openai_key', {
    input: { apiKey },
  })
}

export function settingsSetOpenAiModel(model: OpenAiModelId): Promise<void> {
  return invokeCommand<void>('settings_set_openai_model', {
    input: { model },
  })
}

export function settingsSetCalendarBulkModel(model: OpenAiModelId): Promise<void> {
  return invokeCommand<void>('settings_set_calendar_bulk_model', {
    input: { model },
  })
}

export function settingsSetTranscriptionModel(model: TranscriptionModelId): Promise<void> {
  return invokeCommand<void>('settings_set_transcription_model', {
    input: { model },
  })
}

export function settingsSetTimelinePreferences(
  input: SettingsTimelinePreferencesInput,
): Promise<void> {
  return invokeCommand<void>('settings_set_timeline_preferences', { input })
}

export function settingsSetCalendarBulkPreferences(
  input: SettingsCalendarBulkPreferencesInput,
): Promise<void> {
  return invokeCommand<void>('settings_set_calendar_bulk_preferences', { input })
}

export function settingsSetQuickAddPreferences(
  input: SettingsQuickAddPreferencesInput,
): Promise<void> {
  return invokeCommand<void>('settings_set_quick_add_preferences', { input })
}

export function settingsSetInterfacePreferences(
  input: SettingsInterfacePreferencesInput,
): Promise<void> {
  return invokeCommand<void>('settings_set_interface_preferences', { input })
}

export function summaryLayoutStateGet(): Promise<SummaryLayoutState> {
  return invokeCommand<SummaryLayoutState>('summary_layout_state_get')
}

export function summaryLayoutStateSet(input: SummaryLayoutState): Promise<SummaryLayoutState> {
  return invokeCommand<SummaryLayoutState>('summary_layout_state_set', { input })
}

export function reportingStateGet(): Promise<ReportingState> {
  return invokeCommand<ReportingState>('reporting_state_get')
}

export function reportingStateSet(input: ReportingState): Promise<ReportingState> {
  return invokeCommand<ReportingState>('reporting_state_set', { input })
}

export function engagementList(): Promise<Engagement[]> {
  return invokeCommand<Engagement[]>('engagement_list')
}

export function engagementUpsert(input: EngagementUpsertInput): Promise<IdResult> {
  return invokeCommand<IdResult>('engagement_upsert', { input })
}

export function engagementDelete(id: string): Promise<void> {
  return invokeCommand<void>('engagement_delete', {
    input: { id },
  })
}

export function activityUpsert(input: ActivityUpsertInput): Promise<IdResult> {
  return invokeCommand<IdResult>('activity_upsert', { input })
}

export function activityDelete(id: string): Promise<void> {
  return invokeCommand<void>('activity_delete', {
    input: { id },
  })
}

export function interpretTextMessage(input: InterpretTextInput): Promise<InterpretResult> {
  return invokeCommand<InterpretResult>('interpret_text_message', { input }, {
    messageText: input.rawText,
  })
}

export function transcribeAudioClip(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
  return invokeCommand<TranscribeAudioResult>('transcribe_audio_clip', { input })
}

export function voiceRequestMicrophonePermission(): Promise<MicrophonePermissionResult> {
  return invokeCommand<MicrophonePermissionResult>('voice_request_microphone_permission')
}

export function quickAddHideWindow(): Promise<void> {
  return invokeCommand<void>('quick_add_hide_window')
}

export function quickAddResizeWindow(height: number): Promise<void> {
  return invokeCommand<void>('quick_add_resize_window', { height })
}

export function quickAddShowMainWindow(): Promise<void> {
  return invokeCommand<void>('quick_add_show_main_window')
}

export function timelineListForDate(input: DateInput): Promise<TimelineEntry[]> {
  return invokeCommand<TimelineEntry[]>('timeline_list_for_date', { input })
}

export function timelineListForWeekView(input: DateInput): Promise<TimelineWeekView> {
  return invokeCommand<TimelineWeekView>('timeline_list_for_week_view', { input })
}

export function timelineMonthSummary(
  input: TimelineMonthSummaryInput,
): Promise<TimelineDaySummary[]> {
  return invokeCommand<TimelineDaySummary[]>('timeline_month_summary', { input })
}

export function timelineWeeklySummary(input: DateInput): Promise<TimelineWeeklySummary> {
  return invokeCommand<TimelineWeeklySummary>('timeline_weekly_summary', { input })
}

export function summaryExportWeeklyExcel(input: SummaryExportWeeklyExcelInput): Promise<SummaryExportResult> {
  return invokeCommand<SummaryExportResult>('summary_export_weekly_excel', { input })
}

export function timelineUpdateEntry(input: TimelineUpdateInput): Promise<void> {
  return invokeCommand<void>('timeline_update_entry', { input })
}

export function timelineCreateEntry(input: TimelineCreateInput): Promise<IdResult> {
  return invokeCommand<IdResult>('timeline_create_entry', { input })
}

export function timerGetActive(): Promise<ActiveTimer | null> {
  return invokeCommand<ActiveTimer | null>('timer_get_active')
}

export function timerStart(input: TimerStartInput): Promise<ActiveTimer> {
  return invokeCommand<ActiveTimer>('timer_start', { input })
}

export function timerStartFromEntry(
  input: TimerStartFromEntryInput,
): Promise<TimerStartFromEntryResult> {
  return invokeCommand<TimerStartFromEntryResult>('timer_start_from_entry', { input })
}

export function timerUpdateActive(input: TimerUpdateInput): Promise<ActiveTimer> {
  return invokeCommand<ActiveTimer>('timer_update_active', { input })
}

export function timerStop(input: TimerStopInput): Promise<TimerStopResult> {
  return invokeCommand<TimerStopResult>('timer_stop', { input })
}

export function timerCancel(): Promise<void> {
  return invokeCommand<void>('timer_cancel')
}

export function quickAddSuggestions(
  input: QuickAddSuggestionInput = {},
): Promise<QuickAddSuggestionResult> {
  return invokeCommand<QuickAddSuggestionResult>('quick_add_suggestions', { input })
}

export function timelineDeleteEntry(id: string): Promise<void> {
  return invokeCommand<void>('timeline_delete_entry', {
    input: { id },
  })
}

export function calendarExtractEvents(input: CalendarExtractInput): Promise<CalendarExtractResult> {
  return invokeCommand<CalendarExtractResult>('calendar_extract_events', { input })
}

export function calendarImportEntries(input: CalendarImportInput): Promise<CalendarImportResult> {
  return invokeCommand<CalendarImportResult>('calendar_import_entries', { input })
}

export function diagnosticsList(
  input: DiagnosticsListInput = {},
): Promise<DiagnosticsEvent[]> {
  return invokeCommand<DiagnosticsEvent[]>('diagnostics_list', { input })
}

export function diagnosticsCopyBundle(): Promise<DiagnosticsBundle> {
  return invokeCommand<DiagnosticsBundle>('diagnostics_copy_bundle')
}
