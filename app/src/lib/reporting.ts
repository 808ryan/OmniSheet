import type {
  ReportingDisplayColumn,
  ReportingDisplayFieldKey,
  ReportingDisplayPreset,
  ReportingState,
} from './types'

export const REPORTING_STATE_VERSION = 1
export const REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH = 40
export const COMPACT_REPORTING_DISPLAY_PRESET_ID = 'reporting-display-compact'
export const ENGAGEMENT_ACTIVITY_REPORTING_DISPLAY_PRESET_ID = 'reporting-display-engagement-activity'
export const DEFAULT_REPORTING_DISPLAY_PRESET_ID = COMPACT_REPORTING_DISPLAY_PRESET_ID
export const DEFAULT_REPORTING_DISPLAY_DAY_GROUP_COLUMN_ID = 'reporting-days'
export const DEFAULT_REPORTING_DISPLAY_ROW_TOTAL_COLUMN_ID = 'reporting-row-total'

export interface ReportingDisplayFieldOption {
  key: ReportingDisplayFieldKey
  label: string
  group: 'core' | 'codes' | 'classification' | 'guidance'
  width: string
  wraps: boolean
}

export const REPORTING_DISPLAY_FIELD_OPTIONS: ReportingDisplayFieldOption[] = [
  {
    key: 'details',
    label: 'Activity + Engagement',
    group: 'core',
    width: '17rem',
    wraps: true,
  },
  {
    key: 'engagement',
    label: 'Engagement',
    group: 'core',
    width: '14rem',
    wraps: false,
  },
  {
    key: 'activity',
    label: 'Activity',
    group: 'core',
    width: '14rem',
    wraps: false,
  },
  {
    key: 'client',
    label: 'Client',
    group: 'core',
    width: '12rem',
    wraps: false,
  },
  {
    key: 'engagementCode',
    label: 'Engagement Code',
    group: 'codes',
    width: '9.5rem',
    wraps: false,
  },
  {
    key: 'activityCode',
    label: 'Activity Code',
    group: 'codes',
    width: '9.5rem',
    wraps: false,
  },
  {
    key: 'engagementType',
    label: 'Type',
    group: 'classification',
    width: '8rem',
    wraps: false,
  },
  {
    key: 'engagementTags',
    label: 'Engagement Tags',
    group: 'classification',
    width: '13rem',
    wraps: true,
  },
  {
    key: 'activityTags',
    label: 'Activity Tags',
    group: 'classification',
    width: '13rem',
    wraps: true,
  },
  {
    key: 'engagementUsage',
    label: 'Engagement Usage',
    group: 'guidance',
    width: '17rem',
    wraps: true,
  },
  {
    key: 'activityUsage',
    label: 'Activity Usage',
    group: 'guidance',
    width: '17rem',
    wraps: true,
  },
]

export function createReportingDisplayFieldColumn(
  fieldKey: ReportingDisplayFieldKey,
): ReportingDisplayColumn {
  return {
    kind: 'field',
    id: generateReportingId(`reporting-field-${fieldKey}`),
    fieldKey,
  }
}

export function createReportingDisplayDayGroupColumn(
  id = DEFAULT_REPORTING_DISPLAY_DAY_GROUP_COLUMN_ID,
): ReportingDisplayColumn {
  return {
    kind: 'dayGroup',
    id,
  }
}

export function createReportingDisplayRowTotalColumn(
  id = DEFAULT_REPORTING_DISPLAY_ROW_TOTAL_COLUMN_ID,
): ReportingDisplayColumn {
  return {
    kind: 'rowTotal',
    id,
  }
}

export function buildDefaultReportingDisplayColumns(): ReportingDisplayColumn[] {
  return [
    {
      kind: 'field',
      id: 'reporting-field-details',
      fieldKey: 'details',
    },
    createReportingDisplayDayGroupColumn(),
    createReportingDisplayRowTotalColumn(),
  ]
}

export function buildDefaultReportingDisplayPreset(): ReportingDisplayPreset {
  return {
    id: COMPACT_REPORTING_DISPLAY_PRESET_ID,
    name: 'Compact',
    density: 'comfortable',
    rowLabelMode: 'activityOnly',
    showCodes: false,
    showClient: false,
    showEngagementType: false,
    showEmptyDays: true,
    columns: buildDefaultReportingDisplayColumns(),
  }
}

export function buildEngagementActivityReportingDisplayPreset(): ReportingDisplayPreset {
  return {
    id: ENGAGEMENT_ACTIVITY_REPORTING_DISPLAY_PRESET_ID,
    name: 'Engagement + Activity',
    density: 'comfortable',
    rowLabelMode: 'combined',
    showCodes: true,
    showClient: false,
    showEngagementType: false,
    showEmptyDays: true,
    columns: [
      {
        kind: 'field',
        id: 'reporting-field-engagement',
        fieldKey: 'engagement',
      },
      {
        kind: 'field',
        id: 'reporting-field-activity',
        fieldKey: 'activity',
      },
      createReportingDisplayDayGroupColumn(),
      createReportingDisplayRowTotalColumn(),
    ],
  }
}

export function buildDefaultReportingState(): ReportingState {
  return {
    version: REPORTING_STATE_VERSION,
    selectedViewMode: 'table',
    selectedDisplayPresetId: DEFAULT_REPORTING_DISPLAY_PRESET_ID,
    selectedExportPresetId: 'preset-mercury',
    displayPresets: [
      buildDefaultReportingDisplayPreset(),
      buildEngagementActivityReportingDisplayPreset(),
    ],
  }
}

export function cloneReportingDisplayPreset(
  preset: ReportingDisplayPreset,
  overrides?: Partial<ReportingDisplayPreset>,
): ReportingDisplayPreset {
  return {
    ...preset,
    ...overrides,
    columns: (overrides?.columns ?? preset.columns ?? buildDefaultReportingDisplayColumns()).map((column) => ({
      ...column,
    })),
  }
}

export function getReportingDisplayFieldOption(
  key: ReportingDisplayFieldKey,
): ReportingDisplayFieldOption | undefined {
  return REPORTING_DISPLAY_FIELD_OPTIONS.find((option) => option.key === key)
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
