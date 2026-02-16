import { invoke } from '@tauri-apps/api/core'

import { isTauriRuntime } from './runtime'
import type {
  ActivityUpsertInput,
  DateInput,
  Engagement,
  EngagementUpsertInput,
  IdResult,
  InterpretResult,
  InterpretTextInput,
  SettingsStatus,
  TimelineEntry,
  TimelineUpdateInput,
} from './types'

async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Tauri runtime is required. Use `npm run tauri dev`.')
  }

  return invoke<T>(command, args)
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

export function interpretTextMessage(
  input: InterpretTextInput,
): Promise<InterpretResult> {
  return invokeCommand<InterpretResult>('interpret_text_message', { input })
}

export function timelineListForDate(input: DateInput): Promise<TimelineEntry[]> {
  return invokeCommand<TimelineEntry[]>('timeline_list_for_date', { input })
}

export function timelineUpdateEntry(input: TimelineUpdateInput): Promise<void> {
  return invokeCommand<void>('timeline_update_entry', { input })
}
