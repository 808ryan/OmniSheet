import type {
  ReportingDisplayPreset,
  ReportingState,
} from './types'

export const REPORTING_STATE_VERSION = 1
export const REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH = 40
export const DEFAULT_REPORTING_DISPLAY_PRESET_ID = 'reporting-display-compact-review'

export function buildDefaultReportingDisplayPreset(): ReportingDisplayPreset {
  return {
    id: DEFAULT_REPORTING_DISPLAY_PRESET_ID,
    name: 'Compact Review',
    density: 'compact',
    rowLabelMode: 'combined',
    showCodes: true,
    showClient: false,
    showEngagementType: false,
    showEmptyDays: true,
  }
}

export function buildDefaultReportingState(): ReportingState {
  return {
    version: REPORTING_STATE_VERSION,
    selectedViewMode: 'table',
    selectedDisplayPresetId: DEFAULT_REPORTING_DISPLAY_PRESET_ID,
    selectedExportPresetId: null,
    displayPresets: [buildDefaultReportingDisplayPreset()],
  }
}

export function cloneReportingDisplayPreset(
  preset: ReportingDisplayPreset,
  overrides?: Partial<ReportingDisplayPreset>,
): ReportingDisplayPreset {
  return {
    ...preset,
    ...overrides,
  }
}

export function generateReportingId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function buildNextReportingPresetName(
  baseName: string,
  presets: ReportingDisplayPreset[],
): string {
  const trimmedBaseName = baseName.trim() || 'New Display Preset'
  const existingNames = new Set(presets.map((preset) => preset.name.trim().toLowerCase()))

  if (!existingNames.has(trimmedBaseName.toLowerCase())) {
    return trimmedBaseName
  }

  let suffix = 2
  while (existingNames.has(`${trimmedBaseName} ${suffix}`.toLowerCase())) {
    suffix += 1
  }

  return `${trimmedBaseName} ${suffix}`
}
