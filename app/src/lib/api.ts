import { invoke } from '@tauri-apps/api/core'

import { isTauriRuntime } from './runtime'
import type {
  ActivityUpsertInput,
  AppCommandErrorShape,
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
  RepairSuspiciousEntriesInput,
  RepairSuspiciousEntriesResult,
  SettingsStatus,
  TimelineDaySummary,
  TimelineEntry,
  TimelineMonthSummaryInput,
  TimelineUpdateInput,
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

  await recordFrontendDiagnostic({
    correlationId,
    layer: 'frontend',
    eventType: 'command_start',
    command,
    status: 'ok',
    messageText: options?.messageText,
    detailsJson: JSON.stringify({ args: args ? Object.keys(args) : [] }),
  })

  try {
    const result = await invoke<T>(command, args)
    const durationMs = Math.round(performance.now() - startedAt)

    await recordFrontendDiagnostic({
      correlationId,
      layer: 'frontend',
      eventType: 'command_success',
      command,
      status: 'ok',
      durationMs,
      messageText: options?.messageText,
      detailsJson: JSON.stringify({ durationMs }),
    })

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

export function timelineListForDate(input: DateInput): Promise<TimelineEntry[]> {
  return invokeCommand<TimelineEntry[]>('timeline_list_for_date', { input })
}

export function timelineMonthSummary(
  input: TimelineMonthSummaryInput,
): Promise<TimelineDaySummary[]> {
  return invokeCommand<TimelineDaySummary[]>('timeline_month_summary', { input })
}

export function timelineUpdateEntry(input: TimelineUpdateInput): Promise<void> {
  return invokeCommand<void>('timeline_update_entry', { input })
}

export function diagnosticsList(
  input: DiagnosticsListInput = {},
): Promise<DiagnosticsEvent[]> {
  return invokeCommand<DiagnosticsEvent[]>('diagnostics_list', { input })
}

export function diagnosticsCopyBundle(): Promise<DiagnosticsBundle> {
  return invokeCommand<DiagnosticsBundle>('diagnostics_copy_bundle')
}

export function maintenanceRepairSuspiciousEntries(
  input: RepairSuspiciousEntriesInput = {},
): Promise<RepairSuspiciousEntriesResult> {
  return invokeCommand<RepairSuspiciousEntriesResult>(
    'maintenance_repair_suspicious_entries',
    { input },
  )
}
