import type {
  SummaryLayoutColumn,
  SummaryLayoutFieldKey,
  SummaryLayoutPreset,
  SummaryLayoutState,
} from './types'

export interface SummaryLayoutFieldOption {
  key: SummaryLayoutFieldKey
  label: string
  description: string
  wraps: boolean
  width: string
}

export const SUMMARY_LAYOUT_STATE_VERSION = 3
export const SUMMARY_LAYOUT_MAX_NAME_LENGTH = 40
export const STANDARD_SUMMARY_LAYOUT_PRESET_ID = 'preset-standard'
export const MERCURY_SUMMARY_LAYOUT_PRESET_ID = 'preset-mercury'
export const DEFAULT_SUMMARY_LAYOUT_PRESET_ID = MERCURY_SUMMARY_LAYOUT_PRESET_ID
export const DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID = 'row-total'

export const SUMMARY_LAYOUT_FIELD_OPTIONS: SummaryLayoutFieldOption[] = [
  {
    key: 'engagementCode',
    label: 'Engagement Code',
    description: 'Shows the engagement code from the Codes tab.',
    wraps: false,
    width: '11rem',
  },
  {
    key: 'activityCode',
    label: 'Activity Code',
    description: 'Shows the activity code from the Codes tab.',
    wraps: false,
    width: '11rem',
  },
  {
    key: 'activityName',
    label: 'Activity Name',
    description: 'Shows the activity name linked to each summary row.',
    wraps: false,
    width: '14rem',
  },
  {
    key: 'engagementName',
    label: 'Engagement Name',
    description: 'Shows the engagement name linked to each summary row.',
    wraps: false,
    width: '14rem',
  },
  {
    key: 'clientName',
    label: 'Client Name',
    description: 'Shows the client name saved on the engagement.',
    wraps: false,
    width: '13rem',
  },
  {
    key: 'engagementTags',
    label: 'Engagement Tags',
    description: 'Shows the engagement tags from the Codes tab.',
    wraps: true,
    width: '15rem',
  },
  {
    key: 'engagementUsage',
    label: 'Engagement Usage',
    description: 'Shows the engagement usage guidance from the Codes tab.',
    wraps: true,
    width: '18rem',
  },
  {
    key: 'activityTags',
    label: 'Activity Tags',
    description: 'Shows the activity tags from the Codes tab.',
    wraps: true,
    width: '15rem',
  },
  {
    key: 'activityUsage',
    label: 'Activity Usage',
    description: 'Shows the activity usage guidance from the Codes tab.',
    wraps: true,
    width: '18rem',
  },
]

export function buildDefaultSummaryLayoutState(): SummaryLayoutState {
  return {
    version: SUMMARY_LAYOUT_STATE_VERSION,
    selectedPresetId: DEFAULT_SUMMARY_LAYOUT_PRESET_ID,
    presets: [
      {
        id: STANDARD_SUMMARY_LAYOUT_PRESET_ID,
        name: 'Standard',
        columns: [
          { kind: 'field', id: 'field-engagement-code', fieldKey: 'engagementCode' },
          { kind: 'field', id: 'field-activity-code', fieldKey: 'activityCode' },
          { kind: 'field', id: 'field-activity-name', fieldKey: 'activityName' },
          { kind: 'day', id: 'day-0', dayIndex: 0 },
          { kind: 'day', id: 'day-1', dayIndex: 1 },
          { kind: 'day', id: 'day-2', dayIndex: 2 },
          { kind: 'day', id: 'day-3', dayIndex: 3 },
          { kind: 'day', id: 'day-4', dayIndex: 4 },
          { kind: 'day', id: 'day-5', dayIndex: 5 },
          { kind: 'day', id: 'day-6', dayIndex: 6 },
          createSummaryLayoutRowTotalColumn(),
        ],
      },
      {
        id: MERCURY_SUMMARY_LAYOUT_PRESET_ID,
        name: 'Mercury',
        columns: [
          { kind: 'field', id: 'mercury-field-engagement-code', fieldKey: 'engagementCode' },
          { kind: 'field', id: 'mercury-field-activity-code', fieldKey: 'activityCode' },
          { kind: 'field', id: 'mercury-field-engagement-name', fieldKey: 'engagementName' },
          { kind: 'field', id: 'mercury-field-client-name', fieldKey: 'clientName' },
          {
            kind: 'freeText',
            id: 'mercury-free-text-role',
            label: 'Role',
            rowValues: {},
            repeat: false,
            repeatValue: '',
            repeatRowKey: null,
          },
          {
            kind: 'freeText',
            id: 'mercury-free-text-work-location',
            label: 'Work Location',
            rowValues: {},
            repeat: true,
            repeatValue: 'CA-NOLOCAL',
            repeatRowKey: null,
          },
          createSummaryLayoutRowTotalColumn(),
          { kind: 'day', id: 'mercury-day-0', dayIndex: 0 },
          { kind: 'day', id: 'mercury-day-1', dayIndex: 1 },
          { kind: 'day', id: 'mercury-day-2', dayIndex: 2 },
          { kind: 'day', id: 'mercury-day-3', dayIndex: 3 },
          { kind: 'day', id: 'mercury-day-4', dayIndex: 4 },
          { kind: 'day', id: 'mercury-day-5', dayIndex: 5 },
          { kind: 'day', id: 'mercury-day-6', dayIndex: 6 },
        ],
      },
    ],
  }
}

export function cloneSummaryLayoutColumn(column: SummaryLayoutColumn): SummaryLayoutColumn {
  if (column.kind === 'field') {
    return { ...column }
  }

  if (column.kind === 'day') {
    return { ...column }
  }

  if (column.kind === 'freeText') {
    return {
      ...column,
      rowValues: { ...(column.rowValues ?? {}) },
      repeat: column.repeat ?? false,
      repeatValue: column.repeatValue ?? '',
      repeatRowKey: column.repeatRowKey ?? null,
    }
  }

  return { ...column }
}

export function cloneSummaryLayoutPreset(
  preset: SummaryLayoutPreset,
  overrides?: Partial<SummaryLayoutPreset>,
): SummaryLayoutPreset {
  return {
    ...preset,
    ...overrides,
    columns: (overrides?.columns ?? preset.columns).map(cloneSummaryLayoutColumn),
  }
}

export function generateSummaryLayoutId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createSummaryLayoutFreeTextColumn(label = 'Free Text'): SummaryLayoutColumn {
  return {
    kind: 'freeText',
    id: generateSummaryLayoutId('free-text'),
    label,
    rowValues: {},
    repeat: false,
    repeatValue: '',
    repeatRowKey: null,
  }
}

export function createSummaryLayoutRowTotalColumn(
  id = DEFAULT_SUMMARY_LAYOUT_ROW_TOTAL_COLUMN_ID,
): SummaryLayoutColumn {
  return {
    kind: 'rowTotal',
    id,
  }
}

export function getSummaryLayoutFieldOption(
  key: SummaryLayoutFieldKey,
): SummaryLayoutFieldOption | undefined {
  return SUMMARY_LAYOUT_FIELD_OPTIONS.find((option) => option.key === key)
}
