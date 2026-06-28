import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { listen } from '@tauri-apps/api/event'

import {
  activityDelete,
  activityUpsert,
  calendarExtractEvents,
  calendarImportEntries,
  diagnosticsCopyBundle,
  diagnosticsRecordFrontendEvent,
  diagnosticsList,
  engagementDelete,
  engagementList,
  engagementUpsert,
  interpretTextMessage,
  isAppCommandError,
  quickAddSuggestions,
  reportingStateGet,
  reportingStateSet,
  settingsGetStatus,
  settingsSetCalendarBulkModel,
  settingsSetCalendarBulkPreferences,
  settingsSetInterfacePreferences,
  settingsSetOpenAiKey,
  settingsSetOpenAiModel,
  settingsSetQuickAddPreferences,
  settingsSetTimelinePreferences,
  settingsSetTranscriptionModel,
  summaryExportWeeklyExcel,
  summaryLayoutStateGet,
  summaryLayoutStateSet,
  transcribeAudioClip,
  timelineCreateEntry,
  timelineDeleteEntry,
  timelineListForDate,
  timelineListForWeekView,
  timelineMonthSummary,
  timelineWeeklySummary,
  timelineUpdateEntry,
  voiceRequestMicrophonePermission,
} from './lib/api'
import { isAppRuntime, isTauriRuntime } from './lib/runtime'
import { QUICK_ADD_SUBMITTED_EVENT } from './lib/events'
import { SegmentedControl } from './SegmentedControl'
import {
  buildDefaultSummaryLayoutState,
  cloneSummaryLayoutPreset,
  createSummaryLayoutFreeTextColumn,
  generateSummaryLayoutId,
  getSummaryLayoutFieldOption,
  SUMMARY_LAYOUT_FIELD_OPTIONS,
  SUMMARY_LAYOUT_MAX_NAME_LENGTH,
} from './lib/summaryLayout'
import {
  buildDefaultReportingDisplayColumns,
  buildDefaultReportingState,
  buildNextReportingPresetName,
  cloneReportingDisplayPreset,
  createReportingDisplayFieldColumn,
  generateReportingId,
  getReportingDisplayFieldOption,
  REPORTING_DISPLAY_FIELD_OPTIONS,
  REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH,
} from './lib/reporting'
import {
  formatDate,
  joinTags,
  minuteToLabel,
  minuteToTimeInput,
  parseTagInput,
  shiftDate,
  timeInputToMinute,
} from './lib/time'
import type {
  Activity,
  CalendarExtractCandidate,
  CaptureSourceId,
  DiagnosticsEvent,
  Engagement,
  EngagementType,
  MicrophonePermissionStatus,
  OpenAiModelId,
  QuickAddPreferences,
  QuickAddSuggestion,
  ReportingDisplayColumn,
  ReportingDisplayFieldKey,
  ReportingDisplayPreset,
  ReportingState,
  SettingsStatus,
  SettingsTimelinePreferencesInput,
  SummaryLayoutColumn,
  SummaryLayoutFieldKey,
  SummaryLayoutPreset,
  SummaryLayoutState,
  TimelineDaySummary,
  TimelineEntry,
  TimelineTotalBreakdown,
  TimelineWeekView,
  TimelineWeekStartDay,
  TimelineWeeklySummary,
  TimelineWeeklySummaryNote,
  TimelineWeeklySummaryRow,
  TranscriptionModelId,
  WarningType,
} from './lib/types'
import deleteIcon from './assets/icons/delete.svg'
import editIcon from './assets/icons/edit.svg'
import calendarIcon from './assets/icons/calendar.svg'
import microphoneIcon from './assets/icons/microphone.svg'
import settingsIcon from './assets/icons/settings.svg'
import visibleIcon from './assets/icons/visible.svg'
import visibleOffIcon from './assets/icons/visible-off.svg'
import './App.css'

type View =
  | 'timeline'
  | 'week'
  | 'codes'
  | 'settings'
  | 'diagnostics'
  | 'reporting'
type DiagnosticsFilter = 'all' | 'errors' | 'warnings' | 'capture' | 'settings'
type MonthSummaryCache = Record<string, TimelineDaySummary[]>
type CodeEditorSurface =
  | 'edit-engagement'
  | 'edit-activity'
type CodesCreateStep = 'engagement' | 'activity'
type CodesDetailMode = 'activities' | 'edit-engagement' | 'edit-activity'
type TimelineSurface = 'day' | 'week' | 'calendar-review'
type TimelineDragMode = 'pending' | 'move' | 'resize-duration'

type SubmissionQueueItemState = 'pending' | 'running' | 'success' | 'error'
type LlmSubmissionStatusKind = 'processing' | 'success' | 'error'

interface LlmSubmissionStatus {
  kind: LlmSubmissionStatusKind
  message: string
}

interface SubmissionQueueItem {
  id: string
  rawText: string
  submittedAtMs: number
  captureSource: CaptureSourceId
  requestedOpenAiModel: OpenAiModelId
  clientTimestampIso: string
  clientLocalDate: string
  clientLocalTime: string
  clientUtcOffsetMinutes: number
  selectedDate?: string
  timezone: string
  state: SubmissionQueueItemState
  createdEntryCount?: number
  completedAtMs?: number
  transcriptionModelUsed?: TranscriptionModelId
  transcriptionDurationMs?: number
}

interface QuickBlockDragState {
  engagementId: string
  activityId: string
  activityName: string
  pointerId: number
  originClientX: number
  currentClientX: number
  durationMinutes: number
  isDragging: boolean
}

interface QuickAddActivityView {
  engagement: Engagement
  activity: Activity
  usageCount: number
  lastUsedAt: number | null
}

interface QuickAddActivityGroup {
  engagement: Engagement
  activities: QuickAddActivityView[]
}

interface QuickAddScrollMetrics {
  canScroll: boolean
  thumbTopPct: number
  thumbHeightPct: number
}

type QuickAddSettingsDragKind = 'engagement' | 'activity'

interface QuickAddSettingsDragSnapshot {
  key: string
  top: number
  height: number
  centerY: number
}

interface QuickAddSettingsDragState {
  kind: QuickAddSettingsDragKind
  pointerId: number
  dragKey: string
  engagementId: string
  activityId?: string
  startClientY: number
  latestClientY: number
  sourceIndex: number
  insertionIndex: number
  snapshots: QuickAddSettingsDragSnapshot[]
}

interface VoiceDraftMetadata {
  captureSource: 'voice'
  capturedAtMs: number
  transcriptionModelUsed: TranscriptionModelId
  transcriptionModelUsedLabel: string
  transcriptionDurationMs: number
}

interface TimelineBlockPalette {
  accent: string
  fill: string
  border: string
  selectionRing: string
  text: string
}

interface EngagementFormState {
  id?: string
  code: string
  name: string
  client: string
  engagementType: EngagementType
  colorHex: string
  describeWhenToUse: string
  tags: string
  isActive: boolean
}

interface ActivityFormState {
  id?: string
  engagementId: string
  code: string
  name: string
  colorHex: string
  describeWhenToUse: string
  tags: string
  isActive: boolean
}

interface EntryDraft {
  id: string
  date: string
  engagementId: string
  activityId: string
  description: string
  startTime: string
  endTime: string
  preserveEndOfDay: boolean
}

type EntryAutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

type EntryDraftSavePlan =
  | {
    ok: true
    startMinute: number
    endMinute: number
    normalizedDraft: EntryDraft
    key: string
  }
  | {
    ok: false
    errorMessage: string
  }

type CalendarBulkTab = 'submission' | 'review'
type CalendarCandidateReviewState = 'pending' | 'accepted' | 'rejected' | 'ignored'

interface CalendarReviewCandidate extends CalendarExtractCandidate {
  reviewState: CalendarCandidateReviewState
  savedEntryId?: string | null
  savedEntryDate?: string | null
}

interface CalendarStagedImage {
  imageBase64: string
  mimeType: string
}

interface TimelineWindow {
  startMinute: number
  endMinute: number
}

interface ClippedTimelineEntry {
  entry: TimelineEntry
  clippedStartMinute: number
  clippedEndMinute: number
}

interface PositionedTimelineEntry extends ClippedTimelineEntry {
  laneIndex: number
  laneCount: number
  top: number
  height: number
  leftPercent: number
  widthPercent: number
}

type TimelineLabelTier = 1 | 2 | 3
type VoiceCaptureState = 'idle' | 'recording' | 'transcribing'
type VoicePlatform = 'macos' | 'windows' | 'linux' | 'unknown'
type VoiceSupportFailureReasonCode =
  | 'missing_navigator'
  | 'missing_media_devices'
  | 'missing_get_user_media'
  | 'missing_media_recorder'
type VoicePermissionOutcome =
  | 'not_requested'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'device_unavailable'
  | 'device_unreadable'
  | 'unknown'

interface VoiceEnvironmentSupport {
  platform: VoicePlatform
  isTauriDev: boolean
  hasNavigator: boolean
  hasMediaDevices: boolean
  hasGetUserMedia: boolean
  hasMediaRecorder: boolean
  supportedMimeTypes: string[]
  failureReasonCode: VoiceSupportFailureReasonCode | null
}

interface VoiceRecordingErrorDetails {
  errorCategory:
    | 'permission_denied'
    | 'permission_restricted'
    | 'permission_request_failed'
    | 'device_unavailable'
    | 'device_unreadable'
    | 'unknown'
  message: string
  permissionErrorName: string | null
  permissionOutcome: VoicePermissionOutcome
}

interface TimelineLabel {
  label: string
  fullLabel: string
  tier: TimelineLabelTier
}

interface MiniCalendarProps {
  selectedDate: string
  visibleMonth: string
  todayDate: string
  daysWithEntries: Set<string>
  highlightedDates: Set<string>
  isLoading: boolean
  errorMessage: string | null
  onVisibleMonthChange: (nextMonth: string) => void
  onSelectDate: (date: string) => void
}

interface CalendarDayCell {
  date: string
  dayOfMonth: number
  isCurrentMonth: boolean
}

interface TimelineHeaderDate {
  monthDay: string
  year: string
  weekday: string
}

interface TimelineWeekRangeLabel {
  startMonthDay: string
  startYear: string
  endMonthDay: string
  endYear: string
  isSameYear: boolean
}

type TimelineContextMenuKind = 'entry' | 'empty'

type TimelineContextMenuState =
  | {
    kind: 'entry'
    surface: TimelineSurface
    entryId: string
    createDate: string
    createStartMinute: number
    x: number
    y: number
  }
  | {
    kind: 'empty'
    surface: TimelineSurface
    createDate: string
    createStartMinute: number
    x: number
    y: number
  }

interface TimelineDragState {
  surface: TimelineSurface
  entryId: string
  pointerId: number
  dragMode: TimelineDragMode
  initialClientX: number
  initialClientY: number
  lockedLaneIndex: number
  pointerOffsetMinutes: number
  durationMinutes: number
  originalDate: string
  originalStartMinute: number
  originalEndMinute: number
  previewDate: string
  previewStartMinute: number
  previewEndMinute: number
  isDragging: boolean
}

interface PositionedWeekTimelineEntry extends PositionedTimelineEntry {
  dayIndex: number
  left: number
  width: number
}

interface WeekTimelineLayoutMetrics {
  headerHeight: number
  gutterLeft: number
  dayWidth: number
}

interface SummaryNotesModalState {
  rowIndex: number
  dayIndex: number
}

interface SummaryLayoutModalState {
  mode: 'create' | 'edit'
  presetId: string | null
}

interface ReportingDisplayPresetModalState {
  mode: 'create' | 'edit'
  presetId: string | null
}

type ReportingDisplayDragSurface = 'table' | 'list'

interface ReportingDisplayDragPreview {
  columnId: string
  offsetX: number
  offsetY: number
  surface: ReportingDisplayDragSurface
}

type ReportingExportPreviewSheet = 'weeklyHours' | 'weeklyHoursNotes'

interface ReportingExportPreviewColumn {
  kind: 'field' | 'dayHours' | 'dayNotes' | 'freeText' | 'rowTotal'
  id: string
  header: string
  fieldKey?: SummaryLayoutFieldKey
  dayIndex?: number
  rowValues?: Record<string, string>
  repeat?: boolean
  repeatValue?: string
  repeatRowKey?: string | null
}

interface SummaryLayoutDragSnapshot {
  columnId: string
  left: number
  width: number
  centerX: number
}

interface SummaryLayoutDragState {
  columnId: string
  pointerId: number
  startClientX: number
  latestClientX: number
  draggedCenterX: number
  sourceIndex: number
  insertionIndex: number
  columnSnapshots: SummaryLayoutDragSnapshot[]
}

interface SummaryLayoutViewColumn {
  kind: 'field' | 'day' | 'freeText' | 'rowTotal'
  id: string
  header: string
  width: string
  wraps: boolean
  fieldKey?: SummaryLayoutFieldKey
  dayIndex?: number
}

interface PositionTimelineEntriesOptions {
  lockedEntryId?: string
  lockedLaneIndex?: number
  preferredLaneByEntryId?: Map<string, number>
  preferredLaneOrder?: string[]
}

interface RunActionOptions {
  formatError?: (error: unknown) => string
}

const EMPTY_ENGAGEMENT_FORM: EngagementFormState = {
  code: '',
  name: '',
  client: '',
  engagementType: 'external',
  colorHex: '',
  describeWhenToUse: '',
  tags: '',
  isActive: true,
}

const EMPTY_ACTIVITY_FORM: ActivityFormState = {
  engagementId: '',
  code: '',
  name: '',
  colorHex: '',
  describeWhenToUse: '',
  tags: '',
  isActive: true,
}

const EMPTY_QUICK_ADD_PREFERENCES: QuickAddPreferences = {
  engagementOrder: [],
  hiddenEngagementIds: [],
  activityOrder: {},
  hiddenActivityIds: [],
}

function getDefaultActivityEngagementId(engagements: Engagement[]): string {
  return engagements[0]?.id ?? ''
}

function inferEngagementTypeFromCode(code: string | null | undefined): EngagementType {
  const firstCharacter = code?.trim().charAt(0).toUpperCase()
  return firstCharacter === 'I' || firstCharacter === 'A' ? 'internal' : 'external'
}

function buildEmptyActivityForm(engagementId: string): ActivityFormState {
  return {
    ...EMPTY_ACTIVITY_FORM,
    engagementId,
  }
}

const MINUTES_IN_DAY = 24 * 60
const HOUR_IN_MINUTES = 60
const PIXELS_PER_MINUTE = 1
const TIMELINE_CANVAS_TOP_PADDING = 18
const TIMELINE_CANVAS_BOTTOM_PADDING = 20
const TIMELINE_OVERLAP_GAP_PERCENT = 1.2
const TIMELINE_NEUTRAL_COLOR = '#6F7B89'
const TIMELINE_BLOCK_FILL_ALPHA = 0.2
const TIMELINE_BLOCK_BORDER_ALPHA = 0.34
const TIMELINE_BLOCK_SELECTION_RING_ALPHA = 0.3
const TIMELINE_BLOCK_TEXT_COLOR = '#0F172A'
const TIMELINE_DRAG_SNAP_MINUTES = 15
const TIMELINE_DRAG_ACTIVATION_PX = 4
const TIMELINE_MANUAL_CREATE_DURATION_MINUTES = 30
const TIMELINE_DURATION_RESIZE_ACTIVATION_PX = 12
const TIMELINE_DURATION_RESIZE_DOMINANCE_RATIO = 1.5
const TIMELINE_DURATION_RESIZE_STEP_PX = 28
const TIMELINE_DURATION_RESIZE_STEP_MINUTES = 30
const QUICK_BLOCK_DURATION_STEP_MINUTES = 30
const QUICK_BLOCK_MAX_DURATION_MINUTES = 8 * HOUR_IN_MINUTES
const QUICK_BLOCK_DRAG_STEP_PX = 22
const WEEK_TIMELINE_HEADER_HEIGHT = 64
const WEEK_TIMELINE_GUTTER_LEFT = 60
const WEEK_TIMELINE_DAY_WIDTH = 176
const WEEK_TIMELINE_ENTRY_COLUMN_INSET = 4
const COMPACT_WEEK_TIMELINE_GUTTER_LEFT = 52
const COMPACT_WEEK_TIMELINE_DAY_WIDTH = 154
const WEEK_TIMELINE_COMPACT_MEDIA_QUERY = '(max-width: 720px)'
const FULL_DAY_TIMELINE_WINDOW: TimelineWindow = {
  startMinute: 0,
  endMinute: MINUTES_IN_DAY,
}
const END_OF_DAY_INPUT_SENTINEL = '23:59'
const MAX_CONCURRENT_SUBMISSIONS = 5
const SYSTEM_NOTICE_AUTO_DISMISS_MS = 4000
const LLM_SUBMISSION_STATUS_DISMISS_MS = 5000
const CALENDAR_REVIEW_LOW_CONFIDENCE_THRESHOLD = 0.75
const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5.5-instant'
const DEFAULT_CALENDAR_BULK_MODEL: OpenAiModelId = 'gpt-5.5-instant'
const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId = 'gpt-4o-mini-transcribe'
const MAX_VOICE_RECORDING_DURATION_MS = 120_000
const PREFERRED_VOICE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
] as const

function quickAddActivityKey(engagementId: string, activityId: string): string {
  return `${engagementId}:${activityId}`
}

function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }

    seen.add(value)
    next.push(value)
  }

  return next
}

function sanitizeQuickAddPreferences(
  preferences: QuickAddPreferences | null | undefined,
  engagements: Engagement[],
): QuickAddPreferences {
  const source = preferences ?? EMPTY_QUICK_ADD_PREFERENCES
  const activeEngagementIds = new Set(engagements.filter((engagement) => engagement.isActive).map((engagement) => engagement.id))
  const activeActivityIds = new Set<string>()
  const activityIdsByEngagement = new Map<string, Set<string>>()

  for (const engagement of engagements) {
    if (!engagement.isActive) {
      continue
    }

    const activeActivities = engagement.activities.filter((activity) => activity.isActive)
    const activeIds = new Set(activeActivities.map((activity) => activity.id))
    activityIdsByEngagement.set(engagement.id, activeIds)

    for (const activity of activeActivities) {
      activeActivityIds.add(activity.id)
    }
  }

  const activityOrder: Record<string, string[]> = {}
  for (const [engagementId, activityIds] of Object.entries(source.activityOrder ?? {})) {
    const activeIds = activityIdsByEngagement.get(engagementId)
    if (!activeIds) {
      continue
    }

    const orderedActivityIds = uniqueIds(activityIds).filter((activityId) => activeIds.has(activityId))
    if (orderedActivityIds.length > 0) {
      activityOrder[engagementId] = orderedActivityIds
    }
  }

  return {
    engagementOrder: uniqueIds(source.engagementOrder).filter((engagementId) =>
      activeEngagementIds.has(engagementId),
    ),
    hiddenEngagementIds: uniqueIds(source.hiddenEngagementIds).filter((engagementId) =>
      activeEngagementIds.has(engagementId),
    ),
    activityOrder,
    hiddenActivityIds: uniqueIds(source.hiddenActivityIds).filter((activityId) =>
      activeActivityIds.has(activityId),
    ),
  }
}

function buildQuickAddSettingsDraft(
  preferences: QuickAddPreferences | null | undefined,
  engagements: Engagement[],
): QuickAddPreferences {
  const sanitized = sanitizeQuickAddPreferences(preferences, engagements)
  const engagementOrder = sanitized.engagementOrder.slice()
  const engagementSeen = new Set(engagementOrder)
  const activityOrder: Record<string, string[]> = { ...sanitized.activityOrder }

  for (const engagement of engagements) {
    if (!engagement.isActive) {
      continue
    }

    if (!engagementSeen.has(engagement.id)) {
      engagementOrder.push(engagement.id)
      engagementSeen.add(engagement.id)
    }

    const orderedActivityIds = activityOrder[engagement.id]?.slice() ?? []
    const activitySeen = new Set(orderedActivityIds)
    for (const activity of engagement.activities) {
      if (!activity.isActive || activitySeen.has(activity.id)) {
        continue
      }

      orderedActivityIds.push(activity.id)
      activitySeen.add(activity.id)
    }

    activityOrder[engagement.id] = orderedActivityIds
  }

  return {
    ...sanitized,
    engagementOrder,
    activityOrder,
  }
}

function moveId(values: string[], id: string, direction: -1 | 1): string[] {
  const index = values.indexOf(id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= values.length) {
    return values
  }

  const next = values.slice()
  const [item] = next.splice(index, 1)
  next.splice(nextIndex, 0, item)
  return next
}

function moveIdToIndex(values: string[], id: string, insertionIndex: number): string[] {
  if (!values.includes(id)) {
    return values
  }

  const withoutItem = values.filter((value) => value !== id)
  const safeIndex = Math.min(Math.max(insertionIndex, 0), withoutItem.length)
  return [
    ...withoutItem.slice(0, safeIndex),
    id,
    ...withoutItem.slice(safeIndex),
  ]
}

function toggleId(values: string[], id: string): string[] {
  return values.includes(id)
    ? values.filter((value) => value !== id)
    : [...values, id]
}

function quickAddSettingsEngagementKey(engagementId: string): string {
  return `engagement:${engagementId}`
}

function quickAddSettingsActivityKey(
  engagementId: string,
  activityId: string,
): string {
  return `activity:${engagementId}:${activityId}`
}

function findQuickAddSettingsInsertionIndex(
  draggedCenterY: number,
  dragState: QuickAddSettingsDragState,
): number {
  let insertionIndex = 0
  for (const snapshot of dragState.snapshots) {
    if (snapshot.key === dragState.dragKey) {
      continue
    }

    if (draggedCenterY > snapshot.centerY) {
      insertionIndex += 1
    }
  }

  return Math.min(Math.max(insertionIndex, 0), Math.max(dragState.snapshots.length - 1, 0))
}

function codeEntitySearchText(engagement: Engagement): string {
  return [
    engagement.code,
    engagement.name,
    engagement.client,
    engagement.engagementType,
    engagement.describeWhenToUse,
    ...engagement.tags,
    ...engagement.activities.flatMap((activity) => [
      activity.code,
      activity.name,
      activity.describeWhenToUse,
      ...activity.tags,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
}

function activityCodeSearchText(activity: Activity): string {
  return [
    activity.code,
    activity.name,
    activity.describeWhenToUse,
    ...activity.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
}

function isSummaryLikeView(view: View): boolean {
  return view === 'reporting'
}

function getSummaryRowKey(row: TimelineWeeklySummary['rows'][number], rowIndex: number): string {
  return [
    row.engagementId ?? 'uncategorized',
    row.activityId ?? 'uncategorized',
    row.engagementCode ?? '',
    row.activityCode ?? '',
    rowIndex,
  ].join(':')
}

const SEGMENTED_VIEWS: Array<{ id: View; label: string }> = [
  { id: 'timeline', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'codes', label: 'Codes' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
]
const ENGAGEMENT_TYPE_SEGMENT_OPTIONS: Array<{ id: EngagementType; label: string }> = [
  { id: 'external', label: 'External' },
  { id: 'internal', label: 'Internal' },
]
const CALENDAR_BULK_TAB_OPTIONS: Array<{ id: CalendarBulkTab; label: string }> = [
  { id: 'submission', label: 'Calendar Submission' },
  { id: 'review', label: 'Review Events' },
]
const TIMELINE_WEEK_START_OPTIONS: Array<{ id: TimelineWeekStartDay; label: string }> = [
  { id: 'saturday', label: 'Saturday' },
  { id: 'sunday', label: 'Sunday' },
  { id: 'monday', label: 'Monday' },
]
const WEEKDAY_LABELS_BY_SUNDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
const REPORTING_DISPLAY_FIELD_GROUPS: Array<{
  label: string
  keys: ReportingDisplayFieldKey[]
}> = [
  { label: 'Core', keys: ['details', 'engagement', 'activity', 'client'] },
  { label: 'Codes', keys: ['engagementCode', 'activityCode'] },
  { label: 'Classification', keys: ['engagementType', 'engagementTags', 'activityTags'] },
  { label: 'Guidance', keys: ['engagementUsage', 'activityUsage'] },
]
const SUMMARY_LAYOUT_DAY_COLUMN_WIDTH = '8.5rem'
const SUMMARY_LAYOUT_ROW_TOTAL_WIDTH = '8.5rem'

interface ResponsiveCodeTagListProps {
  tags: string[]
  itemKeyPrefix: string
}

function ResponsiveCodeTagList({ tags, itemKeyPrefix }: ResponsiveCodeTagListProps) {
  const normalizedTags = useMemo(() => normalizeCodeTags(tags), [tags])
  const [visibleCount, setVisibleCount] = useState(normalizedTags.length)
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const measurementRowRef = useRef<HTMLSpanElement | null>(null)
  const moreMeasurementRef = useRef<HTMLSpanElement | null>(null)
  const tagMeasurementRefs = useRef<Array<HTMLSpanElement | null>>([])
  const measurementFrameRef = useRef<number | null>(null)

  const measureVisibleCount = useCallback(() => {
    const container = containerRef.current
    const measurementRow = measurementRowRef.current
    const moreMeasurement = moreMeasurementRef.current

    if (!container || !measurementRow || !moreMeasurement) {
      return
    }

    const availableWidth = container.clientWidth
    if (availableWidth <= 0) {
      setVisibleCount(0)
      return
    }

    const computedStyles = window.getComputedStyle(measurementRow)
    const gapValue = computedStyles.columnGap || computedStyles.gap || '0'
    const gap = Number.parseFloat(gapValue) || 0
    const tagWidths = normalizedTags.map(
      (_, index) => tagMeasurementRefs.current[index]?.offsetWidth ?? 0,
    )
    const prefixWidths = [0]

    for (const width of tagWidths) {
      prefixWidths.push(prefixWidths[prefixWidths.length - 1] + width)
    }

    const allTagsWidth = prefixWidths[prefixWidths.length - 1] + Math.max(0, tagWidths.length - 1) * gap
    if (allTagsWidth <= availableWidth) {
      setVisibleCount((previous) => (previous === normalizedTags.length ? previous : normalizedTags.length))
      return
    }

    let nextVisibleCount = 0

    for (let candidateCount = normalizedTags.length - 1; candidateCount >= 0; candidateCount -= 1) {
      const hiddenCount = normalizedTags.length - candidateCount
      moreMeasurement.textContent = `+${hiddenCount}`
      const moreWidth = moreMeasurement.offsetWidth
      const visibleWidth = prefixWidths[candidateCount]
      const totalItemCount = candidateCount + 1
      const totalGapWidth = totalItemCount > 1 ? (totalItemCount - 1) * gap : 0

      if (visibleWidth + moreWidth + totalGapWidth <= availableWidth) {
        nextVisibleCount = candidateCount
        break
      }
    }

    setVisibleCount((previous) => (previous === nextVisibleCount ? previous : nextVisibleCount))
  }, [normalizedTags])

  useLayoutEffect(() => {
    if (normalizedTags.length === 0) {
      return
    }

    const scheduleMeasurement = () => {
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current)
      }

      measurementFrameRef.current = window.requestAnimationFrame(() => {
        measurementFrameRef.current = null
        measureVisibleCount()
      })
    }

    scheduleMeasurement()

    const container = containerRef.current
    let resizeObserver: ResizeObserver | null = null
    const handleWindowResize = () => {
      scheduleMeasurement()
    }

    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleMeasurement()
      })
      resizeObserver.observe(container)
    } else {
      window.addEventListener('resize', handleWindowResize)
    }

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleWindowResize)
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current)
      }
    }
  }, [measureVisibleCount, normalizedTags.length])

  if (normalizedTags.length === 0) {
    return null
  }

  const safeVisibleCount = Math.max(0, Math.min(visibleCount, normalizedTags.length))
  const hiddenTagCount = Math.max(0, normalizedTags.length - safeVisibleCount)
  const visibleTags = normalizedTags.slice(0, safeVisibleCount)

  return (
    <span className="responsive-code-tag-list">
      <span ref={containerRef} className="code-tag-list">
        {visibleTags.map((tag, index) => (
          <span key={`${itemKeyPrefix}-${tag}-${index}`} className="code-tag">
            {tag}
          </span>
        ))}
        {hiddenTagCount > 0 ? <span className="code-tag code-tag-more">+{hiddenTagCount}</span> : null}
      </span>
      <span className="code-tag-measurement" aria-hidden="true">
        <span ref={measurementRowRef} className="code-tag-list code-tag-list-measurement">
          {normalizedTags.map((tag, index) => (
            <span
              key={`${itemKeyPrefix}-measure-${tag}-${index}`}
              ref={(node) => {
                tagMeasurementRefs.current[index] = node
              }}
              className="code-tag"
            >
              {tag}
            </span>
          ))}
          <span ref={moreMeasurementRef} className="code-tag code-tag-more">
            +{normalizedTags.length}
          </span>
        </span>
      </span>
    </span>
  )
}

function App() {
  const tauriRuntime = isTauriRuntime()
  const appRuntime = isAppRuntime()
  const credentialStoreName = formatCredentialStoreName(detectVoicePlatform())
  const credentialHelpText = 'An API key is required for LLM based timesheet entries.'
  const [timelineClock, setTimelineClock] = useState(() => new Date())
  const todayDate = useMemo(() => formatDate(timelineClock), [timelineClock])

  const [activeView, setActiveView] = useState<View>('timeline')
  const [timelineAutoCenterRequestKey, setTimelineAutoCenterRequestKey] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [isTimelineLoading, setIsTimelineLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [openAiKey, setOpenAiKey] = useState('')
  const credentialStatusTone =
    settingsStatus === null
      ? 'is-checking'
      : settingsStatus.hasOpenAiKey
        ? 'is-configured'
        : 'is-missing'
  const credentialStatusLabel =
    settingsStatus === null
      ? 'Checking key status'
      : settingsStatus.hasOpenAiKey
        ? 'Key configured'
        : 'Key not configured'
  const [selectedOpenAiModelDraft, setSelectedOpenAiModelDraft] =
    useState<OpenAiModelId>(DEFAULT_OPENAI_MODEL)
  const [selectedCalendarBulkModelDraft, setSelectedCalendarBulkModelDraft] =
    useState<OpenAiModelId>(DEFAULT_CALENDAR_BULK_MODEL)
  const [selectedTranscriptionModelDraft, setSelectedTranscriptionModelDraft] =
    useState<TranscriptionModelId>(DEFAULT_TRANSCRIPTION_MODEL)
  const timelineExcludeUncategorizedFromDailyTotals =
    settingsStatus?.timelineExcludeUncategorizedFromDailyTotals ?? true
  const timelineShowUncategorizedDailyTotal =
    settingsStatus?.timelineShowUncategorizedDailyTotal ?? true
  const timelineIncludeExternalInTotals =
    settingsStatus?.timelineIncludeExternalInTotals ?? true
  const timelineIncludeInternalInTotals =
    settingsStatus?.timelineIncludeInternalInTotals ?? false
  const timelineSeparateEngagementTypeTotals =
    settingsStatus?.timelineSeparateEngagementTypeTotals ?? true
  const timelineWeekStartDay: TimelineWeekStartDay = settingsStatus?.timelineWeekStartDay ?? 'saturday'
  const currentTimelinePreferences: SettingsTimelinePreferencesInput = {
    timelineExcludeUncategorizedFromDailyTotals,
    timelineShowUncategorizedDailyTotal,
    timelineIncludeExternalInTotals,
    timelineIncludeInternalInTotals,
    timelineSeparateEngagementTypeTotals,
    timelineWeekStartDay,
  }
  const showDiagnosticsTab = settingsStatus?.showDiagnosticsTab ?? true
  const mainViewTabs = useMemo(
    () => SEGMENTED_VIEWS.filter((view) => showDiagnosticsTab || view.id !== 'diagnostics'),
    [showDiagnosticsTab],
  )

  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [codeEditorSurface, setCodeEditorSurface] = useState<CodeEditorSurface | null>(null)
  const [engagementForm, setEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [hasManualEngagementTypeSelection, setHasManualEngagementTypeSelection] = useState(false)
  const [activityForm, setActivityForm] = useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)
  const [isCodesCreateModalOpen, setIsCodesCreateModalOpen] = useState(false)
  const [codesCreateStep, setCodesCreateStep] = useState<CodesCreateStep>('engagement')
  const [codesCreateEngagementForm, setCodesCreateEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [
    hasManualCodesCreateEngagementTypeSelection,
    setHasManualCodesCreateEngagementTypeSelection,
  ] = useState(false)
  const [codesCreateActivityForm, setCodesCreateActivityForm] =
    useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)
  const [codesCreateContextEngagementId, setCodesCreateContextEngagementId] =
    useState<string | null>(null)
  const [codesCreateNotice, setCodesCreateNotice] = useState<string | null>(null)
  const [codesSelectedEngagementId, setCodesSelectedEngagementId] = useState<string | null>(null)
  const [codesDetailMode, setCodesDetailMode] = useState<CodesDetailMode>('activities')
  const [codesEngagementSearch, setCodesEngagementSearch] = useState('')
  const [codesActivitySearch, setCodesActivitySearch] = useState('')

  const [captureMessage, setCaptureMessage] = useState('')
  const [captureDraftMetadata, setCaptureDraftMetadata] = useState<VoiceDraftMetadata | null>(null)
  const [isLlmEntryCollapsed, setIsLlmEntryCollapsed] = useState(true)
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle')
  const [voiceCaptureStatusMessage, setVoiceCaptureStatusMessage] = useState<string | null>(null)
  const [submissionQueue, setSubmissionQueue] = useState<SubmissionQueueItem[]>([])
  const [quickAddSearch, setQuickAddSearch] = useState('')
  const [quickAddSuggestionItems, setQuickAddSuggestionItems] = useState<QuickAddSuggestion[]>([])
  const [quickAddSuggestedKeys, setQuickAddSuggestedKeys] = useState<string[]>([])
  const [quickAddSuggestionsError, setQuickAddSuggestionsError] = useState<string | null>(null)
  const [isQuickAddSettingsOpen, setIsQuickAddSettingsOpen] = useState(false)
  const [quickAddSettingsDraft, setQuickAddSettingsDraft] = useState<QuickAddPreferences | null>(null)
  const [quickAddSettingsDragState, setQuickAddSettingsDragState] =
    useState<QuickAddSettingsDragState | null>(null)
  const [quickAddSettingsDropCommitKeys, setQuickAddSettingsDropCommitKeys] = useState<string[]>([])
  const [quickBlockDragState, setQuickBlockDragState] = useState<QuickBlockDragState | null>(null)
  const [quickAddScrollMetrics, setQuickAddScrollMetrics] = useState<QuickAddScrollMetrics>({
    canScroll: false,
    thumbTopPct: 0,
    thumbHeightPct: 100,
  })
  const [isCalendarBulkModalOpen, setIsCalendarBulkModalOpen] = useState(false)
  const [calendarBulkTab, setCalendarBulkTab] = useState<CalendarBulkTab>('submission')
  const [calendarSelectedFileName, setCalendarSelectedFileName] = useState<string | null>(null)
  const [calendarImagePreviewUrl, setCalendarImagePreviewUrl] = useState<string | null>(null)
  const [calendarStagedImage, setCalendarStagedImage] = useState<CalendarStagedImage | null>(null)
  const [calendarUploadStatusMessage, setCalendarUploadStatusMessage] = useState<string | null>(null)
  const [calendarUploadErrorMessage, setCalendarUploadErrorMessage] = useState<string | null>(null)
  const [calendarIsExtracting, setCalendarIsExtracting] = useState(false)
  const [calendarIsImporting, setCalendarIsImporting] = useState(false)
  const [calendarReviewCandidates, setCalendarReviewCandidates] = useState<CalendarReviewCandidate[]>([])
  const [selectedCalendarCandidateId, setSelectedCalendarCandidateId] = useState<string | null>(null)
  const [calendarIgnoredKeywordDraft, setCalendarIgnoredKeywordDraft] = useState('lunch')

  const [selectedDate, setSelectedDate] = useState(todayDate)
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyFromDate(todayDate))
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [weekTimeline, setWeekTimeline] = useState<TimelineWeekView | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null)
  const [entryAutoSaveStatus, setEntryAutoSaveStatus] = useState<EntryAutoSaveStatus>('idle')
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenuState | null>(null)
  const [isTimelineDeleteBusy, setIsTimelineDeleteBusy] = useState(false)
  const [timelineDragState, setTimelineDragState] = useState<TimelineDragState | null>(null)
  const [isWeekTimelineLoading, setIsWeekTimelineLoading] = useState(false)
  const [weekTimelineError, setWeekTimelineError] = useState<string | null>(null)
  const [timelineLanePreferences, setTimelineLanePreferences] = useState(() => ({
    byEntryId: new Map<string, number>(),
    order: [] as string[],
  }))
  const [monthSummaryCache, setMonthSummaryCache] = useState<MonthSummaryCache>({})
  const [staleMonthSummaryKeys, setStaleMonthSummaryKeys] = useState<Set<string>>(() => new Set())
  const [monthSummaryLoadingMonth, setMonthSummaryLoadingMonth] = useState<string | null>(null)
  const [monthSummaryError, setMonthSummaryError] = useState<string | null>(null)
  const timelineGridRef = useRef<HTMLDivElement | null>(null)
  const weekTimelineGridRef = useRef<HTMLDivElement | null>(null)
  const calendarReviewTimelineGridRef = useRef<HTMLDivElement | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement | null>(null)
  const calendarFileInputRef = useRef<HTMLInputElement | null>(null)
  const calendarDropZoneRef = useRef<HTMLDivElement | null>(null)
  const calendarReviewAutoCenterKeyRef = useRef<string | null>(null)
  const weekCurrentTimeAutoCenterKeyRef = useRef<string | null>(null)
  const hasInitializedRef = useRef(false)
  const lastLoadedTimelineDateRef = useRef<string | null>(null)
  const pendingAutoCenterDateRef = useRef<string | null>(todayDate)
  const selectedDateRef = useRef(selectedDate)
  const selectedEntryIdRef = useRef<string | null>(selectedEntryId)
  const entryDraftAutoSaveTimeoutRef = useRef<number | null>(null)
  const entryDraftAutoSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const entryDraftLastSavedKeyRef = useRef<string | null>(null)
  const timelineDragStateRef = useRef<TimelineDragState | null>(null)
  const timelineMutationInFlightRef = useRef(false)
  const quickBlockDragStateRef = useRef<QuickBlockDragState | null>(null)
  const quickAddScrollRef = useRef<HTMLDivElement | null>(null)
  const quickAddSettingsDraftRef = useRef<QuickAddPreferences | null>(null)
  const quickAddSettingsDragStateRef = useRef<QuickAddSettingsDragState | null>(null)
  const quickAddSettingsRowRefs = useRef<Record<string, HTMLElement | null>>({})
  const quickAddSettingsDragCaptureTargetRef = useRef<HTMLButtonElement | null>(null)
  const quickAddSettingsDropCommitFrameRef = useRef<number | null>(null)
  const quickAddSettingsSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const timelineEntriesRef = useRef<TimelineEntry[]>([])
  const suppressTimelineClickRef = useRef(false)
  const inFlightSubmissionIdsRef = useRef<Set<string>>(new Set())
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceCaptureStartedAtMsRef = useRef<number | null>(null)
  const voiceCaptureMimeTypeRef = useRef<string>('audio/webm')
  const voiceCaptureCorrelationIdRef = useRef<string | null>(null)
  const voiceCaptureTimeoutRef = useRef<number | null>(null)
  const stopVoiceRecordingToDraftRef = useRef<(reason?: 'mic_button' | 'auto_stop') => void>(() => {})
  const [diagnosticsFilter, setDiagnosticsFilter] = useState<DiagnosticsFilter>('all')
  const [diagnosticsEvents, setDiagnosticsEvents] = useState<DiagnosticsEvent[]>([])
  const [diagnosticsBundleText, setDiagnosticsBundleText] = useState('')
  const [weeklySummary, setWeeklySummary] = useState<TimelineWeeklySummary | null>(null)
  const [isWeeklySummaryLoading, setIsWeeklySummaryLoading] = useState(false)
  const [weeklySummaryError, setWeeklySummaryError] = useState<string | null>(null)
  const [isSummaryExporting, setIsSummaryExporting] = useState(false)
  const [summaryLayoutState, setSummaryLayoutState] = useState<SummaryLayoutState | null>(null)
  const [isSummaryLayoutSaving, setIsSummaryLayoutSaving] = useState(false)
  const [summaryLayoutModal, setSummaryLayoutModal] = useState<SummaryLayoutModalState | null>(null)
  const [summaryLayoutDraft, setSummaryLayoutDraft] = useState<SummaryLayoutPreset | null>(null)
  const [summaryLayoutDraftName, setSummaryLayoutDraftName] = useState('')
  const [summaryLayoutDraftError, setSummaryLayoutDraftError] = useState<string | null>(null)
  const [summaryLayoutInsertionIndex, setSummaryLayoutInsertionIndex] = useState<number | null>(null)
  const [summaryLayoutDragState, setSummaryLayoutDragState] = useState<SummaryLayoutDragState | null>(null)
  const [summaryLayoutDropCommitColumnIds, setSummaryLayoutDropCommitColumnIds] = useState<string[]>([])
  const [reportingState, setReportingState] = useState<ReportingState | null>(null)
  const [isReportingStateSaving, setIsReportingStateSaving] = useState(false)
  const [reportingDisplayPresetModal, setReportingDisplayPresetModal] =
    useState<ReportingDisplayPresetModalState | null>(null)
  const [reportingDisplayPresetDraft, setReportingDisplayPresetDraft] =
    useState<ReportingDisplayPreset | null>(null)
  const [reportingDisplayPresetDraftName, setReportingDisplayPresetDraftName] = useState('')
  const [reportingDisplayPresetDraftError, setReportingDisplayPresetDraftError] =
    useState<string | null>(null)
  const [isReportingDisplayColumnPickerOpen, setIsReportingDisplayColumnPickerOpen] = useState(false)
  const [reportingDisplayDraggedColumnId, setReportingDisplayDraggedColumnId] =
    useState<string | null>(null)
  const [reportingDisplayDragPreview, setReportingDisplayDragPreview] =
    useState<ReportingDisplayDragPreview | null>(null)
  const reportingDisplayPointerDragStateRef = useRef<{
    columnId: string
    pointerId: number
    startClientX: number
    startClientY: number
    surface: ReportingDisplayDragSurface
    lastTargetKey: string | null
  } | null>(null)
  const reportingDisplayDragCleanupRef = useRef<(() => void) | null>(null)
  const reportingDisplayAnimationRectsRef = useRef<Map<string, DOMRect> | null>(null)
  const [isReportingExportModalOpen, setIsReportingExportModalOpen] = useState(false)
  const [reportingExportPreviewSheet, setReportingExportPreviewSheet] =
    useState<ReportingExportPreviewSheet>('weeklyHours')
  const [summaryNotesModal, setSummaryNotesModal] = useState<SummaryNotesModalState | null>(null)
  const summaryLayoutModalRef = useRef<HTMLDivElement | null>(null)
  const summaryLayoutColumnRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const summaryLayoutDragStateRef = useRef<SummaryLayoutDragState | null>(null)
  const summaryLayoutDragCaptureTargetRef = useRef<HTMLButtonElement | null>(null)
  const summaryLayoutDropCommitFrameRef = useRef<number | null>(null)
  const summaryNotesModalRef = useRef<HTMLDivElement | null>(null)
  const [isCompactWeekTimeline, setIsCompactWeekTimeline] = useState(
    () => (
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(WEEK_TIMELINE_COMPACT_MEDIA_QUERY).matches
    ),
  )
  const commitSummaryLayoutDragState = useCallback((next: SummaryLayoutDragState | null) => {
    summaryLayoutDragStateRef.current = next
    setSummaryLayoutDragState(next)
  }, [])
  const releaseSummaryLayoutPointerCapture = useCallback((pointerId?: number | null) => {
    const captureTarget = summaryLayoutDragCaptureTargetRef.current
    if (
      captureTarget
      && pointerId !== null
      && pointerId !== undefined
      && captureTarget.hasPointerCapture(pointerId)
    ) {
      captureTarget.releasePointerCapture(pointerId)
    }

    summaryLayoutDragCaptureTargetRef.current = null
  }, [])
  const commitQuickAddSettingsDragState = useCallback((next: QuickAddSettingsDragState | null) => {
    quickAddSettingsDragStateRef.current = next
    setQuickAddSettingsDragState(next)
  }, [])
  const clearQuickAddSettingsDropAnimation = useCallback(() => {
    if (quickAddSettingsDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(quickAddSettingsDropCommitFrameRef.current)
      quickAddSettingsDropCommitFrameRef.current = null
    }
    setQuickAddSettingsDropCommitKeys([])
  }, [])
  const releaseQuickAddSettingsPointerCapture = useCallback((pointerId?: number | null) => {
    const captureTarget = quickAddSettingsDragCaptureTargetRef.current
    if (
      captureTarget
      && pointerId !== null
      && pointerId !== undefined
      && captureTarget.hasPointerCapture(pointerId)
    ) {
      captureTarget.releasePointerCapture(pointerId)
    }

    quickAddSettingsDragCaptureTargetRef.current = null
  }, [])
  const captureQuickAddSettingsRowRects = useCallback(() => {
    const rects = new Map<string, DOMRect>()
    for (const [key, node] of Object.entries(quickAddSettingsRowRefs.current)) {
      if (!node) {
        continue
      }

      rects.set(key, node.getBoundingClientRect())
    }

    return rects
  }, [])
  const animateQuickAddSettingsRowReorder = useCallback((previousRects: Map<string, DOMRect>) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        for (const [key, previousRect] of previousRects) {
          const node = quickAddSettingsRowRefs.current[key]
          if (!node) {
            continue
          }

          const nextRect = node.getBoundingClientRect()
          const deltaY = previousRect.top - nextRect.top
          if (Math.abs(deltaY) < 1) {
            continue
          }

          node.style.transition = 'none'
          node.style.transform = `translateY(${deltaY}px)`
          void node.offsetHeight
          node.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
          node.style.transform = ''

          const cleanup = () => {
            node.style.transition = ''
            node.removeEventListener('transitionend', cleanup)
          }
          node.addEventListener('transitionend', cleanup, { once: true })
          window.setTimeout(cleanup, 240)
        }
      })
    })
  }, [])
  const persistQuickAddSettingsDraft = useCallback(
    (preferences: QuickAddPreferences) => {
      const quickAddPreferences = sanitizeQuickAddPreferences(preferences, engagements)
      setSettingsStatus((previous) => (
        previous
          ? {
              ...previous,
              quickAddPreferences,
            }
          : previous
      ))

      quickAddSettingsSaveChainRef.current = quickAddSettingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => settingsSetQuickAddPreferences({ quickAddPreferences }))
        .catch((error) => {
          setErrorMessage(`Quick Entry settings could not be saved. ${formatActionErrorMessage(error)}`)
        })
    },
    [engagements],
  )
  const updateQuickAddSettingsDraftWithAnimation = useCallback(
    (
      updater: (previous: QuickAddPreferences) => QuickAddPreferences,
      options?: { animate?: boolean },
    ) => {
      const previousRects = options?.animate === false ? null : captureQuickAddSettingsRowRects()
      const currentDraft =
        quickAddSettingsDraftRef.current
        ?? buildQuickAddSettingsDraft(settingsStatus?.quickAddPreferences, engagements)
      const nextDraft = sanitizeQuickAddPreferences(updater(currentDraft), engagements)

      quickAddSettingsDraftRef.current = nextDraft
      setQuickAddSettingsDraft(nextDraft)
      persistQuickAddSettingsDraft(nextDraft)

      if (previousRects) {
        animateQuickAddSettingsRowReorder(previousRects)
      }
    },
    [
      animateQuickAddSettingsRowReorder,
      captureQuickAddSettingsRowRects,
      engagements,
      persistQuickAddSettingsDraft,
      settingsStatus?.quickAddPreferences,
    ],
  )
  const clearSummaryLayoutDropAnimation = useCallback(() => {
    if (summaryLayoutDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(summaryLayoutDropCommitFrameRef.current)
      summaryLayoutDropCommitFrameRef.current = null
    }
    setSummaryLayoutDropCommitColumnIds([])
  }, [])
  const resetSummaryLayoutEditor = useCallback(() => {
    setSummaryLayoutModal(null)
    setSummaryLayoutDraft(null)
    setSummaryLayoutDraftName('')
    setSummaryLayoutDraftError(null)
    setSummaryLayoutInsertionIndex(null)
    releaseSummaryLayoutPointerCapture(summaryLayoutDragStateRef.current?.pointerId ?? null)
    commitSummaryLayoutDragState(null)
    clearSummaryLayoutDropAnimation()
    summaryLayoutColumnRefs.current = {}
  }, [clearSummaryLayoutDropAnimation, commitSummaryLayoutDragState, releaseSummaryLayoutPointerCapture])
  const resetReportingDisplayPresetEditor = useCallback(() => {
    setReportingDisplayPresetModal(null)
    setReportingDisplayPresetDraft(null)
    setReportingDisplayPresetDraftName('')
    setReportingDisplayPresetDraftError(null)
    setIsReportingDisplayColumnPickerOpen(false)
    setReportingDisplayDraggedColumnId(null)
    setReportingDisplayDragPreview(null)
    reportingDisplayDragCleanupRef.current?.()
    reportingDisplayDragCleanupRef.current = null
    reportingDisplayPointerDragStateRef.current = null
  }, [])
  const weekTimelineLayoutMetrics = useMemo(
    () => buildWeekTimelineLayoutMetrics(isCompactWeekTimeline),
    [isCompactWeekTimeline],
  )

  const loadedTimelineEntries = useMemo(() => {
    const byId = new Map<string, TimelineEntry>()
    for (const entry of weekTimeline?.entries ?? []) {
      byId.set(entry.id, entry)
    }
    for (const entry of timelineEntries) {
      byId.set(entry.id, entry)
    }
    return [...byId.values()]
  }, [timelineEntries, weekTimeline])
  const selectedEntry = useMemo(
    () => loadedTimelineEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [loadedTimelineEntries, selectedEntryId],
  )
  const selectedEntryHasMultiEventSource = (selectedEntry?.sourceMessageEntryCount ?? 0) > 1
  const visibleMonthSummaries = useMemo(
    () => monthSummaryCache[visibleMonth] ?? [],
    [monthSummaryCache, visibleMonth],
  )
  const visibleMonthDaysWithEntries = useMemo(
    () => new Set(visibleMonthSummaries.filter((day) => day.entryCount > 0).map((day) => day.date)),
    [visibleMonthSummaries],
  )
  const hasVisibleMonthSummary = monthSummaryCache[visibleMonth] !== undefined
  const isVisibleMonthSummaryStale = staleMonthSummaryKeys.has(visibleMonth)
  const visibleMonthSummaryError = monthSummaryCache[visibleMonth] ? null : monthSummaryError
  const selectedWeekHighlightedDates = useMemo(
    () => buildWeekDateSet(selectedDate, timelineWeekStartDay),
    [selectedDate, timelineWeekStartDay],
  )
  const summaryWeekHighlightedDates = useMemo(() => {
    if (!isSummaryLikeView(activeView) || !weeklySummary) {
      return selectedWeekHighlightedDates
    }

    return new Set(weeklySummary.days.map((day) => day.date))
  }, [activeView, selectedWeekHighlightedDates, weeklySummary])
  const weekViewHighlightedDates = useMemo(() => {
    if (activeView !== 'week' || !weekTimeline) {
      return selectedWeekHighlightedDates
    }

    return new Set(weekTimeline.days.map((day) => day.date))
  }, [activeView, selectedWeekHighlightedDates, weekTimeline])
  const miniCalendarHighlightedDates = useMemo(
    () => {
      if (activeView === 'week') {
        return weekViewHighlightedDates
      }

      if (isSummaryLikeView(activeView)) {
        return summaryWeekHighlightedDates
      }

      return new Set<string>()
    },
    [activeView, summaryWeekHighlightedDates, weekViewHighlightedDates],
  )
  const selectedSummaryNotesContext = useMemo(() => {
    if (!weeklySummary || !summaryNotesModal) {
      return null
    }

    const row = weeklySummary.rows[summaryNotesModal.rowIndex]
    const day = weeklySummary.days[summaryNotesModal.dayIndex]
    if (!row || !day) {
      return null
    }

    const cell = row.cells[summaryNotesModal.dayIndex]
    if (!cell || cell.notes.length === 0) {
      return null
    }

    return {
      row,
      day,
      dayIndex: summaryNotesModal.dayIndex,
      notes: cell.notes,
    }
  }, [summaryNotesModal, weeklySummary])
  const resolvedSummaryLayoutState = useMemo(
    () => summaryLayoutState ?? buildDefaultSummaryLayoutState(),
    [summaryLayoutState],
  )
  const selectedSummaryLayoutPreset = useMemo(
    () => (
      resolvedSummaryLayoutState.presets.find(
        (preset) => preset.id === resolvedSummaryLayoutState.selectedPresetId,
      ) ?? resolvedSummaryLayoutState.presets[0]
    ),
    [resolvedSummaryLayoutState],
  )
  const resolvedReportingState = useMemo(
    () => reportingState ?? buildDefaultReportingState(),
    [reportingState],
  )
  const selectedReportingDisplayPreset = useMemo(
    () => (
      resolvedReportingState.displayPresets.find(
        (preset) => preset.id === resolvedReportingState.selectedDisplayPresetId,
      ) ?? resolvedReportingState.displayPresets[0]
    ),
    [resolvedReportingState],
  )
  const selectedReportingExportPreset = useMemo(
    () => (
      resolvedSummaryLayoutState.presets.find(
        (preset) => preset.id === resolvedReportingState.selectedExportPresetId,
      )
      ?? selectedSummaryLayoutPreset
      ?? resolvedSummaryLayoutState.presets[0]
    ),
    [resolvedReportingState.selectedExportPresetId, resolvedSummaryLayoutState, selectedSummaryLayoutPreset],
  )
  const engagementById = useMemo(() => {
    const values = new Map<string, Engagement>()
    for (const engagement of engagements) {
      values.set(engagement.id, engagement)
    }
    return values
  }, [engagements])
  const activityById = useMemo(() => {
    const values = new Map<string, Activity>()
    for (const engagement of engagements) {
      for (const activity of engagement.activities) {
        values.set(activity.id, activity)
      }
    }
    return values
  }, [engagements])
  const optimisticEntryDraftPreview = useMemo(
    () => (
      selectedEntry && entryDraft && selectedEntry.id === entryDraft.id
        ? buildOptimisticTimelineEntryPreview(
          selectedEntry,
          entryDraft,
          engagementById,
          activityById,
        )
        : null
    ),
    [activityById, engagementById, entryDraft, selectedEntry],
  )
  const quickAddPreferences = useMemo(
    () => sanitizeQuickAddPreferences(settingsStatus?.quickAddPreferences, engagements),
    [engagements, settingsStatus?.quickAddPreferences],
  )
  const quickAddSuggestionByKey = useMemo(() => {
    const values = new Map<string, QuickAddSuggestion>()
    for (const suggestion of quickAddSuggestionItems) {
      values.set(quickAddActivityKey(suggestion.engagementId, suggestion.activityId), suggestion)
    }

    return values
  }, [quickAddSuggestionItems])
  const allQuickAddActivities = useMemo<QuickAddActivityView[]>(() => {
    const values: QuickAddActivityView[] = []
    for (const engagement of engagements) {
      if (!engagement.isActive) {
        continue
      }

      for (const activity of engagement.activities) {
        if (!activity.isActive) {
          continue
        }

        const suggestion = quickAddSuggestionByKey.get(quickAddActivityKey(engagement.id, activity.id))
        values.push({
          engagement,
          activity,
          usageCount: suggestion?.usageCount ?? 0,
          lastUsedAt: suggestion?.lastUsedAt ?? null,
        })
      }
    }

    return values
  }, [engagements, quickAddSuggestionByKey])
  const quickAddActivityByKey = useMemo(() => {
    const values = new Map<string, QuickAddActivityView>()
    for (const item of allQuickAddActivities) {
      values.set(quickAddActivityKey(item.engagement.id, item.activity.id), item)
    }

    return values
  }, [allQuickAddActivities])
  useEffect(() => {
    setQuickAddSuggestedKeys((previous) => {
      if (previous.length === 0) {
        return previous
      }

      const next = previous.filter((key) => quickAddActivityByKey.has(key))

      return next.length === previous.length ? previous : next
    })
  }, [quickAddActivityByKey])
  const suggestedQuickAddActivities = useMemo(() => {
    const values: QuickAddActivityView[] = []
    const seenKeys = new Set<string>()

    for (const key of quickAddSuggestedKeys) {
      const item = quickAddActivityByKey.get(key)
      if (!item || seenKeys.has(key)) {
        continue
      }

      values.push(item)
      seenKeys.add(key)
    }

    for (const item of allQuickAddActivities) {
      const key = quickAddActivityKey(item.engagement.id, item.activity.id)
      if (seenKeys.has(key)) {
        continue
      }

      values.push(item)
      seenKeys.add(key)
    }

    return values
  }, [allQuickAddActivities, quickAddActivityByKey, quickAddSuggestedKeys])
  const orderedQuickAddActivities = useMemo(() => {
    const hiddenEngagementIds = new Set(quickAddPreferences.hiddenEngagementIds)
    const hiddenActivityIds = new Set(quickAddPreferences.hiddenActivityIds)
    const engagementOrderIndex = new Map(
      quickAddPreferences.engagementOrder.map((engagementId, index) => [engagementId, index]),
    )
    const hasCustomEngagementOrder = engagementOrderIndex.size > 0
    const suggestedActivityIndex = new Map(
      suggestedQuickAddActivities.map((item, index) => [
        quickAddActivityKey(item.engagement.id, item.activity.id),
        index,
      ]),
    )
    const engagementIndex = new Map(engagements.map((engagement, index) => [engagement.id, index]))
    const activityIndex = new Map<string, number>()

    for (const engagement of engagements) {
      engagement.activities.forEach((activity, index) => {
        activityIndex.set(activity.id, index)
      })
    }

    const groups = new Map<string, QuickAddActivityGroup>()
    for (const item of allQuickAddActivities) {
      if (
        hiddenEngagementIds.has(item.engagement.id)
        || hiddenActivityIds.has(item.activity.id)
      ) {
        continue
      }

      const existing = groups.get(item.engagement.id)
      if (existing) {
        existing.activities.push(item)
        continue
      }

      groups.set(item.engagement.id, {
        engagement: item.engagement,
        activities: [item],
      })
    }

    const orderedGroups = [...groups.values()].sort((left, right) => {
      if (hasCustomEngagementOrder) {
        const leftCustomIndex = engagementOrderIndex.get(left.engagement.id)
        const rightCustomIndex = engagementOrderIndex.get(right.engagement.id)
        if (leftCustomIndex !== undefined || rightCustomIndex !== undefined) {
          return (
            leftCustomIndex ?? Number.MAX_SAFE_INTEGER
          ) - (
            rightCustomIndex ?? Number.MAX_SAFE_INTEGER
          )
        }
      }

      const leftSuggestionIndex = Math.min(
        ...left.activities.map((item) =>
          suggestedActivityIndex.get(quickAddActivityKey(item.engagement.id, item.activity.id))
          ?? Number.MAX_SAFE_INTEGER,
        ),
      )
      const rightSuggestionIndex = Math.min(
        ...right.activities.map((item) =>
          suggestedActivityIndex.get(quickAddActivityKey(item.engagement.id, item.activity.id))
          ?? Number.MAX_SAFE_INTEGER,
        ),
      )

      if (leftSuggestionIndex !== rightSuggestionIndex) {
        return leftSuggestionIndex - rightSuggestionIndex
      }

      return (
        engagementIndex.get(left.engagement.id) ?? Number.MAX_SAFE_INTEGER
      ) - (
        engagementIndex.get(right.engagement.id) ?? Number.MAX_SAFE_INTEGER
      )
    })

    return orderedGroups.flatMap((group) => {
      const customActivityOrder = quickAddPreferences.activityOrder[group.engagement.id] ?? []
      const customActivityOrderIndex = new Map(
        customActivityOrder.map((activityId, index) => [activityId, index]),
      )
      const hasCustomActivityOrder = customActivityOrderIndex.size > 0

      return group.activities.slice().sort((left, right) => {
        if (hasCustomActivityOrder) {
          const leftCustomIndex = customActivityOrderIndex.get(left.activity.id)
          const rightCustomIndex = customActivityOrderIndex.get(right.activity.id)
          if (leftCustomIndex !== undefined || rightCustomIndex !== undefined) {
            return (
              leftCustomIndex ?? Number.MAX_SAFE_INTEGER
            ) - (
              rightCustomIndex ?? Number.MAX_SAFE_INTEGER
            )
          }
        }

        const leftSuggestionIndex =
          suggestedActivityIndex.get(quickAddActivityKey(left.engagement.id, left.activity.id))
          ?? Number.MAX_SAFE_INTEGER
        const rightSuggestionIndex =
          suggestedActivityIndex.get(quickAddActivityKey(right.engagement.id, right.activity.id))
          ?? Number.MAX_SAFE_INTEGER

        if (leftSuggestionIndex !== rightSuggestionIndex) {
          return leftSuggestionIndex - rightSuggestionIndex
        }

        return (
          activityIndex.get(left.activity.id) ?? Number.MAX_SAFE_INTEGER
        ) - (
          activityIndex.get(right.activity.id) ?? Number.MAX_SAFE_INTEGER
        )
      })
    })
  }, [
    allQuickAddActivities,
    engagements,
    quickAddPreferences,
    suggestedQuickAddActivities,
  ])
  const visibleQuickAddActivities = useMemo(() => {
    const searchTerms = quickAddSearch
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean)

    if (searchTerms.length === 0) {
      return orderedQuickAddActivities
    }

    return orderedQuickAddActivities.filter(({ engagement, activity }) => {
      const haystack = [
        engagement.code,
        engagement.name,
        activity.code,
        activity.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()

      return searchTerms.every((term) => haystack.includes(term))
    })
  }, [orderedQuickAddActivities, quickAddSearch])
  const quickAddActivityGroups = useMemo<QuickAddActivityGroup[]>(() => {
    const groups: QuickAddActivityGroup[] = []
    const groupByEngagementId = new Map<string, QuickAddActivityGroup>()

    for (const item of visibleQuickAddActivities) {
      let group = groupByEngagementId.get(item.engagement.id)
      if (!group) {
        group = {
          engagement: item.engagement,
          activities: [],
        }
        groupByEngagementId.set(item.engagement.id, group)
        groups.push(group)
      }

      group.activities.push(item)
    }

    return groups
  }, [visibleQuickAddActivities])
  const updateQuickAddScrollMetrics = useCallback(() => {
    const node = quickAddScrollRef.current

    if (!node) {
      setQuickAddScrollMetrics((previous) => (
        previous.canScroll
          ? { canScroll: false, thumbTopPct: 0, thumbHeightPct: 100 }
          : previous
      ))
      return
    }

    const scrollFrame = node.parentElement as HTMLElement | null
    const maxScrollTop = Math.max(node.scrollHeight - node.clientHeight, 0)
    const canScroll = maxScrollTop > 1

    if (!canScroll || node.scrollHeight <= 0 || node.clientHeight <= 0) {
      scrollFrame?.style.setProperty('--quick-add-scroll-thumb-top', '0%')
      scrollFrame?.style.setProperty('--quick-add-scroll-thumb-height', '100%')
      setQuickAddScrollMetrics((previous) => (
        previous.canScroll
          ? { canScroll: false, thumbTopPct: 0, thumbHeightPct: 100 }
          : previous
      ))
      return
    }

    const thumbHeightPct = Math.min(100, Math.max((node.clientHeight / node.scrollHeight) * 100, 18))
    const maxThumbTopPct = Math.max(100 - thumbHeightPct, 0)
    const thumbTopPct = Math.min(maxThumbTopPct, Math.max(0, (node.scrollTop / maxScrollTop) * maxThumbTopPct))

    scrollFrame?.style.setProperty('--quick-add-scroll-thumb-top', `${thumbTopPct}%`)
    scrollFrame?.style.setProperty('--quick-add-scroll-thumb-height', `${thumbHeightPct}%`)

    setQuickAddScrollMetrics((previous) => {
      if (previous.canScroll === canScroll) {
        return previous
      }

      return {
        canScroll,
        thumbTopPct,
        thumbHeightPct,
      }
    })
  }, [])
  useLayoutEffect(() => {
    updateQuickAddScrollMetrics()

    const node = quickAddScrollRef.current
    if (!node) {
      return undefined
    }

    let animationFrame: number | null = null
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }

      animationFrame = window.requestAnimationFrame(updateQuickAddScrollMetrics)
    }

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate)

    resizeObserver?.observe(node)
    if (node.firstElementChild) {
      resizeObserver?.observe(node.firstElementChild)
    }

    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [quickAddActivityGroups, updateQuickAddScrollMetrics])
  const reportingDayIndexes = useMemo(() => (
    buildReportingDisplayAllDayIndexes(weeklySummary)
  ), [weeklySummary])
  const reportingDisplayEditorDayIndexes = useMemo(() => (
    buildReportingDisplayAllDayIndexes(weeklySummary)
  ), [weeklySummary])
  const reportingDisplayDraftColumns = useMemo(
    () => resolveReportingDisplayColumns(reportingDisplayPresetDraft),
    [reportingDisplayPresetDraft],
  )
  const reportingDisplayDraftFieldCount = useMemo(
    () => reportingDisplayDraftColumns.filter((column) => column.kind === 'field').length,
    [reportingDisplayDraftColumns],
  )
  const reportingDisplayDraftFieldKeys = useMemo(
    () => new Set(reportingDisplayDraftColumns
      .filter((column): column is Extract<ReportingDisplayColumn, { kind: 'field' }> => column.kind === 'field')
      .map((column) => column.fieldKey)),
    [reportingDisplayDraftColumns],
  )
  useLayoutEffect(() => {
    const previousRects = reportingDisplayAnimationRectsRef.current
    if (!previousRects) {
      return
    }

    reportingDisplayAnimationRectsRef.current = null
    const dragState = reportingDisplayPointerDragStateRef.current
    if (dragState) {
      const previousRect = previousRects.get(
        `${dragState.surface}:${dragState.columnId}:0`,
      )
      const nextElement = getFirstReportingDisplayColumnElement(
        dragState.columnId,
        dragState.surface,
      )
      if (previousRect && nextElement) {
        const nextRect = nextElement.getBoundingClientRect()
        const deltaX = previousRect.left - nextRect.left
        const deltaY = previousRect.top - nextRect.top
        if (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5) {
          dragState.startClientX -= deltaX
          dragState.startClientY -= deltaY
          setReportingDisplayDragPreview((previous) => (
            previous
              && previous.columnId === dragState.columnId
              && previous.surface === dragState.surface
              ? {
                ...previous,
                offsetX: previous.offsetX + deltaX,
                offsetY: previous.offsetY + deltaY,
              }
              : previous
          ))
        }
      }
    }
    animateReportingDisplayColumnRects(previousRects)
  }, [reportingDisplayDraftColumns])
  const isReportingDisplayDraftDirty = useMemo(() => {
    if (!reportingDisplayPresetDraft || !reportingDisplayPresetModal) {
      return false
    }

    if (reportingDisplayPresetModal.mode === 'create' || !reportingDisplayPresetModal.presetId) {
      return true
    }

    const savedPreset = resolvedReportingState.displayPresets.find(
      (preset) => preset.id === reportingDisplayPresetModal.presetId,
    )

    return !savedPreset || !areReportingDisplayPresetDraftsEqual(
      savedPreset,
      savedPreset.name,
      reportingDisplayPresetDraft,
      reportingDisplayPresetDraftName,
    )
  }, [
    reportingDisplayPresetDraft,
    reportingDisplayPresetDraftName,
    reportingDisplayPresetModal,
    resolvedReportingState.displayPresets,
  ])
  const summaryLayoutPreviewRows = useMemo(
    () => weeklySummary?.rows.slice(0, 3) ?? [],
    [weeklySummary],
  )
  const reportingExportPreviewColumns = useMemo(
    () => buildReportingExportPreviewColumns(
      selectedReportingExportPreset,
      weeklySummary,
      reportingExportPreviewSheet,
    ),
    [reportingExportPreviewSheet, selectedReportingExportPreset, weeklySummary],
  )
  const reportingExportPreviewGridColumns = useMemo(
    () => reportingExportPreviewColumns
      .map(getReportingExportPreviewColumnWidth)
      .join(' '),
    [reportingExportPreviewColumns],
  )
  const reportingExportPreviewFooterLabelIndex = useMemo(
    () => reportingExportPreviewColumns.findIndex((column) => (
      column.kind !== 'dayHours'
      && column.kind !== 'dayNotes'
      && column.kind !== 'rowTotal'
    )),
    [reportingExportPreviewColumns],
  )
  const summaryLayoutDragTransforms = useMemo(
    () => buildSummaryLayoutDragTransforms(
      summaryLayoutDraft?.columns ?? [],
      summaryLayoutDragState,
    ),
    [summaryLayoutDraft, summaryLayoutDragState],
  )
  const activeSummaryLayoutDragPointerId = summaryLayoutDragState?.pointerId ?? null
  const llmSubmissionStatus = useMemo<LlmSubmissionStatus | null>(() => {
    const activeCount = submissionQueue.filter(isActiveSubmissionQueueItem).length
    if (activeCount > 0) {
      return {
        kind: 'processing',
        message: formatLlmSubmissionStatusMessage(activeCount, 'processing'),
      }
    }

    const createdCount = submissionQueue
      .filter((item) => item.state === 'success')
      .reduce((total, item) => total + (item.createdEntryCount ?? 0), 0)
    const zeroEntrySuccessCount = submissionQueue.filter((item) =>
      item.state === 'success' && item.createdEntryCount === 0
    ).length
    if (createdCount > 0) {
      return {
        kind: 'success',
        message: formatLlmSubmissionStatusMessage(createdCount, 'created'),
      }
    }

    if (zeroEntrySuccessCount > 0) {
      return {
        kind: 'success',
        message: zeroEntrySuccessCount === 1
          ? 'No open gaps found.'
          : `${zeroEntrySuccessCount} submissions completed with no open gaps found.`,
      }
    }

    const failedCount = submissionQueue.filter((item) => item.state === 'error').length
    if (failedCount > 0) {
      return {
        kind: 'error',
        message: formatLlmSubmissionStatusMessage(failedCount, 'failed'),
      }
    }

    return null
  }, [submissionQueue])

  const recordVoiceDiagnostic = useCallback((
    eventType: string,
    status: 'ok' | 'warning' | 'error',
    details: Record<string, unknown>,
  ) => {
    void diagnosticsRecordFrontendEvent({
      correlationId: voiceCaptureCorrelationIdRef.current ?? generateClientCorrelationId(),
      layer: 'frontend',
      eventType,
      command: 'voice_capture',
      status,
      detailsJson: JSON.stringify(details),
    })
  }, [])

  const clearVoiceCaptureTimeout = useCallback(() => {
    if (voiceCaptureTimeoutRef.current !== null) {
      window.clearTimeout(voiceCaptureTimeoutRef.current)
      voiceCaptureTimeoutRef.current = null
    }
  }, [])

  const stopVoiceCaptureStream = useCallback(() => {
    const stream = mediaStreamRef.current
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }

    mediaStreamRef.current = null
  }, [])

  const enqueueSubmissionQueueItem = useCallback(({
    rawText,
    submittedAtMs,
    clientTimestampIso,
    clientLocalDate,
    clientLocalTime,
    clientUtcOffsetMinutes,
    selectedDate,
    timezone,
    captureSource,
    transcriptionModelUsed,
    transcriptionDurationMs,
  }: {
    rawText: string
    submittedAtMs: number
    clientTimestampIso: string
    clientLocalDate: string
    clientLocalTime: string
    clientUtcOffsetMinutes: number
    selectedDate?: string
    timezone: string
    captureSource: CaptureSourceId
    transcriptionModelUsed?: TranscriptionModelId
    transcriptionDurationMs?: number
  }) => {
    const queueItem: SubmissionQueueItem = {
      id: generateSubmissionQueueId(),
      rawText,
      submittedAtMs,
      captureSource,
      requestedOpenAiModel: settingsStatus?.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
      clientTimestampIso,
      clientLocalDate,
      clientLocalTime,
      clientUtcOffsetMinutes,
      selectedDate,
      timezone,
      state: 'pending',
      transcriptionModelUsed,
      transcriptionDurationMs,
    }

    setSubmissionQueue((previous) => [...previous, queueItem])
  }, [settingsStatus])

  // When uncategorized time contributes to the primary total, keep it visible so
  // the displayed breakdown reconciles back to that total.
  const shouldShowTimelineUncategorizedDailyTotal =
    !timelineExcludeUncategorizedFromDailyTotals || timelineShowUncategorizedDailyTotal
  const timelineTotalPreferences = useMemo(
    () => ({
      includeExternalInTotals: timelineIncludeExternalInTotals,
      includeInternalInTotals: timelineIncludeInternalInTotals,
      excludeUncategorizedFromTotals: timelineExcludeUncategorizedFromDailyTotals,
    }),
    [
      timelineExcludeUncategorizedFromDailyTotals,
      timelineIncludeExternalInTotals,
      timelineIncludeInternalInTotals,
    ],
  )

  const timelineWindow = FULL_DAY_TIMELINE_WINDOW
  const currentTimelineMinute = (
    timelineClock.getHours() * HOUR_IN_MINUTES
    + timelineClock.getMinutes()
  )
  const currentTimelineTop = (
    TIMELINE_CANVAS_TOP_PADDING
    + (currentTimelineMinute - timelineWindow.startMinute) * PIXELS_PER_MINUTE
  )
  const currentTimelineLabel = minuteToCurrentTimeLabel(currentTimelineMinute)
  const isCurrentTimelineMinuteVisible =
    currentTimelineMinute >= timelineWindow.startMinute
    && currentTimelineMinute <= timelineWindow.endMinute
  const shouldShowDayCurrentTimeIndicator =
    selectedDate === todayDate && isCurrentTimelineMinuteVisible
  const timelineHeaderDate = useMemo(
    () => formatTimelineHeaderDate(selectedDate),
    [selectedDate],
  )

  const timelineWindowMinutes = timelineWindow.endMinute - timelineWindow.startMinute
  const timelineCanvasHeight = (
    timelineWindowMinutes * PIXELS_PER_MINUTE
      + TIMELINE_CANVAS_TOP_PADDING
      + TIMELINE_CANVAS_BOTTOM_PADDING
  )
  const timelinePositioningPreferences = useMemo(
    () => ({
      preferredLaneByEntryId: timelineLanePreferences.byEntryId,
      preferredLaneOrder: timelineLanePreferences.order,
    }),
    [timelineLanePreferences],
  )
  const baselinePositionedTimelineEntries = useMemo(
    () => positionTimelineEntries(
      timelineEntries,
      timelineWindow,
      timelinePositioningPreferences,
    ),
    [timelineEntries, timelinePositioningPreferences, timelineWindow],
  )
  const optimisticTimelineEntries = useMemo(
    () => applyOptimisticTimelineEntryPreview(
      timelineEntries,
      optimisticEntryDraftPreview,
      (entry) => entry.date === selectedDate,
    ),
    [optimisticEntryDraftPreview, selectedDate, timelineEntries],
  )
  const timelineEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(optimisticTimelineEntries, timelineDragState),
    [optimisticTimelineEntries, timelineDragState],
  )
  const timelineDayTotalBreakdown = useMemo(
    () => buildTimelineTotalBreakdown(
      timelineEntriesForLayout,
      timelineTotalPreferences,
    ),
    [timelineEntriesForLayout, timelineTotalPreferences],
  )
  const shouldShowTimelineDayUncategorizedDailyTotal =
    shouldShowTimelineUncategorizedDailyTotal
    && timelineDayTotalBreakdown.uncategorizedMinutes > 0
  const previewPositionedTimelineEntries = useMemo(
    () => positionTimelineEntries(
      timelineEntriesForLayout,
      timelineWindow,
      {
        ...timelinePositioningPreferences,
        ...(timelineDragState?.isDragging
          ? {
            lockedEntryId: timelineDragState.entryId,
            lockedLaneIndex: timelineDragState.lockedLaneIndex,
          }
          : {}),
      },
    ),
    [
      timelineDragState,
      timelineEntriesForLayout,
      timelinePositioningPreferences,
      timelineWindow,
    ],
  )
  const draggedEntryOriginPosition = useMemo(() => {
    if (!timelineDragState?.isDragging || timelineDragState.dragMode !== 'move') {
      return null
    }

    return baselinePositionedTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === timelineDragState.entryId,
    ) ?? null
  }, [baselinePositionedTimelineEntries, timelineDragState])
  const weekTimelineDays = useMemo(
    () => weekTimeline?.days ?? buildWeekViewDays(selectedDate, timelineWeekStartDay),
    [selectedDate, timelineWeekStartDay, weekTimeline],
  )
  const weekTimelineEntries = useMemo(
    () => weekTimeline?.entries ?? [],
    [weekTimeline],
  )
  const weekTimelineDateSet = useMemo(
    () => new Set(weekTimelineDays.map((day) => day.date)),
    [weekTimelineDays],
  )
  const optimisticWeekTimelineEntries = useMemo(
    () => applyOptimisticTimelineEntryPreview(
      weekTimelineEntries,
      optimisticEntryDraftPreview,
      (entry) => weekTimelineDateSet.has(entry.date),
    ),
    [optimisticEntryDraftPreview, weekTimelineDateSet, weekTimelineEntries],
  )
  const weekTimelineEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(optimisticWeekTimelineEntries, timelineDragState),
    [optimisticWeekTimelineEntries, timelineDragState],
  )
  const weekTimelineDayTotalBreakdowns = useMemo(
    () => buildTimelineDayTotalBreakdowns(
      weekTimelineEntriesForLayout,
      weekTimelineDays,
      timelineTotalPreferences,
    ),
    [
      timelineTotalPreferences,
      weekTimelineDays,
      weekTimelineEntriesForLayout,
    ],
  )
  const weekTimelineTotalBreakdown = useMemo(
    () => buildTimelineTotalBreakdown(
      weekTimelineEntriesForLayout,
      timelineTotalPreferences,
    ),
    [timelineTotalPreferences, weekTimelineEntriesForLayout],
  )
  const displayedSummaryWeekTotalBreakdown = useMemo(
    () => weeklySummary
      ? finalizeTimelineTotalBreakdown(weeklySummary.weekTotalBreakdown, timelineTotalPreferences)
      : null,
    [timelineTotalPreferences, weeklySummary],
  )
  const reportingWeeklyTotalSegments = useMemo(
    () => displayedSummaryWeekTotalBreakdown
      ? buildTimelineTotalDisplaySegments(displayedSummaryWeekTotalBreakdown, {
        includePrimaryTotal: true,
        separateEngagementTypeTotals: timelineSeparateEngagementTypeTotals,
        showUncategorizedTotal: shouldShowTimelineUncategorizedDailyTotal,
      })
      : [],
    [
      displayedSummaryWeekTotalBreakdown,
      shouldShowTimelineUncategorizedDailyTotal,
      timelineSeparateEngagementTypeTotals,
    ],
  )
  const baselinePositionedWeekTimelineEntries = useMemo(
    () => positionWeekTimelineEntries(
      weekTimelineEntries,
      weekTimelineDays,
      timelineWindow,
      weekTimelineLayoutMetrics,
      timelinePositioningPreferences,
      timelineDragState,
    ),
    [
      timelineDragState,
      weekTimelineLayoutMetrics,
      timelinePositioningPreferences,
      timelineWindow,
      weekTimelineDays,
      weekTimelineEntries,
    ],
  )
  const previewPositionedWeekTimelineEntries = useMemo(
    () => positionWeekTimelineEntries(
      weekTimelineEntriesForLayout,
      weekTimelineDays,
      timelineWindow,
      weekTimelineLayoutMetrics,
      timelinePositioningPreferences,
      timelineDragState,
    ),
    [
      timelineDragState,
      weekTimelineLayoutMetrics,
      timelinePositioningPreferences,
      timelineWindow,
      weekTimelineDays,
      weekTimelineEntriesForLayout,
    ],
  )
  const draggedWeekEntryOriginPosition = useMemo(() => {
    if (!timelineDragState?.isDragging || timelineDragState.dragMode !== 'move') {
      return null
    }

    return baselinePositionedWeekTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === timelineDragState.entryId,
    ) ?? null
  }, [baselinePositionedWeekTimelineEntries, timelineDragState])
  const currentWeekTimelineDayIndex = useMemo(
    () => weekTimelineDays.findIndex((day) => day.date === todayDate),
    [todayDate, weekTimelineDays],
  )
  const shouldShowWeekCurrentTimeIndicator =
    currentWeekTimelineDayIndex >= 0 && isCurrentTimelineMinuteVisible

  const timelineHourMarks = useMemo(() => {
    const marks: number[] = []
    const firstHourMark =
      Math.ceil(timelineWindow.startMinute / HOUR_IN_MINUTES) * HOUR_IN_MINUTES

    for (
      let minute = firstHourMark;
      minute <= timelineWindow.endMinute;
      minute += HOUR_IN_MINUTES
    ) {
      marks.push(minute)
    }
    return marks
  }, [timelineWindow.endMinute, timelineWindow.startMinute])

  const availableActivities = useMemo(() => {
    if (!entryDraft?.engagementId) {
      return [] as Activity[]
    }

    const engagement = engagements.find(
      (candidate) => candidate.id === entryDraft.engagementId,
    )

    return engagement?.activities ?? []
  }, [engagements, entryDraft])

  const engagementColorById = useMemo(() => {
    const values = new Map<string, string | null>()
    for (const engagement of engagements) {
      values.set(engagement.id, normalizeColorHexInput(engagement.colorHex))
    }
    return values
  }, [engagements])

  const activityColorById = useMemo(() => {
    const values = new Map<string, string | null>()
    for (const engagement of engagements) {
      for (const activity of engagement.activities) {
        values.set(activity.id, normalizeColorHexInput(activity.colorHex))
      }
    }
    return values
  }, [engagements])

  const calendarPendingCandidates = useMemo(
    () => calendarReviewCandidates.filter((candidate) => candidate.reviewState === 'pending'),
    [calendarReviewCandidates],
  )
  const calendarVisibleCandidates = useMemo(
    () =>
      calendarReviewCandidates.filter((candidate) =>
        candidate.reviewState === 'pending' || candidate.reviewState === 'accepted',
      ),
    [calendarReviewCandidates],
  )
  const calendarTimelineCandidates = useMemo(
    () =>
      calendarReviewCandidates.filter((candidate) =>
        candidate.reviewState === 'pending' || candidate.reviewState === 'accepted',
      ),
    [calendarReviewCandidates],
  )
  const calendarAcceptedCandidates = useMemo(
    () => calendarReviewCandidates.filter((candidate) => candidate.reviewState === 'accepted'),
    [calendarReviewCandidates],
  )
  const calendarIgnoredCandidates = useMemo(
    () =>
      calendarReviewCandidates.filter((candidate) =>
        candidate.reviewState === 'ignored' || candidate.reviewState === 'rejected',
      ),
    [calendarReviewCandidates],
  )
  const selectedCalendarCandidate = useMemo(
    () =>
      calendarVisibleCandidates.find((candidate) => candidate.id === selectedCalendarCandidateId)
      ?? calendarVisibleCandidates[0]
      ?? null,
    [calendarVisibleCandidates, selectedCalendarCandidateId],
  )
  const selectedCalendarCandidateIndex = useMemo(
    () =>
      selectedCalendarCandidate
        ? calendarVisibleCandidates.findIndex((candidate) => candidate.id === selectedCalendarCandidate.id)
        : -1,
    [calendarVisibleCandidates, selectedCalendarCandidate],
  )
  const calendarSelectedDate = selectedCalendarCandidate?.date ?? selectedDate
  const calendarCandidatesForSelectedDate = useMemo(
    () =>
      calendarTimelineCandidates.filter((candidate) => candidate.date === calendarSelectedDate),
    [calendarSelectedDate, calendarTimelineCandidates],
  )
  const calendarReviewTimelineEntries = useMemo(
    () => calendarCandidatesForSelectedDate.map((candidate) =>
      calendarCandidateToTimelineEntry(candidate),
    ),
    [calendarCandidatesForSelectedDate],
  )
  const calendarReviewDragState =
    timelineDragState?.surface === 'calendar-review' ? timelineDragState : null
  const calendarReviewEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(calendarReviewTimelineEntries, calendarReviewDragState),
    [calendarReviewDragState, calendarReviewTimelineEntries],
  )
  const baselinePositionedCalendarReviewEntries = useMemo(
    () => positionTimelineEntries(calendarReviewTimelineEntries, timelineWindow),
    [calendarReviewTimelineEntries, timelineWindow],
  )
  const calendarReviewAutoCenterKey = useMemo(
    () => [
      calendarSelectedDate,
      ...calendarCandidatesForSelectedDate.map((candidate) => candidate.id),
    ].join('|'),
    [calendarCandidatesForSelectedDate, calendarSelectedDate],
  )
  const positionedCalendarReviewEntries = useMemo(
    () => positionTimelineEntries(
      calendarReviewEntriesForLayout,
      timelineWindow,
      {
        ...(calendarReviewDragState?.isDragging
          ? {
              lockedEntryId: calendarReviewDragState.entryId,
              lockedLaneIndex: calendarReviewDragState.lockedLaneIndex,
            }
          : {}),
      },
    ),
    [calendarReviewDragState, calendarReviewEntriesForLayout, timelineWindow],
  )
  const selectedCalendarCandidateActivities = useMemo(() => {
    if (!selectedCalendarCandidate?.engagementId) {
      return [] as Activity[]
    }

    return engagements.find(
      (engagement) => engagement.id === selectedCalendarCandidate.engagementId,
    )?.activities ?? []
  }, [engagements, selectedCalendarCandidate])
  const selectedCalendarCandidateHasBlockingIssue =
    selectedCalendarCandidate
      ? hasCalendarCandidateBlockingIssue(selectedCalendarCandidate)
      : false
  const selectedCalendarCandidateCanSave = Boolean(
    selectedCalendarCandidate
    && !selectedCalendarCandidateHasBlockingIssue
    && (
      selectedCalendarCandidate.reviewState !== 'accepted'
      || selectedCalendarCandidate.savedEntryId
    ),
  )
  const calendarReadyToSaveCandidates = useMemo(
    () =>
      calendarPendingCandidates.filter((candidate) => !hasCalendarCandidateBlockingIssue(candidate)),
    [calendarPendingCandidates],
  )

  const selectedActivityEngagement = useMemo(
    () => engagements.find((engagement) => engagement.id === activityForm.engagementId) ?? null,
    [activityForm.engagementId, engagements],
  )
  const selectedCodesCreateActivityEngagement = useMemo(
    () =>
      engagements.find((engagement) => engagement.id === codesCreateActivityForm.engagementId)
      ?? null,
    [codesCreateActivityForm.engagementId, engagements],
  )
  const isEditingEngagement = codeEditorSurface === 'edit-engagement'
  const isEditingActivity = codeEditorSurface === 'edit-activity'
  const resolveCodesCreateActivityEngagementId = useCallback(() => {
    const hasEngagement = (id: string | null | undefined) =>
      Boolean(id && engagements.some((engagement) => engagement.id === id))

    if (codeEditorSurface === 'edit-engagement' && hasEngagement(engagementForm.id)) {
      return engagementForm.id ?? ''
    }

    if (codeEditorSurface === 'edit-activity' && hasEngagement(activityForm.engagementId)) {
      return activityForm.engagementId
    }

    if (activeView === 'codes' && hasEngagement(codesSelectedEngagementId)) {
      return codesSelectedEngagementId ?? ''
    }

    if (hasEngagement(codesCreateContextEngagementId)) {
      return codesCreateContextEngagementId ?? ''
    }

    return engagements.find((engagement) => engagement.isActive)?.id ?? engagements[0]?.id ?? ''
  }, [
    activityForm.engagementId,
    activeView,
    codeEditorSurface,
    codesSelectedEngagementId,
    codesCreateContextEngagementId,
    engagementForm.id,
    engagements,
  ])
  const selectedCodesEngagement = useMemo(
    () =>
      engagements.find((engagement) => engagement.id === codesSelectedEngagementId)
      ?? engagements[0]
      ?? null,
    [codesSelectedEngagementId, engagements],
  )
  const normalizedCodesEngagementSearch = codesEngagementSearch.trim().toLocaleLowerCase()
  const filteredCodesEngagements = useMemo(
    () => (
      normalizedCodesEngagementSearch.length === 0
        ? engagements
        : engagements.filter((engagement) =>
          codeEntitySearchText(engagement).includes(normalizedCodesEngagementSearch),
        )
    ),
    [engagements, normalizedCodesEngagementSearch],
  )
  const normalizedCodesActivitySearch = codesActivitySearch.trim().toLocaleLowerCase()
  const filteredCodesActivities = useMemo(
    () => {
      const activities = selectedCodesEngagement?.activities ?? []
      return normalizedCodesActivitySearch.length === 0
        ? activities
        : activities.filter((activity) =>
          activityCodeSearchText(activity).includes(normalizedCodesActivitySearch),
        )
    },
    [normalizedCodesActivitySearch, selectedCodesEngagement],
  )
  const codesIsEditing =
    (codesDetailMode === 'edit-engagement' && isEditingEngagement)
    || (codesDetailMode === 'edit-activity' && isEditingActivity)
  const selectedCodesEngagementName = selectedCodesEngagement
    ? selectedCodesEngagement.name.trim()
      || selectedCodesEngagement.code?.trim()
      || 'selected engagement'
    : ''
  const codesActivitiesHeading = selectedCodesEngagementName
    ? `Activities in ${selectedCodesEngagementName}`
    : 'Activities'

  const engagementFormColorValue = normalizeColorHexInput(engagementForm.colorHex)
  const activityFormColorValue = normalizeColorHexInput(activityForm.colorHex)
  const selectedEngagementColorValue = normalizeColorHexInput(selectedActivityEngagement?.colorHex)
  const codesCreateEngagementColorValue =
    normalizeColorHexInput(codesCreateEngagementForm.colorHex)
  const codesCreateActivityColorValue =
    normalizeColorHexInput(codesCreateActivityForm.colorHex)
  const selectedCodesCreateEngagementColorValue =
    normalizeColorHexInput(selectedCodesCreateActivityEngagement?.colorHex)

  useEffect(() => {
    const defaultEngagementId = getDefaultActivityEngagementId(engagements)
    if (!defaultEngagementId) {
      setCodesSelectedEngagementId(null)
      setCodesDetailMode('activities')
      return
    }

    setCodesSelectedEngagementId((previous) => (
      previous && engagements.some((engagement) => engagement.id === previous)
        ? previous
        : defaultEngagementId
    ))
  }, [engagements])

  const closeCodeEditor = useCallback(() => {
    setEngagementForm(EMPTY_ENGAGEMENT_FORM)
    setHasManualEngagementTypeSelection(false)
    setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
    setCodeEditorSurface(null)
    setCodesDetailMode('activities')
  }, [engagements])

  const openCodesCreateEngagementModal = useCallback(() => {
    setCodesCreateStep('engagement')
    setCodesCreateEngagementForm(EMPTY_ENGAGEMENT_FORM)
    setHasManualCodesCreateEngagementTypeSelection(false)
    setCodesCreateNotice(null)
    setIsCodesCreateModalOpen(true)
  }, [])

  const openCodesCreateActivityModal = useCallback(() => {
    const engagementId = resolveCodesCreateActivityEngagementId()
    setCodesCreateStep('activity')
    setCodesCreateActivityForm(buildEmptyActivityForm(engagementId))
    setCodesCreateNotice(null)
    setIsCodesCreateModalOpen(true)
  }, [resolveCodesCreateActivityEngagementId])

  const openCodesCreateEngagementFromPane = useCallback(() => {
    setCodesDetailMode('activities')
    openCodesCreateEngagementModal()
  }, [openCodesCreateEngagementModal])

  const openCodesCreateActivityFromPane = useCallback(() => {
    const engagementId = selectedCodesEngagement?.id ?? resolveCodesCreateActivityEngagementId()
    setCodesCreateContextEngagementId(engagementId || null)
    setCodesDetailMode('activities')
    setCodesCreateStep('activity')
    setCodesCreateActivityForm(buildEmptyActivityForm(engagementId))
    setCodesCreateNotice(null)
    setIsCodesCreateModalOpen(true)
  }, [resolveCodesCreateActivityEngagementId, selectedCodesEngagement?.id])

  const closeCodesCreateModal = useCallback(() => {
    setIsCodesCreateModalOpen(false)
    setCodesCreateStep('engagement')
    setCodesCreateEngagementForm(EMPTY_ENGAGEMENT_FORM)
    setHasManualCodesCreateEngagementTypeSelection(false)
    setCodesCreateActivityForm(buildEmptyActivityForm(''))
    setCodesCreateNotice(null)
  }, [])

  useEffect(() => {
    if (!isCodesCreateModalOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy) {
        closeCodesCreateModal()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeCodesCreateModal, isBusy, isCodesCreateModalOpen])

  useEffect(() => {
    if (!isCodesCreateModalOpen || codesCreateStep !== 'activity') {
      return
    }

    setCodesCreateActivityForm((previous) => {
      if (
        previous.engagementId
        && engagements.some((engagement) => engagement.id === previous.engagementId)
      ) {
        return previous
      }

      const nextEngagementId = resolveCodesCreateActivityEngagementId()
      return previous.engagementId === nextEngagementId
        ? previous
        : { ...previous, engagementId: nextEngagementId }
    })
  }, [
    codesCreateStep,
    engagements,
    isCodesCreateModalOpen,
    resolveCodesCreateActivityEngagementId,
  ])

  useEffect(() => {
    if (isEditingEngagement && engagementForm.id) {
      const engagementStillExists = engagements.some((engagement) => engagement.id === engagementForm.id)
      if (!engagementStillExists) {
        setEngagementForm(EMPTY_ENGAGEMENT_FORM)
        setHasManualEngagementTypeSelection(false)
        setCodeEditorSurface(null)
      }
      return
    }

    if (!isEditingActivity) {
      return
    }

    if (engagements.length === 0) {
      setActivityForm(EMPTY_ACTIVITY_FORM)
      setCodeEditorSurface(null)
      return
    }

    const hasSelectedEngagement = engagements.some(
      (engagement) => engagement.id === activityForm.engagementId,
    )

    if (activityForm.id) {
      const activityStillExists = engagements.some((engagement) =>
        engagement.activities.some((activity) => activity.id === activityForm.id),
      )

      if (!activityStillExists || !hasSelectedEngagement) {
        setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
        setCodeEditorSurface(null)
      }

      return
    }
  }, [
    activityForm.engagementId,
    activityForm.id,
    engagementForm.id,
    engagements,
    isEditingActivity,
    isEditingEngagement,
  ])

  const loadEngagements = useCallback(async () => {
    const values = await engagementList()
    setEngagements(values)
    setActivityForm((previous) => {
      if (previous.engagementId || values.length === 0) {
        return previous
      }

      return {
        ...previous,
        engagementId: values[0].id,
      }
    })
    return values
  }, [])

  const loadSettings = useCallback(async () => {
    const status = await settingsGetStatus()
    setSettingsStatus(status)
    setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
    setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
    setSelectedTranscriptionModelDraft(status.selectedTranscriptionModel)
    setCalendarIgnoredKeywordDraft(status.calendarBulkIgnoredKeywords.join('\n'))
  }, [])

  const loadSummaryLayoutState = useCallback(async () => {
    const value = await summaryLayoutStateGet()
    setSummaryLayoutState(value)
    return value
  }, [])

  const loadReportingState = useCallback(async () => {
    const value = await reportingStateGet()
    setReportingState(value)
    return value
  }, [])

  const loadTimeline = useCallback(async (date: string) => {
    const entries = await timelineListForDate({ date })
    lastLoadedTimelineDateRef.current = date
    setTimelineEntries(entries)
    return entries
  }, [])

  const loadWeekTimeline = useCallback(async (date: string) => {
    const value = await timelineListForWeekView({ date })
    setWeekTimeline(value)
    return value
  }, [])

  const loadTimelineMonthSummary = useCallback(async (month: string) => {
    const rows = await timelineMonthSummary({ month })
    setMonthSummaryCache((previous) => ({
      ...previous,
      [month]: rows,
    }))
    setStaleMonthSummaryKeys((previous) => {
      if (!previous.has(month)) {
        return previous
      }

      const next = new Set(previous)
      next.delete(month)
      return next
    })
    return rows
  }, [])

  const loadWeeklySummary = useCallback(async (date: string) => {
    const summary = await timelineWeeklySummary({ date })
    setWeeklySummary(summary)
    return summary
  }, [])

  const loadQuickAddSuggestions = useCallback(async () => {
    setQuickAddSuggestionsError(null)

    try {
      const value = await quickAddSuggestions()
      setQuickAddSuggestionItems(value.suggestions)
      setQuickAddSuggestedKeys((previous) => {
        const incomingKeys = value.suggestions.map((suggestion) =>
          quickAddActivityKey(suggestion.engagementId, suggestion.activityId),
        )

        if (previous.length === 0) {
          return incomingKeys
        }

        const next = previous.slice()
        const seenKeys = new Set(next)

        for (const key of incomingKeys) {
          if (!seenKeys.has(key)) {
            next.push(key)
            seenKeys.add(key)
          }
        }

        return next
      })
      return value
    } catch (error) {
      setQuickAddSuggestionsError(extractErrorMessage(error))
      return null
    }
  }, [])

  const invalidateMonthSummaries = useCallback((monthKeys: string[]) => {
    const uniqueMonthKeys = uniqueIds(monthKeys)
    if (uniqueMonthKeys.length === 0) {
      return
    }

    setStaleMonthSummaryKeys((previous) => {
      let changed = false
      const next = new Set(previous)

      for (const monthKey of uniqueMonthKeys) {
        if (!next.has(monthKey)) {
          next.add(monthKey)
          changed = true
        }
      }

      return changed ? next : previous
    })
  }, [])

  const loadDiagnostics = useCallback(async (filter: DiagnosticsFilter) => {
    const events = await diagnosticsList({
      limit: 100,
      filter: filter === 'all' ? undefined : filter,
    })
    setDiagnosticsEvents(events)
  }, [])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | null = null

    void listen<{ touchedMonthKeys?: string[] }>(
      QUICK_ADD_SUBMITTED_EVENT,
      (event) => {
        const refreshDate = selectedDateRef.current
        const touchedMonthKeys = event.payload?.touchedMonthKeys
        invalidateMonthSummaries(
          touchedMonthKeys && touchedMonthKeys.length > 0
            ? touchedMonthKeys
            : [monthKeyFromDate(refreshDate)],
        )

        void Promise.allSettled([
          loadTimeline(refreshDate),
          loadWeekTimeline(refreshDate),
          loadWeeklySummary(refreshDate),
          loadQuickAddSuggestions(),
        ])
      },
    ).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten()
        return
      }

      unlisten = nextUnlisten
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [
    invalidateMonthSummaries,
    loadTimeline,
    loadWeekTimeline,
    loadWeeklySummary,
    loadQuickAddSuggestions,
    tauriRuntime,
  ])

  useEffect(() => {
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null

    const scheduleNextMinuteTick = () => {
      const now = new Date()
      const millisecondsUntilNextMinute = (
        (HOUR_IN_MINUTES - now.getSeconds()) * 1000
        - now.getMilliseconds()
      )

      timeoutId = window.setTimeout(() => {
        setTimelineClock(new Date())
        scheduleNextMinuteTick()
      }, Math.max(1000, millisecondsUntilNextMinute + 20))
    }

    scheduleNextMinuteTick()

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [])

  useEffect(() => {
    if (!appRuntime) {
      return
    }

    const initialize = async () => {
      try {
        setIsBusy(true)
        await Promise.all([
          loadEngagements(),
          loadQuickAddSuggestions(),
          loadSettings(),
          loadSummaryLayoutState(),
          loadReportingState(),
          loadTimeline(todayDate),
          loadDiagnostics('all'),
        ])
        hasInitializedRef.current = true
      } catch (error) {
        setErrorMessage((error as Error).message)
      } finally {
        setIsBusy(false)
      }
    }

    void initialize()
  }, [
    loadDiagnostics,
    loadEngagements,
    loadQuickAddSuggestions,
    loadReportingState,
    loadSettings,
    loadSummaryLayoutState,
    loadTimeline,
    appRuntime,
    todayDate,
  ])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQuery = window.matchMedia(WEEK_TIMELINE_COMPACT_MEDIA_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactWeekTimeline(event.matches)
    }

    setIsCompactWeekTimeline(mediaQuery.matches)

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [])

  useEffect(() => {
    if (!appRuntime || !hasInitializedRef.current) {
      return
    }

    if (lastLoadedTimelineDateRef.current === selectedDate) {
      return
    }

    void (async () => {
      try {
        setIsTimelineLoading(true)
        setErrorMessage(null)
        await loadTimeline(selectedDate)
      } catch (error) {
        if (isAppCommandError(error)) {
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setErrorMessage((error as Error).message)
        }
      } finally {
        setIsTimelineLoading(false)
      }
    })()
  }, [appRuntime, loadTimeline, selectedDate])

  useEffect(() => () => {
    if (calendarImagePreviewUrl) {
      URL.revokeObjectURL(calendarImagePreviewUrl)
    }
  }, [calendarImagePreviewUrl])

  useEffect(() => {
    if (!appRuntime) {
      return
    }

    if (hasVisibleMonthSummary && !isVisibleMonthSummaryStale) {
      return
    }

    let cancelled = false
    const requestedMonth = visibleMonth

    void (async () => {
      try {
        setMonthSummaryLoadingMonth(requestedMonth)
        setMonthSummaryError(null)
        await loadTimelineMonthSummary(requestedMonth)
        if (cancelled) {
          return
        }
      } catch (error) {
        if (cancelled) {
          return
        }
        setMonthSummaryError((error as Error).message)
      } finally {
        setMonthSummaryLoadingMonth((previous) => (
          previous === requestedMonth ? null : previous
        ))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    appRuntime,
    hasVisibleMonthSummary,
    isVisibleMonthSummaryStale,
    loadTimelineMonthSummary,
    visibleMonth,
  ])

  useEffect(() => {
    if (selectedEntryId && loadedTimelineEntries.every((entry) => entry.id !== selectedEntryId)) {
      setSelectedEntryId(null)
      setEntryDraft(null)
    }

    if (highlightedEntryId && loadedTimelineEntries.every((entry) => entry.id !== highlightedEntryId)) {
      setHighlightedEntryId(null)
    }

    if (
      timelineContextMenu
      && timelineContextMenu.kind === 'entry'
      && timelineContextMenu.surface !== 'calendar-review'
      && timelineContextMenu.entryId
      && loadedTimelineEntries.every((entry) => entry.id !== timelineContextMenu.entryId)
    ) {
      setTimelineContextMenu(null)
    }
  }, [highlightedEntryId, loadedTimelineEntries, selectedEntryId, timelineContextMenu])

  useEffect(() => {
    if (!timelineContextMenu) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        setTimelineContextMenu(null)
        return
      }

      if (timelineContextMenuRef.current?.contains(target)) {
        return
      }

      setTimelineContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTimelineContextMenu(null)
      }
    }

    const handleViewportChange = () => {
      setTimelineContextMenu(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [timelineContextMenu])

  useEffect(() => {
    if (!appRuntime || activeView !== 'diagnostics') {
      return
    }

    void loadDiagnostics(diagnosticsFilter)
  }, [activeView, appRuntime, diagnosticsFilter, loadDiagnostics])

  useEffect(() => {
    if (!settingsStatus || showDiagnosticsTab || activeView !== 'diagnostics') {
      return
    }

    setActiveView('settings')
  }, [activeView, settingsStatus, showDiagnosticsTab])

  useEffect(() => {
    if (!appRuntime || !hasInitializedRef.current || activeView !== 'week') {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        setIsWeekTimelineLoading(true)
        setWeekTimelineError(null)
        await loadWeekTimeline(selectedDate)
      } catch (error) {
        if (cancelled) {
          return
        }
        if (isAppCommandError(error)) {
          setWeekTimelineError(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setWeekTimelineError((error as Error).message)
        }
      } finally {
        if (!cancelled) {
          setIsWeekTimelineLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeView, appRuntime, loadWeekTimeline, selectedDate])

  useEffect(() => {
    if (!appRuntime || !hasInitializedRef.current || !isSummaryLikeView(activeView)) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        setIsWeeklySummaryLoading(true)
        setWeeklySummaryError(null)
        await loadWeeklySummary(selectedDate)
      } catch (error) {
        if (cancelled) {
          return
        }
        if (isAppCommandError(error)) {
          setWeeklySummaryError(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setWeeklySummaryError((error as Error).message)
        }
      } finally {
        if (!cancelled) {
          setIsWeeklySummaryLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeView, appRuntime, loadWeeklySummary, selectedDate])

  useEffect(() => {
    if (
      activeView !== 'timeline'
      && activeView !== 'week'
      && timelineContextMenu
      && timelineContextMenu.surface !== 'calendar-review'
    ) {
      setTimelineContextMenu(null)
    }
  }, [activeView, timelineContextMenu])

  useEffect(() => {
    if (!isSummaryLikeView(activeView) && summaryNotesModal) {
      setSummaryNotesModal(null)
    }
  }, [activeView, summaryNotesModal])

  useEffect(() => {
    if (activeView !== 'reporting' && summaryLayoutModal) {
      resetSummaryLayoutEditor()
    }
  }, [activeView, resetSummaryLayoutEditor, summaryLayoutModal])

  useEffect(() => {
    if (activeView !== 'reporting' && reportingDisplayPresetModal) {
      resetReportingDisplayPresetEditor()
    }
  }, [activeView, reportingDisplayPresetModal, resetReportingDisplayPresetEditor])

  useEffect(() => {
    if (activeView !== 'reporting') {
      setIsReportingExportModalOpen(false)
    }
  }, [activeView])

  useEffect(() => {
    if (!isReportingExportModalOpen) {
      return
    }

    setReportingExportPreviewSheet('weeklyHours')
  }, [isReportingExportModalOpen])

  useEffect(() => {
    if (!isReportingExportModalOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (summaryLayoutModal || reportingDisplayPresetModal) {
          return
        }
        setIsReportingExportModalOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isReportingExportModalOpen, reportingDisplayPresetModal, summaryLayoutModal])

  useEffect(() => {
    if (!summaryNotesModal) {
      return
    }

    if (!selectedSummaryNotesContext) {
      setSummaryNotesModal(null)
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSummaryNotesModal(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedSummaryNotesContext, summaryNotesModal])

  useEffect(() => {
    if (!summaryLayoutModal) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        resetSummaryLayoutEditor()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [resetSummaryLayoutEditor, summaryLayoutModal])

  useLayoutEffect(() => {
    if (summaryLayoutDropCommitColumnIds.length === 0) {
      return
    }

    if (summaryLayoutDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(summaryLayoutDropCommitFrameRef.current)
    }

    summaryLayoutDropCommitFrameRef.current = window.requestAnimationFrame(() => {
      summaryLayoutDropCommitFrameRef.current = null
      setSummaryLayoutDropCommitColumnIds([])
    })
  }, [summaryLayoutDropCommitColumnIds])

  useLayoutEffect(() => {
    if (quickAddSettingsDropCommitKeys.length === 0) {
      return
    }

    if (quickAddSettingsDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(quickAddSettingsDropCommitFrameRef.current)
    }

    quickAddSettingsDropCommitFrameRef.current = window.requestAnimationFrame(() => {
      quickAddSettingsDropCommitFrameRef.current = null
      setQuickAddSettingsDropCommitKeys([])
    })
  }, [quickAddSettingsDropCommitKeys])

  useEffect(() => () => {
    if (summaryLayoutDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(summaryLayoutDropCommitFrameRef.current)
    }
    if (quickAddSettingsDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(quickAddSettingsDropCommitFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (activeSummaryLayoutDragPointerId === null || !summaryLayoutDraft) {
      return
    }

    const finishDrag = (pointerId: number, shouldCommit: boolean) => {
      const current = summaryLayoutDragStateRef.current
      if (!current || current.pointerId !== pointerId) {
        return
      }

      releaseSummaryLayoutPointerCapture(pointerId)
      commitSummaryLayoutDragState(null)

      if (shouldCommit && current.insertionIndex !== current.sourceIndex) {
        const currentDragTransforms = buildSummaryLayoutDragTransforms(summaryLayoutDraft.columns, current)
        const commitResetColumnIds = summaryLayoutDraft.columns
          .filter((column) => Math.abs(currentDragTransforms.get(column.id) ?? 0) > 0.5)
          .map((column) => column.id)
        const nextColumns = moveSummaryLayoutColumn(
          summaryLayoutDraft.columns,
          current.sourceIndex,
          current.insertionIndex,
        )

        setSummaryLayoutDropCommitColumnIds(commitResetColumnIds)

        setSummaryLayoutDraft((previous) => {
          if (!previous) {
            return previous
          }

          return {
            ...previous,
            columns: nextColumns,
          }
        })
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      const current = summaryLayoutDragStateRef.current
      if (!current || event.pointerId !== current.pointerId) {
        return
      }

      const nextInsertionIndex = findSummaryLayoutInsertionIndex(event.clientX, current)
      commitSummaryLayoutDragState({
        ...current,
        latestClientX: event.clientX,
        insertionIndex: nextInsertionIndex,
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      finishDrag(event.pointerId, true)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      finishDrag(event.pointerId, false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [
    activeSummaryLayoutDragPointerId,
    commitSummaryLayoutDragState,
    releaseSummaryLayoutPointerCapture,
    summaryLayoutDraft,
  ])

  useEffect(() => {
    if (activeView !== 'timeline') {
      return
    }

    const grid = timelineGridRef.current
    if (!grid) {
      return
    }

    if (lastLoadedTimelineDateRef.current !== selectedDate) {
      return
    }

    if (pendingAutoCenterDateRef.current !== selectedDate) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      if (selectedDate === todayDate && isCurrentTimelineMinuteVisible) {
        const clampedScrollTop = centerTimelinePositionScrollTop(grid, currentTimelineTop)

        grid.scrollTo({
          top: clampedScrollTop,
          behavior: 'auto',
        })
        pendingAutoCenterDateRef.current = null
        return
      }

      if (baselinePositionedTimelineEntries.length === 0) {
        grid.scrollTop = 0
        pendingAutoCenterDateRef.current = null
        return
      }

      const earliestEntry = baselinePositionedTimelineEntries.reduce((earliest, current) =>
        current.top < earliest.top ? current : earliest,
      )
      const targetTop = (
        earliestEntry.top
        - (grid.clientHeight / 2)
        + (earliestEntry.height / 2)
      )
      const clampedScrollTop = clampTimelineScrollTop(grid, targetTop)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'auto',
      })
      pendingAutoCenterDateRef.current = null
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [
    activeView,
    baselinePositionedTimelineEntries,
    currentTimelineTop,
    isCurrentTimelineMinuteVisible,
    selectedDate,
    timelineAutoCenterRequestKey,
    todayDate,
  ])

  useEffect(() => {
    if (activeView !== 'week') {
      return
    }

    if (!isCurrentTimelineMinuteVisible || currentWeekTimelineDayIndex < 0) {
      weekCurrentTimeAutoCenterKeyRef.current = null
      return
    }

    const grid = weekTimelineGridRef.current
    if (!grid) {
      return
    }

    const weekStartDate = weekTimelineDays[0]?.date ?? selectedDate
    const weekEndDate = weekTimelineDays[6]?.date ?? selectedDate
    const autoCenterKey = [
      weekStartDate,
      weekEndDate,
      todayDate,
      timelineAutoCenterRequestKey,
    ].join(':')

    if (weekCurrentTimeAutoCenterKeyRef.current === autoCenterKey) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const currentTimeTopInGrid =
        weekTimelineLayoutMetrics.headerHeight + currentTimelineTop
      const clampedScrollTop = centerTimelinePositionScrollTop(grid, currentTimeTopInGrid)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'auto',
      })
      weekCurrentTimeAutoCenterKeyRef.current = autoCenterKey
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [
    activeView,
    currentTimelineTop,
    currentWeekTimelineDayIndex,
    isCurrentTimelineMinuteVisible,
    selectedDate,
    timelineAutoCenterRequestKey,
    todayDate,
    weekTimelineDays,
    weekTimelineLayoutMetrics.headerHeight,
  ])

  useEffect(() => {
    if (!isCalendarBulkModalOpen || calendarBulkTab !== 'review') {
      return
    }

    const grid = calendarReviewTimelineGridRef.current
    if (!grid) {
      return
    }

    if (calendarReviewAutoCenterKeyRef.current === calendarReviewAutoCenterKey) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      if (baselinePositionedCalendarReviewEntries.length === 0) {
        grid.scrollTop = 0
        calendarReviewAutoCenterKeyRef.current = calendarReviewAutoCenterKey
        return
      }

      const earliestEntry = baselinePositionedCalendarReviewEntries.reduce((earliest, current) =>
        current.top < earliest.top ? current : earliest,
      )
      const targetTop = (
        earliestEntry.top
        - (grid.clientHeight / 2)
        + (earliestEntry.height / 2)
      )
      const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
      const clampedScrollTop = Math.min(Math.max(0, targetTop), maxScrollTop)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'auto',
      })
      calendarReviewAutoCenterKeyRef.current = calendarReviewAutoCenterKey
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [
    baselinePositionedCalendarReviewEntries,
    calendarBulkTab,
    calendarReviewAutoCenterKey,
    isCalendarBulkModalOpen,
  ])

  useEffect(() => {
    if (!successMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null)
    }, SYSTEM_NOTICE_AUTO_DISMISS_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [successMessage])

  useEffect(() => {
    if (!errorMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setErrorMessage(null)
    }, SYSTEM_NOTICE_AUTO_DISMISS_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [errorMessage])

  const trimSubmissionQueue = useCallback((items: SubmissionQueueItem[]) => {
    const now = Date.now()
    return items.filter((item) => {
      if (isActiveSubmissionQueueItem(item)) {
        return true
      }

      if (!isFinishedSubmissionQueueItem(item)) {
        return false
      }

      const completedAtMs = item.completedAtMs ?? item.submittedAtMs
      return now - completedAtMs < LLM_SUBMISSION_STATUS_DISMISS_MS
    })
  }, [])

  useEffect(() => {
    const finishedItems = submissionQueue.filter(isFinishedSubmissionQueueItem)
    if (finishedItems.length === 0) {
      return
    }

    const now = Date.now()
    const nextDismissAt = Math.min(
      ...finishedItems.map((item) =>
        (item.completedAtMs ?? item.submittedAtMs) + LLM_SUBMISSION_STATUS_DISMISS_MS,
      ),
    )
    const timeoutId = window.setTimeout(() => {
      setSubmissionQueue((previous) => trimSubmissionQueue(previous))
    }, Math.max(0, nextDismissAt - now))

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [submissionQueue, trimSubmissionQueue])

  useEffect(() => {
    if (!codesCreateNotice) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCodesCreateNotice(null)
    }, SYSTEM_NOTICE_AUTO_DISMISS_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [codesCreateNotice])

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([
      loadEngagements(),
      loadTimeline(selectedDate),
      loadWeekTimeline(selectedDate),
      loadSettings(),
      loadWeeklySummary(selectedDate),
      loadQuickAddSuggestions(),
    ])
  }, [
    loadEngagements,
    loadQuickAddSuggestions,
    loadSettings,
    loadTimeline,
    loadWeekTimeline,
    loadWeeklySummary,
    selectedDate,
  ])

  const runAction = useCallback(
    async (action: () => Promise<void>, options?: RunActionOptions) => {
      try {
        setIsBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        await action()
      } catch (error) {
        if (options?.formatError) {
          setErrorMessage(options.formatError(error))
          return
        }

        setErrorMessage(formatActionErrorMessage(error))
      } finally {
        setIsBusy(false)
      }
    },
    [],
  )

  const runTimelineMutation = useCallback(
    async (action: () => Promise<void>, options?: RunActionOptions) => {
      if (timelineMutationInFlightRef.current) {
        return
      }

      try {
        timelineMutationInFlightRef.current = true
        setErrorMessage(null)
        setSuccessMessage(null)
        await action()
      } catch (error) {
        if (options?.formatError) {
          setErrorMessage(options.formatError(error))
          return
        }

        setErrorMessage(formatActionErrorMessage(error))
      } finally {
        timelineMutationInFlightRef.current = false
      }
    },
    [],
  )

  const setTimelineDragStateWithRef = useCallback(
    (updater: (previous: TimelineDragState | null) => TimelineDragState | null) => {
      setTimelineDragState((previous) => {
        const next = updater(previous)
        timelineDragStateRef.current = next
        return next
      })
    },
    [],
  )

  const setQuickBlockDragStateWithRef = useCallback(
    (updater: (previous: QuickBlockDragState | null) => QuickBlockDragState | null) => {
      setQuickBlockDragState((previous) => {
        const next = updater(previous)
        quickBlockDragStateRef.current = next
        return next
      })
    },
    [],
  )

  const clearTimelineSelection = useCallback(() => {
    if (entryDraftAutoSaveTimeoutRef.current !== null) {
      window.clearTimeout(entryDraftAutoSaveTimeoutRef.current)
      entryDraftAutoSaveTimeoutRef.current = null
    }
    entryDraftLastSavedKeyRef.current = null
    setEntryAutoSaveStatus('idle')
    setSelectedEntryId(null)
    setHighlightedEntryId(null)
    setEntryDraft(null)
    setTimelineContextMenu(null)
    setTimelineDragStateWithRef(() => null)
  }, [setTimelineDragStateWithRef])

  const requestTimelineAutoCenter = useCallback((date: string) => {
    pendingAutoCenterDateRef.current = date
    setTimelineAutoCenterRequestKey((previous) => previous + 1)
  }, [])

  const updateSelectedDate = useCallback((
    nextDate: string,
    options?: {
      clearSelection?: boolean
    },
  ) => {
    if (nextDate === selectedDateRef.current) {
      return
    }

    pendingAutoCenterDateRef.current = nextDate
    selectedDateRef.current = nextDate
    setSelectedDate(nextDate)
    setVisibleMonth(monthKeyFromDate(nextDate))

    if (options?.clearSelection === false) {
      return
    }

    clearTimelineSelection()
  }, [clearTimelineSelection])

  const commitTimelineDragDrop = useCallback(
    (dragState: TimelineDragState) => {
      if (dragState.surface === 'calendar-review') {
        const candidateId = getCalendarCandidateIdFromTimelineEntryId(dragState.entryId)
        const draggedCandidate = candidateId
          ? calendarReviewCandidates.find((candidate) => candidate.id === candidateId)
          : null
        if (!candidateId || !draggedCandidate) {
          setTimelineDragStateWithRef(() => null)
          return
        }

        const hasMoved =
          dragState.previewDate !== dragState.originalDate
          || dragState.previewStartMinute !== dragState.originalStartMinute
          || dragState.previewEndMinute !== dragState.originalEndMinute
        if (!hasMoved) {
          setTimelineDragStateWithRef(() => null)
          return
        }

        const nextDurationMinutes = Math.max(
          dragState.previewEndMinute - dragState.previewStartMinute,
          TIMELINE_DRAG_SNAP_MINUTES,
        )
        setCalendarReviewCandidates((previous) =>
          previous.map((candidate) =>
            candidate.id === candidateId
              ? {
                  ...candidate,
                  date: dragState.previewDate,
                  startMinute: dragState.previewStartMinute,
                  endMinute: dragState.previewEndMinute,
                  durationMinutes: nextDurationMinutes,
                  needsTimeConfirmation: false,
                }
              : candidate,
          ),
        )
        setSelectedCalendarCandidateId(candidateId)
        setCalendarUploadStatusMessage('Updated staged calendar event time.')
        setTimelineDragStateWithRef(() => null)
        return
      }

      const draggedEntry = timelineEntriesRef.current.find((entry) => entry.id === dragState.entryId) ?? null
      if (!draggedEntry) {
        setTimelineDragStateWithRef(() => null)
        return
      }

      const hasMoved =
        dragState.previewDate !== dragState.originalDate
        || dragState.previewStartMinute !== dragState.originalStartMinute
        || dragState.previewEndMinute !== dragState.originalEndMinute
      if (!hasMoved) {
        setTimelineDragStateWithRef(() => null)
        return
      }

      const previousMonthKey = monthKeyFromDate(draggedEntry.date)
      const nextMonthKey = monthKeyFromDate(dragState.previewDate)
      const previousSelectedDate = selectedDateRef.current
      const previousTimelineEntries = timelineEntries
      const previousWeekTimeline = weekTimeline
      const previousEntryDraft = entryDraft
      const refreshDate = dragState.previewDate
      const nextStartMinute = dragState.previewStartMinute
      const nextEndMinute = dragState.previewEndMinute
      const nextDurationMinutes = Math.max(nextEndMinute - nextStartMinute, TIMELINE_DRAG_SNAP_MINUTES)
      const optimisticEntry: TimelineEntry = {
        ...draggedEntry,
        date: refreshDate,
        startMinute: nextStartMinute,
        endMinute: nextEndMinute,
        durationMinutes: nextDurationMinutes,
      }
      const optimisticWeekEntries = previousWeekTimeline
        ? replaceTimelineEntry(previousWeekTimeline.entries, optimisticEntry)
        : null
      const nextDraftEndState = buildEntryDraftEndState(nextEndMinute)
      const optimisticDraft = previousEntryDraft && previousEntryDraft.id === draggedEntry.id
        ? {
            ...previousEntryDraft,
            date: refreshDate,
            startTime: minuteToTimeInput(nextStartMinute),
            endTime: nextDraftEndState.endTime,
            preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
          }
        : null

      if (timelineMutationInFlightRef.current) {
        setTimelineDragStateWithRef(() => null)
        return
      }

      timelineMutationInFlightRef.current = true
      setErrorMessage(null)
      setSuccessMessage(null)
      setTimelineLanePreferences((previous) => {
        const nextByEntryId = new Map(previous.byEntryId)
        nextByEntryId.set(draggedEntry.id, dragState.lockedLaneIndex)
        const nextOrder = [
          ...previous.order.filter((entryId) => entryId !== draggedEntry.id),
          draggedEntry.id,
        ]
        return {
          byEntryId: nextByEntryId,
          order: nextOrder,
        }
      })
      updateSelectedDate(refreshDate, { clearSelection: false })
      if (previousWeekTimeline && optimisticWeekEntries) {
        setWeekTimeline({
          ...previousWeekTimeline,
          entries: optimisticWeekEntries,
        })
      }
      if (dragState.surface === 'week' && optimisticWeekEntries) {
        setTimelineEntries(filterTimelineEntriesForDate(optimisticWeekEntries, refreshDate))
      } else {
        setTimelineEntries((previous) => replaceTimelineEntry(previous, optimisticEntry))
      }
      if (optimisticDraft) {
        entryDraftLastSavedKeyRef.current = serializeEntryDraft(optimisticDraft)
        setEntryAutoSaveStatus('saved')
      }
      setEntryDraft((previous) =>
        previous && previous.id === draggedEntry.id ? optimisticDraft ?? previous : previous,
      )
      setTimelineDragStateWithRef(() => null)

      void (async () => {
        try {
          await timelineUpdateEntry({
            id: draggedEntry.id,
            engagementId: draggedEntry.engagementId,
            activityId: draggedEntry.activityId,
            mode: 'drag',
            date: refreshDate,
            startMinute: nextStartMinute,
            endMinute: nextEndMinute,
            description: draggedEntry.description,
          })
        } catch (error) {
          if (previousSelectedDate !== refreshDate) {
            updateSelectedDate(previousSelectedDate, { clearSelection: false })
          }
          if (previousWeekTimeline) {
            setWeekTimeline(previousWeekTimeline)
          }
          if (dragState.surface === 'week' && previousWeekTimeline) {
            setTimelineEntries(
              filterTimelineEntriesForDate(previousWeekTimeline.entries, previousSelectedDate),
            )
          } else {
            setTimelineEntries(previousTimelineEntries)
          }
          entryDraftLastSavedKeyRef.current = previousEntryDraft ? serializeEntryDraft(previousEntryDraft) : null
          setEntryDraft(previousEntryDraft)
          setErrorMessage(formatActionErrorMessage(error))
          timelineMutationInFlightRef.current = false
          return
        }

        invalidateMonthSummaries([previousMonthKey, nextMonthKey])

        try {
          await Promise.all([
            loadTimeline(refreshDate),
            loadWeekTimeline(refreshDate),
            loadWeeklySummary(refreshDate),
          ])
        } catch (error) {
          setErrorMessage(formatActionErrorMessage(error))
        } finally {
          timelineMutationInFlightRef.current = false
        }
      })()
    },
    [
      calendarReviewCandidates,
      entryDraft,
      invalidateMonthSummaries,
      loadTimeline,
      loadWeekTimeline,
      loadWeeklySummary,
      setTimelineLanePreferences,
      setTimelineDragStateWithRef,
      timelineEntries,
      updateSelectedDate,
      weekTimeline,
    ],
  )

  const processSubmissionQueueItem = useCallback(
    async (item: SubmissionQueueItem) => {
      try {
        const result = await interpretTextMessage({
          rawText: item.rawText,
          openAiModel: item.requestedOpenAiModel,
          clientTimestampIso: item.clientTimestampIso,
          clientLocalDate: item.clientLocalDate,
          clientLocalTime: item.clientLocalTime,
          clientUtcOffsetMinutes: item.clientUtcOffsetMinutes,
          selectedDate: item.selectedDate,
          timezone: item.timezone,
          captureSource: item.captureSource,
          transcriptionModel: item.transcriptionModelUsed,
          transcriptionDurationMs: item.transcriptionDurationMs,
        })

        const completedAt = Date.now()
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'success',
                    createdEntryCount: result.createdEntryIds.length,
                    completedAtMs: completedAt,
                  }
                : candidate,
            ),
          ),
        )

        const refreshDate = selectedDateRef.current
        invalidateMonthSummaries(
          result.touchedMonthKeys.length > 0
            ? result.touchedMonthKeys
            : [monthKeyFromDate(refreshDate)],
        )

        await Promise.allSettled([
          loadTimeline(refreshDate),
          loadWeekTimeline(refreshDate),
          loadWeeklySummary(refreshDate),
          loadQuickAddSuggestions(),
        ])
      } catch (error) {
        const completedAt = Date.now()
        setErrorMessage(extractErrorMessage(error))
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'error',
                    completedAtMs: completedAt,
                  }
                : candidate,
            ),
          ),
        )
      } finally {
        inFlightSubmissionIdsRef.current.delete(item.id)
      }
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeekTimeline,
      loadQuickAddSuggestions,
      loadWeeklySummary,
      trimSubmissionQueue,
    ],
  )

  const finalizeStoppedVoiceRecording = useCallback(async ({
    stopReason,
    nextAction,
  }: {
    stopReason: 'mic_button' | 'submit_button' | 'auto_stop'
    nextAction: 'transcribe_only' | 'submit_after_transcription'
  }) => {
    const recorder = mediaRecorderRef.current
    const startedAtMs = voiceCaptureStartedAtMsRef.current

    if (!recorder || recorder.state === 'inactive' || startedAtMs === null) {
      return null
    }

    const capturedAtMs = Date.now()
    const durationMs = Math.max(1, capturedAtMs - startedAtMs)
    clearVoiceCaptureTimeout()
    setVoiceCaptureState('transcribing')
    setVoiceCaptureStatusMessage('Transcribing voice note...')
    recordVoiceDiagnostic('voice_recording_stopped', 'ok', {
      audioDurationMs: durationMs,
      stopReason,
      nextAction,
      mimeType: voiceCaptureMimeTypeRef.current,
    })

    const blob = await new Promise<Blob>((resolve, reject) => {
      const handleStop = () => {
        recorder.removeEventListener('error', handleError)
        stopVoiceCaptureStream()
        mediaRecorderRef.current = null
        const mimeType = recorder.mimeType || voiceCaptureMimeTypeRef.current || 'audio/webm'
        const nextBlob = new Blob(voiceChunksRef.current, { type: mimeType })
        voiceChunksRef.current = []
        voiceCaptureStartedAtMsRef.current = null
        resolve(nextBlob)
      }

      const handleError = () => {
        recorder.removeEventListener('stop', handleStop)
        stopVoiceCaptureStream()
        mediaRecorderRef.current = null
        voiceChunksRef.current = []
        voiceCaptureStartedAtMsRef.current = null
        reject(new Error('Audio recording failed.'))
      }

      recorder.addEventListener('stop', handleStop, { once: true })
      recorder.addEventListener('error', handleError, { once: true })
      recorder.stop()
    })

    return {
      blob,
      mimeType: blob.type || voiceCaptureMimeTypeRef.current || 'audio/webm',
      capturedAtMs,
      durationMs,
    }
  }, [clearVoiceCaptureTimeout, recordVoiceDiagnostic, stopVoiceCaptureStream])

  const transcribeRecordedVoiceBlob = useCallback(async (recording: {
    blob: Blob
    mimeType: string
    capturedAtMs: number
    durationMs: number
  }) => {
    const audioBase64 = await blobToBase64(recording.blob)
    const result = await transcribeAudioClip({
      audioBase64,
      mimeType: recording.mimeType,
      durationMs: recording.durationMs,
      captureTimestampIso: new Date(recording.capturedAtMs).toISOString(),
    })

    return {
      ...result,
      capturedAtMs: recording.capturedAtMs,
    }
  }, [])

  const startVoiceRecording = useCallback(async () => {
    if (voiceCaptureState !== 'idle') {
      return
    }

    setErrorMessage(null)
    setSuccessMessage(null)
    setVoiceCaptureStatusMessage(null)

    voiceCaptureCorrelationIdRef.current = generateClientCorrelationId()
    const support = detectVoiceEnvironmentSupport()
    const supportDiagnosticDetails = buildVoiceSupportDiagnosticDetails(support)

    recordVoiceDiagnostic('voice_support_checked', 'ok', supportDiagnosticDetails)

    if (support.failureReasonCode !== null) {
      const message = formatVoiceSupportUnavailableMessage(support)
      setErrorMessage(message)
      recordVoiceDiagnostic('voice_support_unavailable', 'warning', {
        ...supportDiagnosticDetails,
        message,
        permissionOutcome: 'not_requested',
      })
      voiceCaptureCorrelationIdRef.current = null
      return
    }

    if (support.platform === 'macos' && isTauriRuntime()) {
      recordVoiceDiagnostic('voice_native_permission_check_started', 'ok', {
        ...supportDiagnosticDetails,
        permissionOutcome: 'not_requested',
      })

      try {
        const permissionResult = await voiceRequestMicrophonePermission()
        recordVoiceDiagnostic(
          'voice_native_permission_result',
          voiceDiagnosticStatusForMacosPermission(permissionResult.status),
          {
            ...supportDiagnosticDetails,
            nativePermissionRequested: permissionResult.requested,
            permissionOutcome: mapMacosPermissionOutcome(permissionResult.status),
            permissionStatus: permissionResult.status,
          },
        )

        if (permissionResult.status !== 'granted' && permissionResult.status !== 'unsupported') {
          const errorDetails = mapMacosNativeMicrophonePermissionStatus(permissionResult.status)
          setErrorMessage(errorDetails.message)
          voiceCaptureCorrelationIdRef.current = null
          return
        }
      } catch (error) {
        const errorDetails = buildMacosNativePermissionRequestFailedDetails(error)
        setErrorMessage(errorDetails.message)
        recordVoiceDiagnostic('voice_native_permission_failed', 'error', {
          ...supportDiagnosticDetails,
          errorCategory: errorDetails.errorCategory,
          message: errorDetails.message,
          permissionErrorName: errorDetails.permissionErrorName,
          permissionOutcome: errorDetails.permissionOutcome,
        })
        voiceCaptureCorrelationIdRef.current = null
        return
      }
    }

    let stream: MediaStream | null = null
    const preferredMimeType = selectPreferredVoiceMimeType()

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream)

      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      voiceChunksRef.current = []
      voiceCaptureStartedAtMsRef.current = Date.now()
      voiceCaptureMimeTypeRef.current = recorder.mimeType || preferredMimeType || 'audio/webm'
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data)
        }
      })

      recorder.start()
      setVoiceCaptureState('recording')
      setVoiceCaptureStatusMessage('Recording voice note...')
      recordVoiceDiagnostic('voice_recording_started', 'ok', {
        ...supportDiagnosticDetails,
        mimeType: voiceCaptureMimeTypeRef.current,
        mimeTypeCandidate: preferredMimeType ?? null,
        permissionOutcome: 'granted',
      })

      clearVoiceCaptureTimeout()
      voiceCaptureTimeoutRef.current = window.setTimeout(() => {
        stopVoiceRecordingToDraftRef.current('auto_stop')
      }, MAX_VOICE_RECORDING_DURATION_MS)
    } catch (error) {
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop()
        }
      }

      mediaStreamRef.current = null
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceCaptureStartedAtMsRef.current = null
      setVoiceCaptureState('idle')
      setVoiceCaptureStatusMessage(null)
      const errorDetails = mapVoiceRecordingError(error)
      setErrorMessage(errorDetails.message)
      recordVoiceDiagnostic('voice_recording_failed', 'error', {
        ...supportDiagnosticDetails,
        errorCategory: errorDetails.errorCategory,
        message: errorDetails.message,
        mimeTypeCandidate: preferredMimeType ?? null,
        permissionErrorName: errorDetails.permissionErrorName,
        permissionOutcome: errorDetails.permissionOutcome,
      })
      voiceCaptureCorrelationIdRef.current = null
    }
  }, [
    clearVoiceCaptureTimeout,
    recordVoiceDiagnostic,
    voiceCaptureState,
  ])

  const stopVoiceRecordingToDraft = useCallback(async (
    stopReason: 'mic_button' | 'auto_stop' = 'mic_button',
  ) => {
    try {
      const recording = await finalizeStoppedVoiceRecording({
        stopReason,
        nextAction: 'transcribe_only',
      })

      if (!recording) {
        return
      }

      const transcription = await transcribeRecordedVoiceBlob(recording)
      setCaptureMessage(transcription.transcriptText)
      setCaptureDraftMetadata({
        captureSource: 'voice',
        capturedAtMs: transcription.capturedAtMs,
        transcriptionModelUsed: transcription.transcriptionModelUsed,
        transcriptionModelUsedLabel: transcription.transcriptionModelUsedLabel,
        transcriptionDurationMs: transcription.transcriptionDurationMs,
      })
      setVoiceCaptureState('idle')
      setVoiceCaptureStatusMessage(
        `Voice transcript ready using ${transcription.transcriptionModelUsedLabel}.`,
      )
      setSuccessMessage('Voice note transcribed into the submission box.')
    } catch (error) {
      setVoiceCaptureState('idle')
      setVoiceCaptureStatusMessage(null)
      setErrorMessage(extractErrorMessage(error))
      recordVoiceDiagnostic('voice_transcription_failed', 'error', {
        message: extractErrorMessage(error),
      })
      stopVoiceCaptureStream()
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceCaptureStartedAtMsRef.current = null
    } finally {
      voiceCaptureCorrelationIdRef.current = null
    }
  }, [finalizeStoppedVoiceRecording, recordVoiceDiagnostic, stopVoiceCaptureStream, transcribeRecordedVoiceBlob])

  stopVoiceRecordingToDraftRef.current = (reason = 'mic_button') => {
    void stopVoiceRecordingToDraft(reason)
  }

  const stopVoiceRecordingAndSubmit = useCallback(async () => {
    let queueItemId: string | null = null

    try {
      const recording = await finalizeStoppedVoiceRecording({
        stopReason: 'submit_button',
        nextAction: 'submit_after_transcription',
      })

      if (!recording) {
        return
      }

      const submittedAt = new Date(recording.capturedAtMs)
      const queueItem: SubmissionQueueItem = {
        id: generateSubmissionQueueId(),
        rawText: 'Voice note pending transcription...',
        submittedAtMs: recording.capturedAtMs,
        captureSource: 'voice',
        requestedOpenAiModel: settingsStatus?.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
        clientTimestampIso: submittedAt.toISOString(),
        clientLocalDate: formatDate(submittedAt),
        clientLocalTime: formatLocalTime(submittedAt),
        clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
        selectedDate: selectedDateRef.current,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        state: 'running',
      }
      queueItemId = queueItem.id
      setSubmissionQueue((previous) => [...previous, queueItem])

      const transcription = await transcribeRecordedVoiceBlob(recording)
      setSubmissionQueue((previous) =>
        previous.map((candidate) =>
          candidate.id === queueItem.id
            ? {
              ...candidate,
              rawText: transcription.transcriptText,
              state: 'pending',
              transcriptionModelUsed: transcription.transcriptionModelUsed,
              transcriptionDurationMs: transcription.transcriptionDurationMs,
            }
            : candidate,
        ),
      )
      setCaptureMessage('')
      setCaptureDraftMetadata(null)
      setVoiceCaptureState('idle')
      setVoiceCaptureStatusMessage(null)
    } catch (error) {
      if (queueItemId) {
        const completedAt = Date.now()
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === queueItemId
                ? {
                  ...candidate,
                  state: 'error',
                  completedAtMs: completedAt,
                }
                : candidate,
            ),
          ),
        )
      }

      setVoiceCaptureState('idle')
      setVoiceCaptureStatusMessage(null)
      setErrorMessage(extractErrorMessage(error))
      recordVoiceDiagnostic('voice_transcription_failed', 'error', {
        message: extractErrorMessage(error),
      })
      stopVoiceCaptureStream()
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceCaptureStartedAtMsRef.current = null
    } finally {
      voiceCaptureCorrelationIdRef.current = null
    }
  }, [
    finalizeStoppedVoiceRecording,
    recordVoiceDiagnostic,
    settingsStatus,
    stopVoiceCaptureStream,
    transcribeRecordedVoiceBlob,
    trimSubmissionQueue,
  ])

  useEffect(() => () => {
    clearVoiceCaptureTimeout()
    stopVoiceCaptureStream()
    mediaRecorderRef.current = null
    voiceChunksRef.current = []
    voiceCaptureStartedAtMsRef.current = null
  }, [clearVoiceCaptureTimeout, stopVoiceCaptureStream])

  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId
  }, [selectedEntryId])

  useEffect(() => {
    timelineEntriesRef.current = loadedTimelineEntries
  }, [loadedTimelineEntries])

  useEffect(() => {
    const presentEntryIds = new Set(timelineEntries.map((entry) => entry.id))
    setTimelineLanePreferences((previous) => {
      let changed = false
      const nextByEntryId = new Map<string, number>()
      for (const [entryId, laneIndex] of previous.byEntryId.entries()) {
        if (presentEntryIds.has(entryId)) {
          nextByEntryId.set(entryId, laneIndex)
        } else {
          changed = true
        }
      }

      const nextOrder = previous.order.filter((entryId) => presentEntryIds.has(entryId))
      if (nextOrder.length !== previous.order.length) {
        changed = true
      }

      if (!changed) {
        return previous
      }

      return {
        byEntryId: nextByEntryId,
        order: nextOrder,
      }
    })
  }, [timelineEntries])

  const activeTimelineDragPointerId = timelineDragState?.pointerId ?? null

  useEffect(() => {
    if (activeTimelineDragPointerId === null) {
      return
    }

    const finishDrag = (pointerId: number, shouldCommit: boolean) => {
      const current = timelineDragStateRef.current
      if (!current || current.pointerId !== pointerId) {
        return
      }

      if (current.isDragging) {
        suppressTimelineClickRef.current = true
      }

      if (shouldCommit && current.isDragging) {
        commitTimelineDragDrop(current)
        return
      }

      setTimelineDragStateWithRef(() => null)
    }

    const handlePointerMove = (event: PointerEvent) => {
      const current = timelineDragStateRef.current
      if (!current || event.pointerId !== current.pointerId) {
        return
      }

      const grid = current.surface === 'week'
        ? weekTimelineGridRef.current
        : current.surface === 'calendar-review'
          ? calendarReviewTimelineGridRef.current
          : timelineGridRef.current
      if (!grid) {
        return
      }

      const deltaX = event.clientX - current.initialClientX
      const deltaY = event.clientY - current.initialClientY
      let dragMode = current.dragMode

      if (dragMode === 'pending') {
        const absoluteDeltaX = Math.abs(deltaX)
        const absoluteDeltaY = Math.abs(deltaY)
        const shouldResizeDuration =
          current.surface !== 'calendar-review'
          && absoluteDeltaX >= TIMELINE_DURATION_RESIZE_ACTIVATION_PX
          && absoluteDeltaX >= absoluteDeltaY * TIMELINE_DURATION_RESIZE_DOMINANCE_RATIO

        if (shouldResizeDuration) {
          dragMode = 'resize-duration'
        } else if (absoluteDeltaY >= TIMELINE_DRAG_ACTIVATION_PX) {
          dragMode = 'move'
        } else {
          return
        }
      }

      if (dragMode === 'resize-duration') {
        const nextDurationMinutes = timelineDurationFromHorizontalDrag(
          current.durationMinutes,
          deltaX,
          current.originalStartMinute,
          timelineWindow,
        )
        const nextEndMinute = current.originalStartMinute + nextDurationMinutes

        setTimelineDragStateWithRef((previous) => {
          if (!previous || previous.pointerId !== event.pointerId) {
            return previous
          }

          if (
            previous.isDragging
            && previous.dragMode === dragMode
            && previous.previewDate === current.originalDate
            && previous.previewStartMinute === current.originalStartMinute
            && previous.previewEndMinute === nextEndMinute
          ) {
            return previous
          }

          return {
            ...previous,
            dragMode,
            isDragging: true,
            previewDate: current.originalDate,
            previewStartMinute: current.originalStartMinute,
            previewEndMinute: nextEndMinute,
          }
        })
        return
      }

      const pointerSlot = current.surface === 'week'
        ? resolveWeekTimelinePointerSlot(
          event.clientX,
          event.clientY,
          grid,
          weekTimelineDays,
          timelineWindow,
          weekTimelineLayoutMetrics,
        )
        : {
          date: current.originalDate,
          minute: clientYToTimelineMinute(event.clientY, grid, timelineWindow),
        }
      const pointerMinute = pointerSlot.minute
      const rawStartMinute = pointerMinute - current.pointerOffsetMinutes
      const snappedStartMinute = snapMinute(rawStartMinute, TIMELINE_DRAG_SNAP_MINUTES)
      const clampedStartMinute = clampStartMinuteForDuration(
        snappedStartMinute,
        current.durationMinutes,
        timelineWindow,
      )
      const nextEndMinute = clampedStartMinute + current.durationMinutes

      setTimelineDragStateWithRef((previous) => {
        if (!previous || previous.pointerId !== event.pointerId) {
          return previous
        }

        if (
          previous.isDragging
          && previous.dragMode === dragMode
          && previous.previewDate === pointerSlot.date
          && previous.previewStartMinute === clampedStartMinute
          && previous.previewEndMinute === nextEndMinute
        ) {
          return previous
        }

        return {
          ...previous,
          dragMode,
          isDragging: true,
          previewDate: pointerSlot.date,
          previewStartMinute: clampedStartMinute,
          previewEndMinute: nextEndMinute,
        }
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      finishDrag(event.pointerId, true)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      finishDrag(event.pointerId, false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      const current = timelineDragStateRef.current
      if (!current) {
        return
      }

      event.preventDefault()
      finishDrag(current.pointerId, false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    activeTimelineDragPointerId,
    commitTimelineDragDrop,
    setTimelineDragStateWithRef,
    timelineWindow,
    weekTimelineDays,
    weekTimelineLayoutMetrics,
  ])

  useEffect(() => {
    const availableSlots = MAX_CONCURRENT_SUBMISSIONS - inFlightSubmissionIdsRef.current.size
    if (availableSlots <= 0) {
      return
    }

    const pendingItems = submissionQueue
      .filter(
        (item) =>
          item.state === 'pending' && !inFlightSubmissionIdsRef.current.has(item.id),
      )
      .slice(0, availableSlots)

    if (pendingItems.length === 0) {
      return
    }

    const pendingIds = new Set(pendingItems.map((item) => item.id))
    setSubmissionQueue((previous) =>
      previous.map((item) =>
        pendingIds.has(item.id)
          ? {
              ...item,
              state: 'running',
            }
          : item,
      ),
    )

    for (const pendingItem of pendingItems) {
      inFlightSubmissionIdsRef.current.add(pendingItem.id)
      void processSubmissionQueueItem(pendingItem)
    }
  }, [processSubmissionQueueItem, submissionQueue])

  const updateQuickAddSettingsDraft = useCallback(
    (updater: (previous: QuickAddPreferences) => QuickAddPreferences) => {
      updateQuickAddSettingsDraftWithAnimation(updater, { animate: false })
    },
    [updateQuickAddSettingsDraftWithAnimation],
  )

  const openQuickAddSettings = () => {
    const draft = buildQuickAddSettingsDraft(settingsStatus?.quickAddPreferences, engagements)
    quickAddSettingsDraftRef.current = draft
    setQuickAddSettingsDraft(draft)
    commitQuickAddSettingsDragState(null)
    clearQuickAddSettingsDropAnimation()
    setIsQuickAddSettingsOpen(true)
  }

  const closeQuickAddSettings = useCallback(() => {
    releaseQuickAddSettingsPointerCapture(quickAddSettingsDragStateRef.current?.pointerId ?? null)
    commitQuickAddSettingsDragState(null)
    clearQuickAddSettingsDropAnimation()
    setIsQuickAddSettingsOpen(false)
  }, [
    clearQuickAddSettingsDropAnimation,
    commitQuickAddSettingsDragState,
    releaseQuickAddSettingsPointerCapture,
  ])

  useEffect(() => {
    if (!isQuickAddSettingsOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCodesCreateModalOpen) {
        return
      }

      if (event.key === 'Escape') {
        closeQuickAddSettings()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeQuickAddSettings, isCodesCreateModalOpen, isQuickAddSettingsOpen])

  useEffect(() => {
    if (!isQuickAddSettingsOpen || !quickAddSettingsDraftRef.current) {
      return
    }

    const nextDraft = buildQuickAddSettingsDraft(quickAddSettingsDraftRef.current, engagements)
    quickAddSettingsDraftRef.current = nextDraft
    setQuickAddSettingsDraft(nextDraft)
  }, [engagements, isQuickAddSettingsOpen])

  const moveQuickAddEngagement = (engagementId: string, direction: -1 | 1) => {
    updateQuickAddSettingsDraftWithAnimation((previous) => ({
      ...previous,
      engagementOrder: moveId(previous.engagementOrder, engagementId, direction),
    }))
  }

  const toggleQuickAddEngagementVisibility = (engagementId: string) => {
    const childActivityIds =
      engagementById.get(engagementId)?.activities
        .filter((activity) => activity.isActive)
        .map((activity) => activity.id) ?? []

    updateQuickAddSettingsDraft((previous) => {
      const isHidden = previous.hiddenEngagementIds.includes(engagementId)
      const childActivityIdSet = new Set(childActivityIds)

      return {
        ...previous,
        hiddenEngagementIds: toggleId(previous.hiddenEngagementIds, engagementId),
        hiddenActivityIds: isHidden
          ? previous.hiddenActivityIds.filter((activityId) => !childActivityIdSet.has(activityId))
          : Array.from(new Set([...previous.hiddenActivityIds, ...childActivityIds])),
      }
    })
  }

  const moveQuickAddActivity = (engagementId: string, activityId: string, direction: -1 | 1) => {
    updateQuickAddSettingsDraftWithAnimation((previous) => ({
      ...previous,
      activityOrder: {
        ...previous.activityOrder,
        [engagementId]: moveId(previous.activityOrder[engagementId] ?? [], activityId, direction),
      },
    }))
  }

  const toggleQuickAddActivityVisibility = (activityId: string) => {
    updateQuickAddSettingsDraft((previous) => ({
      ...previous,
      hiddenActivityIds: toggleId(previous.hiddenActivityIds, activityId),
    }))
  }

  const collectQuickAddSettingsDragSnapshots = (keys: string[]): QuickAddSettingsDragSnapshot[] | null => {
    const snapshots: QuickAddSettingsDragSnapshot[] = []
    for (const key of keys) {
      const node = quickAddSettingsRowRefs.current[key]
      if (!node) {
        return null
      }

      const rect = node.getBoundingClientRect()
      snapshots.push({
        key,
        top: rect.top,
        height: rect.height,
        centerY: rect.top + (rect.height / 2),
      })
    }

    return snapshots
  }

  const startQuickAddSettingsDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    options: {
      kind: QuickAddSettingsDragKind
      engagementId: string
      activityId?: string
      keys: string[]
      dragKey: string
    },
  ) => {
    if (isBusy || event.button !== 0) {
      return
    }

    const snapshots = collectQuickAddSettingsDragSnapshots(options.keys)
    if (!snapshots) {
      return
    }

    const sourceIndex = snapshots.findIndex((snapshot) => snapshot.key === options.dragKey)
    if (sourceIndex < 0) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    quickAddSettingsDragCaptureTargetRef.current = event.currentTarget
    commitQuickAddSettingsDragState({
      kind: options.kind,
      pointerId: event.pointerId,
      dragKey: options.dragKey,
      engagementId: options.engagementId,
      activityId: options.activityId,
      startClientY: event.clientY,
      latestClientY: event.clientY,
      sourceIndex,
      insertionIndex: sourceIndex,
      snapshots,
    })
  }

  const onQuickAddSettingsDragPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = quickAddSettingsDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    const draggedSnapshot = current.snapshots[current.sourceIndex]
    if (!draggedSnapshot) {
      return
    }

    const draggedCenterY = draggedSnapshot.centerY + (event.clientY - current.startClientY)
    commitQuickAddSettingsDragState({
      ...current,
      latestClientY: event.clientY,
      insertionIndex: findQuickAddSettingsInsertionIndex(draggedCenterY, current),
    })
  }

  const finishQuickAddSettingsDrag = (
    pointerId: number,
    shouldCommit: boolean,
    clientY?: number,
  ) => {
    const current = quickAddSettingsDragStateRef.current
    if (!current || current.pointerId !== pointerId) {
      return
    }

    const draggedSnapshot = current.snapshots[current.sourceIndex]
    const finalDragState =
      draggedSnapshot && clientY !== undefined
        ? {
            ...current,
            latestClientY: clientY,
            insertionIndex: findQuickAddSettingsInsertionIndex(
              draggedSnapshot.centerY + (clientY - current.startClientY),
              current,
            ),
          }
        : current

    releaseQuickAddSettingsPointerCapture(pointerId)
    commitQuickAddSettingsDragState(null)

    if (!shouldCommit || finalDragState.sourceIndex === finalDragState.insertionIndex) {
      return
    }

    setQuickAddSettingsDropCommitKeys(finalDragState.snapshots.map((snapshot) => snapshot.key))

    updateQuickAddSettingsDraftWithAnimation((previous) => {
      if (finalDragState.kind === 'engagement') {
        return {
          ...previous,
          engagementOrder: moveIdToIndex(
            previous.engagementOrder,
            finalDragState.engagementId,
            finalDragState.insertionIndex,
          ),
        }
      }

      if (!finalDragState.activityId) {
        return previous
      }

      return {
        ...previous,
        activityOrder: {
          ...previous.activityOrder,
          [finalDragState.engagementId]: moveIdToIndex(
            previous.activityOrder[finalDragState.engagementId] ?? [],
            finalDragState.activityId,
            finalDragState.insertionIndex,
          ),
        },
      }
    }, { animate: false })
  }

  const onQuickAddSettingsDragPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    finishQuickAddSettingsDrag(event.pointerId, true, event.clientY)
  }

  const onQuickAddSettingsDragPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    finishQuickAddSettingsDrag(event.pointerId, false, event.clientY)
  }

  const openCalendarBulkModal = () => {
    calendarReviewAutoCenterKeyRef.current = null
    setIsCalendarBulkModalOpen(true)
    setCalendarBulkTab(calendarVisibleCandidates.length > 0 ? 'review' : 'submission')
    setCalendarUploadErrorMessage(null)
    setCalendarUploadStatusMessage(null)
  }

  const resetCalendarBulkModal = useCallback(() => {
    if (calendarImagePreviewUrl) {
      URL.revokeObjectURL(calendarImagePreviewUrl)
    }
    setIsCalendarBulkModalOpen(false)
    setCalendarBulkTab('submission')
    setCalendarSelectedFileName(null)
    setCalendarImagePreviewUrl(null)
    setCalendarStagedImage(null)
    setCalendarUploadStatusMessage(null)
    setCalendarUploadErrorMessage(null)
    setCalendarIsExtracting(false)
    setCalendarIsImporting(false)
    setCalendarReviewCandidates([])
    setSelectedCalendarCandidateId(null)
    calendarReviewAutoCenterKeyRef.current = null
    setTimelineContextMenu(null)
    setTimelineDragStateWithRef(() => null)
  }, [calendarImagePreviewUrl, setTimelineDragStateWithRef])

  useEffect(() => {
    if (!isCalendarBulkModalOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        resetCalendarBulkModal()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isCalendarBulkModalOpen, resetCalendarBulkModal])

  const updateCalendarCandidate = (
    id: string,
    updater: (candidate: CalendarReviewCandidate) => CalendarReviewCandidate,
  ) => {
    setCalendarReviewCandidates((previous) =>
      previous.map((candidate) => (candidate.id === id ? updater(candidate) : candidate)),
    )
  }

  const onCreateCalendarCandidateAtMinute = (date: string, anchorMinute: number) => {
    if (calendarIsImporting) {
      return
    }

    const { startMinute, endMinute } = resolveManualTimelineCreateWindow(anchorMinute, timelineWindow)
    const id = generateCalendarCandidateId()
    const warningFlags: WarningType[] = ['unmatched']
    const nextCandidate: CalendarReviewCandidate = {
      id,
      date,
      startMinute,
      endMinute,
      durationMinutes: Math.max(1, endMinute - startMinute),
      timeEvidence: null,
      description: '',
      extractedText: '',
      sourceText: '',
      confidence: 1,
      engagementId: null,
      activityId: null,
      engagementCode: null,
      engagementName: null,
      engagementType: null,
      activityCode: null,
      activityName: null,
      warningFlags,
      isAllDay: false,
      isIgnored: false,
      ignoredReason: null,
      needsDateConfirmation: false,
      needsTimeConfirmation: false,
      reviewState: 'pending',
    }

    setCalendarReviewCandidates((previous) => [...previous, nextCandidate])
    setSelectedCalendarCandidateId(id)
    setCalendarUploadStatusMessage('Added staged calendar event.')
  }

  const onDeleteCalendarCandidate = (candidateId: string) => {
    if (calendarIsImporting) {
      return
    }

    const nextCandidateId = resolveNextCalendarCandidateId(candidateId)
    updateCalendarCandidate(candidateId, (candidate) => ({
      ...candidate,
      reviewState: 'rejected',
    }))
    setSelectedCalendarCandidateId((previous) =>
      previous === candidateId ? nextCandidateId : previous,
    )
    setTimelineContextMenu(null)
    setCalendarUploadStatusMessage('Deleted staged calendar event.')
  }

  const handleCalendarImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setCalendarUploadErrorMessage('Choose an image file for calendar bulk add.')
      return
    }

    try {
      setCalendarUploadErrorMessage(null)
      setCalendarUploadStatusMessage('Reading calendar screenshot...')
      const imageBase64 = await blobToBase64(file)
      const previewUrl = URL.createObjectURL(file)
      if (calendarImagePreviewUrl) {
        URL.revokeObjectURL(calendarImagePreviewUrl)
      }
      setCalendarImagePreviewUrl(previewUrl)
      setCalendarSelectedFileName(file.name)
      setCalendarStagedImage({
        imageBase64,
        mimeType: file.type || 'image/png',
      })
      setCalendarReviewCandidates([])
      setSelectedCalendarCandidateId(null)
      calendarReviewAutoCenterKeyRef.current = null
      setCalendarUploadStatusMessage('Screenshot ready. Click Submit to extract events.')
    } catch (error) {
      setCalendarUploadErrorMessage(extractErrorMessage(error))
    }
  }

  const onSubmitCalendarScreenshot = () => {
    if (!calendarStagedImage || calendarIsExtracting) {
      return
    }

    void (async () => {
      try {
        setCalendarIsExtracting(true)
        setCalendarUploadErrorMessage(null)
        const submittedAt = new Date()
        setCalendarUploadStatusMessage('Extracting events from screenshot...')
        const result = await calendarExtractEvents({
          imageBase64: calendarStagedImage.imageBase64,
          mimeType: calendarStagedImage.mimeType,
          clientTimestampIso: submittedAt.toISOString(),
          clientLocalDate: formatDate(submittedAt),
          clientLocalTime: formatLocalTime(submittedAt),
          clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          selectedDate,
          openAiModel: settingsStatus?.selectedCalendarBulkModel ?? DEFAULT_CALENDAR_BULK_MODEL,
          ignoredKeywords: parseCalendarIgnoredKeywordDraft(calendarIgnoredKeywordDraft),
          ignoreAllDayEvents: settingsStatus?.calendarBulkIgnoreAllDayEvents ?? true,
        })
        const nextCandidates = result.candidates.map((candidate): CalendarReviewCandidate => ({
          ...candidate,
          reviewState: candidate.isIgnored ? 'ignored' : 'pending',
        }))
        const firstVisibleCandidate = nextCandidates.find((candidate) => candidate.reviewState !== 'ignored')
        setCalendarReviewCandidates(nextCandidates)
        setSelectedCalendarCandidateId(firstVisibleCandidate?.id ?? null)
        calendarReviewAutoCenterKeyRef.current = null
        setCalendarBulkTab('review')
        setCalendarUploadStatusMessage(
          `Found ${nextCandidates.length - result.ignoredCandidateCount} review event${
            nextCandidates.length - result.ignoredCandidateCount === 1 ? '' : 's'
          } using ${result.modelUsedLabel}.`,
        )
      } catch (error) {
        setCalendarUploadErrorMessage(extractErrorMessage(error))
      } finally {
        setCalendarIsExtracting(false)
      }
    })()
  }

  const handleCalendarFileList = (files: FileList | File[]) => {
    const [file] = Array.from(files)
    if (!file) {
      return
    }

    void handleCalendarImageFile(file)
  }

  const onCalendarPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith('image/'),
    )
    const file = imageItem?.getAsFile()
    if (!file) {
      setCalendarUploadStatusMessage('No image found in the clipboard.')
      return
    }

    event.preventDefault()
    void handleCalendarImageFile(file)
  }

  const onReadCalendarImageFromClipboard = async () => {
    const clipboard = navigator.clipboard as Clipboard & {
      read?: () => Promise<ClipboardItem[]>
    }

    if (!clipboard?.read) {
      calendarDropZoneRef.current?.focus()
      setCalendarUploadStatusMessage('Focus is ready. Press Ctrl+V to paste a screenshot.')
      return
    }

    try {
      const items = await clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (!imageType) {
          continue
        }

        const blob = await item.getType(imageType)
        const file = new File([blob], 'calendar-screenshot.png', { type: imageType })
        await handleCalendarImageFile(file)
        return
      }

      setCalendarUploadStatusMessage('No image found in the clipboard.')
    } catch (error) {
      calendarDropZoneRef.current?.focus()
      setCalendarUploadStatusMessage(
        `Clipboard image access was unavailable. Press Ctrl+V in the upload area. ${extractErrorMessage(error)}`,
      )
    }
  }

  const onCalendarCandidateEngagementChange = (candidateId: string, engagementId: string) => {
    const engagement = engagements.find((candidate) => candidate.id === engagementId) ?? null
    updateCalendarCandidate(candidateId, (candidate) => {
      const nextCandidate = {
        ...candidate,
        engagementId: engagement?.id ?? null,
        engagementCode: engagement?.code ?? null,
        engagementName: engagement?.name ?? null,
        activityId: null,
        activityCode: null,
        activityName: null,
      }
      return {
        ...nextCandidate,
        warningFlags: refreshCalendarCandidateWarnings(nextCandidate),
      }
    })
  }

  const onCalendarCandidateActivityChange = (candidateId: string, activityId: string) => {
    const currentCandidate = calendarReviewCandidates.find((candidate) => candidate.id === candidateId)
    const engagement = engagements.find(
      (candidate) => candidate.id === currentCandidate?.engagementId,
    ) ?? null
    const activity = engagement?.activities.find((candidate) => candidate.id === activityId) ?? null
    updateCalendarCandidate(candidateId, (candidate) => {
      const nextCandidate = {
        ...candidate,
        activityId: activity?.id ?? null,
        activityCode: activity?.code ?? null,
        activityName: activity?.name ?? null,
      }
      return {
        ...nextCandidate,
        warningFlags: refreshCalendarCandidateWarnings(nextCandidate),
      }
    })
  }

  const onSelectAdjacentCalendarCandidate = (direction: -1 | 1) => {
    if (calendarVisibleCandidates.length === 0 || selectedCalendarCandidateIndex < 0) {
      return
    }

    const nextIndex = Math.min(
      calendarVisibleCandidates.length - 1,
      Math.max(0, selectedCalendarCandidateIndex + direction),
    )
    setSelectedCalendarCandidateId(calendarVisibleCandidates[nextIndex]?.id ?? null)
  }

  const resolveNextCalendarCandidateId = (currentCandidateId: string) => {
    const currentIndex = calendarVisibleCandidates.findIndex(
      (candidate) => candidate.id === currentCandidateId,
    )
    if (currentIndex < 0) {
      return calendarVisibleCandidates[0]?.id ?? null
    }

    return (
      calendarVisibleCandidates[currentIndex + 1]?.id
      ?? calendarVisibleCandidates[currentIndex - 1]?.id
      ?? null
    )
  }

  const onSaveSelectedCalendarCandidate = () => {
    if (!selectedCalendarCandidate || !selectedCalendarCandidateCanSave || calendarIsImporting) {
      return
    }

    const candidateToSave = selectedCalendarCandidate
    if (candidateToSave.reviewState === 'accepted') {
      const savedEntryId = candidateToSave.savedEntryId
      if (!savedEntryId) {
        return
      }

      void runAction(async () => {
        setCalendarIsImporting(true)
        setCalendarUploadErrorMessage(null)
        const previousMonthKey = monthKeyFromDate(candidateToSave.savedEntryDate ?? candidateToSave.date)
        const nextMonthKey = monthKeyFromDate(candidateToSave.date)

        await timelineUpdateEntry({
          id: savedEntryId,
          engagementId: candidateToSave.engagementId,
          activityId: candidateToSave.activityId,
          mode: 'manual',
          date: candidateToSave.date,
          startMinute: candidateToSave.startMinute,
          endMinute: candidateToSave.endMinute,
          description: candidateToSave.description,
        })

        invalidateMonthSummaries([previousMonthKey, nextMonthKey])
        await Promise.all([
          loadTimeline(selectedDateRef.current),
          loadWeekTimeline(selectedDateRef.current),
          loadWeeklySummary(selectedDateRef.current),
          loadQuickAddSuggestions(),
        ])
        setCalendarReviewCandidates((previous) =>
          previous.map((candidate) =>
            candidate.id === candidateToSave.id
              ? {
                  ...candidate,
                  savedEntryDate: candidateToSave.date,
                }
              : candidate,
          ),
        )
        setSelectedCalendarCandidateId(candidateToSave.id)
        setCalendarUploadStatusMessage('Updated saved calendar event.')
      }).finally(() => {
        setCalendarIsImporting(false)
      })
      return
    }

    const nextCandidateId = resolveNextCalendarCandidateId(candidateToSave.id)

    void runAction(async () => {
      setCalendarIsImporting(true)
      setCalendarUploadErrorMessage(null)
      const submittedAt = new Date()
      const result = await calendarImportEntries({
        clientTimestampIso: submittedAt.toISOString(),
        clientLocalDate: formatDate(submittedAt),
        clientLocalTime: formatLocalTime(submittedAt),
        clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        entries: [
          {
            date: candidateToSave.date,
            startMinute: candidateToSave.startMinute,
            endMinute: candidateToSave.endMinute,
            description: candidateToSave.description,
            extractedText:
              candidateToSave.extractedText
              || candidateToSave.sourceText
              || candidateToSave.description,
            engagementId: candidateToSave.engagementId,
            activityId: candidateToSave.activityId,
            confidence: candidateToSave.confidence,
          },
        ],
      })

      invalidateMonthSummaries(result.touchedMonthKeys)
      await Promise.all([
        loadTimeline(selectedDateRef.current),
        loadWeekTimeline(selectedDateRef.current),
        loadWeeklySummary(selectedDateRef.current),
        loadQuickAddSuggestions(),
      ])
      setCalendarReviewCandidates((previous) =>
        previous.map((candidate) =>
          candidate.id === candidateToSave.id
            ? {
                ...candidate,
                reviewState: 'accepted',
                savedEntryId: result.createdEntryIds[0] ?? null,
                savedEntryDate: candidateToSave.date,
              }
            : candidate,
        ),
      )
      setSelectedCalendarCandidateId(nextCandidateId)
      setCalendarUploadStatusMessage('Saved calendar event to the timeline.')
    }).finally(() => {
      setCalendarIsImporting(false)
    })
  }

  const onSaveAllReadyCalendarCandidates = () => {
    if (calendarReadyToSaveCandidates.length === 0 || calendarIsImporting) {
      return
    }

    const candidatesToSave = calendarReadyToSaveCandidates
    const candidateIdsToSave = new Set(candidatesToSave.map((candidate) => candidate.id))

    void runAction(async () => {
      setCalendarIsImporting(true)
      setCalendarUploadErrorMessage(null)
      const submittedAt = new Date()
      const result = await calendarImportEntries({
        clientTimestampIso: submittedAt.toISOString(),
        clientLocalDate: formatDate(submittedAt),
        clientLocalTime: formatLocalTime(submittedAt),
        clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        entries: candidatesToSave.map((candidate) => ({
          date: candidate.date,
          startMinute: candidate.startMinute,
          endMinute: candidate.endMinute,
          description: candidate.description,
          extractedText: candidate.extractedText || candidate.sourceText || candidate.description,
          engagementId: candidate.engagementId,
          activityId: candidate.activityId,
          confidence: candidate.confidence,
        })),
      })

      invalidateMonthSummaries(result.touchedMonthKeys)
      await Promise.all([
        loadTimeline(selectedDateRef.current),
        loadWeekTimeline(selectedDateRef.current),
        loadWeeklySummary(selectedDateRef.current),
        loadQuickAddSuggestions(),
      ])
      const createdEntryIdByCandidateId = new Map(
        candidatesToSave.map((candidate, index) => [
          candidate.id,
          result.createdEntryIds[index] ?? null,
        ]),
      )
      setCalendarReviewCandidates((previous) =>
        previous.map((candidate) =>
          candidateIdsToSave.has(candidate.id)
            ? {
                ...candidate,
                reviewState: 'accepted',
                savedEntryId: createdEntryIdByCandidateId.get(candidate.id) ?? null,
                savedEntryDate: candidate.date,
              }
            : candidate,
        ),
      )
      resetCalendarBulkModal()
      setSuccessMessage(
        `Saved ${result.createdEntryIds.length} calendar event${
          result.createdEntryIds.length === 1 ? '' : 's'
        } to the timeline.`,
      )
    }).finally(() => {
      setCalendarIsImporting(false)
    })
  }

  const onDeleteSelectedCalendarCandidate = () => {
    if (!selectedCalendarCandidate || calendarIsImporting) {
      return
    }

    onDeleteCalendarCandidate(selectedCalendarCandidate.id)
  }

  const onSubmitCapture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (voiceCaptureState === 'recording') {
      void stopVoiceRecordingAndSubmit()
      return
    }

    const messageToSend = captureMessage.trim()
    if (messageToSend.length === 0) {
      return
    }

    const submittedAt = new Date(captureDraftMetadata?.capturedAtMs ?? Date.now())
    setCaptureMessage('')
    enqueueSubmissionQueueItem({
      rawText: messageToSend,
      submittedAtMs: submittedAt.getTime(),
      clientTimestampIso: submittedAt.toISOString(),
      clientLocalDate: formatDate(submittedAt),
      clientLocalTime: formatLocalTime(submittedAt),
      clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
      selectedDate: selectedDateRef.current,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      captureSource: captureDraftMetadata?.captureSource ?? 'text',
      transcriptionModelUsed: captureDraftMetadata?.transcriptionModelUsed,
      transcriptionDurationMs: captureDraftMetadata?.transcriptionDurationMs,
    })
    setCaptureDraftMetadata(null)
    setVoiceCaptureStatusMessage(null)
  }

  const onCaptureMessageKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.nativeEvent.isComposing
    ) {
      return
    }

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  const onSubmitEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const savedEngagementId = engagementForm.id

    void runAction(async () => {
      const describeWhenToUse = engagementForm.describeWhenToUse.trim()

      const colorHex = normalizeColorHexInput(engagementForm.colorHex)
      if (engagementForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Engagement color must be a valid #RRGGBB value.')
      }

      await engagementUpsert({
        id: engagementForm.id,
        code: engagementForm.code.trim() || null,
        name: engagementForm.name,
        client: engagementForm.client || null,
        engagementType: engagementForm.engagementType,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(engagementForm.tags),
        isActive: engagementForm.isActive,
      })

      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
      setHasManualEngagementTypeSelection(false)
      await refreshAfterMutation()
      setCodeEditorSurface(null)
      if (activeView === 'codes' && savedEngagementId) {
        setCodesSelectedEngagementId(savedEngagementId)
        setCodesDetailMode('activities')
      }
      setSuccessMessage('Engagement saved.')
    }, { formatError: formatCodesMutationError })
  }

  const onDeleteEngagement = (id: string) => {
    void runAction(async () => {
      await engagementDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Engagement deleted.')
    })
  }

  const onEditEngagement = (engagement: Engagement) => {
    setCodesCreateContextEngagementId(engagement.id)
    setCodeEditorSurface('edit-engagement')
    setHasManualEngagementTypeSelection(false)
    setEngagementForm({
      id: engagement.id,
      code: engagement.code ?? '',
      name: engagement.name,
      client: engagement.client ?? '',
      engagementType: engagement.engagementType,
      colorHex: engagement.colorHex ?? '',
      describeWhenToUse: engagement.describeWhenToUse ?? '',
      tags: joinTags(engagement.tags),
      isActive: engagement.isActive,
    })
  }

  const onSubmitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextEngagementId =
      activityForm.engagementId || getDefaultActivityEngagementId(engagements)

    void runAction(async () => {
      const describeWhenToUse = activityForm.describeWhenToUse.trim()
      const colorHex = normalizeColorHexInput(activityForm.colorHex)
      if (activityForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Activity color must be a valid #RRGGBB value.')
      }

      await activityUpsert({
        id: activityForm.id,
        engagementId: activityForm.engagementId,
        code: activityForm.code.trim() || null,
        name: activityForm.name,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(activityForm.tags),
        isActive: activityForm.isActive,
      })

      setActivityForm(buildEmptyActivityForm(nextEngagementId))
      await refreshAfterMutation()
      setCodeEditorSurface(null)
      if (activeView === 'codes') {
        setCodesSelectedEngagementId(nextEngagementId)
        setCodesDetailMode('activities')
      }
      setSuccessMessage('Activity saved.')
    }, { formatError: formatCodesMutationError })
  }

  const onSubmitCodesCreateEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      const name = codesCreateEngagementForm.name.trim()
      const code = codesCreateEngagementForm.code.trim()
      const describeWhenToUse = codesCreateEngagementForm.describeWhenToUse.trim()

      if (!name) {
        throw new Error('Engagement name is required.')
      }
      const colorHex = normalizeColorHexInput(codesCreateEngagementForm.colorHex)
      if (codesCreateEngagementForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Engagement color must be a valid #RRGGBB value.')
      }

      const result = await engagementUpsert({
        code: code || null,
        name,
        client: codesCreateEngagementForm.client.trim() || null,
        engagementType: codesCreateEngagementForm.engagementType,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(codesCreateEngagementForm.tags),
        isActive: codesCreateEngagementForm.isActive,
      })

      await refreshAfterMutation()
      setCodesCreateContextEngagementId(result.id)
      setCodesCreateEngagementForm(EMPTY_ENGAGEMENT_FORM)
      setHasManualCodesCreateEngagementTypeSelection(false)
      setCodesCreateActivityForm(buildEmptyActivityForm(result.id))
      setCodesCreateStep('activity')
      if (activeView === 'codes') {
        setCodesSelectedEngagementId(result.id)
        setCodesDetailMode('activities')
      }
      setSuccessMessage(null)
      setCodesCreateNotice('Engagement created. Proceed to create activities.')
    }, { formatError: formatCodesMutationError })
  }

  const onSubmitCodesCreateActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      const engagementId =
        codesCreateActivityForm.engagementId || resolveCodesCreateActivityEngagementId()
      const name = codesCreateActivityForm.name.trim()
      const code = codesCreateActivityForm.code.trim()
      const describeWhenToUse = codesCreateActivityForm.describeWhenToUse.trim()

      if (!engagementId) {
        throw new Error('Choose an engagement for the activity.')
      }
      if (!name) {
        throw new Error('Activity name is required.')
      }
      const colorHex = normalizeColorHexInput(codesCreateActivityForm.colorHex)
      if (codesCreateActivityForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Activity color must be a valid #RRGGBB value.')
      }

      await activityUpsert({
        engagementId,
        code: code || null,
        name,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(codesCreateActivityForm.tags),
        isActive: codesCreateActivityForm.isActive,
      })

      await refreshAfterMutation()
      setCodesCreateContextEngagementId(engagementId)
      setCodesCreateActivityForm(buildEmptyActivityForm(engagementId))
      setCodesCreateStep('activity')
      if (activeView === 'codes') {
        setCodesSelectedEngagementId(engagementId)
        setCodesDetailMode('activities')
      }
      setSuccessMessage(null)
      setCodesCreateNotice('Activity created. You may create the next activity.')
    }, { formatError: formatCodesMutationError })
  }

  const onDeleteActivity = (id: string) => {
    void runAction(async () => {
      await activityDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Activity deleted.')
    })
  }

  const onEditActivity = (activity: Activity) => {
    setCodesCreateContextEngagementId(activity.engagementId)
    setCodeEditorSurface('edit-activity')
    setActivityForm({
      id: activity.id,
      engagementId: activity.engagementId,
      code: activity.code ?? '',
      name: activity.name,
      colorHex: activity.colorHex ?? '',
      describeWhenToUse: activity.describeWhenToUse ?? '',
      tags: joinTags(activity.tags),
      isActive: activity.isActive,
    })
  }

  const onSetDate = (nextDate: string) => {
    updateSelectedDate(nextDate)
  }

  const onJumpToToday = () => {
    const nextDate = formatDate(new Date())
    if (nextDate === selectedDateRef.current) {
      requestTimelineAutoCenter(nextDate)
      return
    }

    onSetDate(nextDate)
  }

  const onJumpToThisWeek = () => {
    const nextDate = formatDate(new Date())
    if (nextDate === selectedDateRef.current) {
      requestTimelineAutoCenter(nextDate)
      return
    }

    updateSelectedDate(nextDate)
  }

  const onSelectCalendarDate = (nextDate: string) => {
    onSetDate(nextDate)
  }

  const onSelectEntry = useCallback((
    entry: TimelineEntry,
    options?: {
      syncSelectedDate?: boolean
    },
  ) => {
    const nextDraft = buildEntryDraft(entry)
    setTimelineContextMenu(null)
    if (options?.syncSelectedDate) {
      updateSelectedDate(entry.date, { clearSelection: false })
    }
    setHighlightedEntryId(null)
    setSelectedEntryId(entry.id)
    entryDraftLastSavedKeyRef.current = serializeEntryDraft(nextDraft)
    setEntryAutoSaveStatus('saved')
    setEntryDraft(nextDraft)
  }, [updateSelectedDate])

  const onSelectTimelineBlock = (entry: TimelineEntry) => {
    if (suppressTimelineClickRef.current) {
      suppressTimelineClickRef.current = false
      return
    }

    onSelectEntry(entry)
  }

  const onSelectCalendarReviewBlock = (candidateId: string) => {
    if (suppressTimelineClickRef.current) {
      suppressTimelineClickRef.current = false
      return
    }

    setSelectedCalendarCandidateId(candidateId)
  }

  const onSelectWeekTimelineBlock = (entry: TimelineEntry) => {
    if (suppressTimelineClickRef.current) {
      suppressTimelineClickRef.current = false
      return
    }

    onSelectEntry(entry, { syncSelectedDate: true })
  }

  const onStartTimelineDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: TimelineEntry,
    surface: TimelineSurface = 'day',
  ) => {
    if (
      event.button !== 0
      || isBusy
      || timelineMutationInFlightRef.current
      || isTimelineDeleteBusy
      || (surface === 'day' ? isTimelineLoading : isWeekTimelineLoading)
    ) {
      return
    }

    const grid = surface === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
    if (!grid) {
      return
    }

    const durationMinutes = Math.max(
      entry.endMinute - entry.startMinute,
      TIMELINE_DRAG_SNAP_MINUTES,
    )
    const pointerMinute = surface === 'week'
      ? resolveWeekTimelinePointerSlot(
        event.clientX,
        event.clientY,
        grid,
        weekTimelineDays,
        timelineWindow,
        weekTimelineLayoutMetrics,
      ).minute
      : clientYToTimelineMinute(event.clientY, grid, timelineWindow)
    const pointerOffsetMinutes = Math.min(
      durationMinutes,
      Math.max(0, pointerMinute - entry.startMinute),
    )

    event.preventDefault()
    suppressTimelineClickRef.current = false
    onSelectEntry(entry, { syncSelectedDate: surface === 'week' })
    const lockedLaneIndex = (
      surface === 'week' ? baselinePositionedWeekTimelineEntries : baselinePositionedTimelineEntries
    ).find(
      (positionedEntry) => positionedEntry.entry.id === entry.id,
    )?.laneIndex ?? 0

    setTimelineDragStateWithRef(() => ({
      surface,
      entryId: entry.id,
      pointerId: event.pointerId,
      dragMode: 'pending',
      initialClientX: event.clientX,
      initialClientY: event.clientY,
      lockedLaneIndex,
      pointerOffsetMinutes,
      durationMinutes,
      originalDate: entry.date,
      originalStartMinute: entry.startMinute,
      originalEndMinute: entry.endMinute,
      previewDate: entry.date,
      previewStartMinute: entry.startMinute,
      previewEndMinute: entry.endMinute,
      isDragging: false,
    }))
  }

  const onStartCalendarReviewDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: TimelineEntry,
    candidateId: string,
  ) => {
    if (event.button !== 0 || isBusy || calendarIsImporting) {
      return
    }

    const grid = calendarReviewTimelineGridRef.current
    if (!grid) {
      return
    }

    const durationMinutes = Math.max(
      entry.endMinute - entry.startMinute,
      TIMELINE_DRAG_SNAP_MINUTES,
    )
    const pointerMinute = clientYToTimelineMinute(event.clientY, grid, timelineWindow)
    const pointerOffsetMinutes = Math.min(
      durationMinutes,
      Math.max(0, pointerMinute - entry.startMinute),
    )

    event.preventDefault()
    suppressTimelineClickRef.current = false
    setSelectedCalendarCandidateId(candidateId)
    const lockedLaneIndex = baselinePositionedCalendarReviewEntries.find(
      (positionedEntry) => positionedEntry.entry.id === entry.id,
    )?.laneIndex ?? 0

    setTimelineDragStateWithRef(() => ({
      surface: 'calendar-review',
      entryId: entry.id,
      pointerId: event.pointerId,
      dragMode: 'pending',
      initialClientX: event.clientX,
      initialClientY: event.clientY,
      lockedLaneIndex,
      pointerOffsetMinutes,
      durationMinutes,
      originalDate: entry.date,
      originalStartMinute: entry.startMinute,
      originalEndMinute: entry.endMinute,
      previewDate: entry.date,
      previewStartMinute: entry.startMinute,
      previewEndMinute: entry.endMinute,
      isDragging: false,
    }))
  }

  const onOpenTimelineContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    entry: TimelineEntry,
    surface: TimelineSurface = 'day',
  ) => {
    event.preventDefault()

    if (
      isBusy
      || timelineMutationInFlightRef.current
      || isTimelineDeleteBusy
      || (surface === 'day' ? isTimelineLoading : isWeekTimelineLoading)
    ) {
      return
    }

    event.stopPropagation()
    onSelectEntry(entry, { syncSelectedDate: surface === 'week' })

    const grid = surface === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
    const pointerMinute = surface === 'week'
      ? (
        grid
          ? resolveWeekTimelinePointerSlot(
            event.clientX,
            event.clientY,
            grid,
            weekTimelineDays,
            timelineWindow,
            weekTimelineLayoutMetrics,
          ).minute
          : entry.startMinute
      )
      : (
        grid
          ? clientYToTimelineMinute(event.clientY, grid, timelineWindow)
          : entry.startMinute
      )
    const { startMinute } = resolveManualTimelineCreateWindow(pointerMinute, timelineWindow)
    const position = clampTimelineContextMenuPosition(event.clientX, event.clientY, 'entry')
    setTimelineContextMenu({
      kind: 'entry',
      surface,
      entryId: entry.id,
      createDate: entry.date,
      createStartMinute: startMinute,
      x: position.x,
      y: position.y,
    })
  }

  const onOpenCalendarReviewContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    entry: TimelineEntry,
    candidateId: string,
  ) => {
    event.preventDefault()

    if (isBusy || calendarIsImporting || timelineDragState?.isDragging) {
      return
    }

    event.stopPropagation()
    setSelectedCalendarCandidateId(candidateId)

    const grid = calendarReviewTimelineGridRef.current
    const pointerMinute = grid
      ? clientYToTimelineMinute(event.clientY, grid, timelineWindow)
      : entry.startMinute
    const { startMinute } = resolveManualTimelineCreateWindow(pointerMinute, timelineWindow)
    const position = clampTimelineContextMenuPosition(event.clientX, event.clientY, 'entry')
    setTimelineContextMenu({
      kind: 'entry',
      surface: 'calendar-review',
      entryId: candidateId,
      createDate: entry.date,
      createStartMinute: startMinute,
      x: position.x,
      y: position.y,
    })
  }

  const scrollDayTimelineToEntry = useCallback((entry: TimelineEntry) => {
    const runScroll = () => {
      const grid = timelineGridRef.current
      if (!grid) {
        return
      }

      const top = (
        TIMELINE_CANVAS_TOP_PADDING
        + (entry.startMinute - timelineWindow.startMinute) * PIXELS_PER_MINUTE
      )
      const height = Math.max(
        TIMELINE_DRAG_SNAP_MINUTES,
        entry.endMinute - entry.startMinute,
      ) * PIXELS_PER_MINUTE
      const targetTop = top - (grid.clientHeight / 2) + (height / 2)
      const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
      const clampedScrollTop = Math.min(Math.max(0, targetTop), maxScrollTop)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'smooth',
      })
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(runScroll)
    })
  }, [timelineWindow])

  const createQuickBlockEntry = useCallback(
    (engagement: Engagement, activity: Activity, durationMinutes: number) => {
      if (timelineMutationInFlightRef.current) {
        return
      }

      const { startMinute, endMinute } = resolveQuickBlockCreateWindow(durationMinutes)
      const date = formatDate(new Date())
      const monthKey = monthKeyFromDate(date)

      void runTimelineMutation(async () => {
        const result = await timelineCreateEntry({
          date,
          startMinute,
          endMinute,
          engagementId: engagement.id,
          activityId: activity.id,
          description: '',
        })

        setActiveView('timeline')
        updateSelectedDate(date, { clearSelection: false })
        setSelectedEntryId(null)
        setEntryDraft(null)
        pendingAutoCenterDateRef.current = null

        const [entries] = await Promise.all([
          loadTimeline(date),
          loadWeekTimeline(date),
          loadWeeklySummary(date),
        ])
        invalidateMonthSummaries([monthKey])
        const createdEntry = entries.find((entry) => entry.id === result.id)
        if (createdEntry) {
          onSelectEntry(createdEntry)
          setHighlightedEntryId(result.id)
          scrollDayTimelineToEntry(createdEntry)
        }
        setSuccessMessage(`Added ${formatEntityDisplayLabel(activity.name, activity.code)}.`)
      })
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeekTimeline,
      loadWeeklySummary,
      onSelectEntry,
      runTimelineMutation,
      scrollDayTimelineToEntry,
      updateSelectedDate,
    ],
  )

  const onQuickBlockActivityPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => {
    if (event.button !== 0 || timelineMutationInFlightRef.current || activity.isActive === false) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setHighlightedEntryId(null)
    setQuickBlockDragStateWithRef(() => ({
      engagementId: engagement.id,
      activityId: activity.id,
      activityName: activity.name,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      currentClientX: event.clientX,
      durationMinutes: TIMELINE_MANUAL_CREATE_DURATION_MINUTES,
      isDragging: false,
    }))
  }

  const onQuickBlockActivityPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    const nextDuration = quickBlockDurationFromDrag(
      current.originClientX,
      event.clientX,
    )
    const nextIsDragging =
      current.isDragging
      || Math.abs(event.clientX - current.originClientX) >= TIMELINE_DRAG_ACTIVATION_PX

    setQuickBlockDragStateWithRef(() => ({
      ...current,
      currentClientX: event.clientX,
      durationMinutes: nextDuration,
      isDragging: nextIsDragging,
    }))
  }

  const onQuickBlockActivityPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    event.preventDefault()
    setQuickBlockDragStateWithRef(() => null)
    createQuickBlockEntry(engagement, activity, current.durationMinutes)
  }

  const onQuickBlockActivityPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = quickBlockDragStateRef.current
    if (!current || current.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    setQuickBlockDragStateWithRef(() => null)
  }

  const onCreateTimelineEntryAtMinute = useCallback(
    (date: string, anchorMinute: number) => {
      const { startMinute, endMinute } = resolveManualTimelineCreateWindow(anchorMinute, timelineWindow)

      void runTimelineMutation(async () => {
        const result = await timelineCreateEntry({
          date,
          startMinute,
          endMinute,
        })
        updateSelectedDate(date, { clearSelection: false })
        const [entries] = await Promise.all([
          loadTimeline(date),
          loadWeekTimeline(date),
          loadWeeklySummary(date),
        ])
        invalidateMonthSummaries([monthKeyFromDate(date)])
        const createdEntry = entries.find((entry) => entry.id === result.id) ?? null
        if (createdEntry) {
          const nextDraft = buildEntryDraft(createdEntry)
          setSelectedEntryId(createdEntry.id)
          entryDraftLastSavedKeyRef.current = serializeEntryDraft(nextDraft)
          setEntryAutoSaveStatus('saved')
          setEntryDraft(nextDraft)
        }
        setTimelineContextMenu(null)
        setSuccessMessage('Timeline entry created.')
      })
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeekTimeline,
      loadWeeklySummary,
      runTimelineMutation,
      timelineWindow,
      updateSelectedDate,
    ],
  )

  const onCreateTimelineEntryFromContextMenu = () => {
    if (!timelineContextMenu) {
      return
    }

    const date = timelineContextMenu.createDate
    const startMinute = timelineContextMenu.createStartMinute
    setTimelineContextMenu(null)
    if (timelineContextMenu.surface === 'calendar-review') {
      onCreateCalendarCandidateAtMinute(date, startMinute)
      return
    }

    onCreateTimelineEntryAtMinute(date, startMinute)
  }

  const onDeleteTimelineContextMenuEntry = () => {
    if (!timelineContextMenu || timelineContextMenu.kind !== 'entry') {
      return
    }

    const entryId = timelineContextMenu.entryId
    if (timelineContextMenu.surface === 'calendar-review') {
      onDeleteCalendarCandidate(entryId)
      return
    }

    onDeleteTimelineEntry(entryId)
  }

  const onOpenTimelineEmptyContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    surface: TimelineSurface = 'day',
  ) => {
    event.preventDefault()

    if (
      isBusy
      || timelineMutationInFlightRef.current
      || isTimelineDeleteBusy
      || timelineDragState?.isDragging
      || (surface === 'day' ? isTimelineLoading : isWeekTimelineLoading)
    ) {
      return
    }

    if (isTargetWithinTimelineBlock(event.target)) {
      return
    }

    const grid = surface === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
    if (!grid) {
      return
    }

    const pointerSlot = surface === 'week'
      ? resolveWeekTimelinePointerSlot(
        event.clientX,
        event.clientY,
        grid,
        weekTimelineDays,
        timelineWindow,
        weekTimelineLayoutMetrics,
      )
      : {
        date: selectedDateRef.current,
        minute: clientYToTimelineMinute(event.clientY, grid, timelineWindow),
      }
    const { startMinute } = resolveManualTimelineCreateWindow(pointerSlot.minute, timelineWindow)
    const position = clampTimelineContextMenuPosition(event.clientX, event.clientY, 'empty')
    setTimelineContextMenu({
      kind: 'empty',
      surface,
      createDate: pointerSlot.date,
      createStartMinute: startMinute,
      x: position.x,
      y: position.y,
    })
  }

  const onOpenCalendarReviewEmptyContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault()

    if (isBusy || calendarIsImporting || timelineDragState?.isDragging) {
      return
    }

    if (isTargetWithinTimelineBlock(event.target)) {
      return
    }

    const grid = calendarReviewTimelineGridRef.current
    if (!grid) {
      return
    }

    const pointerMinute = clientYToTimelineMinute(event.clientY, grid, timelineWindow)
    const { startMinute } = resolveManualTimelineCreateWindow(pointerMinute, timelineWindow)
    const position = clampTimelineContextMenuPosition(event.clientX, event.clientY, 'empty')
    setTimelineContextMenu({
      kind: 'empty',
      surface: 'calendar-review',
      createDate: calendarSelectedDate,
      createStartMinute: startMinute,
      x: position.x,
      y: position.y,
    })
  }

  const onDoubleClickTimelineEmptySpace = (
    event: ReactMouseEvent<HTMLDivElement>,
    surface: TimelineSurface = 'day',
  ) => {
    if (
      isBusy
      || timelineMutationInFlightRef.current
      || isTimelineDeleteBusy
      || timelineDragState?.isDragging
      || (surface === 'day' ? isTimelineLoading : isWeekTimelineLoading)
    ) {
      return
    }

    if (isTargetWithinTimelineBlock(event.target)) {
      return
    }

    const grid = surface === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
    if (!grid) {
      return
    }

    event.preventDefault()
    const pointerSlot = surface === 'week'
      ? resolveWeekTimelinePointerSlot(
        event.clientX,
        event.clientY,
        grid,
        weekTimelineDays,
        timelineWindow,
        weekTimelineLayoutMetrics,
      )
      : {
        date: selectedDateRef.current,
        minute: clientYToTimelineMinute(event.clientY, grid, timelineWindow),
      }
    onCreateTimelineEntryAtMinute(pointerSlot.date, pointerSlot.minute)
  }

  const onDoubleClickCalendarReviewEmptySpace = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (isBusy || calendarIsImporting || timelineDragState?.isDragging) {
      return
    }

    if (isTargetWithinTimelineBlock(event.target)) {
      return
    }

    const grid = calendarReviewTimelineGridRef.current
    if (!grid) {
      return
    }

    event.preventDefault()
    const pointerMinute = clientYToTimelineMinute(event.clientY, grid, timelineWindow)
    onCreateCalendarCandidateAtMinute(calendarSelectedDate, pointerMinute)
  }

  const saveEntryDraftSnapshot = useCallback(
    async (draft: EntryDraft) => {
      if (selectedEntryIdRef.current !== draft.id) {
        return
      }

      const savePlan = buildEntryDraftSavePlan(draft)
      if (!savePlan.ok) {
        setSuccessMessage(null)
        setErrorMessage(savePlan.errorMessage)
        setEntryAutoSaveStatus('error')
        return
      }

      const currentEntry = timelineEntriesRef.current.find((entry) => entry.id === draft.id) ?? null
      const previousEntryDate = currentEntry?.date ?? selectedDateRef.current
      const previousMonthKey = monthKeyFromDate(previousEntryDate)
      const nextMonthKey = monthKeyFromDate(savePlan.normalizedDraft.date)
      const refreshDate = savePlan.normalizedDraft.date
      const nextEngagementId = savePlan.normalizedDraft.engagementId || null
      const nextActivityId = savePlan.normalizedDraft.activityId || null
      const shouldRefreshQuickAddSuggestions =
        currentEntry?.engagementId !== nextEngagementId
        || currentEntry?.activityId !== nextActivityId

      setEntryAutoSaveStatus('saving')
      setSuccessMessage(null)
      setErrorMessage(null)

      try {
        await timelineUpdateEntry({
          id: savePlan.normalizedDraft.id,
          engagementId: nextEngagementId,
          activityId: nextActivityId,
          mode: 'manual',
          date: savePlan.normalizedDraft.date,
          startMinute: savePlan.startMinute,
          endMinute: savePlan.endMinute,
          description: savePlan.normalizedDraft.description,
        })

        invalidateMonthSummaries([previousMonthKey, nextMonthKey])
        updateSelectedDate(refreshDate, { clearSelection: false })
        const refreshTasks: Promise<unknown>[] = [
          loadTimeline(refreshDate),
          loadWeekTimeline(refreshDate),
          loadWeeklySummary(refreshDate),
        ]

        if (shouldRefreshQuickAddSuggestions) {
          refreshTasks.push(loadQuickAddSuggestions())
        }

        await Promise.all(refreshTasks)

        if (selectedEntryIdRef.current !== draft.id) {
          return
        }

        entryDraftLastSavedKeyRef.current = savePlan.key
        setEntryDraft((previous) =>
          previous && previous.id === draft.id ? savePlan.normalizedDraft : previous,
        )
        setEntryAutoSaveStatus('saved')
      } catch (error) {
        if (selectedEntryIdRef.current !== draft.id) {
          return
        }

        setEntryAutoSaveStatus('error')
        setErrorMessage(formatActionErrorMessage(error))
      }
    },
    [
      invalidateMonthSummaries,
      loadTimeline,
      loadWeekTimeline,
      loadWeeklySummary,
      loadQuickAddSuggestions,
      updateSelectedDate,
    ],
  )

  useEffect(() => {
    if (!entryDraft) {
      return undefined
    }

    const draftKey = serializeEntryDraft(entryDraft)
    if (draftKey === entryDraftLastSavedKeyRef.current) {
      return undefined
    }

    if (entryDraftAutoSaveTimeoutRef.current !== null) {
      window.clearTimeout(entryDraftAutoSaveTimeoutRef.current)
    }

    entryDraftAutoSaveTimeoutRef.current = window.setTimeout(() => {
      const draftToSave = entryDraft
      entryDraftAutoSaveTimeoutRef.current = null
      entryDraftAutoSaveChainRef.current = entryDraftAutoSaveChainRef.current
        .catch(() => undefined)
        .then(() => saveEntryDraftSnapshot(draftToSave))
    }, 700)

    return () => {
      if (entryDraftAutoSaveTimeoutRef.current !== null) {
        window.clearTimeout(entryDraftAutoSaveTimeoutRef.current)
        entryDraftAutoSaveTimeoutRef.current = null
      }
    }
  }, [entryDraft, saveEntryDraftSnapshot])

  const onSaveEntryDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!entryDraft) {
      return
    }

    entryDraftAutoSaveChainRef.current = entryDraftAutoSaveChainRef.current
      .catch(() => undefined)
      .then(() => saveEntryDraftSnapshot(entryDraft))
  }

  const onDeleteTimelineEntry = (id: string) => {
    if (isTimelineDeleteBusy) {
      return
    }

    void (async () => {
      const existingEntry = loadedTimelineEntries.find((entry) => entry.id === id) ?? null
      const entryDate = existingEntry?.date ?? selectedDateRef.current
      const monthKey = monthKeyFromDate(entryDate)
      const activeGrid = activeView === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
      const previousScrollTop = activeGrid?.scrollTop ?? 0

      try {
        setIsTimelineDeleteBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        setTimelineContextMenu(null)
        if (entryDraftAutoSaveTimeoutRef.current !== null) {
          window.clearTimeout(entryDraftAutoSaveTimeoutRef.current)
          entryDraftAutoSaveTimeoutRef.current = null
        }
        await entryDraftAutoSaveChainRef.current.catch(() => undefined)
        await timelineDeleteEntry(id)
        await Promise.all([
          loadTimeline(selectedDateRef.current),
          loadWeekTimeline(selectedDateRef.current),
          loadWeeklySummary(selectedDateRef.current),
          loadQuickAddSuggestions(),
        ])

        window.requestAnimationFrame(() => {
          const grid = activeView === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
          if (!grid) {
            return
          }

          const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
          grid.scrollTop = Math.min(previousScrollTop, maxScrollTop)
        })

        invalidateMonthSummaries([monthKey])
        setSuccessMessage('Timeline entry deleted.')
      } catch (error) {
        setErrorMessage(formatActionErrorMessage(error))
      } finally {
        setIsTimelineDeleteBusy(false)
      }
    })()
  }

  const onSaveApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetOpenAiKey(openAiKey)
      setOpenAiKey('')
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
      setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
      setSelectedTranscriptionModelDraft(status.selectedTranscriptionModel)

      if (!status.hasOpenAiKey) {
        const keySaveFailureReason =
          status.lastError ?? `${credentialStoreName} reported ${status.storageHealth}.`
        throw new Error(
          `Key save verification failed. ${keySaveFailureReason}`.trim(),
        )
      }

      if (status.statusLevel === 'warning') {
        setSuccessMessage(
          `OpenAI API key saved for this app session only because ${credentialStoreName} is unavailable.`,
        )
      } else {
        setSuccessMessage('OpenAI API key saved securely.')
      }
    })
  }

  const onSaveOpenAiModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetOpenAiModel(selectedOpenAiModelDraft)
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
      setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
      setSuccessMessage('Interpretation model preference saved.')
    })
  }

  const onSaveCalendarBulkModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetCalendarBulkModel(selectedCalendarBulkModelDraft)
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
      setSuccessMessage('Calendar bulk add model preference saved.')
    })
  }

  const onSaveTranscriptionModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetTranscriptionModel(selectedTranscriptionModelDraft)
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
      setSelectedTranscriptionModelDraft(status.selectedTranscriptionModel)
      setSuccessMessage('Speech-to-text model preference saved.')
    })
  }

  const onSaveTimelinePreferences = (preferences: SettingsTimelinePreferencesInput) => {
    const previousStatus = settingsStatus
    if (!previousStatus) {
      return
    }

    if (!preferences.timelineIncludeExternalInTotals && !preferences.timelineIncludeInternalInTotals) {
      setErrorMessage('At least one of External or Internal type codes must be included in totals.')
      return
    }

    setSettingsStatus({
      ...previousStatus,
      ...preferences,
    })

    void runAction(async () => {
      try {
        await settingsSetTimelinePreferences(preferences)
        if (preferences.timelineWeekStartDay !== previousStatus.timelineWeekStartDay) {
          await Promise.all([
            loadWeekTimeline(selectedDate),
            loadWeeklySummary(selectedDate),
          ])
        }
        const status = await settingsGetStatus()
        setSettingsStatus(status)
        setSelectedOpenAiModelDraft(status.selectedOpenAiModel)
        setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
        setSelectedTranscriptionModelDraft(status.selectedTranscriptionModel)
        setSuccessMessage('Timeline preferences saved.')
      } catch (error) {
        setSettingsStatus(previousStatus)
        throw error
      }
    })
  }

  const onSaveCalendarBulkPreferences = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      const calendarBulkIgnoredKeywords = parseCalendarIgnoredKeywordDraft(calendarIgnoredKeywordDraft)
      await settingsSetCalendarBulkPreferences({
        calendarBulkIgnoredKeywords,
        calendarBulkIgnoreAllDayEvents: settingsStatus?.calendarBulkIgnoreAllDayEvents ?? true,
      })
      const status = await settingsGetStatus()
      setSettingsStatus(status)
      setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
      setCalendarIgnoredKeywordDraft(status.calendarBulkIgnoredKeywords.join('\n'))
      setSuccessMessage('Calendar bulk add preferences saved.')
    })
  }

  const onSaveCalendarIgnoreAllDayPreference = (calendarBulkIgnoreAllDayEvents: boolean) => {
    const previousStatus = settingsStatus
    if (!previousStatus) {
      return
    }

    const calendarBulkIgnoredKeywords = parseCalendarIgnoredKeywordDraft(calendarIgnoredKeywordDraft)
    setSettingsStatus({
      ...previousStatus,
      calendarBulkIgnoredKeywords,
      calendarBulkIgnoreAllDayEvents,
    })

    void runAction(async () => {
      try {
        await settingsSetCalendarBulkPreferences({
          calendarBulkIgnoredKeywords,
          calendarBulkIgnoreAllDayEvents,
        })
        const status = await settingsGetStatus()
        setSettingsStatus(status)
        setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
        setCalendarIgnoredKeywordDraft(status.calendarBulkIgnoredKeywords.join('\n'))
        setSuccessMessage('Calendar bulk add preferences saved.')
      } catch (error) {
        setSettingsStatus(previousStatus)
        throw error
      }
    })
  }

  const onSaveInterfacePreferences = (showDiagnosticsTab: boolean) => {
    const previousStatus = settingsStatus
    if (!previousStatus) {
      return
    }

    setSettingsStatus({
      ...previousStatus,
      showDiagnosticsTab,
    })

    void runAction(async () => {
      try {
        await settingsSetInterfacePreferences({ showDiagnosticsTab })
        const status = await settingsGetStatus()
        setSettingsStatus(status)
        setSelectedCalendarBulkModelDraft(status.selectedCalendarBulkModel)
        setSuccessMessage('Interface preferences saved.')
      } catch (error) {
        setSettingsStatus(previousStatus)
        throw error
      }
    })
  }

  const onRefreshDiagnostics = () => {
    void runAction(async () => {
      await loadDiagnostics(diagnosticsFilter)
      setSuccessMessage('Diagnostics refreshed.')
    })
  }

  const onCopyDiagnostics = () => {
    void runAction(async () => {
      const bundle = await diagnosticsCopyBundle()
      setDiagnosticsBundleText(bundle.text)

      try {
        await navigator.clipboard.writeText(bundle.text)
        setSuccessMessage('Diagnostics bundle copied to clipboard.')
      } catch {
        setSuccessMessage('Diagnostics bundle generated below (clipboard not available).')
      }
    })
  }

  const onShiftSummaryWeek = (weekDelta: number) => {
    onSetDate(shiftDate(selectedDate, weekDelta * 7))
  }

  const onExportSummaryWeek = () => {
    if (!weeklySummary) {
      setErrorMessage('No summary data available to export.')
      return
    }

    if (!selectedReportingExportPreset) {
      setErrorMessage('No export preset is selected.')
      return
    }

    void runAction(async () => {
      setIsSummaryExporting(true)
      try {
        const result = await summaryExportWeeklyExcel({
          date: selectedDate,
          layoutPreset: selectedReportingExportPreset,
        })
        if (!result.autoOpenAttempted || result.autoOpenSucceeded) {
          setSuccessMessage(`Weekly summary exported and opened: ${result.filePath}`)
          return
        }

        setSuccessMessage(
          `Weekly summary exported to ${result.filePath}. Auto-open failed: ${result.autoOpenError ?? 'unknown error'}`,
        )
      } finally {
        setIsSummaryExporting(false)
      }
    })
  }

  const persistSummaryLayoutState = useCallback(async (
    nextState: SummaryLayoutState,
    options?: { successMessage?: string },
  ) => {
    setIsSummaryLayoutSaving(true)
    setErrorMessage(null)
    try {
      const savedState = await summaryLayoutStateSet(nextState)
      setSummaryLayoutState(savedState)
      if (options?.successMessage) {
        setSuccessMessage(options.successMessage)
      }
      return savedState
    } finally {
      setIsSummaryLayoutSaving(false)
    }
  }, [])

  const persistReportingState = useCallback(async (
    nextState: ReportingState,
    options?: { successMessage?: string },
  ) => {
    setIsReportingStateSaving(true)
    setErrorMessage(null)
    try {
      const savedState = await reportingStateSet(nextState)
      setReportingState(savedState)
      if (options?.successMessage) {
        setSuccessMessage(options.successMessage)
      }
      return savedState
    } finally {
      setIsReportingStateSaving(false)
    }
  }, [])

  const updateReportingState = useCallback((
    updater: (state: ReportingState) => ReportingState,
    options?: { successMessage?: string },
  ) => {
    const nextState = updater(resolvedReportingState)
    void (async () => {
      try {
        await persistReportingState(nextState, options)
      } catch (error) {
        setErrorMessage(extractErrorMessage(error))
      }
    })()
  }, [persistReportingState, resolvedReportingState])

  const openSummaryLayoutEditor = useCallback((
    mode: 'create' | 'edit',
  ) => {
    const basePreset = selectedReportingExportPreset
    if (!basePreset) {
      return
    }

    if (mode === 'create') {
      const nextName = buildNextSummaryLayoutPresetName(
        `${basePreset.name} Copy`,
        resolvedSummaryLayoutState.presets,
      )
      const draft = cloneSummaryLayoutPreset(basePreset, {
        id: generateSummaryLayoutId('preset'),
        name: nextName,
      })
      setSummaryLayoutDraft(draft)
      setSummaryLayoutDraftName(draft.name)
      setSummaryLayoutModal({
        mode,
        presetId: null,
      })
    } else {
      const draft = cloneSummaryLayoutPreset(basePreset)
      setSummaryLayoutDraft(draft)
      setSummaryLayoutDraftName(draft.name)
      setSummaryLayoutModal({
        mode,
        presetId: basePreset.id,
      })
    }

    setSummaryLayoutDraftError(null)
    setSummaryLayoutInsertionIndex(null)
    releaseSummaryLayoutPointerCapture(summaryLayoutDragStateRef.current?.pointerId ?? null)
    commitSummaryLayoutDragState(null)
    clearSummaryLayoutDropAnimation()
  }, [
    clearSummaryLayoutDropAnimation,
    commitSummaryLayoutDragState,
    releaseSummaryLayoutPointerCapture,
    resolvedSummaryLayoutState.presets,
    selectedReportingExportPreset,
  ])

  const onSelectReportingExportPreset = (presetId: string) => {
    if (
      isReportingStateSaving
      || presetId === selectedReportingExportPreset?.id
    ) {
      return
    }

    updateReportingState((state) => ({
      ...state,
      selectedExportPresetId: presetId,
    }))
  }

  const onSelectReportingDisplayPreset = (presetId: string) => {
    if (
      isReportingStateSaving
      || presetId === selectedReportingDisplayPreset?.id
    ) {
      return
    }

    updateReportingState((state) => ({
      ...state,
      selectedDisplayPresetId: presetId,
    }))
  }

  const openReportingDisplayPresetEditor = useCallback((mode: 'create' | 'edit') => {
    const basePreset = selectedReportingDisplayPreset
    if (!basePreset) {
      return
    }

    if (mode === 'create') {
      const nextName = buildNextReportingPresetName(
        `${basePreset.name} Copy`,
        resolvedReportingState.displayPresets,
      )
      const draft = cloneReportingDisplayPreset(basePreset, {
        id: generateReportingId('reporting-display'),
        name: nextName,
      })
      setReportingDisplayPresetDraft(draft)
      setReportingDisplayPresetDraftName(draft.name)
      setReportingDisplayPresetModal({
        mode,
        presetId: null,
      })
    } else {
      setReportingDisplayPresetDraft(cloneReportingDisplayPreset(basePreset))
      setReportingDisplayPresetDraftName(basePreset.name)
      setReportingDisplayPresetModal({
        mode,
        presetId: basePreset.id,
      })
    }

    setReportingDisplayPresetDraftError(null)
    setIsReportingDisplayColumnPickerOpen(false)
    setReportingDisplayDraggedColumnId(null)
    setReportingDisplayDragPreview(null)
  }, [resolvedReportingState.displayPresets, selectedReportingDisplayPreset])

  const onSaveReportingDisplayPreset = () => {
    if (!reportingDisplayPresetDraft || !reportingDisplayPresetModal) {
      return
    }

    const trimmedName = reportingDisplayPresetDraftName.trim()
    if (!trimmedName) {
      setReportingDisplayPresetDraftError('Enter a table preset name before saving.')
      return
    }

    if (trimmedName.length > REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH) {
      setReportingDisplayPresetDraftError(
        `Display preset names must be ${REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH} characters or fewer.`,
      )
      return
    }

    const duplicateName = resolvedReportingState.displayPresets.some((preset) => (
      preset.id !== reportingDisplayPresetDraft.id
      && preset.name.trim().toLowerCase() === trimmedName.toLowerCase()
    ))
    if (duplicateName) {
      setReportingDisplayPresetDraftError('Display preset names must be unique.')
      return
    }

    const draftToSave = {
      ...reportingDisplayPresetDraft,
      name: trimmedName,
    }

    const nextDisplayPresets = (
      reportingDisplayPresetModal.mode === 'create'
        ? [...resolvedReportingState.displayPresets, draftToSave]
        : resolvedReportingState.displayPresets.map((preset) => (
          preset.id === draftToSave.id ? draftToSave : preset
        ))
    )

    void (async () => {
      try {
        await persistReportingState({
          ...resolvedReportingState,
          selectedDisplayPresetId: draftToSave.id,
          displayPresets: nextDisplayPresets,
        }, {
          successMessage:
            reportingDisplayPresetModal.mode === 'create'
              ? 'Reporting table preset created.'
              : 'Reporting table preset updated.',
        })
        resetReportingDisplayPresetEditor()
      } catch (error) {
        setReportingDisplayPresetDraftError(extractErrorMessage(error))
      }
    })()
  }

  const onDeleteReportingDisplayPreset = () => {
    if (
      !reportingDisplayPresetDraft
      || !reportingDisplayPresetModal
      || resolvedReportingState.displayPresets.length <= 1
    ) {
      setReportingDisplayPresetDraftError('At least one table preset must remain.')
      return
    }

    const confirmed = window.confirm(`Delete table preset "${reportingDisplayPresetDraft.name}"?`)
    if (!confirmed) {
      return
    }

    const remainingPresets = resolvedReportingState.displayPresets.filter(
      (preset) => preset.id !== reportingDisplayPresetDraft.id,
    )
    const nextSelectedPresetId = (
      resolvedReportingState.selectedDisplayPresetId === reportingDisplayPresetDraft.id
        ? remainingPresets[0]?.id ?? resolvedReportingState.selectedDisplayPresetId
        : resolvedReportingState.selectedDisplayPresetId
    )

    void (async () => {
      try {
        await persistReportingState({
          ...resolvedReportingState,
          selectedDisplayPresetId: nextSelectedPresetId,
          displayPresets: remainingPresets,
        }, {
          successMessage: 'Reporting table preset deleted.',
        })
        resetReportingDisplayPresetEditor()
      } catch (error) {
        setReportingDisplayPresetDraftError(extractErrorMessage(error))
      }
    })()
  }

  const updateReportingDisplayPresetDraftColumns = useCallback((
    updater: (columns: ReportingDisplayColumn[]) => ReportingDisplayColumn[],
  ) => {
    setReportingDisplayPresetDraft((previous) => {
      if (!previous) {
        return previous
      }

      const currentColumns = resolveReportingDisplayColumns(previous)
      return {
        ...previous,
        columns: updater(currentColumns),
      }
    })
  }, [])

  const onAddReportingDisplayColumn = (fieldKey: ReportingDisplayFieldKey) => {
    updateReportingDisplayPresetDraftColumns((columns) => {
      if (columns.some((column) => column.kind === 'field' && column.fieldKey === fieldKey)) {
        return columns
      }

      const nextColumn = createReportingDisplayFieldColumn(fieldKey)
      const dayGroupIndex = columns.findIndex((column) => column.kind === 'dayGroup')
      const rowTotalIndex = columns.findIndex((column) => column.kind === 'rowTotal')
      const insertionIndex = dayGroupIndex >= 0
        ? dayGroupIndex
        : rowTotalIndex >= 0
          ? rowTotalIndex
          : columns.length

      return [
        ...columns.slice(0, insertionIndex),
        nextColumn,
        ...columns.slice(insertionIndex),
      ]
    })
    setReportingDisplayPresetDraftError(null)
    setIsReportingDisplayColumnPickerOpen(false)
  }

  const onRemoveReportingDisplayColumn = (columnId: string) => {
    updateReportingDisplayPresetDraftColumns((columns) => {
      const column = columns.find((candidate) => candidate.id === columnId)
      if (!column || column.kind !== 'field') {
        return columns
      }

      const fieldCount = columns.filter((candidate) => candidate.kind === 'field').length
      if (fieldCount <= 1) {
        setReportingDisplayPresetDraftError('Keep at least one field column in the view.')
        return columns
      }

      setReportingDisplayPresetDraftError(null)
      return columns.filter((candidate) => candidate.id !== columnId)
    })
  }

  const onMoveReportingDisplayColumn = useCallback((
    sourceColumnId: string,
    targetColumnId: string,
    insertAfterTarget = false,
  ) => {
    if (sourceColumnId === targetColumnId) {
      return
    }

    reportingDisplayAnimationRectsRef.current = collectReportingDisplayColumnRects()
    updateReportingDisplayPresetDraftColumns((columns) => (
      moveReportingDisplayColumn(columns, sourceColumnId, targetColumnId, insertAfterTarget)
    ))
    setReportingDisplayPresetDraftError(null)
  }, [updateReportingDisplayPresetDraftColumns])

  const onSelectReportingDisplayEditorPreset = (presetId: string) => {
    if (presetId === reportingDisplayPresetModal?.presetId) {
      return
    }

    if (isReportingDisplayDraftDirty) {
      const confirmed = window.confirm('Discard unsaved changes to this view?')
      if (!confirmed) {
        return
      }
    }

    const nextPreset = resolvedReportingState.displayPresets.find((preset) => preset.id === presetId)
    if (!nextPreset) {
      return
    }

    const nextDraft = cloneReportingDisplayPreset(nextPreset)
    setReportingDisplayPresetDraft(nextDraft)
    setReportingDisplayPresetDraftName(nextDraft.name)
    setReportingDisplayPresetModal({
      mode: 'edit',
      presetId: nextPreset.id,
    })
    setReportingDisplayPresetDraftError(null)
    setIsReportingDisplayColumnPickerOpen(false)
    setReportingDisplayDraggedColumnId(null)
    setReportingDisplayDragPreview(null)
    reportingDisplayDragCleanupRef.current?.()
    reportingDisplayDragCleanupRef.current = null
    reportingDisplayPointerDragStateRef.current = null
  }

  const finishReportingDisplayColumnDrag = useCallback(() => {
    reportingDisplayDragCleanupRef.current?.()
    reportingDisplayDragCleanupRef.current = null
    reportingDisplayPointerDragStateRef.current = null
    setReportingDisplayDraggedColumnId(null)
    setReportingDisplayDragPreview(null)
  }, [])

  const moveReportingDisplayColumnDrag = useCallback((event: PointerEvent) => {
    const dragState = reportingDisplayPointerDragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    const nextDragPreview: ReportingDisplayDragPreview = {
      columnId: dragState.columnId,
      offsetX: event.clientX - dragState.startClientX,
      offsetY: event.clientY - dragState.startClientY,
      surface: dragState.surface,
    }

    const dropTarget = getReportingDisplayColumnDropTarget(event.clientX, event.clientY)
    if (!dropTarget || dropTarget.columnId === dragState.columnId) {
      setReportingDisplayDragPreview(nextDragPreview)
      return
    }

    const targetKey = `${dropTarget.columnId}:${dropTarget.insertAfterTarget ? 'after' : 'before'}`
    if (targetKey === dragState.lastTargetKey) {
      setReportingDisplayDragPreview(nextDragPreview)
      return
    }

    flushSync(() => {
      setReportingDisplayDragPreview(nextDragPreview)
    })
    dragState.lastTargetKey = targetKey
    onMoveReportingDisplayColumn(
      dragState.columnId,
      dropTarget.columnId,
      dropTarget.insertAfterTarget,
    )
  }, [onMoveReportingDisplayColumn])

  const onStartReportingDisplayColumnPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    columnId: string,
  ) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    reportingDisplayDragCleanupRef.current?.()
    const dragSurfaceElement = event.currentTarget.closest<HTMLElement>(
      '[data-reporting-display-column-id]',
    )
    const surface = dragSurfaceElement
      ? getReportingDisplayElementSurface(dragSurfaceElement)
      : 'table'
    reportingDisplayPointerDragStateRef.current = {
      columnId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      surface,
      lastTargetKey: null,
    }
    setReportingDisplayDraggedColumnId(columnId)
    setReportingDisplayDragPreview({
      columnId,
      offsetX: 0,
      offsetY: 0,
      surface,
    })

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      moveReportingDisplayColumnDrag(pointerEvent)
    }

    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const dragState = reportingDisplayPointerDragStateRef.current
      if (!dragState || dragState.pointerId !== pointerEvent.pointerId) {
        return
      }

      moveReportingDisplayColumnDrag(pointerEvent)
      finishReportingDisplayColumnDrag()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    reportingDisplayDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }

  const onSaveReportingDisplayPresetAsNew = () => {
    if (!reportingDisplayPresetDraft) {
      return
    }

    const trimmedName = reportingDisplayPresetDraftName.trim()
    const nextName = buildNextReportingPresetName(
      trimmedName || `${reportingDisplayPresetDraft.name} Copy`,
      resolvedReportingState.displayPresets,
    )
    const draftToSave = cloneReportingDisplayPreset(reportingDisplayPresetDraft, {
      id: generateReportingId('reporting-display'),
      name: nextName,
    })

    void (async () => {
      try {
        await persistReportingState({
          ...resolvedReportingState,
          selectedDisplayPresetId: draftToSave.id,
          displayPresets: [...resolvedReportingState.displayPresets, draftToSave],
        }, {
          successMessage: 'Reporting table view created.',
        })
        resetReportingDisplayPresetEditor()
      } catch (error) {
        setReportingDisplayPresetDraftError(extractErrorMessage(error))
      }
    })()
  }

  const onRemoveSummaryLayoutColumn = (columnId: string) => {
    clearSummaryLayoutDropAnimation()
    setSummaryLayoutDraft((previous) => {
      if (!previous) {
        return previous
      }

      const targetColumn = previous.columns.find((column) => column.id === columnId)
      if (!targetColumn || targetColumn.kind === 'rowTotal') {
        return previous
      }

      if (countSummaryLayoutNonTotalColumns(previous.columns) <= 1) {
        setSummaryLayoutDraftError('A preset must keep at least one column besides Row Total.')
        return previous
      }

      const nextColumns = previous.columns.filter((column) => column.id !== columnId)
      if (nextColumns.length === previous.columns.length) {
        return previous
      }

      setSummaryLayoutDraftError(null)
      setSummaryLayoutInsertionIndex(null)
      return {
        ...previous,
        columns: nextColumns,
      }
    })
  }

  const onInsertSummaryLayoutColumn = (column: SummaryLayoutColumn, atIndex: number) => {
    clearSummaryLayoutDropAnimation()
    setSummaryLayoutDraft((previous) => {
      if (!previous) {
        return previous
      }

      const nextColumns = [...previous.columns]
      nextColumns.splice(atIndex, 0, column)
      return {
        ...previous,
        columns: nextColumns,
      }
    })
    setSummaryLayoutInsertionIndex(null)
    setSummaryLayoutDraftError(null)
  }

  const onUpdateSummaryLayoutFreeTextLabel = (columnId: string, label: string) => {
    setSummaryLayoutDraft((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        columns: previous.columns.map((column) => (
          column.kind === 'freeText' && column.id === columnId
            ? { ...column, label }
            : column
        )),
      }
    })
    setSummaryLayoutDraftError(null)
  }

  const onUpdateSummaryLayoutFreeTextRowValue = (
    columnId: string,
    rowKey: string,
    value: string,
  ) => {
    setSummaryLayoutDraft((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        columns: previous.columns.map((column) => {
          if (column.kind !== 'freeText' || column.id !== columnId) {
            return column
          }

          if (column.repeat) {
            return {
              ...column,
              repeatValue: value,
              repeatRowKey: column.repeatRowKey ?? rowKey,
            }
          }

          const nextRowValues = { ...(column.rowValues ?? {}) }
          if (value.trim()) {
            nextRowValues[rowKey] = value
          } else {
            delete nextRowValues[rowKey]
          }

          return {
            ...column,
            rowValues: nextRowValues,
          }
        }),
      }
    })
    setSummaryLayoutDraftError(null)
  }

  const onToggleSummaryLayoutFreeTextRepeat = (
    columnId: string,
    rowKey: string,
    value: string,
  ) => {
    setSummaryLayoutDraft((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        columns: previous.columns.map((column) => {
          if (column.kind !== 'freeText' || column.id !== columnId) {
            return column
          }

          if (column.repeat && column.repeatRowKey === rowKey) {
            return {
              ...column,
              repeat: false,
              repeatValue: '',
              repeatRowKey: null,
            }
          }

          const nextRowValues = { ...(column.rowValues ?? {}) }
          if (value.trim()) {
            nextRowValues[rowKey] = value
          } else {
            delete nextRowValues[rowKey]
          }

          return {
            ...column,
            rowValues: nextRowValues,
            repeat: true,
            repeatValue: value,
            repeatRowKey: rowKey,
          }
        }),
      }
    })
    setSummaryLayoutDraftError(null)
  }

  const onSaveSummaryLayoutPreset = () => {
    if (!summaryLayoutDraft || !summaryLayoutModal) {
      return
    }

    const trimmedName = summaryLayoutDraftName.trim()
    if (!trimmedName) {
      setSummaryLayoutDraftError('Enter a preset name before saving.')
      return
    }

    if (trimmedName.length > SUMMARY_LAYOUT_MAX_NAME_LENGTH) {
      setSummaryLayoutDraftError(
        `Preset names must be ${SUMMARY_LAYOUT_MAX_NAME_LENGTH} characters or fewer.`,
      )
      return
    }

    const duplicateName = resolvedSummaryLayoutState.presets.some((preset) => (
      preset.id !== summaryLayoutDraft.id
      && preset.name.trim().toLowerCase() === trimmedName.toLowerCase()
    ))
    if (duplicateName) {
      setSummaryLayoutDraftError('Preset names must be unique.')
      return
    }

    const draftToSave = {
      ...summaryLayoutDraft,
      name: trimmedName,
    }

    const nextPresets = (
      summaryLayoutModal.mode === 'create'
        ? [...resolvedSummaryLayoutState.presets, draftToSave]
        : resolvedSummaryLayoutState.presets.map((preset) => (
          preset.id === draftToSave.id ? draftToSave : preset
        ))
    )
    void (async () => {
      try {
        await persistSummaryLayoutState({
          ...resolvedSummaryLayoutState,
          selectedPresetId: resolvedSummaryLayoutState.selectedPresetId,
          presets: nextPresets,
        }, {
          successMessage:
            summaryLayoutModal.mode === 'create'
              ? 'Export preset created.'
              : 'Export preset updated.',
        })
        await persistReportingState({
          ...resolvedReportingState,
          selectedExportPresetId: draftToSave.id,
        })
        resetSummaryLayoutEditor()
      } catch (error) {
        setSummaryLayoutDraftError(extractErrorMessage(error))
      }
    })()
  }

  const onDeleteSummaryLayoutPreset = () => {
    if (!summaryLayoutDraft || !summaryLayoutModal || resolvedSummaryLayoutState.presets.length <= 1) {
      setSummaryLayoutDraftError('At least one preset must remain.')
      return
    }

    const confirmed = window.confirm(`Delete preset "${summaryLayoutDraft.name}"?`)
    if (!confirmed) {
      return
    }

    const remainingPresets = resolvedSummaryLayoutState.presets.filter(
      (preset) => preset.id !== summaryLayoutDraft.id,
    )
    const nextSelectedPresetId = (
      resolvedSummaryLayoutState.selectedPresetId === summaryLayoutDraft.id
        ? remainingPresets[0]?.id ?? resolvedSummaryLayoutState.selectedPresetId
        : resolvedSummaryLayoutState.selectedPresetId
    )
    const nextReportingExportPresetId = (
      resolvedReportingState.selectedExportPresetId === summaryLayoutDraft.id
        ? remainingPresets[0]?.id ?? null
        : resolvedReportingState.selectedExportPresetId
    )

    void (async () => {
      try {
        await persistSummaryLayoutState({
          ...resolvedSummaryLayoutState,
          selectedPresetId: nextSelectedPresetId,
          presets: remainingPresets,
        }, {
          successMessage: 'Export preset deleted.',
        })
        await persistReportingState({
          ...resolvedReportingState,
          selectedExportPresetId: nextReportingExportPresetId,
        })
        resetSummaryLayoutEditor()
      } catch (error) {
        setSummaryLayoutDraftError(extractErrorMessage(error))
      }
    })()
  }

  const onStartSummaryLayoutDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    columnId: string,
    sourceIndex: number,
  ) => {
    if (!summaryLayoutDraft) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    summaryLayoutDragCaptureTargetRef.current = event.currentTarget
    clearSummaryLayoutDropAnimation()
    const columnSnapshots: SummaryLayoutDragSnapshot[] = []
    for (const column of summaryLayoutDraft.columns) {
      const columnNode = summaryLayoutColumnRefs.current[column.id]
      if (!columnNode) {
        return
      }

      const columnRect = columnNode.getBoundingClientRect()
      columnSnapshots.push({
        columnId: column.id,
        left: columnRect.left,
        width: columnRect.width,
        centerX: columnRect.left + (columnRect.width / 2),
      })
    }

    const draggedSnapshot = columnSnapshots[sourceIndex]
    if (!draggedSnapshot) {
      return
    }

    setSummaryLayoutInsertionIndex(null)
    commitSummaryLayoutDragState({
      columnId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      latestClientX: event.clientX,
      draggedCenterX: draggedSnapshot.centerX,
      sourceIndex,
      insertionIndex: sourceIndex,
      columnSnapshots,
    })
  }

  const onOpenSummaryNotes = (rowIndex: number, dayIndex: number) => {
    setSummaryNotesModal({
      rowIndex,
      dayIndex,
    })
  }

  const onCloseSummaryNotes = () => {
    setSummaryNotesModal(null)
  }

  const onCopySummaryNotes = () => {
    if (!selectedSummaryNotesContext) {
      return
    }

    const text = formatSummaryNotesForClipboard(selectedSummaryNotesContext.notes)
    void runAction(async () => {
      try {
        await navigator.clipboard.writeText(text)
        setSuccessMessage('Summary notes copied to clipboard.')
      } catch {
        setErrorMessage('Clipboard is not available in this environment.')
      }
    })
  }

  const weekTimelineRangeLabel = useMemo(() => {
    const startDate = weekTimelineDays[0]?.date ?? selectedDate
    const endDate = weekTimelineDays[6]?.date ?? selectedDate
    return formatTimelineWeekRangeLabel(startDate, endDate)
  }, [selectedDate, weekTimelineDays])

  const onSelectView = (view: View) => {
    if (view === 'diagnostics' && !showDiagnosticsTab) {
      return
    }

    if (view === 'week' && activeView !== 'week') {
      clearTimelineSelection()
    }

    if (view === 'timeline' || view === 'week') {
      requestTimelineAutoCenter(selectedDateRef.current)
    }

    setActiveView(view)
  }

  const entryAutoSaveStatusLabel =
    entryAutoSaveStatus === 'saving'
      ? 'Saving...'
      : entryAutoSaveStatus === 'saved'
        ? 'Saved'
        : entryAutoSaveStatus === 'error'
          ? 'Not saved'
          : ''

  const timelineEditorPanel = (
    <aside className={`timeline-editor ${entryDraft ? '' : 'is-empty'}`}>
      <div className="timeline-editor-header">
        <h3>Edit Entry</h3>
        {entryDraft ? (
          <button
            type="button"
            className="timeline-editor-close"
            aria-label="Close edit entry"
            title="Close edit entry"
            onClick={clearTimelineSelection}
            disabled={isTimelineDeleteBusy}
          >
            <span className="control-icon close-icon" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {entryDraft ? (
        <form className="stack" onSubmit={onSaveEntryDraft}>
          <label>
            Date
            <input
              type="date"
              value={entryDraft.date}
              onChange={(event) =>
                setEntryDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        date: event.target.value,
                      }
                    : previous,
                )
              }
            />
          </label>
          <label>
            Engagement
            <select
              value={entryDraft.engagementId}
              onChange={(event) =>
                setEntryDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        engagementId: event.target.value,
                        activityId: '',
                      }
                    : previous,
                )
              }
            >
              <option value="">Uncategorized</option>
              {engagements.map((engagement) => (
                <option key={engagement.id} value={engagement.id}>
                  {formatEntityDisplayLabel(engagement.name, engagement.code)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Activity
            <select
              value={entryDraft.activityId}
              onChange={(event) =>
                setEntryDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        activityId: event.target.value,
                      }
                    : previous,
                )
              }
            >
              <option value="">Uncategorized</option>
              {availableActivities.map((activity) => (
                <option key={activity.id} value={activity.id}>
                  {formatEntityDisplayLabel(activity.name, activity.code)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start
            <span className="time-input-shell">
              <input
                type="time"
                step={60}
                value={entryDraft.startTime}
                onChange={(event) =>
                  setEntryDraft((previous) =>
                    previous
                      ? {
                          ...previous,
                          startTime: event.target.value,
                        }
                      : previous,
                  )
                }
              />
              <span className="control-icon clock-icon" aria-hidden="true" />
            </span>
          </label>
          <label>
            End
            <span className="time-input-shell">
              <input
                type="time"
                step={60}
                value={entryDraft.endTime}
                onChange={(event) =>
                  setEntryDraft((previous) =>
                    previous
                      ? {
                          ...previous,
                          endTime: event.target.value,
                          preserveEndOfDay: false,
                        }
                      : previous,
                  )
                }
              />
              <span className="control-icon clock-icon" aria-hidden="true" />
            </span>
          </label>
          <label>
            Description
            <textarea
              aria-label="Entry description"
              rows={4}
              value={entryDraft.description}
              onChange={(event) =>
                setEntryDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        description: event.target.value,
                      }
                    : previous,
                )
              }
            />
          </label>
          <div className="timeline-entry-actions">
            <p
              className={`timeline-entry-save-status ${entryAutoSaveStatus}`}
              aria-live="polite"
            >
              {entryAutoSaveStatusLabel}
            </p>
            <button
              type="button"
              className="button-soft-danger"
              onClick={() => onDeleteTimelineEntry(entryDraft.id)}
              disabled={isTimelineDeleteBusy}
            >
              <span className="control-icon trash-icon" aria-hidden="true" />
              Delete
            </button>
          </div>
        </form>
      ) : (
        <p className="timeline-editor-empty">
          Select a timeline block to edit engagement, activity, and timing.
        </p>
      )}

      {selectedEntry ? (
        <div className="entry-metadata">
          <p>
            Confidence: {(selectedEntry.confidence * 100).toFixed(0)}%
          </p>
          <p>Source: {selectedEntry.source}</p>
          {selectedEntry.source !== 'manual' ? (
            <p>User Submission: {selectedEntry.userSubmissionText || 'Unavailable'}</p>
          ) : null}
          <p>Description: {selectedEntry.description}</p>
          {selectedEntry.modelUsedLabel ? (
            <p>Model Used: {selectedEntry.modelUsedLabel}</p>
          ) : null}
          {selectedEntry.source === 'voice' && selectedEntry.transcriptionModelUsedLabel ? (
            <p>Transcription Model: {selectedEntry.transcriptionModelUsedLabel}</p>
          ) : null}
          {selectedEntry.durationDefaulted ? (
            <p>
              Duration: Defaulted to {selectedEntry.durationMinutes} minutes (not specified in
              message).
            </p>
          ) : null}
          {selectedEntry.fallbackSummary ? (
            <p>Fallback: {selectedEntry.fallbackSummary}</p>
          ) : null}
          {selectedEntryHasMultiEventSource ? (
            <p>
              Capture provenance: Event {selectedEntry.sourceMessageEntryIndex ?? '?'} of{' '}
              {selectedEntry.sourceMessageEntryCount} from one message.
            </p>
          ) : null}
          {selectedEntryHasMultiEventSource || selectedEntry.warningFlags.length > 0 ? (
            <div className="warning-row">
              {selectedEntryHasMultiEventSource ? (
                <span className="warning-badge provenance">Multi-Event Source</span>
              ) : null}
              {selectedEntry.warningFlags.map((warningType) => (
                <WarningBadge key={`${selectedEntry.id}-${warningType}`} type={warningType} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  )

  const codesCreateModal = isCodesCreateModalOpen ? createPortal(
    <div
      className="calendar-bulk-backdrop codes-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          closeCodesCreateModal()
        }
      }}
    >
      <section
        className="calendar-bulk-modal codes-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codes-create-title"
      >
        <header className="calendar-bulk-header codes-create-header">
          <div>
            <h3 id="codes-create-title">Add Codes</h3>
            <p>
              {codesCreateStep === 'engagement'
                ? 'Start with an engagement, then add its activities.'
                : 'Add activities for the selected engagement.'}
            </p>
          </div>
          {codesCreateNotice ? (
            <div className="alert success codes-create-notice" role="status">
              <span className="alert-message">{codesCreateNotice}</span>
              <button
                type="button"
                className="alert-close"
                aria-label="Dismiss add codes message"
                onClick={() => setCodesCreateNotice(null)}
              >
                &times;
              </button>
            </div>
          ) : null}
          <div className="calendar-bulk-header-actions">
            <button
              type="button"
              className="timeline-editor-close"
              aria-label="Close add codes"
              title="Close"
              onClick={closeCodesCreateModal}
              disabled={isBusy}
            >
              <span className="control-icon close-icon" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="codes-create-body">
          <nav className="codes-create-rail" aria-label="Add code type">
            <button
              type="button"
              className={codesCreateStep === 'engagement' ? 'active' : ''}
              onClick={() => {
                setCodesCreateStep('engagement')
                setCodesCreateNotice(null)
              }}
            >
              <strong>Add Engagement</strong>
              <span>Define the engagement code first.</span>
            </button>
            <button
              type="button"
              className={codesCreateStep === 'activity' ? 'active' : ''}
              onClick={() => {
                setCodesCreateStep('activity')
                setCodesCreateNotice(null)
                setCodesCreateActivityForm((previous) => ({
                  ...previous,
                  engagementId: previous.engagementId || resolveCodesCreateActivityEngagementId(),
                }))
              }}
              disabled={engagements.length === 0}
            >
              <strong>Add Activity</strong>
              <span>Add activity codes under an engagement.</span>
            </button>
          </nav>

          <section className="codes-create-workspace">
            {codesCreateStep === 'engagement' ? (
              <form className="stack code-editor-form codes-create-form" onSubmit={onSubmitCodesCreateEngagement}>
                <div className="codes-create-form-header">
                  <h4>Add Engagement</h4>
                  <button type="submit" className="button-soft-primary" disabled={isBusy}>
                    <span className="control-icon plus-icon" aria-hidden="true" />
                    Add Engagement
                  </button>
                </div>
                <label>
                  <span className="field-label-row">
                    Engagement Name
                    <span className="required-indicator" aria-hidden="true">*</span>
                  </span>
                  <input
                    value={codesCreateEngagementForm.name}
                    onChange={(event) =>
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Engagement Code
                  <input
                    value={codesCreateEngagementForm.code}
                    onChange={(event) => {
                      const nextCode = event.target.value
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        code: nextCode,
                        engagementType: hasManualCodesCreateEngagementTypeSelection
                          ? previous.engagementType
                          : inferEngagementTypeFromCode(nextCode),
                      }))
                    }}
                    placeholder="E-12345"
                  />
                </label>
                <label>
                  Describe when to use this engagement
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={codesCreateEngagementForm.describeWhenToUse}
                    onChange={(event) =>
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        describeWhenToUse: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Tags / Key Words (comma separated)
                  <input
                    value={codesCreateEngagementForm.tags}
                    onChange={(event) =>
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        tags: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Client
                  <input
                    value={codesCreateEngagementForm.client}
                    onChange={(event) =>
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        client: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="code-editor-field">
                  <span className="code-editor-field-label">Engagement Type</span>
                  <SegmentedControl
                    ariaLabel="Add engagement type"
                    className="engagement-type-segmented"
                    options={ENGAGEMENT_TYPE_SEGMENT_OPTIONS}
                    value={codesCreateEngagementForm.engagementType}
                    onChange={(engagementType) => {
                      setHasManualCodesCreateEngagementTypeSelection(true)
                      setCodesCreateEngagementForm((previous) => ({
                        ...previous,
                        engagementType,
                      }))
                    }}
                  />
                </div>
                <label>
                  Color
                  <div className="color-input-row">
                    <input
                      type="color"
                      value={codesCreateEngagementColorValue ?? TIMELINE_NEUTRAL_COLOR}
                      onChange={(event) =>
                        setCodesCreateEngagementForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      aria-label="Select engagement color"
                    />
                    <input
                      value={codesCreateEngagementForm.colorHex}
                      onChange={(event) =>
                        setCodesCreateEngagementForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="#RRGGBB"
                      maxLength={7}
                    />
                    <button
                      type="button"
                      className="ghost color-clear-button"
                      onClick={() =>
                        setCodesCreateEngagementForm((previous) => ({
                          ...previous,
                          colorHex: '',
                        }))
                      }
                    >
                      Use Default
                    </button>
                  </div>
                </label>
                <div className="codes-active-field">
                  <div className="codes-active-toggle">
                    <span>Active</span>
                    <label className="settings-toggle-group">
                      <input
                        type="checkbox"
                        checked={codesCreateEngagementForm.isActive}
                        onChange={(event) =>
                          setCodesCreateEngagementForm((previous) => ({
                            ...previous,
                            isActive: event.target.checked,
                          }))
                        }
                        aria-label="Active"
                      />
                    </label>
                  </div>
                  <small>Show in timeline code selection and quick entry panels</small>
                </div>
              </form>
            ) : (
              <form className="stack code-editor-form codes-create-form" onSubmit={onSubmitCodesCreateActivity}>
                <div className="codes-create-form-header">
                  <h4>Add Activity</h4>
                  <button
                    type="submit"
                    className="button-soft-primary"
                    disabled={isBusy || engagements.length === 0}
                  >
                    <span className="control-icon plus-icon" aria-hidden="true" />
                    Add Activity
                  </button>
                </div>
                <label>
                  Engagement Name
                  <select
                    value={codesCreateActivityForm.engagementId}
                    onChange={(event) =>
                      setCodesCreateActivityForm((previous) => ({
                        ...previous,
                        engagementId: event.target.value,
                      }))
                    }
                    disabled={engagements.length === 0}
                    required
                  >
                    <option value="" disabled>
                      Select engagement
                    </option>
                    {engagements.map((engagement) => (
                      <option key={engagement.id} value={engagement.id}>
                        {formatEntityDisplayLabel(engagement.name, engagement.code)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label-row">
                    Activity Name
                    <span className="required-indicator" aria-hidden="true">*</span>
                  </span>
                  <input
                    value={codesCreateActivityForm.name}
                    onChange={(event) =>
                      setCodesCreateActivityForm((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }))
                    }
                    disabled={engagements.length === 0}
                    required
                  />
                </label>
                <label>
                  Activity Code
                  <input
                    value={codesCreateActivityForm.code}
                    onChange={(event) =>
                      setCodesCreateActivityForm((previous) => ({
                        ...previous,
                        code: event.target.value,
                      }))
                    }
                    disabled={engagements.length === 0}
                    placeholder="007"
                  />
                </label>
                <label>
                  Describe when to use this activity
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={codesCreateActivityForm.describeWhenToUse}
                    onChange={(event) =>
                      setCodesCreateActivityForm((previous) => ({
                        ...previous,
                        describeWhenToUse: event.target.value,
                      }))
                    }
                    disabled={engagements.length === 0}
                  />
                </label>
                <label>
                  Tags / Key Words (comma separated)
                  <input
                    value={codesCreateActivityForm.tags}
                    onChange={(event) =>
                      setCodesCreateActivityForm((previous) => ({
                        ...previous,
                        tags: event.target.value,
                      }))
                    }
                    disabled={engagements.length === 0}
                  />
                </label>
                <label>
                  Color
                  <div className="color-input-row">
                    <input
                      type="color"
                      value={
                        codesCreateActivityColorValue
                        ?? selectedCodesCreateEngagementColorValue
                        ?? TIMELINE_NEUTRAL_COLOR
                      }
                      onChange={(event) =>
                        setCodesCreateActivityForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      aria-label="Select activity color"
                      disabled={engagements.length === 0}
                    />
                    <input
                      value={
                        codesCreateActivityForm.colorHex
                        || selectedCodesCreateEngagementColorValue
                        || ''
                      }
                      onChange={(event) =>
                        setCodesCreateActivityForm((previous) => ({
                          ...previous,
                          colorHex: event.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="#RRGGBB"
                      maxLength={7}
                      disabled={engagements.length === 0}
                    />
                    <button
                      type="button"
                      className="ghost color-clear-button"
                      onClick={() =>
                        setCodesCreateActivityForm((previous) => ({
                          ...previous,
                          colorHex: '',
                        }))
                      }
                      disabled={engagements.length === 0}
                    >
                      Use Default
                    </button>
                  </div>
                </label>
                <div className="codes-active-field">
                  <div className="codes-active-toggle">
                    <span>Active</span>
                    <label className="settings-toggle-group">
                      <input
                        type="checkbox"
                        checked={codesCreateActivityForm.isActive}
                        onChange={(event) =>
                          setCodesCreateActivityForm((previous) => ({
                            ...previous,
                            isActive: event.target.checked,
                          }))
                        }
                        aria-label="Active"
                        disabled={engagements.length === 0}
                      />
                    </label>
                  </div>
                  <small>Show in timeline code selection and quick entry panels</small>
                </div>
              </form>
            )}
          </section>
        </div>
      </section>
    </div>,
    document.body,
  ) : null

  const quickAddSettingsResolvedDraft =
    quickAddSettingsDraft ?? buildQuickAddSettingsDraft(settingsStatus?.quickAddPreferences, engagements)
  const quickAddSettingsEngagements = quickAddSettingsResolvedDraft.engagementOrder
    .map((engagementId) => engagementById.get(engagementId))
    .filter((engagement): engagement is Engagement => Boolean(engagement?.isActive))
  const quickAddSettingsHiddenEngagementIds = new Set(quickAddSettingsResolvedDraft.hiddenEngagementIds)
  const quickAddSettingsHiddenActivityIds = new Set(quickAddSettingsResolvedDraft.hiddenActivityIds)
  const quickAddSettingsDropCommitKeySet = new Set(quickAddSettingsDropCommitKeys)
  const quickAddSettingsPreviewGroups = quickAddSettingsEngagements
    .filter((engagement) => !quickAddSettingsHiddenEngagementIds.has(engagement.id))
    .map<QuickAddActivityGroup | null>((engagement) => {
      const activeActivitiesById = new Map(
        engagement.activities
          .filter((activity) => activity.isActive)
          .map((activity) => [activity.id, activity]),
      )
      const activities = (quickAddSettingsResolvedDraft.activityOrder[engagement.id] ?? [])
        .map((activityId) => activeActivitiesById.get(activityId))
        .filter((activity): activity is Activity => {
          if (!activity) {
            return false
          }

          return !quickAddSettingsHiddenActivityIds.has(activity.id)
        })
        .map((activity) => {
          const suggestion = quickAddSuggestionByKey.get(quickAddActivityKey(engagement.id, activity.id))
          return {
            engagement,
            activity,
            usageCount: suggestion?.usageCount ?? 0,
            lastUsedAt: suggestion?.lastUsedAt ?? null,
          }
        })

      return activities.length > 0 ? { engagement, activities } : null
    })
    .filter((group): group is QuickAddActivityGroup => Boolean(group))
  const quickAddShownActivityCount = quickAddSettingsPreviewGroups.reduce(
    (total, group) => total + group.activities.length,
    0,
  )
  const getQuickAddSettingsDragPresentation = (key: string) => {
    const current = quickAddSettingsDragState
    if (!current) {
      return {
        className: '',
        style: undefined as CSSProperties | undefined,
      }
    }

    const snapshotIndex = current.snapshots.findIndex((snapshot) => snapshot.key === key)
    if (snapshotIndex < 0) {
      return {
        className: '',
        style: undefined as CSSProperties | undefined,
      }
    }

    if (key === current.dragKey) {
      return {
        className: 'is-dragging',
        style: {
          transform: `translateY(${current.latestClientY - current.startClientY}px)`,
        } as CSSProperties,
      }
    }

    const draggedSnapshot = current.snapshots[current.sourceIndex]
    if (!draggedSnapshot || current.sourceIndex === current.insertionIndex) {
      return {
        className: '',
        style: undefined as CSSProperties | undefined,
      }
    }

    const nextSnapshot = current.snapshots[current.sourceIndex + 1]
    const previousSnapshot = current.snapshots[current.sourceIndex - 1]
    const nextGap = nextSnapshot ? nextSnapshot.top - draggedSnapshot.top - draggedSnapshot.height : null
    const previousGap = previousSnapshot ? draggedSnapshot.top - previousSnapshot.top - previousSnapshot.height : null
    const shiftDistance = draggedSnapshot.height + Math.max(nextGap ?? previousGap ?? 8, 0)

    if (
      current.sourceIndex < current.insertionIndex
      && snapshotIndex > current.sourceIndex
      && snapshotIndex <= current.insertionIndex
    ) {
      return {
        className: 'is-displaced',
        style: { transform: `translateY(-${shiftDistance}px)` } as CSSProperties,
      }
    }

    if (
      current.sourceIndex > current.insertionIndex
      && snapshotIndex >= current.insertionIndex
      && snapshotIndex < current.sourceIndex
    ) {
      return {
        className: 'is-displaced',
        style: { transform: `translateY(${shiftDistance}px)` } as CSSProperties,
      }
    }

    return {
      className: '',
      style: undefined as CSSProperties | undefined,
    }
  }

  const quickAddSettingsModal = isQuickAddSettingsOpen ? createPortal(
    <div
      className="calendar-bulk-backdrop quick-add-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          closeQuickAddSettings()
        }
      }}
    >
      <section
        className="calendar-bulk-modal quick-add-settings-modal"
        role="dialog"
        aria-modal={!isCodesCreateModalOpen}
        aria-labelledby="quick-add-settings-title"
      >
        <header className="calendar-bulk-header quick-add-settings-header">
          <div>
            <h3 id="quick-add-settings-title">Quick Entry Settings</h3>
            <p>Rearrange or hide engagements/activities to customize how it appears.</p>
          </div>
          <div className="calendar-bulk-header-actions">
            <button
              type="button"
              className="ghost quick-add-settings-header-button"
              onClick={() => {
                openCodesCreateEngagementModal()
              }}
              disabled={isBusy}
            >
              <span className="control-icon plus-icon" aria-hidden="true" />
              Add Engagement
            </button>
            <button
              type="button"
              className="ghost quick-add-settings-header-button"
              onClick={() => {
                openCodesCreateActivityModal()
              }}
              disabled={isBusy || engagements.length === 0}
            >
              <span className="control-icon plus-icon" aria-hidden="true" />
              Add Activity
            </button>
            <button
              type="button"
              className="timeline-editor-close"
              aria-label="Close Quick Entry settings"
              title="Close"
              onClick={closeQuickAddSettings}
              disabled={isBusy}
            >
              <span className="control-icon close-icon" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="quick-add-settings-body">
          <section className="quick-add-settings-list" aria-label="Quick Entry order and visibility">
            {quickAddSettingsEngagements.length === 0 ? (
              <p className="quick-add-settings-empty">No active engagements.</p>
            ) : (
              quickAddSettingsEngagements.map((engagement, engagementIndex) => {
                const engagementKey = quickAddSettingsEngagementKey(engagement.id)
                const engagementDragPresentation = getQuickAddSettingsDragPresentation(engagementKey)
                const engagementColor = engagement.colorHex ?? TIMELINE_NEUTRAL_COLOR
                const activeActivitiesById = new Map(
                  engagement.activities
                    .filter((activity) => activity.isActive)
                    .map((activity) => [activity.id, activity]),
                )
                const orderedActivities = (quickAddSettingsResolvedDraft.activityOrder[engagement.id] ?? [])
                  .map((activityId) => activeActivitiesById.get(activityId))
                  .filter((activity): activity is Activity => Boolean(activity))
                const engagementHidden = quickAddSettingsResolvedDraft.hiddenEngagementIds.includes(engagement.id)
                const engagementLabel = formatEntityDisplayLabel(
                  engagement.name,
                  engagement.code,
                  'Engagement',
                )

                return (
                  <article
                    key={engagement.id}
                    ref={(node) => {
                      quickAddSettingsRowRefs.current[engagementKey] = node
                    }}
                    className={[
                      'quick-add-settings-engagement',
                      engagementHidden ? 'is-hidden' : '',
                      quickAddSettingsDropCommitKeySet.has(engagementKey) ? 'is-commit-reset' : '',
                      engagementDragPresentation.className,
                    ].filter(Boolean).join(' ')}
                    style={{
                      '--quick-add-settings-color': engagementColor,
                      ...engagementDragPresentation.style,
                    } as CSSProperties}
                  >
                    <div className="quick-add-settings-row quick-add-settings-engagement-row">
                      <button
                        type="button"
                        className="quick-add-settings-handle"
                        aria-label={`Drag ${engagementLabel}`}
                        title="Drag to reorder"
                        onPointerDown={(event) =>
                          startQuickAddSettingsDrag(event, {
                            kind: 'engagement',
                            engagementId: engagement.id,
                            keys: quickAddSettingsEngagements.map((item) =>
                              quickAddSettingsEngagementKey(item.id),
                            ),
                            dragKey: engagementKey,
                          })
                        }
                        onPointerMove={onQuickAddSettingsDragPointerMove}
                        onPointerUp={onQuickAddSettingsDragPointerUp}
                        onPointerCancel={onQuickAddSettingsDragPointerCancel}
                        disabled={isBusy}
                      >
                        <span aria-hidden="true" />
                      </button>
                      <div className="quick-add-settings-title-block">
                        <strong>{formatEntityPrimaryLabel(
                          engagement.name,
                          engagement.code,
                          'Engagement',
                        )}</strong>
                        <span>{formatActivityCount(orderedActivities.length)}</span>
                      </div>
                      <div className="quick-add-settings-controls">
                        <button
                          type="button"
                          className="quick-add-reorder-button"
                          aria-label={`Move ${engagementLabel} up`}
                          title="Move up"
                          onClick={() => moveQuickAddEngagement(engagement.id, -1)}
                          disabled={engagementIndex === 0 || isBusy}
                        >
                          <span className="control-icon chevron-up" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="quick-add-reorder-button"
                          aria-label={`Move ${engagementLabel} down`}
                          title="Move down"
                          onClick={() => moveQuickAddEngagement(engagement.id, 1)}
                          disabled={engagementIndex === quickAddSettingsEngagements.length - 1 || isBusy}
                        >
                          <span className="control-icon chevron-down" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={`quick-add-visibility-button ${engagementHidden ? 'is-hidden' : ''}`}
                          aria-label={`${engagementHidden ? 'Show' : 'Hide'} ${engagementLabel}`}
                          aria-pressed={!engagementHidden}
                          title={engagementHidden ? 'Show in Quick Entry' : 'Hide from Quick Entry'}
                          onClick={() => toggleQuickAddEngagementVisibility(engagement.id)}
                          disabled={isBusy}
                        >
                          <img src={engagementHidden ? visibleOffIcon : visibleIcon} alt="" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="quick-add-settings-activities">
                      {orderedActivities.length === 0 ? (
                        <p className="quick-add-settings-empty">No active activities.</p>
                      ) : (
                        orderedActivities.map((activity, activityIndex) => {
                          const activityHidden = quickAddSettingsResolvedDraft.hiddenActivityIds.includes(activity.id)
                          const activityLabel = formatEntityDisplayLabel(activity.name, activity.code)
                          const activityEffectivelyHidden = engagementHidden || activityHidden
                          const activityVisibilityLabel = engagementHidden
                            ? `${activityLabel} hidden because ${engagementLabel} is hidden`
                            : `${activityHidden ? 'Show' : 'Hide'} ${activityLabel}`
                          const activityVisibilityTitle = engagementHidden
                            ? 'Hidden because engagement is hidden'
                            : activityHidden
                              ? 'Show in Quick Entry'
                              : 'Hide from Quick Entry'
                          const activityKey = quickAddSettingsActivityKey(engagement.id, activity.id)
                          const activityDragPresentation = getQuickAddSettingsDragPresentation(activityKey)
                          const activityColor = activity.colorHex ?? engagementColor

                          return (
                            <div
                              key={activity.id}
                              ref={(node) => {
                                quickAddSettingsRowRefs.current[activityKey] = node
                              }}
                              className={[
                                'quick-add-settings-row',
                                'quick-add-settings-activity-row',
                                activityHidden ? 'is-hidden' : '',
                                quickAddSettingsDropCommitKeySet.has(activityKey) ? 'is-commit-reset' : '',
                                activityDragPresentation.className,
                              ].filter(Boolean).join(' ')}
                              style={{
                                '--quick-add-settings-color': activityColor,
                                ...activityDragPresentation.style,
                              } as CSSProperties}
                            >
                              <button
                                type="button"
                                className="quick-add-settings-handle small"
                                aria-label={`Drag ${activityLabel}`}
                                title="Drag to reorder"
                                onPointerDown={(event) =>
                                  startQuickAddSettingsDrag(event, {
                                    kind: 'activity',
                                    engagementId: engagement.id,
                                    activityId: activity.id,
                                    keys: orderedActivities.map((item) =>
                                      quickAddSettingsActivityKey(engagement.id, item.id),
                                    ),
                                    dragKey: activityKey,
                                  })
                                }
                                onPointerMove={onQuickAddSettingsDragPointerMove}
                                onPointerUp={onQuickAddSettingsDragPointerUp}
                                onPointerCancel={onQuickAddSettingsDragPointerCancel}
                                disabled={isBusy}
                              >
                                <span aria-hidden="true" />
                              </button>
                              <div className="quick-add-settings-title-block">
                                <strong>{formatEntityPrimaryLabel(activity.name, activity.code)}</strong>
                              </div>
                              <div className="quick-add-settings-controls">
                                <button
                                  type="button"
                                  className="quick-add-reorder-button"
                                  aria-label={`Move ${activityLabel} up`}
                                  title="Move up"
                                  onClick={() => moveQuickAddActivity(engagement.id, activity.id, -1)}
                                  disabled={activityIndex === 0 || isBusy}
                                >
                                  <span className="control-icon chevron-up" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className="quick-add-reorder-button"
                                  aria-label={`Move ${activityLabel} down`}
                                  title="Move down"
                                  onClick={() => moveQuickAddActivity(engagement.id, activity.id, 1)}
                                  disabled={activityIndex === orderedActivities.length - 1 || isBusy}
                                >
                                  <span className="control-icon chevron-down" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className={`quick-add-visibility-button ${activityEffectivelyHidden ? 'is-hidden' : ''}`}
                                  aria-label={activityVisibilityLabel}
                                  aria-pressed={!activityEffectivelyHidden}
                                  title={activityVisibilityTitle}
                                  onClick={() => toggleQuickAddActivityVisibility(activity.id)}
                                  disabled={isBusy}
                                >
                                  <img
                                    src={activityEffectivelyHidden ? visibleOffIcon : visibleIcon}
                                    alt=""
                                    aria-hidden="true"
                                  />
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </article>
                )
              })
            )}
          </section>

          <aside className="quick-add-settings-preview-panel" aria-label="Quick Entry preview">
            <div className="quick-add-settings-preview-header">
              <h4>Live Preview</h4>
              <span>{quickAddShownActivityCount} visible</span>
            </div>
            <div className="quick-add-panel quick-add-settings-preview">
              {quickAddSettingsPreviewGroups.length === 0 ? (
                <p className="quick-add-empty">
                  {allQuickAddActivities.length === 0 ? 'No active activities yet.' : 'All Quick Entry items are hidden.'}
                </p>
              ) : (
                <div className="quick-add-scroll-frame">
                  <div className="quick-add-scroll">
                    <div className="quick-add-list">
                      {quickAddSettingsPreviewGroups.map((group) => {
                        const engagementColor = group.engagement.colorHex ?? TIMELINE_NEUTRAL_COLOR

                        return (
                          <section
                            key={group.engagement.id}
                            className="quick-add-group"
                            style={{
                              '--quick-add-color': engagementColor,
                            } as CSSProperties}
                          >
                            <div className="quick-add-group-header">
                              <span>{formatEntityPrimaryLabel(
                                group.engagement.name,
                                group.engagement.code,
                                'Engagement',
                              )}</span>
                            </div>
                            <div className="quick-add-grid">
                              {group.activities.map(({ activity }) => {
                                const activityColor = activity.colorHex ?? engagementColor
                                const activityLabel = activity.name || activity.code

                                return (
                                  <div
                                    key={activity.id}
                                    className="quick-add-tile quick-add-settings-preview-tile"
                                    role="button"
                                    aria-disabled="true"
                                    style={{
                                      '--quick-add-color': activityColor,
                                      '--quick-add-duration-progress': '0%',
                                    } as CSSProperties}
                                  >
                                    <span className="quick-add-tile-main">
                                      <strong>{activityLabel}</strong>
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </section>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  ) : null

  const calendarBulkModal = isCalendarBulkModalOpen ? createPortal(
    <div
      className="calendar-bulk-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !calendarIsExtracting && !calendarIsImporting) {
          resetCalendarBulkModal()
        }
      }}
    >
      <section
        className="calendar-bulk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-bulk-title"
      >
        <header className="calendar-bulk-header">
          <div>
            <h3 id="calendar-bulk-title">Calendar Bulk Add</h3>
            <p>
              Stage calendar screenshots as reviewable time entries before importing them.
            </p>
          </div>
          <div className="calendar-bulk-header-actions">
            <p className="calendar-bulk-counter" aria-live="polite">
              {calendarPendingCandidates.length} reviewable
              {' '}| {calendarAcceptedCandidates.length} accepted
              {' '}| {calendarIgnoredCandidates.length} ignored
            </p>
            <button
              type="button"
              className="timeline-editor-close"
              aria-label="Close calendar bulk add"
              title="Close"
              onClick={resetCalendarBulkModal}
              disabled={calendarIsExtracting || calendarIsImporting}
            >
              <span className="control-icon close-icon" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className={`calendar-bulk-top-row ${calendarBulkTab === 'review' ? 'is-review' : ''}`}>
          <div className="calendar-bulk-tabs-and-stepper">
            <SegmentedControl
              ariaLabel="Calendar bulk workflows"
              className="calendar-bulk-tabs"
              mode="tab"
              options={CALENDAR_BULK_TAB_OPTIONS}
              value={calendarBulkTab}
              onChange={(nextCalendarBulkTab) => {
                if (nextCalendarBulkTab === 'review') {
                  calendarReviewAutoCenterKeyRef.current = null
                }

                setCalendarBulkTab(nextCalendarBulkTab)
              }}
            />

            {calendarBulkTab === 'review' ? (
              <div className="calendar-review-stepper">
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button"
                  aria-label="Previous calendar event"
                  title="Previous"
                  onClick={() => onSelectAdjacentCalendarCandidate(-1)}
                  disabled={selectedCalendarCandidateIndex <= 0}
                >
                  <span className="control-icon chevron-left" aria-hidden="true" />
                </button>
                <span>
                  {selectedCalendarCandidateIndex >= 0
                    ? `Event ${selectedCalendarCandidateIndex + 1} of ${calendarVisibleCandidates.length}`
                    : 'Event 0 of 0'}
                </span>
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button"
                  aria-label="Next calendar event"
                  title="Next"
                  onClick={() => onSelectAdjacentCalendarCandidate(1)}
                  disabled={
                    selectedCalendarCandidateIndex < 0
                    || selectedCalendarCandidateIndex >= calendarVisibleCandidates.length - 1
                  }
                >
                  <span className="control-icon chevron-right" aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>

          {calendarBulkTab === 'review' ? (
            <div className="calendar-review-actions">
              <button
                type="button"
                className="ghost calendar-save-all-button"
                onClick={onSaveAllReadyCalendarCandidates}
                disabled={calendarReadyToSaveCandidates.length === 0 || calendarIsImporting}
                title="Save all ready calendar events"
              >
                <span className="control-icon save-icon" aria-hidden="true" />
                {calendarIsImporting ? 'Saving...' : 'Save All'}
              </button>
              <button
                type="button"
                className="button-soft-primary"
                onClick={onSaveSelectedCalendarCandidate}
                disabled={
                  !selectedCalendarCandidate
                  || !selectedCalendarCandidateCanSave
                  || calendarIsImporting
                }
              >
                <span className="control-icon save-icon" aria-hidden="true" />
                {calendarIsImporting
                  ? 'Saving...'
                  : selectedCalendarCandidate?.reviewState === 'accepted'
                    ? 'Update'
                    : 'Save'}
              </button>
              <button
                type="button"
                className="button-soft-danger"
                onClick={onDeleteSelectedCalendarCandidate}
                disabled={
                  !selectedCalendarCandidate
                  || selectedCalendarCandidate.reviewState === 'accepted'
                  || calendarIsImporting
                }
              >
                <span className="control-icon trash-icon" aria-hidden="true" />
                Delete
              </button>
            </div>
          ) : null}
        </div>

        {calendarBulkTab === 'submission' ? (
          <div className="calendar-submission-layout">
            <input
              ref={calendarFileInputRef}
              type="file"
              accept="image/*"
              className="calendar-file-input"
              onChange={(event) => {
                if (event.target.files) {
                  handleCalendarFileList(event.target.files)
                }
                event.currentTarget.value = ''
              }}
            />
            <div
              ref={calendarDropZoneRef}
              className={`calendar-drop-zone ${calendarImagePreviewUrl ? 'has-preview' : ''}`}
              tabIndex={0}
              role="group"
              aria-label="Calendar screenshot upload area"
              aria-busy={calendarIsExtracting}
              onClick={() => {
                if (!calendarIsExtracting) {
                  calendarFileInputRef.current?.click()
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (!calendarIsExtracting) {
                    calendarFileInputRef.current?.click()
                  }
                }
              }}
              onPaste={onCalendarPaste}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleCalendarFileList(event.dataTransfer.files)
              }}
            >
              {calendarImagePreviewUrl ? (
                <img
                  className="calendar-drop-zone-preview"
                  src={calendarImagePreviewUrl}
                  alt="Calendar screenshot preview"
                />
              ) : (
                <div className="calendar-drop-zone-main">
                  <img src={calendarIcon} alt="" aria-hidden="true" />
                  <div>
                    <h4>Drop a calendar screenshot</h4>
                    <p>Browse, drag an image here, or paste from the clipboard.</p>
                  </div>
                </div>
              )}
              <div className="calendar-upload-actions">
                <button
                  type="button"
                  className="button-soft-primary"
                  onClick={(event) => {
                    event.stopPropagation()
                    calendarFileInputRef.current?.click()
                  }}
                  disabled={calendarIsExtracting}
                >
                  <span className="control-icon plus-icon" aria-hidden="true" />
                  Browse
                </button>
                <button
                  type="button"
                  className="ghost calendar-paste-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onReadCalendarImageFromClipboard()
                  }}
                  disabled={calendarIsExtracting}
                >
                  <span className="control-icon paste-icon" aria-hidden="true" />
                  Paste
                </button>
                <button
                  type="button"
                  className="button-soft-primary calendar-submit-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onSubmitCalendarScreenshot()
                  }}
                  disabled={!calendarStagedImage || calendarIsExtracting}
                >
                  <span className="control-icon save-icon" aria-hidden="true" />
                  {calendarIsExtracting ? 'Submitting...' : 'Submit'}
                </button>
              </div>
              {(calendarIsExtracting || calendarUploadStatusMessage || calendarUploadErrorMessage || calendarSelectedFileName) ? (
                <div className="calendar-upload-feedback">
                  {calendarSelectedFileName ? <strong>{calendarSelectedFileName}</strong> : null}
                  {calendarIsExtracting ? (
                    <p className="calendar-bulk-status">Extracting calendar events...</p>
                  ) : calendarUploadStatusMessage ? (
                    <p className="calendar-bulk-status">{calendarUploadStatusMessage}</p>
                  ) : null}
                  {calendarUploadErrorMessage ? (
                    <p className="calendar-bulk-error" role="alert">{calendarUploadErrorMessage}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="calendar-review-layout">
            <section className="calendar-review-timeline-panel">
              <div
                className={`timeline-grid calendar-review-timeline ${
                  selectedCalendarCandidate ? 'has-selection' : ''
                } ${
                  calendarReviewDragState?.isDragging ? 'dragging' : ''
                }`}
                role="list"
                aria-label="Calendar review timeline"
                ref={calendarReviewTimelineGridRef}
              >
                <div
                  className="timeline-canvas"
                  style={{ minHeight: `${timelineCanvasHeight}px` }}
                  onContextMenu={onOpenCalendarReviewEmptyContextMenu}
                  onDoubleClick={onDoubleClickCalendarReviewEmptySpace}
                >
                  {timelineHourMarks.map((minute) => (
                    <div
                      key={`calendar-review-hour-${minute}`}
                      className="timeline-hour-mark"
                      style={{
                        top:
                          TIMELINE_CANVAS_TOP_PADDING
                          + (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                      }}
                    >
                      <span>{minuteToLabel(minute)}</span>
                    </div>
                  ))}

                  <div className="timeline-entry-layer">
                    {positionedCalendarReviewEntries.map((positionedEntry) => {
                      const { entry } = positionedEntry
                      const candidateId = entry.id.startsWith('calendar-')
                        ? entry.id.slice('calendar-'.length)
                        : null
                      const candidate = candidateId
                        ? calendarReviewCandidates.find((reviewCandidate) => reviewCandidate.id === candidateId)
                        : null
                      const blockColor = resolveTimelineBlockColor(
                        entry,
                        activityColorById,
                        engagementColorById,
                      )
                      const blockLabel = buildTimelineBlockLabel(
                        entry,
                        positionedEntry.widthPercent,
                        positionedEntry.height,
                      )
                      const reviewLabel = getTimelineBlockReviewLabel(entry.warningFlags)
                      const blockPalette = buildTimelineBlockPalette(blockColor)
                      const blockClassName = [
                        'timeline-block',
                        'calendar-review-block',
                        `tier-${blockLabel.tier}`,
                        candidate ? `state-${candidate.reviewState}` : 'is-existing',
                        candidate?.id === selectedCalendarCandidate?.id ? 'selected' : '',
                        reviewLabel ? 'needs-review' : '',
                        candidate?.needsDateConfirmation || candidate?.needsTimeConfirmation
                          ? 'needs-confirmation'
                          : '',
                      ]
                        .filter((className) => className.length > 0)
                        .join(' ')
                      const blockStyle = {
                        top: positionedEntry.top,
                        height: positionedEntry.height,
                        left: `${positionedEntry.leftPercent}%`,
                        width: `${positionedEntry.widthPercent}%`,
                        ...buildTimelineBlockCssVariables(blockPalette),
                      } as CSSProperties
                      const title = buildTimelineBlockTitle(
                        blockLabel.fullLabel,
                        entry.description,
                        reviewLabel,
                      )

                      if (!candidate) {
                        return null
                      }

                      const isDragPreview =
                        calendarReviewDragState?.isDragging
                        && calendarReviewDragState.entryId === entry.id
                      if (isDragPreview) {
                        return (
                          <div
                            key={entry.id}
                            className={`timeline-block calendar-review-block drag-preview tier-${blockLabel.tier}`}
                            style={blockStyle}
                            title={title}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent label={blockLabel.label} />
                          </div>
                        )
                      }

                      if (candidate.reviewState === 'accepted') {
                        return (
                          <button
                            type="button"
                            key={entry.id}
                            className={blockClassName}
                            style={blockStyle}
                            onClick={() => onSelectCalendarReviewBlock(candidate.id)}
                            onPointerDown={(event) => onStartCalendarReviewDrag(event, entry, candidate.id)}
                            title={title}
                            aria-label={title}
                          >
                            <TimelineBlockContent label={blockLabel.label} />
                          </button>
                        )
                      }

                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={blockClassName}
                          style={blockStyle}
                          onClick={() => onSelectCalendarReviewBlock(candidate.id)}
                          onPointerDown={(event) => onStartCalendarReviewDrag(event, entry, candidate.id)}
                          onContextMenu={(event) => onOpenCalendarReviewContextMenu(event, entry, candidate.id)}
                          title={title}
                          aria-label={title}
                          aria-haspopup="menu"
                        >
                          <TimelineBlockContent label={blockLabel.label} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>

            <aside className={`calendar-review-editor timeline-editor ${selectedCalendarCandidate ? '' : 'is-empty'}`}>
              <div className="timeline-editor-header">
                <div>
                  <h3>Review Event</h3>
                  {selectedCalendarCandidate ? (
                    <p className={`calendar-review-state ${selectedCalendarCandidate.reviewState}`}>
                      {selectedCalendarCandidate.reviewState}
                    </p>
                  ) : null}
                </div>
              </div>

              {selectedCalendarCandidate ? (
                <>
                  <div className="stack calendar-entry-form">
                    <label>
                      Date
                      <input
                        type="date"
                        value={selectedCalendarCandidate.date}
                        onChange={(event) => {
                          const nextDate = event.target.value
                          if (!nextDate) {
                            return
                          }
                          updateCalendarCandidate(selectedCalendarCandidate.id, (candidate) => ({
                            ...candidate,
                            date: nextDate,
                            needsDateConfirmation: false,
                          }))
                        }}
                      />
                    </label>
                    <label>
                      Engagement
                      <select
                        value={selectedCalendarCandidate.engagementId ?? ''}
                        onChange={(event) =>
                          onCalendarCandidateEngagementChange(
                            selectedCalendarCandidate.id,
                            event.target.value,
                          )
                        }
                      >
                        <option value="">Uncategorized</option>
                        {engagements.map((engagement) => (
                          <option key={engagement.id} value={engagement.id}>
                            {formatEntityDisplayLabel(engagement.name, engagement.code)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Activity
                      <select
                        value={selectedCalendarCandidate.activityId ?? ''}
                        onChange={(event) =>
                          onCalendarCandidateActivityChange(
                            selectedCalendarCandidate.id,
                            event.target.value,
                          )
                        }
                      >
                        <option value="">Uncategorized</option>
                        {selectedCalendarCandidateActivities.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {formatEntityDisplayLabel(activity.name, activity.code)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Start
                      <span className="time-input-shell">
                        <input
                          type="time"
                          step={60}
                          value={minuteToTimeInput(Math.min(selectedCalendarCandidate.startMinute, MINUTES_IN_DAY - 1))}
                          onChange={(event) => {
                            const nextStartMinute = Math.min(
                              MINUTES_IN_DAY - 1,
                              Math.max(0, timeInputToMinute(event.target.value)),
                            )
                            updateCalendarCandidate(selectedCalendarCandidate.id, (candidate) => {
                              const nextEndMinute = Math.min(
                                MINUTES_IN_DAY,
                                Math.max(candidate.endMinute, nextStartMinute + 1),
                              )
                              return {
                                ...candidate,
                                startMinute: nextStartMinute,
                                endMinute: nextEndMinute,
                                durationMinutes: Math.max(1, nextEndMinute - nextStartMinute),
                                needsTimeConfirmation: false,
                              }
                            })
                          }}
                        />
                        <span className="control-icon clock-icon" aria-hidden="true" />
                      </span>
                    </label>
                    <label>
                      End
                      <span className="time-input-shell">
                        <input
                          type="time"
                          step={60}
                          value={
                            selectedCalendarCandidate.endMinute >= MINUTES_IN_DAY
                              ? END_OF_DAY_INPUT_SENTINEL
                              : minuteToTimeInput(selectedCalendarCandidate.endMinute)
                          }
                          onChange={(event) => {
                            updateCalendarCandidate(selectedCalendarCandidate.id, (candidate) => {
                              const parsedEndMinute = timeInputToMinute(event.target.value)
                              const nextEndMinute = Math.min(
                                MINUTES_IN_DAY,
                                Math.max(candidate.startMinute + 1, parsedEndMinute),
                              )
                              return {
                                ...candidate,
                                endMinute: nextEndMinute,
                                durationMinutes: Math.max(1, nextEndMinute - candidate.startMinute),
                                needsTimeConfirmation: false,
                              }
                            })
                          }}
                        />
                        <span className="control-icon clock-icon" aria-hidden="true" />
                      </span>
                    </label>
                    <label>
                      Description
                      <textarea
                        rows={4}
                        value={selectedCalendarCandidate.description}
                        onChange={(event) =>
                          updateCalendarCandidate(selectedCalendarCandidate.id, (candidate) => ({
                            ...candidate,
                            description: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="calendar-review-diagnostics">
                    <p>
                      Confidence: {(selectedCalendarCandidate.confidence * 100).toFixed(0)}%
                    </p>
                    <p>Extracted: {selectedCalendarCandidate.extractedText}</p>
                    {selectedCalendarCandidate.timeEvidence ? (
                      <p>Time evidence: {selectedCalendarCandidate.timeEvidence}</p>
                    ) : null}
                    {selectedCalendarCandidate.needsDateConfirmation ? (
                      <p className="calendar-bulk-warning-text">Date confirmation required.</p>
                    ) : null}
                    {selectedCalendarCandidate.needsTimeConfirmation ? (
                      <p className="calendar-bulk-warning-text">Time confirmation required.</p>
                    ) : null}
                    {selectedCalendarCandidate.warningFlags.length > 0 ? (
                      <div className="warning-row">
                        {selectedCalendarCandidate.warningFlags.map((warningType) => (
                          <WarningBadge
                            key={`${selectedCalendarCandidate.id}-${warningType}`}
                            type={warningType}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>

                </>
              ) : (
                <p className="timeline-editor-empty">
                  Upload a screenshot to stage calendar events for review.
                </p>
              )}

              {calendarUploadErrorMessage ? (
                <p className="calendar-bulk-error" role="alert">{calendarUploadErrorMessage}</p>
              ) : null}
            </aside>
          </div>
        )}
      </section>
    </div>,
    document.body,
  ) : null

  const codesActivitiesPane = selectedCodesEngagement ? (
    <>
      <div className="codes-activities-toolbar">
        <div className="codes-pane-title">
          <h2 title={codesActivitiesHeading}>{codesActivitiesHeading}</h2>
        </div>
        <input
          type="search"
          className="quick-add-search codes-activity-search"
          value={codesActivitySearch}
          onChange={(event) => setCodesActivitySearch(event.target.value)}
          placeholder="Search activities"
          aria-label="Search activities"
          disabled={codesIsEditing}
        />
      </div>

      <div className="codes-activity-list">
        {selectedCodesEngagement.activities.length === 0 ? (
          <p className="engagement-empty-state">No activities yet.</p>
        ) : filteredCodesActivities.length === 0 ? (
          <p className="engagement-empty-state">No matching activities.</p>
        ) : (
          filteredCodesActivities.map((activity) => {
            const activityColor =
              normalizeColorHexInput(activity.colorHex)
              ?? normalizeColorHexInput(selectedCodesEngagement.colorHex)
              ?? TIMELINE_NEUTRAL_COLOR

            return (
              <div
                key={activity.id}
                className={`codes-activity-row ${activity.isActive ? '' : 'is-inactive'}`}
                style={{ '--codes-activity-color': activityColor } as CSSProperties}
              >
                <div>
                  <div className="codes-title-line">
                    {activity.code ? (
                      <span className="code-item-badge">{activity.code}</span>
                    ) : null}
                    <strong>{activity.name}</strong>
                    {activity.isActive ? null : (
                      <span className="codes-state-pill">Inactive</span>
                    )}
                  </div>
                  {activity.describeWhenToUse?.trim() ? (
                    <span className="codes-activity-usage">
                      {activity.describeWhenToUse}
                    </span>
                  ) : null}
                  <ResponsiveCodeTagList
                    tags={activity.tags}
                    itemKeyPrefix={`codes-activity-${activity.id}`}
                  />
                </div>
                <div className="code-item-actions">
                  <button
                    type="button"
                    className="icon-action-button"
                    aria-label={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                    onClick={() => {
                      setCodesSelectedEngagementId(activity.engagementId)
                      onEditActivity(activity)
                      setCodesDetailMode('edit-activity')
                    }}
                    disabled={codesIsEditing}
                  >
                    <img src={editIcon} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-action-button is-danger"
                    aria-label={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                    onClick={() => {
                      setCodesDetailMode('activities')
                      onDeleteActivity(activity.id)
                    }}
                    disabled={codesIsEditing}
                  >
                    <img src={deleteIcon} alt="" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </>
  ) : (
    <p className="code-list-empty">No engagement selected.</p>
  )

  if (!appRuntime) {
    return (
      <div className="runtime-shell">
        <h1>OmniSheet</h1>
        <p>This application requires the Tauri runtime.</p>
        <p>Start it with `npm run tauri dev` after installing Rust toolchain.</p>
      </div>
    )
  }

  return (
    <div className="app-shell" data-testid="omnisheet-app-shell">
      <div className={`workspace-shell ${activeView === 'timeline' ? 'with-timeline' : 'without-timeline'}`}>
        <aside className="sidebar-panel">
          <section className={`sidebar-section sidebar-capture ${isLlmEntryCollapsed ? 'is-llm-collapsed' : ''}`}>
            <div className="sidebar-section-header">
              <button
                type="button"
                className="sidebar-section-title-button"
                onClick={() => setIsLlmEntryCollapsed((previous) => !previous)}
                aria-expanded={!isLlmEntryCollapsed}
                aria-controls="llm-entry-body"
                title={isLlmEntryCollapsed ? 'Expand LLM Entry' : 'Collapse LLM Entry'}
              >
                <span>LLM Entry</span>
                <span
                  className={`control-icon ${isLlmEntryCollapsed ? 'chevron-down' : 'chevron-up'}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div id="llm-entry-body" className="llm-entry-body" hidden={isLlmEntryCollapsed}>
              <form onSubmit={onSubmitCapture} className="stack">
                <textarea
                  aria-label="Entry message"
                  value={captureMessage}
                  onKeyDown={onCaptureMessageKeyDown}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setCaptureMessage(nextValue)
                    if (nextValue.trim().length === 0) {
                      setCaptureDraftMetadata(null)
                      if (voiceCaptureState === 'idle') {
                        setVoiceCaptureStatusMessage(null)
                      }
                    }
                  }}
                  placeholder="Example: Just finished a 30 minute SAP ITGC meeting with the Apple team"
                  rows={4}
                  required={voiceCaptureState !== 'recording'}
                />
                {voiceCaptureStatusMessage ? (
                  <p className={`capture-status ${voiceCaptureState === 'recording' ? 'recording' : ''}`}>
                    {voiceCaptureStatusMessage}
                  </p>
                ) : null}
                <div className="capture-actions">
                  <button
                    type="button"
                    className={`capture-mic-button ${voiceCaptureState === 'recording' ? 'recording' : ''}`}
                    onClick={() => {
                      if (voiceCaptureState === 'recording') {
                        void stopVoiceRecordingToDraft()
                        return
                      }

                      void startVoiceRecording()
                    }}
                    disabled={voiceCaptureState === 'transcribing'}
                    aria-label={voiceCaptureState === 'recording' ? 'Stop recording' : 'Start recording'}
                    title={voiceCaptureState === 'recording' ? 'Stop recording' : 'Start recording'}
                  >
                    <img src={microphoneIcon} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="capture-calendar-button"
                    onClick={openCalendarBulkModal}
                    disabled={voiceCaptureState === 'transcribing' || calendarIsExtracting}
                    aria-label="Open calendar bulk add"
                    title="Calendar bulk add"
                  >
                    <img src={calendarIcon} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="submit"
                    disabled={
                      voiceCaptureState === 'transcribing'
                      || (voiceCaptureState !== 'recording' && captureMessage.trim().length === 0)
                    }
                  >
                    {voiceCaptureState === 'recording' ? 'Stop & Send' : 'Send'}
                  </button>
                </div>
                {llmSubmissionStatus ? (
                  <p
                    className={`capture-llm-status ${llmSubmissionStatus.kind}`}
                    aria-live="polite"
                  >
                    {llmSubmissionStatus.message}
                  </p>
                ) : null}
              </form>
            </div>

            <div className="quick-add-panel" aria-label="Quick Entry">
              <div className="quick-add-header">
                <h3>Quick Entry</h3>
                <button
                  type="button"
                  className="quick-add-settings-button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openQuickAddSettings}
                  aria-label="Open Quick Entry settings"
                  title="Quick Entry settings"
                >
                  <img src={settingsIcon} alt="" aria-hidden="true" draggable={false} />
                </button>
              </div>
              <input
                className="quick-add-search"
                type="search"
                value={quickAddSearch}
                onChange={(event) => setQuickAddSearch(event.target.value)}
                placeholder="Search activities"
                aria-label="Search quick entry activities"
              />
              {quickAddSuggestionsError ? (
                <p className="quick-add-error" role="status">{quickAddSuggestionsError}</p>
              ) : null}
              {quickAddActivityGroups.length === 0 ? (
                <p className="quick-add-empty">
                  {allQuickAddActivities.length === 0
                    ? 'No active activities yet.'
                    : orderedQuickAddActivities.length === 0 && quickAddSearch.trim().length === 0
                      ? 'All Quick Entry items are hidden.'
                      : 'No matching activities.'}
                </p>
              ) : (
                <div className="quick-add-scroll-frame">
                  <div
                    ref={quickAddScrollRef}
                    className="quick-add-scroll"
                    onScroll={updateQuickAddScrollMetrics}
                  >
                    <div className="quick-add-list">
                      {quickAddActivityGroups.map((group) => {
                        const engagementColor = group.engagement.colorHex ?? TIMELINE_NEUTRAL_COLOR

                        return (
                          <section
                            key={group.engagement.id}
                            className="quick-add-group"
                            style={{
                              '--quick-add-color': engagementColor,
                            } as CSSProperties}
                          >
                            <div
                              className="quick-add-group-header"
                              title={formatEntityDisplayLabel(
                                group.engagement.name,
                                group.engagement.code,
                                'Engagement',
                              )}
                            >
                              <span>{formatEntityPrimaryLabel(
                                group.engagement.name,
                                group.engagement.code,
                                'Engagement',
                              )}</span>
                            </div>
                            <div className="quick-add-grid">
                              {group.activities.map(({ activity, engagement }) => {
                                const activityColor = activity.colorHex ?? engagementColor
                                const isDraggingActivity =
                                  quickBlockDragState?.activityId === activity.id
                                  && quickBlockDragState.engagementId === engagement.id
                                const durationMinutes = isDraggingActivity
                                  ? quickBlockDragState.durationMinutes
                                  : TIMELINE_MANUAL_CREATE_DURATION_MINUTES
                                const activityLabel = activity.name || activity.code
                                const fullActivityLabel = formatEntityDisplayLabel(activity.name, activity.code)

                                return (
                                  <button
                                    key={activity.id}
                                    type="button"
                                    className={`quick-add-tile ${isDraggingActivity ? 'dragging' : ''}`}
                                    onPointerDown={(event) =>
                                      onQuickBlockActivityPointerDown(event, engagement, activity)
                                    }
                                    onPointerMove={onQuickBlockActivityPointerMove}
                                    onPointerUp={(event) =>
                                      onQuickBlockActivityPointerUp(event, engagement, activity)
                                    }
                                    onPointerCancel={onQuickBlockActivityPointerCancel}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        createQuickBlockEntry(
                                          engagement,
                                          activity,
                                          TIMELINE_MANUAL_CREATE_DURATION_MINUTES,
                                        )
                                      }
                                    }}
                                    aria-label={`Add ${fullActivityLabel} for ${formatQuickBlockDuration(durationMinutes)}`}
                                    title={fullActivityLabel}
                                    style={{
                                      '--quick-add-color': activityColor,
                                      '--quick-add-duration-progress': `${quickBlockDurationProgress(durationMinutes)}%`,
                                    } as CSSProperties}
                                  >
                                    <span className="quick-add-tile-main">
                                      <strong>{activityLabel}</strong>
                                    </span>
                                    {isDraggingActivity ? (
                                      <span className="quick-add-duration">
                                        {formatQuickBlockDuration(durationMinutes)}
                                      </span>
                                    ) : null}
                                    {isDraggingActivity ? (
                                      <span className="quick-add-duration-track" aria-hidden="true">
                                        <span />
                                      </span>
                                    ) : null}
                                  </button>
                                )
                              })}
                            </div>
                          </section>
                        )
                      })}
                    </div>
                  </div>
                  {quickAddScrollMetrics.canScroll ? (
                    <div
                      className="quick-add-scroll-indicator"
                      aria-hidden="true"
                    >
                      <span />
                    </div>
                  ) : null}
                </div>
              )}
            </div>

          </section>

          <section className="sidebar-section sidebar-calendar">
            <MiniCalendar
              selectedDate={selectedDate}
              visibleMonth={visibleMonth}
              todayDate={todayDate}
              daysWithEntries={visibleMonthDaysWithEntries}
              highlightedDates={miniCalendarHighlightedDates}
              isLoading={monthSummaryLoadingMonth === visibleMonth}
              errorMessage={visibleMonthSummaryError}
              onVisibleMonthChange={setVisibleMonth}
              onSelectDate={onSelectCalendarDate}
            />
          </section>
        </aside>

        <main className="app-main">
          <SegmentedControl
            ariaLabel="Main views"
            className="main-view-tabs"
            mode="tab"
            options={mainViewTabs}
            value={activeView}
            onChange={onSelectView}
          />

          <div className="app-notices" aria-live="polite">
            {errorMessage ? (
              <div className="alert error" role="alert">
                <span className="alert-message">{errorMessage}</span>
                <button
                  type="button"
                  className="alert-close"
                  aria-label="Dismiss error message"
                  onClick={() => setErrorMessage(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
            {successMessage ? (
              <div className="alert success" role="status">
                <span className="alert-message">{successMessage}</span>
                <button
                  type="button"
                  className="alert-close"
                  aria-label="Dismiss success message"
                  onClick={() => setSuccessMessage(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
          </div>

          <div className={`app-content ${activeView === 'timeline' || activeView === 'week' ? 'timeline-active' : 'wide-active'}`}>

        {activeView === 'timeline' ? (
          <section className="panel timeline-panel">
            <div className="timeline-toolbar">
              <div>
                <h2 className="timeline-date-heading">
                  <strong>{timelineHeaderDate.monthDay}</strong>, {timelineHeaderDate.year}
                </h2>
                <p className="timeline-range">
                  {timelineHeaderDate.weekday}
                  {buildTimelineTotalDisplaySegments(timelineDayTotalBreakdown, {
                    includePrimaryTotal: true,
                    separateEngagementTypeTotals: timelineSeparateEngagementTypeTotals,
                    showUncategorizedTotal: shouldShowTimelineDayUncategorizedDailyTotal,
                  }).map((segment) => (
                    <Fragment key={segment.key}>
                      <span className="timeline-range-separator" aria-hidden="true">•</span>
                      <span
                        className={`timeline-range-total ${segment.key === 'total' ? '' : 'timeline-range-total-secondary'}`}
                      >
                        {segment.label}
                      </span>
                    </Fragment>
                  ))}
                </p>
              </div>
              <div className="timeline-controls timeline-stepper" aria-label="Day navigation">
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-prev"
                  aria-label="Previous day"
                  title="Previous day"
                  onClick={() => onSetDate(shiftDate(selectedDate, -1))}
                  disabled={isTimelineLoading}
                >
                  <span className="control-icon chevron-left" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="stepper-button stepper-center"
                  onClick={onJumpToToday}
                  disabled={isTimelineLoading}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-next"
                  aria-label="Next day"
                  title="Next day"
                  onClick={() => onSetDate(shiftDate(selectedDate, 1))}
                  disabled={isTimelineLoading}
                >
                  <span className="control-icon chevron-right" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="timeline-layout">
              <div
                className={`timeline-grid ${timelineDragState?.isDragging ? 'dragging' : ''}`}
                role="list"
                aria-label="Timeline entries"
                aria-busy={isTimelineLoading}
                ref={timelineGridRef}
              >
                <div
                  className="timeline-canvas"
                  style={{ minHeight: `${timelineCanvasHeight}px` }}
                  onContextMenu={onOpenTimelineEmptyContextMenu}
                  onDoubleClick={onDoubleClickTimelineEmptySpace}
                >
                  {timelineHourMarks.map((minute) => (
                    <div
                      key={minute}
                      className="timeline-hour-mark"
                      style={{
                        top:
                          TIMELINE_CANVAS_TOP_PADDING
                          + (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                      }}
                    >
                      <span>{minuteToLabel(minute)}</span>
                    </div>
                  ))}

                  {shouldShowDayCurrentTimeIndicator ? (
                    <div
                      className="timeline-current-time-indicator timeline-current-time-indicator-day"
                      style={{ top: currentTimelineTop }}
                      aria-hidden="true"
                    >
                      <span className="timeline-current-time-label">{currentTimelineLabel}</span>
                    </div>
                  ) : null}

                  <div className="timeline-entry-layer">
                    {draggedEntryOriginPosition
                      ? (() => {
                        const ghostEntry = draggedEntryOriginPosition.entry
                        const ghostColor = resolveTimelineBlockColor(
                          ghostEntry,
                          activityColorById,
                          engagementColorById,
                        )
                        const ghostLabel = buildTimelineBlockLabel(
                          ghostEntry,
                          draggedEntryOriginPosition.widthPercent,
                          draggedEntryOriginPosition.height,
                        )
                        const ghostReviewLabel = getTimelineBlockReviewLabel(ghostEntry.warningFlags)
                        const ghostPalette = buildTimelineBlockPalette(ghostColor)
                        const ghostNeedsReview = ghostReviewLabel !== null

                        return (
                          <div
                            className={`timeline-block drag-origin-ghost tier-${ghostLabel.tier} ${ghostNeedsReview ? 'needs-review' : ''}`}
                            style={{
                              top: draggedEntryOriginPosition.top,
                              height: draggedEntryOriginPosition.height,
                              left: `${draggedEntryOriginPosition.leftPercent}%`,
                              width: `${draggedEntryOriginPosition.widthPercent}%`,
                              ...buildTimelineBlockCssVariables(ghostPalette),
                            } as CSSProperties}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent label={ghostLabel.label} />
                          </div>
                        )
                      })()
                      : null}
                    {previewPositionedTimelineEntries.map((positionedEntry) => {
                      const { entry } = positionedEntry
                      const blockColor = resolveTimelineBlockColor(
                        entry,
                        activityColorById,
                        engagementColorById,
                      )
                      const blockLabel = buildTimelineBlockLabel(
                        entry,
                        positionedEntry.widthPercent,
                        positionedEntry.height,
                      )
                      const reviewLabel = getTimelineBlockReviewLabel(entry.warningFlags)
                      const needsReview = reviewLabel !== null
                      const isDragPreview =
                        timelineDragState?.isDragging
                        && timelineDragState.surface === 'day'
                        && timelineDragState.entryId === entry.id
                      const shouldShowDurationBadge =
                        timelineDragState?.surface === 'day'
                        && timelineDragState.entryId === entry.id
                        && (
                          timelineDragState.dragMode === 'pending'
                          || timelineDragState.dragMode === 'resize-duration'
                        )
                      const blockPalette = buildTimelineBlockPalette(blockColor)

                      if (isDragPreview) {
                        return (
                          <div
                            key={entry.id}
                            className={`timeline-block drag-preview tier-${blockLabel.tier} ${shouldShowDurationBadge ? 'duration-active' : ''}`}
                            style={{
                              top: positionedEntry.top,
                              height: positionedEntry.height,
                              left: `${positionedEntry.leftPercent}%`,
                              width: `${positionedEntry.widthPercent}%`,
                              ...buildTimelineBlockCssVariables(blockPalette),
                            } as CSSProperties}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent
                              label={blockLabel.label}
                              durationLabel={
                                shouldShowDurationBadge
                                  ? formatQuickBlockDuration(entry.durationMinutes)
                                  : null
                              }
                            />
                          </div>
                        )
                      }

                      const blockClassName = [
                        'timeline-block',
                        `tier-${blockLabel.tier}`,
                        selectedEntryId === entry.id || highlightedEntryId === entry.id ? 'selected' : '',
                        needsReview ? 'needs-review' : '',
                        shouldShowDurationBadge ? 'duration-active' : '',
                      ]
                        .filter((className) => className.length > 0)
                        .join(' ')

                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={blockClassName}
                          style={{
                            top: positionedEntry.top,
                            height: positionedEntry.height,
                            left: `${positionedEntry.leftPercent}%`,
                            width: `${positionedEntry.widthPercent}%`,
                            ...buildTimelineBlockCssVariables(blockPalette),
                          } as CSSProperties}
                          onClick={() => onSelectTimelineBlock(entry)}
                          onPointerDown={(event) => onStartTimelineDrag(event, entry)}
                          onContextMenu={(event) => {
                            if (timelineDragState?.isDragging) {
                              event.preventDefault()
                              return
                            }
                            event.stopPropagation()
                            onOpenTimelineContextMenu(event, entry)
                          }}
                          title={buildTimelineBlockTitle(
                            blockLabel.fullLabel,
                            entry.description,
                            reviewLabel,
                          )}
                          aria-label={buildTimelineBlockAriaLabel(
                            blockLabel.fullLabel,
                            entry.description,
                            reviewLabel,
                          )}
                          aria-haspopup="menu"
                        >
                          <TimelineBlockContent
                            label={blockLabel.label}
                            durationLabel={
                              shouldShowDurationBadge
                                ? formatQuickBlockDuration(entry.durationMinutes)
                                : null
                            }
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {timelineEditorPanel}
            </div>
          </section>
        ) : null}

        {activeView === 'week' ? (
          <section className="panel timeline-panel week-panel">
            <div className="timeline-toolbar">
              <div>
                <h2 className="timeline-date-heading">
                  {weekTimelineRangeLabel.isSameYear ? (
                    <>
                      <strong>
                        {weekTimelineRangeLabel.startMonthDay} - {weekTimelineRangeLabel.endMonthDay}
                      </strong>
                      , {weekTimelineRangeLabel.endYear}
                    </>
                  ) : (
                    <>
                      <strong>{weekTimelineRangeLabel.startMonthDay}</strong>
                      , {weekTimelineRangeLabel.startYear} -{' '}
                      <strong>{weekTimelineRangeLabel.endMonthDay}</strong>
                      , {weekTimelineRangeLabel.endYear}
                    </>
                  )}
                </h2>
                <p className="timeline-range">
                  {buildTimelineTotalDisplaySegments(weekTimelineTotalBreakdown, {
                    includePrimaryTotal: true,
                    separateEngagementTypeTotals: timelineSeparateEngagementTypeTotals,
                    showUncategorizedTotal: shouldShowTimelineDayUncategorizedDailyTotal,
                  }).map((segment, segmentIndex) => (
                    <Fragment key={segment.key}>
                      {segmentIndex > 0 ? (
                        <span className="timeline-range-separator" aria-hidden="true">•</span>
                      ) : null}
                      <span
                        className={`timeline-range-total ${segment.key === 'total' ? '' : 'timeline-range-total-secondary'}`}
                      >
                        {segment.label}
                      </span>
                    </Fragment>
                  ))}
                </p>
              </div>
              <div className="timeline-controls timeline-stepper" aria-label="Week navigation">
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-prev"
                  aria-label="Previous week"
                  title="Previous week"
                  onClick={() => onSetDate(shiftDate(selectedDate, -7))}
                  disabled={isWeekTimelineLoading}
                >
                  <span className="control-icon chevron-left" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="stepper-button stepper-center"
                  onClick={onJumpToThisWeek}
                  disabled={isWeekTimelineLoading}
                >
                  This Week
                </button>
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-next"
                  aria-label="Next week"
                  title="Next week"
                  onClick={() => onSetDate(shiftDate(selectedDate, 7))}
                  disabled={isWeekTimelineLoading}
                >
                  <span className="control-icon chevron-right" aria-hidden="true" />
                </button>
              </div>
            </div>

            {weekTimelineError ? (
              <p className="mini-calendar-error">{weekTimelineError}</p>
            ) : null}

            <div className={`timeline-layout week-timeline-layout ${selectedEntry ? 'has-editor' : 'full-width'}`}>
              <div
                className={`timeline-grid week-timeline-grid ${(timelineDragState?.isDragging && timelineDragState.surface === 'week') ? 'dragging' : ''}`}
                style={{
                  '--week-timeline-gutter-left': `${weekTimelineLayoutMetrics.gutterLeft}px`,
                  '--week-timeline-day-width': `${weekTimelineLayoutMetrics.dayWidth}px`,
                  '--week-timeline-header-height': `${weekTimelineLayoutMetrics.headerHeight}px`,
                } as CSSProperties}
                role="list"
                aria-label="Week timeline entries"
                aria-busy={isWeekTimelineLoading}
                ref={weekTimelineGridRef}
              >
                <div
                  className="week-timeline-surface"
                  style={{
                    minWidth: `${weekTimelineLayoutMetrics.gutterLeft + (weekTimelineLayoutMetrics.dayWidth * weekTimelineDays.length)}px`,
                    minHeight: `${timelineCanvasHeight + weekTimelineLayoutMetrics.headerHeight}px`,
                  }}
                >
                  <div className="week-timeline-header">
                    <div className="week-timeline-header-spacer" aria-hidden="true" />
                    {weekTimelineDays.map((day) => {
                      const isSelectedDay = day.date === selectedDate
                      const isToday = day.date === todayDate
                      const dayTotalBreakdown =
                        weekTimelineDayTotalBreakdowns.get(day.date)
                        ?? createEmptyTimelineTotalBreakdown()
                      const shouldShowDayUncategorizedDailyTotal =
                        shouldShowTimelineUncategorizedDailyTotal
                        && dayTotalBreakdown.uncategorizedMinutes > 0
                      const weekDayPrimaryTotalSegments = buildWeekTimelinePrimaryTotalSegments(
                        dayTotalBreakdown,
                        timelineSeparateEngagementTypeTotals,
                      )
                      const headerClassName = [
                        'week-timeline-day-header',
                        isSelectedDay ? 'is-selected' : '',
                        isToday ? 'is-today' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')

                      return (
                        <div key={day.date} className={headerClassName}>
                          <span className="week-timeline-day-label">
                            {formatWeekTimelineDayLabel(day.date)}
                          </span>
                          <span className="week-timeline-day-total">
                            <span className="week-timeline-day-total-line">
                              {weekDayPrimaryTotalSegments.map((segment, segmentIndex) => (
                                <Fragment key={segment.key}>
                                  {segmentIndex > 0 ? (
                                    <span className="week-timeline-day-total-separator" aria-hidden="true">
                                      •
                                    </span>
                                  ) : null}
                                  <span>{segment.label}</span>
                                </Fragment>
                              ))}
                            </span>
                            {shouldShowDayUncategorizedDailyTotal ? (
                              <span className="week-timeline-day-uncategorized-total">
                                {formatTimelineHoursCompact(dayTotalBreakdown.uncategorizedMinutes)} uncategorized
                              </span>
                            ) : null}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  <div
                    className="week-timeline-body"
                    style={{ minHeight: `${timelineCanvasHeight}px` }}
                    onContextMenu={(event) => onOpenTimelineEmptyContextMenu(event, 'week')}
                    onDoubleClick={(event) => onDoubleClickTimelineEmptySpace(event, 'week')}
                  >
                    {timelineHourMarks.map((minute) => (
                      <div
                        key={`week-hour-${minute}`}
                        className="timeline-hour-mark week-timeline-hour-mark"
                        style={{
                          top:
                            TIMELINE_CANVAS_TOP_PADDING
                            + (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                        }}
                      >
                        <span>{minuteToLabel(minute)}</span>
                      </div>
                    ))}

                    <div className="week-timeline-frozen-gutter-layer" aria-hidden="true">
                      <div className="week-timeline-frozen-gutter">
                        {timelineHourMarks.map((minute) => (
                          <div
                            key={`week-gutter-hour-${minute}`}
                            className="week-timeline-frozen-hour-mark"
                            style={{
                              top:
                                TIMELINE_CANVAS_TOP_PADDING
                                + (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                            }}
                          >
                            <span>{minuteToLabel(minute)}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {weekTimelineDays.map((day, dayIndex) => (
                      <div
                        key={`week-column-${day.date}`}
                        className={`week-timeline-day-column ${day.date === selectedDate ? 'is-selected' : ''}`}
                        style={{
                          left: `${weekTimelineLayoutMetrics.gutterLeft + (dayIndex * weekTimelineLayoutMetrics.dayWidth)}px`,
                          width: `${weekTimelineLayoutMetrics.dayWidth}px`,
                          top: '0px',
                          minHeight: `${timelineCanvasHeight}px`,
                        }}
                        aria-hidden="true"
                      />
                    ))}

                    {shouldShowWeekCurrentTimeIndicator ? (
                      <div
                        className="timeline-current-time-indicator week-timeline-current-time-indicator"
                        style={{
                          top: currentTimelineTop,
                          left:
                            weekTimelineLayoutMetrics.gutterLeft
                            + (currentWeekTimelineDayIndex * weekTimelineLayoutMetrics.dayWidth),
                          width: weekTimelineLayoutMetrics.dayWidth,
                        }}
                        aria-hidden="true"
                      >
                        <span className="timeline-current-time-label">{currentTimelineLabel}</span>
                      </div>
                    ) : null}

                    <div className="week-timeline-entry-layer">
                      {draggedWeekEntryOriginPosition && timelineDragState?.surface === 'week'
                        ? (() => {
                          const ghostEntry = draggedWeekEntryOriginPosition.entry
                          const ghostColor = resolveTimelineBlockColor(
                            ghostEntry,
                            activityColorById,
                            engagementColorById,
                          )
                          const ghostLabel = buildTimelineBlockLabel(
                            ghostEntry,
                            draggedWeekEntryOriginPosition.widthPercent,
                            draggedWeekEntryOriginPosition.height,
                          )
                          const ghostReviewLabel = getTimelineBlockReviewLabel(ghostEntry.warningFlags)
                          const ghostPalette = buildTimelineBlockPalette(ghostColor)
                          const ghostNeedsReview = ghostReviewLabel !== null

                          return (
                            <div
                              className={`timeline-block drag-origin-ghost tier-${ghostLabel.tier} ${ghostNeedsReview ? 'needs-review' : ''}`}
                              style={{
                                top: draggedWeekEntryOriginPosition.top,
                                height: draggedWeekEntryOriginPosition.height,
                                left: draggedWeekEntryOriginPosition.left,
                                width: draggedWeekEntryOriginPosition.width,
                                ...buildTimelineBlockCssVariables(ghostPalette),
                              } as CSSProperties}
                              aria-hidden="true"
                            >
                              <TimelineBlockContent label={ghostLabel.label} />
                            </div>
                          )
                        })()
                        : null}
                      {previewPositionedWeekTimelineEntries.map((positionedEntry) => {
                        const { entry } = positionedEntry
                        const blockColor = resolveTimelineBlockColor(
                          entry,
                          activityColorById,
                          engagementColorById,
                        )
                        const blockLabel = buildTimelineBlockLabel(
                          entry,
                          positionedEntry.widthPercent,
                          positionedEntry.height,
                        )
                        const reviewLabel = getTimelineBlockReviewLabel(entry.warningFlags)
                        const needsReview = reviewLabel !== null
                        const isDragPreview =
                          timelineDragState?.isDragging
                          && timelineDragState.surface === 'week'
                          && timelineDragState.entryId === entry.id
                        const shouldShowDurationBadge =
                          timelineDragState?.surface === 'week'
                          && timelineDragState.entryId === entry.id
                          && (
                            timelineDragState.dragMode === 'pending'
                            || timelineDragState.dragMode === 'resize-duration'
                          )
                        const blockPalette = buildTimelineBlockPalette(blockColor)

                        if (isDragPreview) {
                          return (
                            <div
                              key={entry.id}
                              className={`timeline-block drag-preview tier-${blockLabel.tier} ${shouldShowDurationBadge ? 'duration-active' : ''}`}
                              style={{
                                top: positionedEntry.top,
                                height: positionedEntry.height,
                                left: positionedEntry.left,
                                width: positionedEntry.width,
                                ...buildTimelineBlockCssVariables(blockPalette),
                              } as CSSProperties}
                              aria-hidden="true"
                            >
                              <TimelineBlockContent
                                label={blockLabel.label}
                                durationLabel={
                                  shouldShowDurationBadge
                                    ? formatQuickBlockDuration(entry.durationMinutes)
                                    : null
                                }
                              />
                            </div>
                          )
                        }

                        const blockClassName = [
                          'timeline-block',
                          `tier-${blockLabel.tier}`,
                          selectedEntryId === entry.id || highlightedEntryId === entry.id ? 'selected' : '',
                          needsReview ? 'needs-review' : '',
                          shouldShowDurationBadge ? 'duration-active' : '',
                        ]
                          .filter((className) => className.length > 0)
                          .join(' ')

                        return (
                          <button
                            type="button"
                            key={entry.id}
                            className={blockClassName}
                            style={{
                              top: positionedEntry.top,
                              height: positionedEntry.height,
                              left: positionedEntry.left,
                              width: positionedEntry.width,
                              ...buildTimelineBlockCssVariables(blockPalette),
                            } as CSSProperties}
                            onClick={() => onSelectWeekTimelineBlock(entry)}
                            onPointerDown={(event) => onStartTimelineDrag(event, entry, 'week')}
                            onContextMenu={(event) => {
                              if (timelineDragState?.isDragging) {
                                event.preventDefault()
                                return
                              }
                              event.stopPropagation()
                              onOpenTimelineContextMenu(event, entry, 'week')
                            }}
                            title={buildTimelineBlockTitle(
                              blockLabel.fullLabel,
                              entry.description,
                              reviewLabel,
                            )}
                            aria-label={buildTimelineBlockAriaLabel(
                              blockLabel.fullLabel,
                              entry.description,
                              reviewLabel,
                            )}
                            aria-haspopup="menu"
                          >
                            <TimelineBlockContent
                              label={blockLabel.label}
                              durationLabel={
                                shouldShowDurationBadge
                                  ? formatQuickBlockDuration(entry.durationMinutes)
                                  : null
                              }
                            />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {selectedEntry ? timelineEditorPanel : null}
            </div>
          </section>
        ) : null}

        {activeView === 'codes' ? (
          <section className="panel codes-prototype codes-panel">
            <div className="codes-layout">
              <aside className="codes-rail" aria-label="Engagement hierarchy">
                <div className="codes-rail-header">
                  <div className="codes-pane-title">
                    <h2>Engagements</h2>
                  </div>
                  <input
                    type="search"
                    className="quick-add-search codes-engagement-search"
                    value={codesEngagementSearch}
                    onChange={(event) => setCodesEngagementSearch(event.target.value)}
                    placeholder="Search engagements"
                    aria-label="Search engagements"
                  />
                </div>
                <div className="codes-rail-list">
                  {engagements.length === 0 ? (
                    <p className="code-list-empty">No engagements yet.</p>
                  ) : filteredCodesEngagements.length === 0 ? (
                    <p className="code-list-empty">No matching engagements.</p>
                  ) : (
                    filteredCodesEngagements.map((engagement) => {
                      const engagementColor =
                        normalizeColorHexInput(engagement.colorHex) ?? TIMELINE_NEUTRAL_COLOR
                      const isSelected = selectedCodesEngagement?.id === engagement.id

                      return (
                        <div
                          key={engagement.id}
                          className={`codes-rail-item ${isSelected ? 'active' : ''} ${
                            engagement.isActive ? '' : 'is-inactive'
                          }`}
                          style={{ '--codes-engagement-color': engagementColor } as CSSProperties}
                        >
                          <button
                            type="button"
                            className="codes-rail-select"
                            onClick={() => {
                              setCodesSelectedEngagementId(engagement.id)
                              setCodesCreateContextEngagementId(engagement.id)
                              setCodesActivitySearch('')
                              closeCodeEditor()
                            }}
                          >
                            <span className="codes-rail-copy">
                              <span className="codes-rail-title">
                                {engagement.code ? (
                                  <span className="code-item-badge">{engagement.code}</span>
                                ) : null}
                                <span>{engagement.name}</span>
                                {engagement.isActive ? null : (
                                  <span className="codes-state-pill">Inactive</span>
                                )}
                              </span>
                              <small>
                                {engagement.describeWhenToUse?.trim() || 'Usage guidance not added yet.'}
                              </small>
                            </span>
                          </button>
                          <div className="codes-rail-actions">
                            <button
                              type="button"
                              className="icon-action-button"
                              aria-label={`Edit engagement ${formatEntityDisplayLabel(
                                engagement.name,
                                engagement.code,
                              )}`}
                              title={`Edit engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => {
                                setCodesSelectedEngagementId(engagement.id)
                                setCodesCreateContextEngagementId(engagement.id)
                                setCodesActivitySearch('')
                                onEditEngagement(engagement)
                                setCodesDetailMode('edit-engagement')
                              }}
                            >
                              <img src={editIcon} alt="" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-action-button is-danger"
                              aria-label={`Delete engagement ${formatEntityDisplayLabel(
                                engagement.name,
                                engagement.code,
                              )}`}
                              title={`Delete engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => {
                                setCodesDetailMode('activities')
                                onDeleteEngagement(engagement.id)
                              }}
                            >
                              <img src={deleteIcon} alt="" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
                <button
                  type="button"
                  className="ghost codes-pane-create-button codes-floating-add-button"
                  onClick={openCodesCreateEngagementFromPane}
                  disabled={isBusy}
                >
                  <span className="control-icon plus-icon" aria-hidden="true" />
                  Add Engagement
                </button>
              </aside>

              <section
                className={`codes-detail ${codesIsEditing ? 'is-editing' : ''}`}
              >
                {codesIsEditing ? (
                  <div className="codes-activities-surface is-under-editing" aria-hidden="true">
                    {codesActivitiesPane}
                  </div>
                ) : null}
                {codesDetailMode === 'edit-engagement' && isEditingEngagement ? (
                  <form className="stack code-editor-form codes-edit-form codes-edit-form" onSubmit={onSubmitEngagement}>
                    <div className="codes-edit-header">
                      <h3>Edit Engagement</h3>
                      <div className="codes-edit-header-actions">
                        <button type="button" className="ghost" onClick={closeCodeEditor}>
                          Cancel
                        </button>
                        <button type="submit" className="button-soft-primary" disabled={isBusy}>
                          Update
                        </button>
                      </div>
                    </div>
                    <label>
                      <span className="field-label-row">
                        Engagement Name
                        <span className="required-indicator" aria-hidden="true">*</span>
                      </span>
                      <span className="field-helper">Required</span>
                      <input
                        value={engagementForm.name}
                        onChange={(event) =>
                          setEngagementForm((previous) => ({
                            ...previous,
                            name: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>
                    <label>
                      Engagement Code
                      <input
                        value={engagementForm.code}
                        onChange={(event) => {
                          const nextCode = event.target.value
                          setEngagementForm((previous) => ({
                            ...previous,
                            code: nextCode,
                            engagementType: hasManualEngagementTypeSelection
                              ? previous.engagementType
                              : inferEngagementTypeFromCode(nextCode),
                          }))
                        }}
                      />
                    </label>
                    <label>
                      <span className="field-label-row">
                        Describe when to use this engagement
                      </span>
                      <span className="field-helper">Used for LLM matching</span>
                      <textarea
                        rows={3}
                        maxLength={500}
                        value={engagementForm.describeWhenToUse}
                        onChange={(event) =>
                          setEngagementForm((previous) => ({
                            ...previous,
                            describeWhenToUse: event.target.value,
                          }))
                        }
                        placeholder="Use this engagement when..."
                      />
                    </label>
                    <label>
                      Tags / Key Words (comma separated)
                      <span className="field-helper">Used for LLM matching</span>
                      <input
                        value={engagementForm.tags}
                        onChange={(event) =>
                          setEngagementForm((previous) => ({
                            ...previous,
                            tags: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Client
                      <input
                        value={engagementForm.client}
                        onChange={(event) =>
                          setEngagementForm((previous) => ({
                            ...previous,
                            client: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="code-editor-field">
                      <span className="code-editor-field-label">Engagement Type</span>
                      <SegmentedControl
                        ariaLabel="Engagement type"
                        className="engagement-type-segmented"
                        options={ENGAGEMENT_TYPE_SEGMENT_OPTIONS}
                        value={engagementForm.engagementType}
                        onChange={(engagementType) => {
                          setHasManualEngagementTypeSelection(true)
                          setEngagementForm((previous) => ({
                            ...previous,
                            engagementType,
                          }))
                        }}
                      />
                    </div>
                    <label>
                      Color
                      <div className="color-input-row">
                        <input
                          type="color"
                          value={engagementFormColorValue ?? TIMELINE_NEUTRAL_COLOR}
                          onChange={(event) =>
                            setEngagementForm((previous) => ({
                              ...previous,
                              colorHex: event.target.value.toUpperCase(),
                            }))
                          }
                          aria-label="Select engagement color"
                        />
                        <input
                          value={engagementForm.colorHex}
                          onChange={(event) =>
                            setEngagementForm((previous) => ({
                              ...previous,
                              colorHex: event.target.value.toUpperCase(),
                            }))
                          }
                          placeholder="#RRGGBB"
                          maxLength={7}
                        />
                        <button
                          type="button"
                          className="ghost color-clear-button"
                          onClick={() =>
                            setEngagementForm((previous) => ({
                              ...previous,
                              colorHex: '',
                            }))
                          }
                        >
                          Use Default
                        </button>
                      </div>
                    </label>
                    <div className="codes-active-field">
                      <div className="codes-active-toggle">
                        <span>Active</span>
                        <label className="settings-toggle-group">
                          <input
                            type="checkbox"
                            checked={engagementForm.isActive}
                            onChange={(event) =>
                              setEngagementForm((previous) => ({
                                ...previous,
                                isActive: event.target.checked,
                              }))
                            }
                            aria-label="Active"
                          />
                        </label>
                      </div>
                      <small>Show in timeline code selection and quick entry panels</small>
                    </div>
                  </form>
                ) : codesDetailMode === 'edit-activity' && isEditingActivity ? (
                  <form className="stack code-editor-form codes-edit-form codes-edit-form" onSubmit={onSubmitActivity}>
                    <div className="codes-edit-header">
                      <h3>Edit Activity</h3>
                      <div className="codes-edit-header-actions">
                        <button type="button" className="ghost" onClick={closeCodeEditor}>
                          Cancel
                        </button>
                        <button type="submit" className="button-soft-primary" disabled={isBusy || engagements.length === 0}>
                          Update
                        </button>
                      </div>
                    </div>
                    <label>
                      Engagement Name
                      <select
                        value={activityForm.engagementId}
                        onChange={(event) =>
                          setActivityForm((previous) => ({
                            ...previous,
                            engagementId: event.target.value,
                          }))
                        }
                        required
                      >
                        <option value="" disabled>
                          Select engagement
                        </option>
                        {engagements.map((engagement) => (
                          <option key={engagement.id} value={engagement.id}>
                            {formatEntityDisplayLabel(engagement.name, engagement.code)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="field-label-row">
                        Activity Name
                        <span className="required-indicator" aria-hidden="true">*</span>
                      </span>
                      <span className="field-helper">Required</span>
                      <input
                        value={activityForm.name}
                        onChange={(event) =>
                          setActivityForm((previous) => ({
                            ...previous,
                            name: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>
                    <label>
                      Activity Code
                      <input
                        value={activityForm.code}
                        onChange={(event) =>
                          setActivityForm((previous) => ({
                            ...previous,
                            code: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span className="field-label-row">
                        Describe when to use this activity
                      </span>
                      <span className="field-helper">Used for LLM matching</span>
                      <textarea
                        rows={3}
                        maxLength={500}
                        value={activityForm.describeWhenToUse}
                        onChange={(event) =>
                          setActivityForm((previous) => ({
                            ...previous,
                            describeWhenToUse: event.target.value,
                          }))
                        }
                        placeholder="Use this activity when..."
                      />
                    </label>
                    <label>
                      Tags / Key Words (comma separated)
                      <span className="field-helper">Used for LLM matching</span>
                      <input
                        value={activityForm.tags}
                        onChange={(event) =>
                          setActivityForm((previous) => ({
                            ...previous,
                            tags: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Color
                      <div className="color-input-row">
                        <input
                          type="color"
                          value={activityFormColorValue ?? selectedEngagementColorValue ?? TIMELINE_NEUTRAL_COLOR}
                          onChange={(event) =>
                            setActivityForm((previous) => ({
                              ...previous,
                              colorHex: event.target.value.toUpperCase(),
                            }))
                          }
                          aria-label="Select activity color"
                        />
                        <input
                          value={activityForm.colorHex || selectedEngagementColorValue || ''}
                          onChange={(event) =>
                            setActivityForm((previous) => ({
                              ...previous,
                              colorHex: event.target.value.toUpperCase(),
                            }))
                          }
                          placeholder="#RRGGBB"
                          maxLength={7}
                        />
                        <button
                          type="button"
                          className="ghost color-clear-button"
                          onClick={() =>
                            setActivityForm((previous) => ({
                              ...previous,
                              colorHex: '',
                            }))
                          }
                        >
                          Use Default
                        </button>
                      </div>
                    </label>
                    <div className="codes-active-field">
                      <div className="codes-active-toggle">
                        <span>Active</span>
                        <label className="settings-toggle-group">
                          <input
                            type="checkbox"
                            checked={activityForm.isActive}
                            onChange={(event) =>
                              setActivityForm((previous) => ({
                                ...previous,
                                isActive: event.target.checked,
                              }))
                            }
                            aria-label="Active"
                          />
                        </label>
                      </div>
                      <small>Show in timeline code selection and quick entry panels</small>
                    </div>
                  </form>
                ) : selectedCodesEngagement ? (
                  <>
                    <div className="codes-activities-toolbar">
                      <div className="codes-pane-title">
                        <h2 title={codesActivitiesHeading}>{codesActivitiesHeading}</h2>
                      </div>
                      <input
                        type="search"
                        className="quick-add-search codes-activity-search"
                        value={codesActivitySearch}
                        onChange={(event) => setCodesActivitySearch(event.target.value)}
                        placeholder="Search activities"
                        aria-label="Search activities"
                      />
                    </div>

                    <div className="codes-activity-list">
                      {selectedCodesEngagement.activities.length === 0 ? (
                        <p className="engagement-empty-state">No activities yet.</p>
                      ) : filteredCodesActivities.length === 0 ? (
                        <p className="engagement-empty-state">No matching activities.</p>
                      ) : (
                        filteredCodesActivities.map((activity) => {
                          const activityColor =
                            normalizeColorHexInput(activity.colorHex)
                            ?? normalizeColorHexInput(selectedCodesEngagement.colorHex)
                            ?? TIMELINE_NEUTRAL_COLOR

                          return (
                            <div
                              key={activity.id}
                              className={`codes-activity-row ${activity.isActive ? '' : 'is-inactive'}`}
                              style={{ '--codes-activity-color': activityColor } as CSSProperties}
                            >
                              <div>
                                <div className="codes-title-line">
                                  {activity.code ? (
                                    <span className="code-item-badge">{activity.code}</span>
                                  ) : null}
                                  <strong>{activity.name}</strong>
                                  {activity.isActive ? null : (
                                    <span className="codes-state-pill">Inactive</span>
                                  )}
                                </div>
                                {activity.describeWhenToUse?.trim() ? (
                                  <span className="codes-activity-usage">
                                    {activity.describeWhenToUse}
                                  </span>
                                ) : null}
                                <ResponsiveCodeTagList
                                  tags={activity.tags}
                                  itemKeyPrefix={`codes-activity-${activity.id}`}
                                />
                              </div>
                              <div className="code-item-actions">
                                <button
                                  type="button"
                                  className="icon-action-button"
                                  aria-label={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                  onClick={() => {
                                    setCodesSelectedEngagementId(activity.engagementId)
                                    onEditActivity(activity)
                                    setCodesDetailMode('edit-activity')
                                  }}
                                >
                                  <img src={editIcon} alt="" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className="icon-action-button is-danger"
                                  aria-label={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                  onClick={() => {
                                    setCodesDetailMode('activities')
                                    onDeleteActivity(activity.id)
                                  }}
                                >
                                  <img src={deleteIcon} alt="" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </>
                ) : (
                  <p className="code-list-empty">No engagement selected.</p>
                )}
                {selectedCodesEngagement && !codesIsEditing ? (
                  <button
                    type="button"
                    className="ghost codes-pane-create-button codes-floating-add-button"
                    onClick={openCodesCreateActivityFromPane}
                    disabled={isBusy || !selectedCodesEngagement}
                  >
                    <span className="control-icon plus-icon" aria-hidden="true" />
                    Add Activity
                  </button>
                ) : null}
              </section>
            </div>
          </section>
        ) : null}

        {activeView === 'settings' ? (
          <section className="panel settings-panel">
            <div className="settings-header">
              <h2>Settings</h2>
            </div>

            <div className="settings-layout">
              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Credentials</h3>
                </div>
                <form className="settings-preference-row settings-credential-row" onSubmit={onSaveApiKey}>
                  <label htmlFor="settings-openai-key">
                    OpenAI API Key
                    <span className="field-helper">{credentialHelpText}</span>
                  </label>
                  <div className="settings-credential-stack">
                    <div className="settings-control-group">
                      <input
                        id="settings-openai-key"
                        type="password"
                        value={openAiKey}
                        onChange={(event) => setOpenAiKey(event.target.value)}
                        placeholder="sk-..."
                        required
                      />
                      <button
                        type="submit"
                        className="settings-save-button button-soft-primary"
                        disabled={isBusy || openAiKey.trim().length === 0}
                      >
                        Save Key
                      </button>
                    </div>
                    <div
                      className={`settings-credential-status ${credentialStatusTone}`}
                      aria-live="polite"
                    >
                      <span className="settings-credential-status-mark" aria-hidden="true" />
                      <span>{credentialStatusLabel}</span>
                    </div>
                    {settingsStatus?.lastError ? (
                      <p className={`settings-alert alert ${settingsStatus.statusLevel === 'error' ? 'error' : 'warning'}`}>
                        Last key status: {settingsStatus.lastError}
                      </p>
                    ) : null}
                  </div>
                </form>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Models</h3>
                </div>
                <form className="settings-preference-row" onSubmit={onSaveOpenAiModel}>
                  <label htmlFor="settings-openai-model">Interpretation</label>
                  <div className="settings-control-group">
                    <select
                      id="settings-openai-model"
                      value={selectedOpenAiModelDraft}
                      onChange={(event) =>
                        setSelectedOpenAiModelDraft(event.target.value as OpenAiModelId)
                      }
                      disabled={isBusy || settingsStatus === null}
                    >
                      {(settingsStatus?.availableOpenAiModels ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="settings-save-button button-soft-primary"
                      disabled={
                        isBusy ||
                        settingsStatus === null ||
                        selectedOpenAiModelDraft === settingsStatus.selectedOpenAiModel
                      }
                    >
                      Save
                    </button>
                  </div>
                </form>
                <form className="settings-preference-row" onSubmit={onSaveCalendarBulkModel}>
                  <label htmlFor="settings-calendar-bulk-model">Calendar Bulk Add</label>
                  <div className="settings-control-group">
                    <select
                      id="settings-calendar-bulk-model"
                      value={selectedCalendarBulkModelDraft}
                      onChange={(event) =>
                        setSelectedCalendarBulkModelDraft(event.target.value as OpenAiModelId)
                      }
                      disabled={isBusy || settingsStatus === null}
                    >
                      {(settingsStatus?.availableOpenAiModels ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="settings-save-button button-soft-primary"
                      disabled={
                        isBusy ||
                        settingsStatus === null ||
                        selectedCalendarBulkModelDraft === settingsStatus.selectedCalendarBulkModel
                      }
                    >
                      Save
                    </button>
                  </div>
                </form>
                <form className="settings-preference-row" onSubmit={onSaveTranscriptionModel}>
                  <label htmlFor="settings-transcription-model">Speech-to-Text</label>
                  <div className="settings-control-group">
                    <select
                      id="settings-transcription-model"
                      value={selectedTranscriptionModelDraft}
                      onChange={(event) =>
                        setSelectedTranscriptionModelDraft(
                          event.target.value as TranscriptionModelId,
                        )
                      }
                      disabled={isBusy || settingsStatus === null}
                    >
                      {(settingsStatus?.availableTranscriptionModels ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="settings-save-button button-soft-primary"
                      disabled={
                        isBusy ||
                        settingsStatus === null ||
                        selectedTranscriptionModelDraft ===
                          settingsStatus.selectedTranscriptionModel
                      }
                    >
                      Save
                    </button>
                  </div>
                </form>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Timeline</h3>
                </div>
                <div className="settings-preference-row settings-radio-row">
                  <span id="settings-timeline-week-start-label" className="settings-preference-label">
                    Seven-day week starts on
                  </span>
                  <div
                    className="settings-radio-group"
                    role="radiogroup"
                    aria-labelledby="settings-timeline-week-start-label"
                  >
                    {TIMELINE_WEEK_START_OPTIONS.map((option) => (
                      <label key={option.id} className="settings-radio-option">
                        <input
                          type="radio"
                          name="settings-timeline-week-start"
                          value={option.id}
                          checked={timelineWeekStartDay === option.id}
                          onChange={() =>
                            onSaveTimelinePreferences({
                              ...currentTimelinePreferences,
                              timelineWeekStartDay: option.id,
                            })
                          }
                          disabled={isBusy || settingsStatus === null}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-exclude-uncategorized">
                    Exclude uncategorized time from daily, weekly, and reporting totals
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-exclude-uncategorized"
                      type="checkbox"
                      checked={timelineExcludeUncategorizedFromDailyTotals}
                      onChange={(event) =>
                        onSaveTimelinePreferences({
                          ...currentTimelinePreferences,
                          timelineExcludeUncategorizedFromDailyTotals: event.target.checked,
                        })
                      }
                      disabled={isBusy || settingsStatus === null}
                    />
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-show-uncategorized">
                    Display uncategorized time alongside categorized time in daily, weekly, and reporting totals.
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-show-uncategorized"
                      type="checkbox"
                      checked={timelineShowUncategorizedDailyTotal}
                      onChange={(event) =>
                        onSaveTimelinePreferences({
                          ...currentTimelinePreferences,
                          timelineShowUncategorizedDailyTotal: event.target.checked,
                        })
                      }
                      disabled={
                        isBusy ||
                        settingsStatus === null ||
                        !timelineExcludeUncategorizedFromDailyTotals
                      }
                    />
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-include-external">
                    External type codes should be included in the weekly totals
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-include-external"
                      type="checkbox"
                      checked={timelineIncludeExternalInTotals}
                      onChange={(event) =>
                        onSaveTimelinePreferences({
                          ...currentTimelinePreferences,
                          timelineIncludeExternalInTotals: event.target.checked,
                        })
                      }
                      disabled={
                        isBusy
                        || settingsStatus === null
                        || (timelineIncludeExternalInTotals && !timelineIncludeInternalInTotals)
                      }
                    />
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-include-internal">
                    Internal type codes should be included in the weekly totals.
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-include-internal"
                      type="checkbox"
                      checked={timelineIncludeInternalInTotals}
                      onChange={(event) =>
                        onSaveTimelinePreferences({
                          ...currentTimelinePreferences,
                          timelineIncludeInternalInTotals: event.target.checked,
                        })
                      }
                      disabled={
                        isBusy
                        || settingsStatus === null
                        || (timelineIncludeInternalInTotals && !timelineIncludeExternalInTotals)
                      }
                    />
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-separate-types">
                    Separate out External and Internal type codes in the daily, weekly, and reporting totals.
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-separate-types"
                      type="checkbox"
                      checked={timelineSeparateEngagementTypeTotals}
                      onChange={(event) =>
                        onSaveTimelinePreferences({
                          ...currentTimelinePreferences,
                          timelineSeparateEngagementTypeTotals: event.target.checked,
                        })
                      }
                      disabled={isBusy || settingsStatus === null}
                    />
                  </div>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Calendar Bulk Add</h3>
                </div>
                <form className="settings-preference-row" onSubmit={onSaveCalendarBulkPreferences}>
                  <label htmlFor="settings-calendar-ignore-keywords">
                    Ignored keywords
                    <span className="field-helper">
                      Separate words/phrases by new line, comma, or semicolons.
                    </span>
                  </label>
                  <div className="settings-control-group settings-control-group-vertical">
                    <textarea
                      id="settings-calendar-ignore-keywords"
                      value={calendarIgnoredKeywordDraft}
                      onChange={(event) => setCalendarIgnoredKeywordDraft(event.target.value)}
                      rows={4}
                      placeholder="lunch"
                      disabled={isBusy || settingsStatus === null}
                    />
                    <button
                      type="submit"
                      className="settings-save-button button-soft-primary"
                      disabled={isBusy || settingsStatus === null}
                    >
                      Save
                    </button>
                  </div>
                </form>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-calendar-ignore-all-day">
                    Ignore all-day calendar events
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-calendar-ignore-all-day"
                      type="checkbox"
                      checked={settingsStatus?.calendarBulkIgnoreAllDayEvents ?? true}
                      onChange={(event) =>
                        onSaveCalendarIgnoreAllDayPreference(event.target.checked)
                      }
                      disabled={isBusy || settingsStatus === null}
                    />
                  </div>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Interface</h3>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-show-diagnostics-tab">
                    Show Diagnostics tab
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-show-diagnostics-tab"
                      type="checkbox"
                      checked={showDiagnosticsTab}
                      onChange={(event) =>
                        onSaveInterfacePreferences(event.target.checked)
                      }
                      disabled={isBusy || settingsStatus === null}
                    />
                  </div>
                </div>
              </section>

            </div>
          </section>
        ) : null}

        {activeView === 'diagnostics' ? (
          <section className="panel diagnostics-panel">
            <div className="diagnostics-toolbar">
              <h2>Diagnostics</h2>
              <div className="row-actions">
                <button type="button" onClick={onRefreshDiagnostics} disabled={isBusy}>
                  Refresh
                </button>
                <button type="button" onClick={onCopyDiagnostics} disabled={isBusy}>
                  Copy Diagnostics
                </button>
              </div>
            </div>

            <div className="diagnostics-filters">
              {(['all', 'errors', 'warnings', 'capture', 'settings'] as DiagnosticsFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={diagnosticsFilter === filter ? 'active-filter' : 'ghost'}
                  onClick={() => setDiagnosticsFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>

            <div className="diagnostics-list">
              {diagnosticsEvents.length === 0 ? (
                <p>No diagnostics events found.</p>
              ) : (
                diagnosticsEvents.map((event) => (
                  <article
                    key={event.id}
                    className={`diag-event ${event.status === 'error' ? 'error' : ''} ${event.status === 'warning' ? 'warning' : ''}`}
                  >
                    <p>
                      <strong>{formatDiagnosticsTime(event.timestamp)}</strong> | {event.layer} | {event.eventType}
                    </p>
                    <p>
                      command: {event.command ?? '-'} | status: {event.status} | duration:{' '}
                      {event.durationMs ?? '-'}ms | correlation: <code>{event.correlationId}</code>
                    </p>
                    {event.messageText ? <p>message: {event.messageText}</p> : null}
                    <pre>{event.detailsJson}</pre>
                  </article>
                ))
              )}
            </div>

            {diagnosticsBundleText ? (
              <div className="stack">
                <h3>Latest Diagnostics Bundle</h3>
                <p className="diagnostics-hint">
                  Reproduce the issue once, then use this bundle or Copy Diagnostics to share the latest full context.
                </p>
                <textarea value={diagnosticsBundleText} readOnly rows={10} />
              </div>
            ) : null}
          </section>
        ) : null}

        {activeView === 'reporting' ? (
          <section className="panel reporting-panel reporting-v2-panel">
            <header className="reporting-toolbar">
              <div className="reporting-title-block">
                <h2>Reporting</h2>
                <p>
                  {weeklySummary
                    ? `${weeklySummary.weekStartDate} - ${weeklySummary.weekEndDate}`
                    : selectedDate}
                </p>
              </div>

              <div className="reporting-toolbar-main">
                <div className="timeline-controls timeline-stepper reporting-week-stepper" aria-label="Reporting week navigation">
                  <button
                    type="button"
                    className="timeline-arrow-button stepper-button stepper-prev"
                    aria-label="Previous week"
                    title="Previous week"
                    onClick={() => onShiftSummaryWeek(-1)}
                    disabled={isBusy || isWeeklySummaryLoading}
                  >
                    <span className="control-icon chevron-left" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="stepper-button stepper-center"
                    onClick={onJumpToThisWeek}
                    disabled={isBusy || isWeeklySummaryLoading}
                  >
                    This Week
                  </button>
                  <button
                    type="button"
                    className="timeline-arrow-button stepper-button stepper-next"
                    aria-label="Next week"
                    title="Next week"
                    onClick={() => onShiftSummaryWeek(1)}
                    disabled={isBusy || isWeeklySummaryLoading}
                  >
                    <span className="control-icon chevron-right" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </header>

            <section className="reporting-command-row reporting-v2-command-row" aria-label="Reporting controls and weekly totals">
              <div className="reporting-week-total-strip" aria-label="Weekly total breakdown">
                <span className="reporting-command-label">Weekly Total Hours</span>
                <div className="reporting-week-total-values">
                  {reportingWeeklyTotalSegments.length > 0 ? (
                    reportingWeeklyTotalSegments.map((segment, segmentIndex) => {
                      const segmentLabel = splitTimelineTotalSegmentLabel(segment.label)

                      return (
                        <Fragment key={segment.key}>
                          {segmentIndex > 0 ? (
                            <span
                              className={`reporting-total-separator is-${segment.key} ${
                                segment.key === 'total' ? 'primary' : 'secondary'
                              }`}
                              aria-hidden="true"
                            >
                              &bull;
                            </span>
                          ) : null}
                          <span
                            className={`reporting-total-segment is-${segment.key} ${
                              segment.key === 'total' ? 'primary' : 'secondary'
                            }`}
                          >
                            <strong>{segmentLabel.amount}</strong>
                            <span>{segmentLabel.label}</span>
                          </span>
                        </Fragment>
                      )
                    })
                  ) : (
                    <span className="reporting-total-empty">No weekly total</span>
                  )}
                </div>
              </div>

              <div className="reporting-v2-view-controls">
                <label className="reporting-table-preset-select">
                  <span>View Preset</span>
                  <select
                    value={selectedReportingDisplayPreset?.id ?? ''}
                    onChange={(event) => onSelectReportingDisplayPreset(event.target.value)}
                    disabled={isBusy || isReportingStateSaving}
                  >
                    {resolvedReportingState.displayPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="ghost reporting-toolbar-button"
                  onClick={() => openReportingDisplayPresetEditor('edit')}
                  disabled={isBusy || isReportingStateSaving || !selectedReportingDisplayPreset}
                >
                  <img className="reporting-preset-button-icon" src={editIcon} alt="" aria-hidden="true" />
                  Customize
                </button>
                <button
                  type="button"
                  className="button-soft-primary reporting-toolbar-button"
                  onClick={() => {
                    setReportingExportPreviewSheet('weeklyHours')
                    setIsReportingExportModalOpen(true)
                  }}
                  disabled={
                    isBusy
                    || isWeeklySummaryLoading
                    || isSummaryExporting
                    || isSummaryLayoutSaving
                    || !weeklySummary
                  }
                >
                  <span className="control-icon download-icon" aria-hidden="true" />
                  {isSummaryExporting ? 'Exporting...' : 'Export'}
                </button>
              </div>
            </section>

            {weeklySummaryError ? (
              <p className="mini-calendar-error">{weeklySummaryError}</p>
            ) : null}

            <ReportingTableView
              summary={weeklySummary}
              preset={selectedReportingDisplayPreset}
              dayIndexes={reportingDayIndexes}
              engagementById={engagementById}
              activityById={activityById}
              timelineTotalPreferences={timelineTotalPreferences}
              displayedWeekTotalBreakdown={displayedSummaryWeekTotalBreakdown}
              isLoading={isWeeklySummaryLoading}
              onOpenNotes={onOpenSummaryNotes}
            />
          </section>
        ) : null}

          </div>
        </main>
      </div>
      {codesCreateModal}
      {quickAddSettingsModal}
      {calendarBulkModal}
      {timelineContextMenu ? createPortal(
        <div
          ref={timelineContextMenuRef}
          className="timeline-context-menu"
          style={{
            left: `${timelineContextMenu.x}px`,
            top: `${timelineContextMenu.y}px`,
          }}
          role="menu"
          aria-label={
            timelineContextMenu.kind === 'entry'
              ? 'Timeline entry actions'
              : 'Timeline actions'
          }
        >
          <button
            type="button"
            className="timeline-context-menu-item"
            role="menuitem"
            onClick={onCreateTimelineEntryFromContextMenu}
            disabled={
              timelineContextMenu.surface === 'calendar-review'
                ? calendarIsImporting
                : isBusy || isTimelineDeleteBusy
            }
          >
            <span className="control-icon plus-icon" aria-hidden="true" />
            {timelineContextMenu.surface === 'calendar-review' ? 'Create staged event' : 'Create new entry'}
          </button>
          {timelineContextMenu.kind === 'entry' && timelineContextMenu.entryId ? (
            <button
              type="button"
              className="timeline-context-menu-item is-danger"
              role="menuitem"
              onClick={onDeleteTimelineContextMenuEntry}
              disabled={
                timelineContextMenu.surface === 'calendar-review'
                  ? calendarIsImporting
                  : isBusy || isTimelineDeleteBusy
              }
            >
              <span className="control-icon trash-icon" aria-hidden="true" />
              {timelineContextMenu.surface === 'calendar-review' ? 'Delete staged event' : 'Delete entry'}
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {isReportingExportModalOpen ? createPortal(
        <div
          className="summary-layout-editor-backdrop reporting-config-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsReportingExportModalOpen(false)
            }
          }}
        >
          <div
            className="reporting-config-modal reporting-export-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Export reporting week"
          >
            <header className="reporting-config-header">
              <div>
                <h3>Export to Excel</h3>
                <p>
                  {weeklySummary
                    ? `${weeklySummary.weekStartDate} - ${weeklySummary.weekEndDate}`
                    : selectedDate}
                </p>
              </div>
              <button
                type="button"
                className="timeline-editor-close"
                onClick={() => setIsReportingExportModalOpen(false)}
                aria-label="Close export"
                title="Close"
              >
                <span className="control-icon close-icon" aria-hidden="true" />
              </button>
            </header>

            <div className="reporting-config-body">
              <div className="reporting-export-preset-controls">
                <label>
                  <span>Export Preset</span>
                  <select
                    value={selectedReportingExportPreset?.id ?? ''}
                    onChange={(event) => onSelectReportingExportPreset(event.target.value)}
                    disabled={isBusy || isReportingStateSaving || isSummaryLayoutSaving}
                  >
                    {resolvedSummaryLayoutState.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="reporting-config-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openSummaryLayoutEditor('edit')}
                    disabled={isBusy || isSummaryLayoutSaving || !selectedReportingExportPreset}
                  >
                    <img className="reporting-preset-button-icon" src={editIcon} alt="" aria-hidden="true" />
                    Edit Preset
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openSummaryLayoutEditor('create')}
                    disabled={isBusy || isSummaryLayoutSaving || !selectedReportingExportPreset}
                  >
                    <span className="control-icon plus-icon" aria-hidden="true" />
                    New Preset
                  </button>
                </div>
              </div>

              {selectedReportingExportPreset ? (
                <section className="reporting-export-preview" aria-label="Export column preview">
                  <div className="reporting-export-preview-header">
                    <strong>Excel Export Preview</strong>
                    <button
                      type="button"
                      className="button-soft-primary reporting-export-preview-action"
                      onClick={() => {
                        setIsReportingExportModalOpen(false)
                        onExportSummaryWeek()
                      }}
                      disabled={
                        isBusy
                        || isWeeklySummaryLoading
                        || isSummaryExporting
                        || isSummaryLayoutSaving
                        || isReportingStateSaving
                        || !weeklySummary
                        || !selectedReportingExportPreset
                      }
                    >
                      <span className="control-icon download-icon" aria-hidden="true" />
                      {isSummaryExporting ? 'Exporting...' : 'Export'}
                    </button>
                  </div>
                  <div className="reporting-export-preview-tabs" role="tablist" aria-label="Excel workbook sheets">
                    <button
                      type="button"
                      className={reportingExportPreviewSheet === 'weeklyHours' ? 'active' : ''}
                      role="tab"
                      aria-selected={reportingExportPreviewSheet === 'weeklyHours'}
                      onClick={() => setReportingExportPreviewSheet('weeklyHours')}
                    >
                      Weekly Hours
                    </button>
                    <button
                      type="button"
                      className={reportingExportPreviewSheet === 'weeklyHoursNotes' ? 'active' : ''}
                      role="tab"
                      aria-selected={reportingExportPreviewSheet === 'weeklyHoursNotes'}
                      onClick={() => setReportingExportPreviewSheet('weeklyHoursNotes')}
                    >
                      Weekly Hours + Notes
                    </button>
                  </div>
                  <div
                    className="reporting-export-preview-grid"
                    style={{
                      '--reporting-export-column-count': reportingExportPreviewColumns.length,
                      '--reporting-export-grid-columns': reportingExportPreviewGridColumns,
                    } as CSSProperties}
                  >
                    <div className="reporting-export-preview-row reporting-export-preview-head">
                      {reportingExportPreviewColumns.map((column) => (
                        <span key={`export-preview-head-${column.id}`} title={column.header}>
                          {column.header}
                        </span>
                      ))}
                    </div>
                    {(weeklySummary && weeklySummary.rows.length > 0
                      ? weeklySummary.rows
                      : [null]).map((row, previewRowIndex) => (
                      <div
                        key={`export-preview-row-${previewRowIndex}`}
                        className="reporting-export-preview-row"
                      >
                        {reportingExportPreviewColumns.map((column) => (
                          <span
                            key={`export-preview-${column.id}-${previewRowIndex}`}
                            title={column.header}
                          >
                            {row
                              ? renderReportingExportPreviewCell(
                                column,
                                row,
                                engagementById,
                                activityById,
                              )
                              : '-'}
                          </span>
                        ))}
                      </div>
                    ))}
                    <div className="reporting-export-preview-row reporting-export-preview-foot">
                      {reportingExportPreviewColumns.map((column, columnIndex) => (
                        <span key={`export-preview-foot-${column.id}`}>
                          {renderReportingExportPreviewFooter(
                            column,
                            weeklySummary,
                            columnIndex === reportingExportPreviewFooterLabelIndex,
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {reportingDisplayPresetModal && reportingDisplayPresetDraft ? createPortal(
        <div
          className="summary-layout-editor-backdrop reporting-display-preset-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              resetReportingDisplayPresetEditor()
            }
          }}
        >
          {activeView === 'reporting' ? (
            <div
              className="reporting-display-preset-modal reporting-v2-preset-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Customize reporting preset"
            >
              <header className="reporting-display-preset-header">
                <div>
                  <h3>Customize Preset</h3>
                </div>
                <button
                  type="button"
                  className="timeline-editor-close"
                  onClick={resetReportingDisplayPresetEditor}
                  aria-label="Close preset editor"
                  title="Close"
                >
                  <span className="control-icon close-icon" aria-hidden="true" />
                </button>
              </header>

              <div className="reporting-v2-preset-editor">
                <section className="reporting-v2-settings-panel" aria-label="Preset settings">
                  <label className="reporting-v2-field">
                    <span>Preset</span>
                    <select
                      value={reportingDisplayPresetModal.presetId ?? reportingDisplayPresetDraft.id}
                      onChange={(event) => onSelectReportingDisplayEditorPreset(event.target.value)}
                    >
                      {resolvedReportingState.displayPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="reporting-v2-field">
                    <span>Preset Name</span>
                    <input
                      type="text"
                      value={reportingDisplayPresetDraftName}
                      onChange={(event) => {
                        setReportingDisplayPresetDraftName(event.target.value)
                        setReportingDisplayPresetDraftError(null)
                      }}
                      maxLength={REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH}
                      placeholder="Preset name"
                    />
                  </label>
                </section>

                <section className="reporting-v2-column-panel" aria-label="Preset columns">
                  <div className="reporting-v2-column-panel-header">
                    <h4>Columns</h4>
                    <button
                      type="button"
                      className="button-soft-primary reporting-v2-add-column"
                      onClick={() => setIsReportingDisplayColumnPickerOpen((previous) => !previous)}
                    >
                      <span className="control-icon plus-icon" aria-hidden="true" />
                      Add Column
                    </button>
                  </div>

                  <div className="reporting-v2-column-list">
                    {reportingDisplayDraftColumns.map((column) => {
                      const columnLabel = getReportingDisplayColumnLabel(column)
                      const isRequiredColumn = column.kind !== 'field'
                      const isDragged = reportingDisplayDraggedColumnId === column.id
                      const dragStyle = isDragged && reportingDisplayDragPreview?.surface === 'list'
                        ? ({
                          transform: `translate3d(0, ${reportingDisplayDragPreview.offsetY}px, 0)`,
                          zIndex: 6,
                        } as CSSProperties)
                        : undefined

                      return (
                        <div
                          key={column.id}
                          data-reporting-display-column-id={column.id}
                          className={`reporting-v2-column-row ${isDragged ? 'is-dragging' : ''}`}
                          style={dragStyle}
                        >
                          <button
                            type="button"
                            className="reporting-v2-column-handle"
                            aria-label={`Reorder ${columnLabel}`}
                            onPointerDown={(event) => onStartReportingDisplayColumnPointerDrag(event, column.id)}
                          >
                            <ReportingColumnReorderIcon />
                          </button>
                          <span>{columnLabel}</span>
                          {isRequiredColumn ? (
                            <strong>Required</strong>
                          ) : (
                            <button
                              type="button"
                              className="summary-layout-editor-remove"
                              onClick={() => onRemoveReportingDisplayColumn(column.id)}
                              aria-label={`Remove ${columnLabel}`}
                              disabled={reportingDisplayDraftFieldCount <= 1}
                            >
                              -
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {isReportingDisplayColumnPickerOpen ? (
                    <div className="reporting-v2-column-picker">
                      {REPORTING_DISPLAY_FIELD_GROUPS.map((group) => (
                        <div key={group.label} className="reporting-v2-column-picker-group">
                          <span>{group.label}</span>
                          <div>
                            {group.keys.map((fieldKey) => {
                              const option = REPORTING_DISPLAY_FIELD_OPTIONS.find((candidate) => candidate.key === fieldKey)
                              const isEnabled = reportingDisplayDraftFieldKeys.has(fieldKey)

                              return (
                                <button
                                  key={fieldKey}
                                  type="button"
                                  onClick={() => onAddReportingDisplayColumn(fieldKey)}
                                  disabled={isEnabled}
                                >
                                  {option?.label ?? fieldKey}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>

                <section className="reporting-v2-preview-panel" aria-label="Preset preview">
                  <div className="reporting-v2-preview-header">
                    <h4>Preview</h4>
                  </div>
                  <ReportingTableView
                    summary={weeklySummary}
                    preset={reportingDisplayPresetDraft}
                    dayIndexes={reportingDisplayEditorDayIndexes}
                    engagementById={engagementById}
                    activityById={activityById}
                    timelineTotalPreferences={timelineTotalPreferences}
                    displayedWeekTotalBreakdown={displayedSummaryWeekTotalBreakdown}
                    isLoading={isWeeklySummaryLoading}
                    rowsLimit={4}
                    isPreview
                    draggedColumnId={reportingDisplayDraggedColumnId}
                    dragPreview={reportingDisplayDragPreview}
                    onColumnPointerDown={onStartReportingDisplayColumnPointerDrag}
                  />
                </section>
              </div>

              {reportingDisplayPresetDraftError ? (
                <p className="mini-calendar-error">{reportingDisplayPresetDraftError}</p>
              ) : null}

              <footer className="reporting-display-preset-actions reporting-v2-preset-actions">
                <div>
                  {reportingDisplayPresetModal.mode === 'edit' ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={onDeleteReportingDisplayPreset}
                      disabled={isReportingStateSaving || resolvedReportingState.displayPresets.length <= 1}
                    >
                      <span className="control-icon trash-icon" aria-hidden="true" />
                      Delete
                    </button>
                  ) : null}
                </div>
                <div>
                  <button type="button" className="ghost" onClick={resetReportingDisplayPresetEditor}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={onSaveReportingDisplayPresetAsNew}
                    disabled={isReportingStateSaving}
                  >
                    <span className="control-icon plus-icon" aria-hidden="true" />
                    Save as New
                  </button>
                  <button
                    type="button"
                    onClick={onSaveReportingDisplayPreset}
                    disabled={isReportingStateSaving}
                  >
                    <span className="control-icon save-icon" aria-hidden="true" />
                    {isReportingStateSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </footer>
            </div>
          ) : (
            <div
              className="reporting-display-preset-modal"
              role="dialog"
              aria-modal="true"
              aria-label={
                reportingDisplayPresetModal.mode === 'create'
                  ? 'Create reporting table preset'
                  : 'Edit reporting table preset'
              }
            >
              <header className="reporting-display-preset-header">
                <div>
                  <h3>
                    {reportingDisplayPresetModal.mode === 'create'
                      ? 'New Table Preset'
                      : 'Edit Table Preset'}
                  </h3>
                </div>
                <button
                  type="button"
                  className="timeline-editor-close"
                  onClick={resetReportingDisplayPresetEditor}
                  aria-label="Close table preset editor"
                  title="Close"
                >
                  <span className="control-icon close-icon" aria-hidden="true" />
                </button>
              </header>

              <div className="reporting-display-preset-form">
                <label>
                  <span>Preset Name</span>
                  <input
                    type="text"
                    value={reportingDisplayPresetDraftName}
                    onChange={(event) => {
                      setReportingDisplayPresetDraftName(event.target.value)
                      setReportingDisplayPresetDraftError(null)
                    }}
                    maxLength={REPORTING_DISPLAY_PRESET_MAX_NAME_LENGTH}
                    placeholder="Preset name"
                  />
                </label>

                <label>
                  <span>Row Label</span>
                  <select
                    value={reportingDisplayPresetDraft.rowLabelMode}
                    onChange={(event) =>
                      setReportingDisplayPresetDraft((previous) => (
                        previous
                          ? {
                            ...previous,
                            rowLabelMode: event.target.value as ReportingDisplayPreset['rowLabelMode'],
                          }
                          : previous
                      ))
                    }
                  >
                    <option value="combined">Engagement / Activity</option>
                    <option value="separate">Engagement over Activity</option>
                    <option value="activityOnly">Activity focused</option>
                  </select>
                </label>

                <div className="reporting-display-options" role="group" aria-label="Reporting display options">
                  {([
                    ['showCodes', 'Show codes'],
                    ['showClient', 'Show client'],
                    ['showEngagementType', 'Show engagement type'],
                    ['showEmptyDays', 'Show empty days'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="reporting-display-option">
                      <input
                        type="checkbox"
                        checked={reportingDisplayPresetDraft[key]}
                        onChange={(event) =>
                          setReportingDisplayPresetDraft((previous) => (
                            previous ? { ...previous, [key]: event.target.checked } : previous
                          ))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {reportingDisplayPresetDraftError ? (
                <p className="mini-calendar-error">{reportingDisplayPresetDraftError}</p>
              ) : null}

              <footer className="reporting-display-preset-actions">
                {reportingDisplayPresetModal.mode === 'edit' ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={onDeleteReportingDisplayPreset}
                    disabled={isReportingStateSaving || resolvedReportingState.displayPresets.length <= 1}
                  >
                    <span className="control-icon trash-icon" aria-hidden="true" />
                    Delete Preset
                  </button>
                ) : <span />}
                <div>
                  <button type="button" className="ghost" onClick={resetReportingDisplayPresetEditor}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onSaveReportingDisplayPreset}
                    disabled={isReportingStateSaving}
                  >
                    <span className="control-icon save-icon" aria-hidden="true" />
                    {isReportingStateSaving ? 'Saving...' : 'Save Preset'}
                  </button>
                </div>
              </footer>
            </div>
          )}
        </div>,
        document.body,
      ) : null}
      {summaryLayoutModal && summaryLayoutDraft ? createPortal(
        <div
          className="summary-layout-editor-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              resetSummaryLayoutEditor()
            }
          }}
        >
          <div
            ref={summaryLayoutModalRef}
            className="summary-layout-editor-modal is-reporting-export-editor"
            role="dialog"
            aria-modal="true"
            aria-label={
              summaryLayoutModal.mode === 'create'
                ? 'Create export preset'
                : 'Edit export preset'
            }
            >
              <div className="summary-layout-editor-header">
              <div>
                <h3>
                  {summaryLayoutModal.mode === 'create'
                    ? 'New Export Preset'
                    : 'Edit Export Preset'}
                </h3>
                <p>
                  Reorder, remove, or insert Excel columns. Row Total stays required, but you can move it.
                </p>
              </div>
              <button
                type="button"
                className="timeline-editor-close"
                onClick={resetSummaryLayoutEditor}
                aria-label="Close export preset editor"
                title="Close"
              >
                <span className="control-icon close-icon" aria-hidden="true" />
              </button>
            </div>

            <label className="summary-layout-editor-name-field">
              <span>Preset Name</span>
              <input
                type="text"
                value={summaryLayoutDraftName}
                onChange={(event) => {
                  setSummaryLayoutDraftName(event.target.value)
                  setSummaryLayoutDraftError(null)
                }}
                maxLength={SUMMARY_LAYOUT_MAX_NAME_LENGTH}
                placeholder="Preset name"
              />
            </label>

            {summaryLayoutDraftError ? (
              <p className="mini-calendar-error">{summaryLayoutDraftError}</p>
            ) : null}

            <div className="summary-layout-editor-preview-wrap">
              <div className="summary-layout-editor-preview-scroll">
                <div className="summary-layout-editor-track">
                  <button
                    type="button"
                    className={`summary-layout-insert-slot ${summaryLayoutInsertionIndex === 0 ? 'active' : ''}`}
                    onClick={() => setSummaryLayoutInsertionIndex((previous) => previous === 0 ? null : 0)}
                    aria-label="Add a column at the beginning"
                  >
                    <span className="summary-layout-insert-button">+</span>
                    <span className="summary-layout-insert-line" aria-hidden="true" />
                  </button>
                  {summaryLayoutDraft.columns.map((column, columnIndex) => {
                    const previewColumn = buildSummaryViewColumn(column, weeklySummary)
                    const shouldWrapPreviewColumn = true
                    const isDragging = summaryLayoutDragState?.columnId === column.id
                    const isCommitReset = summaryLayoutDropCommitColumnIds.includes(column.id)
                    const activeTransformX = (
                      isDragging || activeSummaryLayoutDragPointerId !== null
                        ? summaryLayoutDragTransforms.get(column.id) ?? 0
                        : 0
                    )
                    const isDisplaced = !isDragging && Math.abs(activeTransformX) > 0.5

                    return (
                      <Fragment key={column.id}>
                        <div
                          ref={(node) => {
                            summaryLayoutColumnRefs.current[column.id] = node
                          }}
                          className={`summary-layout-editor-column ${shouldWrapPreviewColumn ? 'wraps' : ''} ${previewColumn.kind === 'rowTotal' ? 'summary-layout-editor-column-required' : ''} ${isDragging ? 'dragging' : ''} ${isDisplaced ? 'displaced' : ''} ${isCommitReset ? 'commit-reset' : ''}`}
                          style={{
                            width: SUMMARY_LAYOUT_DAY_COLUMN_WIDTH,
                            transform: buildSummaryLayoutColumnTransform(activeTransformX, isDragging),
                            zIndex: isDragging ? 5 : isDisplaced ? 2 : undefined,
                          }}
                        >
                          <div className="summary-layout-editor-column-controls">
                            {previewColumn.kind === 'rowTotal' ? (
                              <span className="summary-layout-editor-required-pill">Required</span>
                            ) : (
                              <button
                                type="button"
                                className="summary-layout-editor-remove"
                                onClick={() => onRemoveSummaryLayoutColumn(column.id)}
                                aria-label={`Remove ${previewColumn.header}`}
                              >
                                -
                              </button>
                            )}
                            <button
                              type="button"
                              className="summary-layout-editor-handle"
                              aria-label={`Reorder ${previewColumn.header}`}
                              onPointerDown={(event) => onStartSummaryLayoutDrag(event, column.id, columnIndex)}
                            >
                              <span className="summary-layout-editor-dots" aria-hidden="true" />
                            </button>
                          </div>
                          <div className={`summary-layout-editor-cell summary-layout-editor-header-cell ${shouldWrapPreviewColumn ? 'wraps' : ''}`}>
                            {column.kind === 'freeText' ? (
                              <input
                                type="text"
                                className="summary-layout-editor-free-text-input"
                                value={column.label}
                                onChange={(event) => onUpdateSummaryLayoutFreeTextLabel(column.id, event.target.value)}
                                placeholder="Free Text"
                              />
                            ) : (
                              previewColumn.kind === 'day' && previewColumn.dayIndex !== undefined && weeklySummary
                                ? formatSummaryDayLabel(weeklySummary, previewColumn.dayIndex)
                                : previewColumn.header
                            )}
                          </div>
                          {(summaryLayoutPreviewRows.length > 0 ? summaryLayoutPreviewRows : [null, null, null]).map((row, previewRowIndex) => (
                            <div
                              key={`${column.id}-preview-${previewRowIndex}`}
                              className={`summary-layout-editor-cell ${shouldWrapPreviewColumn ? 'wraps' : ''}`}
                            >
                              {row ? (
                                column.kind === 'freeText'
                                  ? (() => {
                                    const rowKey = buildSummaryFreeTextRowKey(row)
                                    const freeTextValue = resolveSummaryFreeTextValue(column, rowKey)
                                    const shouldShowRepeatAction = previewRowIndex === 0
                                    const isRepeatSource = column.repeat

                                    return (
                                      <div
                                        className={`summary-layout-free-text-editor-cell ${
                                          shouldShowRepeatAction ? 'has-repeat-action' : ''
                                        }`}
                                      >
                                        <input
                                          type="text"
                                          value={freeTextValue}
                                          onChange={(event) => onUpdateSummaryLayoutFreeTextRowValue(
                                            column.id,
                                            rowKey,
                                            event.target.value,
                                          )}
                                          placeholder="Blank"
                                          aria-label={`${column.label} text for ${formatSummaryRowLabel(row)}`}
                                        />
                                        {shouldShowRepeatAction ? (
                                          <button
                                            type="button"
                                            className={`summary-layout-free-text-repeat ${isRepeatSource ? 'active' : ''}`}
                                            onClick={() => onToggleSummaryLayoutFreeTextRepeat(column.id, rowKey, freeTextValue)}
                                            aria-pressed={isRepeatSource}
                                            aria-label={
                                              isRepeatSource
                                                ? `Stop repeating ${column.label}`
                                                : `Repeat ${column.label} from this row`
                                            }
                                            title={isRepeatSource ? 'Stop repeating' : 'Repeat this text'}
                                          >
                                            <span className="control-icon repeat-icon" aria-hidden="true" />
                                          </button>
                                        ) : null}
                                      </div>
                                    )
                                  })()
                                  : renderSummaryPreviewCell(
                                    previewColumn,
                                    row,
                                    engagementById,
                                    activityById,
                                  )
                              ) : <span className="summary-layout-editor-placeholder">Preview</span>}
                            </div>
                          ))}
                          <div className="summary-layout-editor-cell summary-layout-editor-footer-cell">
                            {renderSummaryPreviewSimpleFooter(previewColumn, weeklySummary)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`summary-layout-insert-slot ${summaryLayoutInsertionIndex === columnIndex + 1 ? 'active' : ''}`}
                          onClick={() => setSummaryLayoutInsertionIndex((previous) => (
                            previous === columnIndex + 1 ? null : columnIndex + 1
                          ))}
                          aria-label={`Add a column after ${previewColumn.header}`}
                        >
                          <span className="summary-layout-insert-button">+</span>
                          <span className="summary-layout-insert-line" aria-hidden="true" />
                        </button>
                      </Fragment>
                    )
                  })}
                </div>
              </div>
              {summaryLayoutInsertionIndex !== null ? (
                <div className="summary-layout-picker">
                  <div className="summary-layout-picker-header">
                    <h4>Add Column</h4>
                    <p>Select a hidden field, a hidden day, or add a new free-text column.</p>
                  </div>
                  <div className="summary-layout-picker-table" role="table" aria-label="Available summary columns">
                    <div className="summary-layout-picker-head" role="row">
                      <span role="columnheader">Column</span>
                      <span role="columnheader">Description</span>
                    </div>
                    {buildSummaryLayoutInsertOptions(summaryLayoutDraft, weeklySummary).map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        className="summary-layout-picker-row"
                        role="row"
                        onClick={() => onInsertSummaryLayoutColumn(option.createColumn(), summaryLayoutInsertionIndex)}
                      >
                        <span role="cell">{option.label}</span>
                        <span role="cell">{option.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="summary-layout-editor-actions">
              {summaryLayoutModal.mode === 'edit' ? (
                <button
                  type="button"
                  className="danger"
                  onClick={onDeleteSummaryLayoutPreset}
                  disabled={isSummaryLayoutSaving || resolvedSummaryLayoutState.presets.length <= 1}
                >
                  <span className="control-icon trash-icon" aria-hidden="true" />
                  Delete Preset
                </button>
              ) : <span />}
              <div className="summary-layout-editor-actions-group">
                <button type="button" className="ghost" onClick={resetSummaryLayoutEditor}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onSaveSummaryLayoutPreset}
                  disabled={isSummaryLayoutSaving}
                >
                  <span className="control-icon save-icon" aria-hidden="true" />
                  {isSummaryLayoutSaving ? 'Saving...' : 'Save Preset'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {selectedSummaryNotesContext ? createPortal(
        <div
          className="summary-notes-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onCloseSummaryNotes()
            }
          }}
        >
          <div
            ref={summaryNotesModalRef}
            className="summary-notes-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Summary notes details"
          >
            <div className="summary-notes-header">
              <h3>Notes</h3>
              <button
                type="button"
                className="timeline-editor-close"
                onClick={onCloseSummaryNotes}
                aria-label="Close notes"
                title="Close"
              >
                <span className="control-icon close-icon" aria-hidden="true" />
              </button>
            </div>
            <p className="summary-notes-context">
              {formatEntityDisplayLabel(
                selectedSummaryNotesContext.row.engagementName,
                selectedSummaryNotesContext.row.engagementCode,
              )} / {formatEntityDisplayLabel(
                selectedSummaryNotesContext.row.activityName,
                selectedSummaryNotesContext.row.activityCode,
              )}
              {' '}on {formatWeekdayName(selectedSummaryNotesContext.day.date)} ({formatMonthDay(selectedSummaryNotesContext.day.date)})
            </p>
            <div className="summary-notes-list">
              {selectedSummaryNotesContext.notes.map((note, index) => (
                <p key={`${note.startMinute}-${note.endMinute}-${index}`}>
                  {formatMinutesAsHours(note.durationMinutes)} Hours: {note.description}
                </p>
              ))}
            </div>
            <div className="summary-notes-actions">
              <button type="button" onClick={onCopySummaryNotes}>
                Copy
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function MiniCalendar({
  selectedDate,
  visibleMonth,
  todayDate,
  daysWithEntries,
  highlightedDates,
  isLoading,
  errorMessage,
  onVisibleMonthChange,
  onSelectDate,
}: MiniCalendarProps) {
  const monthLabel = useMemo(() => formatMonthHeading(visibleMonth), [visibleMonth])
  const dayCells = useMemo(() => buildCalendarDayCells(visibleMonth), [visibleMonth])

  return (
    <div className="mini-calendar" aria-busy={isLoading}>
      <div className="mini-calendar-nav">
        <button
          type="button"
          className="ghost mini-calendar-arrow"
          onClick={() => onVisibleMonthChange(shiftMonthKey(visibleMonth, -1))}
          aria-label={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, -1))}`}
          title={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, -1))}`}
        >
          <span className="control-icon chevron-left" aria-hidden="true" />
        </button>
        <p className="mini-calendar-title" aria-live="polite">
          {monthLabel}
        </p>
        <button
          type="button"
          className="ghost mini-calendar-arrow"
          onClick={() => onVisibleMonthChange(shiftMonthKey(visibleMonth, 1))}
          aria-label={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, 1))}`}
          title={`Show ${formatMonthHeading(shiftMonthKey(visibleMonth, 1))}`}
        >
          <span className="control-icon chevron-right" aria-hidden="true" />
        </button>
      </div>

      <div className="mini-calendar-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS_BY_SUNDAY.map((label, index) => (
          <span key={`${visibleMonth}-${label}-${index}`}>{label}</span>
        ))}
      </div>

      <div className="mini-calendar-grid" role="grid" aria-label={`${monthLabel} calendar`}>
        {dayCells.map((cell) => {
          const isSelected = cell.date === selectedDate
          const isToday = cell.date === todayDate
          const hasEntries = daysWithEntries.has(cell.date)
          const isInHighlightedWeek = highlightedDates.has(cell.date)
          const classes = [
            'mini-calendar-day',
            cell.isCurrentMonth ? 'current-month' : 'outside-month',
            isSelected ? 'is-selected' : '',
            isToday ? 'is-today' : '',
            hasEntries ? 'has-entries' : '',
            isInHighlightedWeek ? 'in-summary-week' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              type="button"
              key={cell.date}
              className={classes}
              role="gridcell"
              aria-pressed={isSelected}
              aria-label={formatCalendarDayAriaLabel(cell.date, {
                isSelected,
                isToday,
                hasEntries,
                isInHighlightedWeek,
              })}
              onClick={() => onSelectDate(cell.date)}
            >
              <span>{cell.dayOfMonth}</span>
            </button>
          )
        })}
      </div>

      {errorMessage ? <p className="mini-calendar-error">{errorMessage}</p> : null}
    </div>
  )
}

function WarningBadge({ type }: { type: WarningType }) {
  const label =
    type === 'low_confidence'
      ? 'Low Confidence'
      : type === 'overlap'
        ? 'Overlap'
        : 'Unmatched'

  return <span className={`warning-badge ${type}`}>{label}</span>
}

function TimelineBlockContent({
  label,
  durationLabel = null,
}: {
  label: string
  durationLabel?: string | null
}) {
  return (
    <span className="timeline-block-content">
      <span className="timeline-block-label">{label}</span>
      {durationLabel ? (
        <span className="timeline-block-duration-badge">{durationLabel}</span>
      ) : null}
    </span>
  )
}

function formatDiagnosticsTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatLocalTime(value: Date): string {
  const hours = `${value.getHours()}`.padStart(2, '0')
  const minutes = `${value.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function buildEntryDraftEndState(endMinute: number): Pick<EntryDraft, 'endTime' | 'preserveEndOfDay'> {
  if (endMinute === MINUTES_IN_DAY) {
    return {
      endTime: END_OF_DAY_INPUT_SENTINEL,
      preserveEndOfDay: true,
    }
  }

  return {
    endTime: minuteToTimeInput(endMinute),
    preserveEndOfDay: false,
  }
}

function buildEntryDraft(entry: TimelineEntry): EntryDraft {
  const endState = buildEntryDraftEndState(entry.endMinute)

  return {
    id: entry.id,
    date: entry.date,
    engagementId: entry.engagementId ?? '',
    activityId: entry.activityId ?? '',
    description: entry.description,
    startTime: minuteToTimeInput(entry.startMinute),
    ...endState,
  }
}

function serializeEntryDraft(entryDraft: EntryDraft): string {
  return JSON.stringify([
    entryDraft.id,
    entryDraft.date,
    entryDraft.engagementId,
    entryDraft.activityId,
    entryDraft.description,
    entryDraft.startTime,
    entryDraft.endTime,
    entryDraft.preserveEndOfDay,
  ])
}

function buildEntryDraftSavePlan(entryDraft: EntryDraft): EntryDraftSavePlan {
  if (entryDraft.date.trim().length === 0) {
    return {
      ok: false,
      errorMessage: 'Date is required.',
    }
  }

  if (entryDraft.startTime.trim().length === 0) {
    return {
      ok: false,
      errorMessage: 'Start time is required.',
    }
  }

  if (entryDraft.endTime.trim().length === 0) {
    return {
      ok: false,
      errorMessage: 'End time is required.',
    }
  }

  const startMinute = timeInputToMinute(entryDraft.startTime)
  const endMinute = resolveEntryDraftEndMinute(entryDraft)
  if (endMinute <= startMinute) {
    return {
      ok: false,
      errorMessage: 'End time must be later than start time.',
    }
  }

  const nextDraftEndState = buildEntryDraftEndState(endMinute)
  const normalizedDraft: EntryDraft = {
    ...entryDraft,
    startTime: minuteToTimeInput(startMinute),
    endTime: nextDraftEndState.endTime,
    preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
  }

  return {
    ok: true,
    startMinute,
    endMinute,
    normalizedDraft,
    key: serializeEntryDraft(normalizedDraft),
  }
}

function parseCalendarIgnoredKeywordDraft(value: string): string[] {
  const seen = new Set<string>()
  const keywords: string[] = []

  for (const candidate of value.split(/[,\n;]/)) {
    const normalized = candidate.trim().toLowerCase()
    if (normalized.length === 0 || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    keywords.push(normalized)
  }

  return keywords
}

function refreshCalendarCandidateWarnings(candidate: CalendarReviewCandidate): WarningType[] {
  const warnings: WarningType[] = candidate.warningFlags.filter((warning) => warning === 'overlap')

  if (candidate.confidence < CALENDAR_REVIEW_LOW_CONFIDENCE_THRESHOLD) {
    warnings.push('low_confidence')
  }

  if (!candidate.engagementId || !candidate.activityId) {
    warnings.push('unmatched')
  }

  return warnings
}

function hasCalendarCandidateBlockingIssue(candidate: CalendarReviewCandidate): boolean {
  return (
    candidate.needsDateConfirmation
    || candidate.needsTimeConfirmation
    || candidate.description.trim().length === 0
  )
}

function calendarCandidateToTimelineEntry(candidate: CalendarReviewCandidate): TimelineEntry {
  const candidateTimestamp = Math.floor(Date.now() / 1000)

  return {
    id: `calendar-${candidate.id}`,
    date: candidate.date,
    startMinute: candidate.startMinute,
    endMinute: candidate.endMinute,
    durationMinutes: Math.max(1, candidate.endMinute - candidate.startMinute),
    description: candidate.description,
    userSubmissionText: candidate.extractedText || candidate.sourceText,
    source: 'calendar',
    confidence: candidate.confidence,
    engagementId: candidate.engagementId,
    activityId: candidate.activityId,
    engagementCode: candidate.engagementCode,
    engagementName: candidate.engagementName,
    engagementType: candidate.engagementType ?? (
      candidate.engagementId ? inferEngagementTypeFromCode(candidate.engagementCode) : null
    ),
    activityCode: candidate.activityCode,
    activityName: candidate.activityName,
    usedActivityFallback: false,
    usedTemporalFallback: false,
    durationDefaulted: false,
    fallbackSummary: null,
    sourceMessageEntryIndex: null,
    sourceMessageEntryCount: null,
    modelUsed: null,
    modelUsedLabel: null,
    transcriptionModelUsed: null,
    transcriptionModelUsedLabel: null,
    warningFlags: candidate.warningFlags,
    createdAt: candidateTimestamp,
    updatedAt: candidateTimestamp,
  }
}

function getCalendarCandidateIdFromTimelineEntryId(entryId: string): string | null {
  return entryId.startsWith('calendar-') ? entryId.slice('calendar-'.length) : null
}

function resolveEntryDraftEndMinute(entryDraft: EntryDraft): number {
  if (entryDraft.preserveEndOfDay && entryDraft.endTime === END_OF_DAY_INPUT_SENTINEL) {
    return MINUTES_IN_DAY
  }

  return timeInputToMinute(entryDraft.endTime)
}

function generateSubmissionQueueId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isActiveSubmissionQueueItem(item: SubmissionQueueItem): boolean {
  return item.state === 'pending' || item.state === 'running'
}

function isFinishedSubmissionQueueItem(item: SubmissionQueueItem): boolean {
  return item.state === 'success' || item.state === 'error'
}

function formatLlmSubmissionStatusMessage(
  count: number,
  status: 'processing' | 'created' | 'failed',
): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'} ${status}.`
}

function generateCalendarCandidateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `calendar-candidate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function generateClientCorrelationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function listSupportedVoiceMimeTypes(): string[] {
  if (typeof MediaRecorder === 'undefined') {
    return []
  }

  const supportsCheck = typeof MediaRecorder.isTypeSupported === 'function'
  return PREFERRED_VOICE_MIME_TYPES.filter(
    (candidate) => !supportsCheck || MediaRecorder.isTypeSupported(candidate),
  )
}

function selectPreferredVoiceMimeType(): string | undefined {
  return listSupportedVoiceMimeTypes()[0]
}

function detectVoiceEnvironmentSupport(): VoiceEnvironmentSupport {
  const hasNavigator = typeof navigator !== 'undefined'
  const hasMediaDevices = hasNavigator && typeof navigator.mediaDevices !== 'undefined'
  const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined'
  let failureReasonCode: VoiceSupportFailureReasonCode | null = null

  if (!hasNavigator) {
    failureReasonCode = 'missing_navigator'
  } else if (!hasMediaDevices) {
    failureReasonCode = 'missing_media_devices'
  } else if (!hasGetUserMedia) {
    failureReasonCode = 'missing_get_user_media'
  } else if (!hasMediaRecorder) {
    failureReasonCode = 'missing_media_recorder'
  }

  return {
    platform: detectVoicePlatform(),
    isTauriDev: import.meta.env.DEV && isTauriRuntime(),
    hasNavigator,
    hasMediaDevices,
    hasGetUserMedia,
    hasMediaRecorder,
    supportedMimeTypes: listSupportedVoiceMimeTypes(),
    failureReasonCode,
  }
}

function buildVoiceSupportDiagnosticDetails(
  support: VoiceEnvironmentSupport,
): Record<string, unknown> {
  return {
    failureReasonCode: support.failureReasonCode,
    hasGetUserMedia: support.hasGetUserMedia,
    hasMediaDevices: support.hasMediaDevices,
    hasMediaRecorder: support.hasMediaRecorder,
    hasNavigator: support.hasNavigator,
    isTauriDev: support.isTauriDev,
    platform: support.platform,
    supportedMimeTypes: support.supportedMimeTypes,
  }
}

function formatVoiceSupportUnavailableMessage(support: VoiceEnvironmentSupport): string {
  if (
    (support.failureReasonCode === 'missing_media_devices'
      || support.failureReasonCode === 'missing_get_user_media')
    && support.platform === 'macos'
    && support.isTauriDev
  ) {
    return 'Voice recording is unavailable in this macOS development runtime. Test voice from the packaged OmniSheet.app so macOS can grant microphone access.'
  }

  if (support.failureReasonCode === 'missing_media_recorder' && support.platform === 'macos') {
    return 'This macOS WebKit runtime does not support voice recording yet. Test the packaged OmniSheet.app on a supported macOS version.'
  }

  if (support.failureReasonCode === 'missing_media_devices') {
    return 'Voice recording is unavailable because this runtime does not expose media devices.'
  }

  if (support.failureReasonCode === 'missing_get_user_media') {
    return 'Voice recording is unavailable because microphone capture is not exposed in this runtime.'
  }

  if (support.failureReasonCode === 'missing_media_recorder') {
    return 'Voice recording is unavailable because this runtime does not support audio recording.'
  }

  if (support.failureReasonCode === 'missing_navigator') {
    return 'Voice recording is unavailable because no browser runtime was detected.'
  }

  return 'Voice recording is not available in this environment.'
}

function mapVoiceRecordingError(error: unknown): VoiceRecordingErrorDetails {
  const permissionErrorName = getVoiceErrorName(error)

  if (permissionErrorName === 'NotAllowedError' || permissionErrorName === 'SecurityError') {
    return {
      errorCategory: 'permission_denied',
      message: 'Microphone access was denied. Enable OmniSheet in System Settings > Privacy & Security > Microphone, then try again.',
      permissionErrorName,
      permissionOutcome: 'denied',
    }
  }

  if (permissionErrorName === 'NotFoundError' || permissionErrorName === 'OverconstrainedError') {
    return {
      errorCategory: 'device_unavailable',
      message: 'No microphone was found for voice recording.',
      permissionErrorName,
      permissionOutcome: 'device_unavailable',
    }
  }

  if (permissionErrorName === 'NotReadableError' || permissionErrorName === 'AbortError') {
    return {
      errorCategory: 'device_unreadable',
      message: 'The microphone is busy or could not be started. Close other apps using the microphone and try again.',
      permissionErrorName,
      permissionOutcome: 'device_unreadable',
    }
  }

  return {
    errorCategory: 'unknown',
    message: extractErrorMessage(error),
    permissionErrorName,
    permissionOutcome: 'unknown',
  }
}

function voiceDiagnosticStatusForMacosPermission(
  status: MicrophonePermissionStatus,
): 'ok' | 'warning' {
  if (status === 'granted' || status === 'unsupported') {
    return 'ok'
  }

  return 'warning'
}

function mapMacosPermissionOutcome(status: MicrophonePermissionStatus): VoicePermissionOutcome {
  if (status === 'granted') {
    return 'granted'
  }

  if (status === 'denied') {
    return 'denied'
  }

  if (status === 'restricted') {
    return 'restricted'
  }

  return 'unknown'
}

function mapMacosNativeMicrophonePermissionStatus(
  status: MicrophonePermissionStatus,
): VoiceRecordingErrorDetails {
  if (status === 'denied') {
    return {
      errorCategory: 'permission_denied',
      message: 'Microphone access was denied. Enable OmniSheet in System Settings > Privacy & Security > Microphone, then try again.',
      permissionErrorName: null,
      permissionOutcome: 'denied',
    }
  }

  if (status === 'restricted') {
    return {
      errorCategory: 'permission_restricted',
      message: 'Microphone access is restricted by macOS or an administrator policy, so OmniSheet cannot start voice recording on this Mac.',
      permissionErrorName: null,
      permissionOutcome: 'restricted',
    }
  }

  return {
    errorCategory: 'permission_request_failed',
    message: 'OmniSheet could not confirm microphone access with macOS. Respond to the macOS permission prompt if it is open, then try again.',
    permissionErrorName: null,
    permissionOutcome: 'unknown',
  }
}

function buildMacosNativePermissionRequestFailedDetails(
  error: unknown,
): VoiceRecordingErrorDetails {
  return {
    errorCategory: 'permission_request_failed',
    message: 'OmniSheet could not request microphone access from macOS. Close the app, reopen it from Finder, and try again.',
    permissionErrorName: getVoiceErrorName(error),
    permissionOutcome: 'unknown',
  }
}

function detectVoicePlatform(): VoicePlatform {
  if (typeof navigator === 'undefined') {
    return 'unknown'
  }

  const userAgentDataPlatform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform
  const platformText = [
    navigator.userAgent,
    userAgentDataPlatform,
    navigator.platform,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()

  if (platformText.includes('mac')) {
    return 'macos'
  }

  if (platformText.includes('win')) {
    return 'windows'
  }

  if (
    platformText.includes('linux')
    || platformText.includes('x11')
    || platformText.includes('ubuntu')
  ) {
    return 'linux'
  }

  return 'unknown'
}

function formatCredentialStoreName(platform: VoicePlatform): string {
  if (platform === 'macos') {
    return 'Keychain'
  }

  if (platform === 'windows') {
    return 'Credential Manager'
  }

  return 'the system credential store'
}

function getVoiceErrorName(error: unknown): string | null {
  if (error instanceof Error && typeof error.name === 'string' && error.name.length > 0) {
    return error.name
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && typeof error.name === 'string'
    && error.name.length > 0
  ) {
    return error.name
  }

  return null
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(new Error('Audio recording could not be prepared for transcription.'))
    }
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== 'string') {
        reject(new Error('Audio recording could not be prepared for transcription.'))
        return
      }

      const [, encoded] = value.split(',', 2)
      resolve(encoded ?? value)
    }
    reader.readAsDataURL(blob)
  })
}

function extractErrorMessage(error: unknown): string {
  if (isAppCommandError(error)) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'Unknown error'
}

function formatActionErrorMessage(error: unknown): string {
  if (isAppCommandError(error)) {
    return `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`
  }

  return extractErrorMessage(error)
}

function formatCodesMutationError(error: unknown): string {
  const rawMessage = extractErrorMessage(error).trim()
  const normalized = rawMessage.toLowerCase()

  if (normalized.includes('unique constraint failed: engagements.code')) {
    return 'This engagement code is already in use. Enter a different engagement code.'
  }

  if (
    normalized.includes('unique constraint failed: activities.engagement_id')
    && normalized.includes('activities.code')
  ) {
    return 'This activity code already exists for the selected engagement. Enter a different activity code.'
  }

  if (normalized.includes('engagement name is required')) {
    return 'Engagement name is required.'
  }

  if (
    normalized.includes('engagement usage guidance is required')
    || normalized.includes('activity usage guidance is required')
    || normalized.includes('usage guidance is required')
  ) {
    return '"Describe when to use" is required for matching.'
  }

  if (normalized.includes('activity engagement and name are required')) {
    return 'Select an engagement and enter an activity name.'
  }

  if (
    normalized.includes('invalid input: colorhex must be a valid #rrggbb value')
    || normalized.includes('engagement color must be a valid #rrggbb value')
    || normalized.includes('activity color must be a valid #rrggbb value')
  ) {
    return 'Color must be a valid hex value like #1A2B3C.'
  }

  if (normalized.includes('describewhentouse must be')) {
    return '"Describe when to use" must be 500 characters or fewer.'
  }

  if (normalized.includes('foreign key constraint failed')) {
    return 'The selected engagement is no longer available. Refresh and try again.'
  }

  if (normalized.includes('database error:')) {
    return 'We could not save your changes due to a database error. Please try again.'
  }

  return 'We could not save your changes. Please review your input and try again.'
}

function formatMinutesAsHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

function formatTimelineHoursCompact(minutes: number): string {
  const formattedHours = (minutes / 60)
    .toFixed(2)
    .replace(/(?:\.0+|(\.\d*?)0+)$/, '$1')

  return `${formattedHours}h`
}

function formatQuickBlockDuration(minutes: number): string {
  if (minutes < HOUR_IN_MINUTES) {
    return `${minutes}m`
  }

  return formatTimelineHoursCompact(minutes)
}

function quickBlockDurationProgress(minutes: number): number {
  const minDuration = TIMELINE_MANUAL_CREATE_DURATION_MINUTES
  const span = QUICK_BLOCK_MAX_DURATION_MINUTES - minDuration

  if (span <= 0) {
    return 0
  }

  return ((clampQuickBlockDuration(minutes) - minDuration) / span) * 100
}

function formatMonthDay(date: string): string {
  const [yearToken, monthToken, dayToken] = date.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const day = Number(dayToken)
  const value = new Date(year, monthIndex, day)
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

function formatWeekdayName(date: string, format: 'long' | 'short' = 'long'): string {
  const value = new Date(`${date}T00:00:00`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: format,
  }).format(value)
}

function getSummaryDayDate(
  weeklySummary: TimelineWeeklySummary | null | undefined,
  dayIndex: number,
): string | null {
  return weeklySummary?.days[dayIndex]?.date ?? weeklySummary?.weekStartDate ?? null
}

function getSummaryDayName(
  weeklySummary: TimelineWeeklySummary | null | undefined,
  dayIndex: number,
): string {
  const date = getSummaryDayDate(weeklySummary, dayIndex)
  return date ? formatWeekdayName(date) : `Day ${dayIndex + 1}`
}

function getSummaryDayShortName(
  weeklySummary: TimelineWeeklySummary | null | undefined,
  dayIndex: number,
): string {
  const date = getSummaryDayDate(weeklySummary, dayIndex)
  return date ? formatWeekdayName(date, 'short') : `D${dayIndex + 1}`
}

function formatSummaryDayLabel(
  weeklySummary: TimelineWeeklySummary | null | undefined,
  dayIndex: number,
): string {
  const dayName = getSummaryDayName(weeklySummary, dayIndex)
  const date = getSummaryDayDate(weeklySummary, dayIndex)

  return date ? `${dayName} (${formatMonthDay(date)})` : dayName
}

function weekStartOffsetFromSunday(weekStartDay: TimelineWeekStartDay): number {
  if (weekStartDay === 'monday') {
    return 1
  }

  if (weekStartDay === 'saturday') {
    return 6
  }

  return 0
}

function getWeekStartDate(anchorDate: string, weekStartDay: TimelineWeekStartDay): Date {
  const anchor = new Date(`${anchorDate}T00:00:00`)
  const weekStart = new Date(anchor)
  const daysSinceWeekStart = (anchor.getDay() + 7 - weekStartOffsetFromSunday(weekStartDay)) % 7
  weekStart.setDate(anchor.getDate() - daysSinceWeekStart)

  return weekStart
}

function buildWeekViewDays(
  anchorDate: string,
  weekStartDay: TimelineWeekStartDay,
): TimelineWeekView['days'] {
  const weekStart = getWeekStartDate(anchorDate, weekStartDay)

  return Array.from({ length: 7 }, (_, dayIndex) => {
    const value = new Date(weekStart)
    value.setDate(weekStart.getDate() + dayIndex)
    return {
      date: formatDate(value),
    }
  })
}

function buildWeekDateSet(anchorDate: string, weekStartDay: TimelineWeekStartDay): Set<string> {
  return new Set(buildWeekViewDays(anchorDate, weekStartDay).map((day) => day.date))
}

function formatTimelineWeekRangeLabel(startDate: string, endDate: string): TimelineWeekRangeLabel {
  const startValue = new Date(`${startDate}T00:00:00`)
  const endValue = new Date(`${endDate}T00:00:00`)
  const startMonthDay = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(startValue)
  const endMonthDay = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(endValue)
  const startYear = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
  }).format(startValue)
  const endYear = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
  }).format(endValue)

  return {
    startMonthDay,
    startYear,
    endMonthDay,
    endYear,
    isSameYear: startYear === endYear,
  }
}

function formatWeekTimelineDayLabel(date: string): string {
  const value = new Date(`${date}T00:00:00`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
  })
    .format(value)
    .replace(',', '')
}

function formatTimelineHeaderDate(date: string): TimelineHeaderDate {
  const value = new Date(`${date}T00:00:00`)
  return {
    monthDay: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
    }).format(value),
    year: new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
    }).format(value),
    weekday: new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
    }).format(value),
  }
}

function minuteToCurrentTimeLabel(totalMinutes: number): string {
  const normalizedMinutes = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440
  const hours24 = Math.floor(normalizedMinutes / HOUR_IN_MINUTES)
  const minutes = normalizedMinutes % HOUR_IN_MINUTES
  const hours12 = hours24 % 12 || 12
  return `${hours12}:${`${minutes}`.padStart(2, '0')}`
}

function formatSummaryNotesForClipboard(notes: TimelineWeeklySummaryNote[]): string {
  return notes
    .map((note) => `${formatMinutesAsHours(note.durationMinutes)} Hours: ${note.description}`)
    .join('\n')
}

function monthKeyFromDate(date: string): string {
  return date.slice(0, 7)
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const shifted = new Date(year, monthIndex + delta, 1)
  return `${shifted.getFullYear()}-${`${shifted.getMonth() + 1}`.padStart(2, '0')}`
}

function formatMonthHeading(monthKey: string): string {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1
  const value = new Date(year, monthIndex, 1)

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(value)
}

function buildCalendarDayCells(monthKey: string): CalendarDayCell[] {
  const [yearToken, monthToken] = monthKey.split('-')
  const year = Number(yearToken)
  const monthIndex = Number(monthToken) - 1

  const firstDayOfMonth = new Date(year, monthIndex, 1)
  const gridStart = new Date(year, monthIndex, 1 - firstDayOfMonth.getDay())
  const cells: CalendarDayCell[] = []

  for (let index = 0; index < 42; index += 1) {
    const currentDate = new Date(gridStart)
    currentDate.setDate(gridStart.getDate() + index)

    cells.push({
      date: formatDate(currentDate),
      dayOfMonth: currentDate.getDate(),
      isCurrentMonth:
        currentDate.getFullYear() === year
        && currentDate.getMonth() === monthIndex,
    })
  }

  return cells
}

function formatCalendarDayAriaLabel(
  date: string,
  state: {
    isSelected: boolean
    isToday: boolean
    hasEntries: boolean
    isInHighlightedWeek: boolean
  },
): string {
  const value = new Date(`${date}T00:00:00`)
  const parts = [
    new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(value),
  ]

  if (state.isSelected) {
    parts.push('selected')
  }

  if (state.isToday) {
    parts.push('today')
  }

  if (state.hasEntries) {
    parts.push('has entries')
  }

  if (state.isInHighlightedWeek) {
    parts.push('in summary week')
  }

  return parts.join(', ')
}

function applyDragPreviewToTimelineEntries(
  entries: TimelineEntry[],
  dragState: TimelineDragState | null,
): TimelineEntry[] {
  if (!dragState || !dragState.isDragging) {
    return entries
  }

  const previewDuration = dragState.previewEndMinute - dragState.previewStartMinute
  return entries.map((entry) =>
    entry.id === dragState.entryId
      ? {
          ...entry,
          date: dragState.previewDate,
          startMinute: dragState.previewStartMinute,
          endMinute: dragState.previewEndMinute,
          durationMinutes: previewDuration,
        }
      : entry,
  )
}

function applyOptimisticTimelineEntryPreview(
  entries: TimelineEntry[],
  optimisticEntry: TimelineEntry | null,
  shouldIncludeEntry: (entry: TimelineEntry) => boolean,
): TimelineEntry[] {
  if (!optimisticEntry || !shouldIncludeEntry(optimisticEntry)) {
    return entries
  }

  return entries.some((entry) => entry.id === optimisticEntry.id)
    ? replaceTimelineEntry(entries, optimisticEntry)
    : entries
}

function buildOptimisticTimelineEntryPreview(
  currentEntry: TimelineEntry,
  entryDraft: EntryDraft,
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
): TimelineEntry | null {
  const savePlan = buildEntryDraftSavePlan(entryDraft)
  if (!savePlan.ok) {
    return null
  }

  const { normalizedDraft } = savePlan
  const engagement = normalizedDraft.engagementId
    ? engagementById.get(normalizedDraft.engagementId) ?? null
    : null
  const activity = normalizedDraft.activityId
    ? activityById.get(normalizedDraft.activityId) ?? null
    : null
  const warningFlags: WarningType[] = []

  if (!normalizedDraft.engagementId || !normalizedDraft.activityId) {
    warningFlags.push('unmatched')
  }

  return {
    ...currentEntry,
    date: normalizedDraft.date,
    startMinute: savePlan.startMinute,
    endMinute: savePlan.endMinute,
    durationMinutes: savePlan.endMinute - savePlan.startMinute,
    description: normalizedDraft.description.trim(),
    engagementId: normalizedDraft.engagementId || null,
    activityId: normalizedDraft.activityId || null,
    engagementCode: engagement?.code ?? null,
    engagementName: engagement?.name ?? null,
    engagementType: engagement?.engagementType ?? null,
    activityCode: activity?.code ?? null,
    activityName: activity?.name ?? null,
    warningFlags,
  }
}

function createEmptyTimelineTotalBreakdown(): TimelineTotalBreakdown {
  return {
    primaryMinutes: 0,
    externalMinutes: 0,
    internalMinutes: 0,
    uncategorizedMinutes: 0,
  }
}

interface TimelineTotalPreferences {
  includeExternalInTotals: boolean
  includeInternalInTotals: boolean
  excludeUncategorizedFromTotals: boolean
}

interface TimelineTotalDisplaySegment {
  key: string
  label: string
}

function createTimelineTotalSegment(
  key: string,
  minutes: number,
  label: string,
): TimelineTotalDisplaySegment {
  return {
    key,
    label: `${formatTimelineHoursCompact(minutes)} ${label}`,
  }
}

function splitTimelineTotalSegmentLabel(label: string): { amount: string; label: string } {
  const [amount = label, ...labelParts] = label.split(' ')
  const segmentLabel = labelParts.join(' ')

  return {
    amount,
    label: segmentLabel
      ? segmentLabel.charAt(0).toUpperCase() + segmentLabel.slice(1)
      : '',
  }
}

function buildTimelineTotalDisplaySegments(
  breakdown: TimelineTotalBreakdown,
  options: {
    includePrimaryTotal: boolean
    separateEngagementTypeTotals: boolean
    showUncategorizedTotal: boolean
  },
): TimelineTotalDisplaySegment[] {
  const segments: TimelineTotalDisplaySegment[] = []

  if (options.includePrimaryTotal) {
    segments.push(createTimelineTotalSegment('total', breakdown.primaryMinutes, 'total'))
  }

  if (options.separateEngagementTypeTotals) {
    if (breakdown.externalMinutes > 0) {
      segments.push(createTimelineTotalSegment('external', breakdown.externalMinutes, 'external'))
    }
    if (breakdown.internalMinutes > 0) {
      segments.push(createTimelineTotalSegment('internal', breakdown.internalMinutes, 'internal'))
    }
  }

  if (options.showUncategorizedTotal && breakdown.uncategorizedMinutes > 0) {
    segments.push(
      createTimelineTotalSegment('uncategorized', breakdown.uncategorizedMinutes, 'uncategorized'),
    )
  }

  return segments
}

function buildWeekTimelinePrimaryTotalSegments(
  breakdown: TimelineTotalBreakdown,
  separateEngagementTypeTotals: boolean,
): TimelineTotalDisplaySegment[] {
  if (
    separateEngagementTypeTotals
    && (breakdown.externalMinutes > 0 || breakdown.internalMinutes > 0)
  ) {
    return buildTimelineTotalDisplaySegments(breakdown, {
      includePrimaryTotal: false,
      separateEngagementTypeTotals: true,
      showUncategorizedTotal: false,
    })
  }

  return [createTimelineTotalSegment('total', breakdown.primaryMinutes, 'total')]
}

function finalizeTimelineTotalBreakdown(
  breakdown: TimelineTotalBreakdown,
  preferences: TimelineTotalPreferences,
): TimelineTotalBreakdown {
  const primaryMinutes =
    (preferences.includeExternalInTotals ? breakdown.externalMinutes : 0)
    + (preferences.includeInternalInTotals ? breakdown.internalMinutes : 0)
    + (preferences.excludeUncategorizedFromTotals ? 0 : breakdown.uncategorizedMinutes)

  return {
    ...breakdown,
    primaryMinutes,
  }
}

function isReportingRowExcludedFromPrimaryTotal(
  row: TimelineWeeklySummaryRow,
  preferences: TimelineTotalPreferences,
): boolean {
  if (row.isUncategorized) {
    return preferences.excludeUncategorizedFromTotals
  }

  if (row.engagementType === 'internal') {
    return !preferences.includeInternalInTotals
  }

  if (row.engagementType === 'external') {
    return !preferences.includeExternalInTotals
  }

  return false
}

function addEntryToTimelineTotalBreakdown(
  breakdown: TimelineTotalBreakdown,
  entry: TimelineEntry,
): void {
  if (isTimelineEntryUncategorized(entry)) {
    breakdown.uncategorizedMinutes += entry.durationMinutes
    return
  }

  if (entry.engagementType === 'internal') {
    breakdown.internalMinutes += entry.durationMinutes
    return
  }

  breakdown.externalMinutes += entry.durationMinutes
}

function buildTimelineTotalBreakdown(
  entries: TimelineEntry[],
  preferences: TimelineTotalPreferences,
): TimelineTotalBreakdown {
  const breakdown = createEmptyTimelineTotalBreakdown()

  for (const entry of entries) {
    addEntryToTimelineTotalBreakdown(breakdown, entry)
  }

  return finalizeTimelineTotalBreakdown(breakdown, preferences)
}

function buildTimelineDayTotalBreakdowns(
  entries: TimelineEntry[],
  days: TimelineWeekView['days'],
  preferences: TimelineTotalPreferences,
): Map<string, TimelineTotalBreakdown> {
  const totalsByDate = new Map(
    days.map((day) => [day.date, createEmptyTimelineTotalBreakdown()] as const),
  )

  for (const entry of entries) {
    let breakdown = totalsByDate.get(entry.date)
    if (!breakdown) {
      breakdown = createEmptyTimelineTotalBreakdown()
      totalsByDate.set(entry.date, breakdown)
    }

    addEntryToTimelineTotalBreakdown(breakdown, entry)
  }

  for (const [date, breakdown] of totalsByDate) {
    totalsByDate.set(date, finalizeTimelineTotalBreakdown(breakdown, preferences))
  }

  return totalsByDate
}

function replaceTimelineEntry(
  entries: TimelineEntry[],
  nextEntry: TimelineEntry,
): TimelineEntry[] {
  const nextEntries = entries.map((entry) => entry.id === nextEntry.id ? nextEntry : entry)

  return nextEntries.sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date)
    }

    if (left.startMinute !== right.startMinute) {
      return left.startMinute - right.startMinute
    }

    if (left.endMinute !== right.endMinute) {
      return left.endMinute - right.endMinute
    }

    return left.id.localeCompare(right.id)
  })
}

function filterTimelineEntriesForDate(
  entries: TimelineEntry[],
  date: string,
): TimelineEntry[] {
  return entries.filter((entry) => entry.date === date)
}

function snapMinute(value: number, increment: number): number {
  if (increment <= 0) {
    return value
  }

  return Math.round(value / increment) * increment
}

function clampQuickBlockDuration(durationMinutes: number): number {
  const rounded = snapMinute(durationMinutes, QUICK_BLOCK_DURATION_STEP_MINUTES)
  return Math.min(
    QUICK_BLOCK_MAX_DURATION_MINUTES,
    Math.max(TIMELINE_MANUAL_CREATE_DURATION_MINUTES, rounded),
  )
}

function quickBlockDurationFromDrag(originClientX: number, currentClientX: number): number {
  const dragDistance = Math.max(0, currentClientX - originClientX)
  const durationSteps = Math.round(dragDistance / QUICK_BLOCK_DRAG_STEP_PX)
  return clampQuickBlockDuration(
    TIMELINE_MANUAL_CREATE_DURATION_MINUTES
    + durationSteps * QUICK_BLOCK_DURATION_STEP_MINUTES,
  )
}

function dragStepFromDelta(deltaPixels: number, stepPixels: number): number {
  if (stepPixels <= 0 || deltaPixels === 0) {
    return 0
  }

  return Math.sign(deltaPixels) * Math.round(Math.abs(deltaPixels) / stepPixels)
}

function timelineDurationFromHorizontalDrag(
  originalDurationMinutes: number,
  deltaPixels: number,
  startMinute: number,
  timelineWindow: TimelineWindow,
): number {
  const durationSteps = dragStepFromDelta(deltaPixels, TIMELINE_DURATION_RESIZE_STEP_PX)
  const requestedDuration =
    originalDurationMinutes
    + durationSteps * TIMELINE_DURATION_RESIZE_STEP_MINUTES
  const maxDuration = Math.max(1, timelineWindow.endMinute - startMinute)
  const minDuration = Math.min(TIMELINE_MANUAL_CREATE_DURATION_MINUTES, maxDuration)

  return Math.min(
    maxDuration,
    Math.max(minDuration, requestedDuration),
  )
}

function currentRoundedTimelineStartMinute(): number {
  const now = new Date()
  const currentMinute = now.getHours() * HOUR_IN_MINUTES + now.getMinutes()
  return Math.min(
    MINUTES_IN_DAY,
    Math.max(
      0,
      snapMinute(currentMinute, TIMELINE_DRAG_SNAP_MINUTES),
    ),
  )
}

function resolveQuickBlockCreateWindow(durationMinutes: number): { startMinute: number; endMinute: number } {
  const safeDuration = clampQuickBlockDuration(durationMinutes)
  const snappedStartMinute = currentRoundedTimelineStartMinute()
  const endMinute = Math.min(MINUTES_IN_DAY, snappedStartMinute + safeDuration)
  const startMinute = Math.max(0, endMinute - safeDuration)

  return { startMinute, endMinute }
}

function clampTimelineScrollTop(grid: HTMLDivElement, targetTop: number): number {
  const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
  return Math.min(Math.max(0, targetTop), maxScrollTop)
}

function centerTimelinePositionScrollTop(
  grid: HTMLDivElement,
  positionTop: number,
): number {
  return clampTimelineScrollTop(grid, positionTop - (grid.clientHeight / 2))
}

function clampStartMinuteForDuration(
  startMinute: number,
  durationMinutes: number,
  timelineWindow: TimelineWindow,
): number {
  const safeDuration = Math.max(durationMinutes, TIMELINE_DRAG_SNAP_MINUTES)
  const maxStartMinute = Math.max(
    timelineWindow.startMinute,
    timelineWindow.endMinute - safeDuration,
  )

  return Math.min(
    Math.max(startMinute, timelineWindow.startMinute),
    maxStartMinute,
  )
}

function clientYToTimelineMinute(
  clientY: number,
  grid: HTMLDivElement,
  timelineWindow: TimelineWindow,
): number {
  const gridRect = grid.getBoundingClientRect()
  const relativeY =
    clientY - gridRect.top + grid.scrollTop - TIMELINE_CANVAS_TOP_PADDING
  const pixelsPerMinute = PIXELS_PER_MINUTE > 0 ? PIXELS_PER_MINUTE : 1

  return timelineWindow.startMinute + (relativeY / pixelsPerMinute)
}

function buildWeekTimelineLayoutMetrics(isCompact: boolean): WeekTimelineLayoutMetrics {
  return {
    headerHeight: WEEK_TIMELINE_HEADER_HEIGHT,
    gutterLeft: isCompact ? COMPACT_WEEK_TIMELINE_GUTTER_LEFT : WEEK_TIMELINE_GUTTER_LEFT,
    dayWidth: isCompact ? COMPACT_WEEK_TIMELINE_DAY_WIDTH : WEEK_TIMELINE_DAY_WIDTH,
  }
}

function resolveWeekTimelinePointerSlot(
  clientX: number,
  clientY: number,
  grid: HTMLDivElement,
  days: TimelineWeekView['days'],
  timelineWindow: TimelineWindow,
  layoutMetrics: WeekTimelineLayoutMetrics,
): {
  date: string
  dayIndex: number
  minute: number
} {
  const gridRect = grid.getBoundingClientRect()
  const relativeX = clientX - gridRect.left + grid.scrollLeft - layoutMetrics.gutterLeft
  const unclampedDayIndex = Math.floor(relativeX / layoutMetrics.dayWidth)
  const dayIndex = Math.min(Math.max(unclampedDayIndex, 0), Math.max(days.length - 1, 0))
  const relativeY =
    clientY
    - gridRect.top
    + grid.scrollTop
    - layoutMetrics.headerHeight
    - TIMELINE_CANVAS_TOP_PADDING
  const minute = timelineWindow.startMinute + (relativeY / PIXELS_PER_MINUTE)

  return {
    date: days[dayIndex]?.date ?? days[0]?.date ?? formatDate(new Date()),
    dayIndex,
    minute,
  }
}

function positionTimelineEntries(
  entries: TimelineEntry[],
  timelineWindow: TimelineWindow,
  options?: PositionTimelineEntriesOptions,
): PositionedTimelineEntry[] {
  const clippedEntries: ClippedTimelineEntry[] = entries
    .map((entry) => {
      const clippedStartMinute = Math.max(entry.startMinute, timelineWindow.startMinute)
      const clippedEndMinute = Math.min(entry.endMinute, timelineWindow.endMinute)

      return {
        entry,
        clippedStartMinute,
        clippedEndMinute,
      }
    })
    .filter((entry) => entry.clippedEndMinute > entry.clippedStartMinute)
    .sort((a, b) => {
      if (a.clippedStartMinute !== b.clippedStartMinute) {
        return a.clippedStartMinute - b.clippedStartMinute
      }

      if (a.clippedEndMinute !== b.clippedEndMinute) {
        return a.clippedEndMinute - b.clippedEndMinute
      }

      return a.entry.id.localeCompare(b.entry.id)
    })

  if (clippedEntries.length === 0) {
    return []
  }

  type LaneEntry = ClippedTimelineEntry & { laneIndex: number }

  const groups: LaneEntry[][] = []
  let activeLanes: Array<{ laneIndex: number; endMinute: number }> = []
  let currentGroup: LaneEntry[] = []

  for (const clippedEntry of clippedEntries) {
    activeLanes = activeLanes.filter(
      (lane) => lane.endMinute > clippedEntry.clippedStartMinute,
    )

    if (activeLanes.length === 0 && currentGroup.length > 0) {
      groups.push(currentGroup)
      currentGroup = []
    }

    const occupiedLanes = new Set(activeLanes.map((lane) => lane.laneIndex))
    let laneIndex = 0
    while (occupiedLanes.has(laneIndex)) {
      laneIndex += 1
    }

    activeLanes.push({
      laneIndex,
      endMinute: clippedEntry.clippedEndMinute,
    })

    currentGroup.push({
      ...clippedEntry,
      laneIndex,
    })
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  const positionedEntries: PositionedTimelineEntry[] = []

  for (const group of groups) {
    const laneCount = Math.max(...group.map((entry) => entry.laneIndex)) + 1
    let layoutGroup = group
    const preferredLaneByEntryId = options?.preferredLaneByEntryId
    const preferredLaneOrder = options?.preferredLaneOrder ?? []

    if (
      preferredLaneByEntryId
      && preferredLaneByEntryId.size > 0
      && preferredLaneOrder.length > 0
    ) {
      const groupEntryIds = new Set(group.map((entry) => entry.entry.id))
      const orderedGroupEntryIds = preferredLaneOrder.filter((entryId) => groupEntryIds.has(entryId))

      for (const entryId of orderedGroupEntryIds) {
        const preferredLaneIndex = preferredLaneByEntryId.get(entryId)
        if (
          typeof preferredLaneIndex !== 'number'
          || preferredLaneIndex < 0
          || preferredLaneIndex >= laneCount
        ) {
          continue
        }

        const preferredEntry = layoutGroup.find((entry) => entry.entry.id === entryId) ?? null
        if (!preferredEntry || preferredEntry.laneIndex === preferredLaneIndex) {
          continue
        }

        const currentLaneIndex = preferredEntry.laneIndex
        layoutGroup = layoutGroup.map((groupEntry) => {
          if (groupEntry.entry.id === entryId) {
            return {
              ...groupEntry,
              laneIndex: preferredLaneIndex,
            }
          }

          if (groupEntry.laneIndex === preferredLaneIndex) {
            return {
              ...groupEntry,
              laneIndex: currentLaneIndex,
            }
          }

          return groupEntry
        })
      }
    }

    const lockedEntryId = options?.lockedEntryId
    const lockedLaneIndex = options?.lockedLaneIndex
    const lockedEntry = lockedEntryId
      ? layoutGroup.find((entry) => entry.entry.id === lockedEntryId) ?? null
      : null

    if (
      lockedEntry
      && typeof lockedLaneIndex === 'number'
      && lockedLaneIndex >= 0
      && lockedLaneIndex < laneCount
      && lockedEntry.laneIndex !== lockedLaneIndex
    ) {
      const currentLaneIndex = lockedEntry.laneIndex
      layoutGroup = layoutGroup.map((groupEntry) => {
        if (groupEntry.entry.id === lockedEntry.entry.id) {
          return {
            ...groupEntry,
            laneIndex: lockedLaneIndex,
          }
        }

        if (groupEntry.laneIndex === lockedLaneIndex) {
          return {
            ...groupEntry,
            laneIndex: currentLaneIndex,
          }
        }

        return groupEntry
      })
    }

    const laneGapPercent = laneCount > 1 ? TIMELINE_OVERLAP_GAP_PERCENT : 0
    const totalGapPercent = laneGapPercent * Math.max(0, laneCount - 1)
    const widthPercent = (100 - totalGapPercent) / laneCount

    for (const groupEntry of layoutGroup) {
      positionedEntries.push({
        ...groupEntry,
        laneCount,
        top:
          TIMELINE_CANVAS_TOP_PADDING
          + (groupEntry.clippedStartMinute - timelineWindow.startMinute)
          * PIXELS_PER_MINUTE,
        height: Math.max(
          (groupEntry.clippedEndMinute - groupEntry.clippedStartMinute)
          * PIXELS_PER_MINUTE,
          30,
        ),
        leftPercent: groupEntry.laneIndex * (widthPercent + laneGapPercent),
        widthPercent,
      })
    }
  }

  return positionedEntries
}

function positionWeekTimelineEntries(
  entries: TimelineEntry[],
  days: TimelineWeekView['days'],
  timelineWindow: TimelineWindow,
  layoutMetrics: WeekTimelineLayoutMetrics,
  options?: PositionTimelineEntriesOptions,
  dragState?: TimelineDragState | null,
): PositionedWeekTimelineEntry[] {
  const positionedEntries: PositionedWeekTimelineEntry[] = []

  days.forEach((day, dayIndex) => {
    const dayEntries = entries.filter((entry) => entry.date === day.date)
    const dayPositions = positionTimelineEntries(
      dayEntries,
      timelineWindow,
      {
        ...options,
        ...(dragState?.isDragging && dragState.previewDate === day.date
          ? {
            lockedEntryId: dragState.entryId,
            lockedLaneIndex: dragState.lockedLaneIndex,
          }
          : {}),
      },
    )

    dayPositions.forEach((positionedEntry) => {
      const dayEntryLeft = layoutMetrics.gutterLeft + (dayIndex * layoutMetrics.dayWidth)
      const usableDayWidth = Math.max(
        1,
        layoutMetrics.dayWidth - (WEEK_TIMELINE_ENTRY_COLUMN_INSET * 2),
      )

      positionedEntries.push({
        ...positionedEntry,
        dayIndex,
        left:
          dayEntryLeft
          + WEEK_TIMELINE_ENTRY_COLUMN_INSET
          + ((positionedEntry.leftPercent / 100) * usableDayWidth),
        width: (positionedEntry.widthPercent / 100) * usableDayWidth,
      })
    })
  })

  return positionedEntries
}

function normalizeColorHexInput(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().toUpperCase()
  if (normalized.length === 0) {
    return null
  }

  if (!/^#[0-9A-F]{6}$/.test(normalized)) {
    return null
  }

  return normalized
}

function resolveTimelineBlockColor(
  entry: TimelineEntry,
  activityColorById: Map<string, string | null>,
  engagementColorById: Map<string, string | null>,
): string {
  if (entry.activityId) {
    const activityColor = activityColorById.get(entry.activityId)
    if (activityColor) {
      return activityColor
    }
  }

  if (entry.engagementId) {
    const engagementColor = engagementColorById.get(entry.engagementId)
    if (engagementColor) {
      return engagementColor
    }
  }

  return TIMELINE_NEUTRAL_COLOR
}

function buildTimelineBlockPalette(backgroundHex: string): TimelineBlockPalette {
  const normalized = normalizeColorHexInput(backgroundHex) ?? TIMELINE_NEUTRAL_COLOR
  const { red, green, blue } = parseHexColorChannels(normalized)

  return {
    accent: normalized,
    fill: colorChannelsToRgba(red, green, blue, TIMELINE_BLOCK_FILL_ALPHA),
    border: colorChannelsToRgba(red, green, blue, TIMELINE_BLOCK_BORDER_ALPHA),
    selectionRing: colorChannelsToRgba(red, green, blue, TIMELINE_BLOCK_SELECTION_RING_ALPHA),
    text: TIMELINE_BLOCK_TEXT_COLOR,
  }
}

function buildTimelineBlockCssVariables(palette: TimelineBlockPalette): CSSProperties {
  return {
    '--timeline-block-fill': palette.fill,
    '--timeline-block-border': palette.border,
    '--timeline-block-selection-ring': palette.selectionRing,
    '--timeline-block-accent': palette.accent,
    color: palette.text,
  } as CSSProperties
}

function parseHexColorChannels(colorHex: string): {
  red: number
  green: number
  blue: number
} {
  return {
    red: Number.parseInt(colorHex.slice(1, 3), 16),
    green: Number.parseInt(colorHex.slice(3, 5), 16),
    blue: Number.parseInt(colorHex.slice(5, 7), 16),
  }
}

function colorChannelsToRgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function normalizeCodeTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function formatActivityCount(count: number): string {
  return `${count} ${count === 1 ? 'activity' : 'activities'}`
}

function normalizeDisplayText(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function formatEntityPrimaryLabel(
  name: string | null | undefined,
  code: string | null | undefined,
  fallback = 'Uncategorized',
): string {
  return normalizeDisplayText(name) ?? normalizeDisplayText(code) ?? fallback
}

function formatEntityDisplayLabel(
  name: string | null | undefined,
  code: string | null | undefined,
  fallback = 'Uncategorized',
): string {
  const primary = formatEntityPrimaryLabel(name, code, fallback)
  const normalizedCode = normalizeDisplayText(code)

  if (!normalizedCode || normalizedCode.toUpperCase() === primary.toUpperCase()) {
    return primary
  }

  return `${primary} (${normalizedCode})`
}

function formatSummaryCodeValue(code: string | null | undefined, isUncategorized: boolean): string {
  if (isUncategorized) {
    return 'UNCAT'
  }

  return normalizeDisplayText(code) ?? ''
}

function getTimelineBlockReviewLabel(warningFlags: WarningType[]): string | null {
  const hasLowConfidence = warningFlags.includes('low_confidence')
  const hasUnmatched = warningFlags.includes('unmatched')

  if (hasLowConfidence && hasUnmatched) {
    return 'Low confidence and uncategorized'
  }

  if (hasLowConfidence) {
    return 'Low confidence'
  }

  if (hasUnmatched) {
    return 'Uncategorized'
  }

  return null
}

function buildTimelineBlockTitle(
  fullLabel: string,
  description: string,
  reviewLabel: string | null,
): string {
  const reviewLine = reviewLabel ? `\nReview needed: ${reviewLabel}` : ''
  return `${fullLabel}\n${description}${reviewLine}`
}

function buildTimelineBlockAriaLabel(
  fullLabel: string,
  description: string,
  reviewLabel: string | null,
): string {
  const reviewSentence = reviewLabel ? ` Review needed: ${reviewLabel}.` : ''
  return `${fullLabel}. ${description}.${reviewSentence}`
}

function isTimelineEntryUncategorized(entry: TimelineEntry): boolean {
  return !entry.engagementId || !entry.activityId
}

function resolveTimelineLabelTier(
  widthPercent: number,
  blockHeight: number,
): TimelineLabelTier {
  if (widthPercent < 36 || blockHeight < 28) {
    return 3
  }

  if (widthPercent < 58 || blockHeight < 38) {
    return 2
  }

  return 1
}

function buildTimelineBlockLabel(
  entry: TimelineEntry,
  widthPercent: number,
  blockHeight: number,
): TimelineLabel {
  const tier = resolveTimelineLabelTier(widthPercent, blockHeight)

  if (isTimelineEntryUncategorized(entry)) {
    const description = normalizeDisplayText(entry.description)

    return {
      label: description ? `Uncategorized | ${description}` : 'Uncategorized',
      fullLabel: 'Uncategorized',
      tier,
    }
  }

  const engagementPrimary = formatEntityPrimaryLabel(
    entry.engagementName,
    entry.engagementCode,
    'Uncategorized',
  )
  const activityPrimary = formatEntityPrimaryLabel(
    entry.activityName,
    entry.activityCode,
    'Uncategorized',
  )
  const fullLabelBase = `${formatEntityDisplayLabel(entry.engagementName, entry.engagementCode)} | ${formatEntityDisplayLabel(entry.activityName, entry.activityCode)}`

  if (tier === 3) {
    return {
      label: activityPrimary,
      fullLabel: fullLabelBase,
      tier,
    }
  }

  if (tier === 2) {
    return {
      label: `${engagementPrimary} | ${activityPrimary}`,
      fullLabel: fullLabelBase,
      tier,
    }
  }

  return {
    label: fullLabelBase,
    fullLabel: fullLabelBase,
    tier,
  }
}

function resolveManualTimelineCreateWindow(
  anchorMinute: number,
  timelineWindow: TimelineWindow,
): { startMinute: number; endMinute: number } {
  const snappedStartMinute = snapMinute(anchorMinute, TIMELINE_DRAG_SNAP_MINUTES)
  const startMinute = clampStartMinuteForDuration(
    snappedStartMinute,
    TIMELINE_MANUAL_CREATE_DURATION_MINUTES,
    timelineWindow,
  )
  return {
    startMinute,
    endMinute: startMinute + TIMELINE_MANUAL_CREATE_DURATION_MINUTES,
  }
}

function isTargetWithinTimelineBlock(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.timeline-block') !== null
}

function clampTimelineContextMenuPosition(
  clientX: number,
  clientY: number,
  menuKind: TimelineContextMenuKind,
): { x: number; y: number } {
  const viewportPadding = 8
  const menuWidth = 170
  const menuHeight = menuKind === 'entry' ? 82 : 46
  const maxX = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding)
  const maxY = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding)

  return {
    x: Math.min(Math.max(clientX, viewportPadding), maxX),
    y: Math.min(Math.max(clientY, viewportPadding), maxY),
  }
}

function buildSummaryViewColumn(
  column: SummaryLayoutColumn,
  weeklySummary?: TimelineWeeklySummary | null,
): SummaryLayoutViewColumn {
  if (column.kind === 'field') {
    const option = getSummaryLayoutFieldOption(column.fieldKey)
    return {
      kind: 'field',
      id: column.id,
      header: option?.label ?? 'Column',
      width: option?.width ?? '13rem',
      wraps: option?.wraps ?? false,
      fieldKey: column.fieldKey,
    }
  }

  if (column.kind === 'day') {
    return {
      kind: 'day',
      id: column.id,
      header: getSummaryDayName(weeklySummary, column.dayIndex),
      width: SUMMARY_LAYOUT_DAY_COLUMN_WIDTH,
      wraps: false,
      dayIndex: column.dayIndex,
    }
  }

  if (column.kind === 'rowTotal') {
    return {
      kind: 'rowTotal',
      id: column.id,
      header: 'Row Total',
      width: SUMMARY_LAYOUT_ROW_TOTAL_WIDTH,
      wraps: false,
    }
  }

  return {
    kind: 'freeText',
    id: column.id,
    header: column.label,
    width: '13rem',
    wraps: true,
  }
}

function formatReportingExportDayHeader(
  weeklySummary: TimelineWeeklySummary | null,
  dayIndex: number,
): string {
  return formatSummaryDayLabel(weeklySummary, dayIndex)
}

function buildReportingExportPreviewColumns(
  preset: SummaryLayoutPreset | undefined,
  weeklySummary: TimelineWeeklySummary | null,
  sheet: ReportingExportPreviewSheet,
): ReportingExportPreviewColumn[] {
  const columns: ReportingExportPreviewColumn[] = []
  const presetColumns = preset?.columns ?? []
  let columnIndex = 0

  while (columnIndex < presetColumns.length) {
    const column = presetColumns[columnIndex]

    if (column.kind === 'field') {
      const option = getSummaryLayoutFieldOption(column.fieldKey)
      columns.push({
        kind: 'field',
        id: column.id,
        header: option?.label ?? 'Column',
        fieldKey: column.fieldKey,
      })
    } else if (column.kind === 'day') {
      const dayHeader = formatReportingExportDayHeader(weeklySummary, column.dayIndex)

      if (sheet === 'weeklyHours') {
        columns.push({
          kind: 'dayHours',
          id: column.id,
          header: dayHeader,
          dayIndex: column.dayIndex,
        })
      } else {
        columns.push({
          kind: 'dayHours',
          id: `${column.id}-hours`,
          header: `${dayHeader} Hours`,
          dayIndex: column.dayIndex,
        })
        columns.push({
          kind: 'dayNotes',
          id: `${column.id}-notes`,
          header: 'Notes',
          dayIndex: column.dayIndex,
        })
      }
    } else if (column.kind === 'freeText') {
      columns.push({
        kind: 'freeText',
        id: column.id,
        header: column.label,
        rowValues: column.rowValues,
        repeat: column.repeat,
        repeatValue: column.repeatValue,
        repeatRowKey: column.repeatRowKey,
      })
    } else {
      columns.push({
        kind: 'rowTotal',
        id: column.id,
        header: 'Row Total',
      })
    }

    columnIndex += 1
  }

  return columns
}

function getReportingExportPreviewColumnWidth(column: ReportingExportPreviewColumn): string {
  const headerWidth = (minRem: number, maxRem: number): string => {
    const widthRem = Math.min(maxRem, Math.max(minRem, column.header.length * 0.42 + 1.2))
    const width = `${widthRem.toFixed(2)}rem`
    return `minmax(${width}, ${width})`
  }

  if (column.kind === 'dayNotes') {
    return 'minmax(3.4rem, 4.4rem)'
  }

  if (column.kind === 'dayHours') {
    return 'minmax(4.6rem, 5.4rem)'
  }

  if (column.kind === 'rowTotal') {
    return headerWidth(4.8, 5.8)
  }

  if (column.kind === 'freeText') {
    return headerWidth(4.5, 8.5)
  }

  if (column.fieldKey) {
    return headerWidth(4.5, 8.25)
  }

  return headerWidth(4.5, 8.25)
}

function resolveSummaryFieldValue(
  fieldKey: SummaryLayoutFieldKey,
  row: TimelineWeeklySummary['rows'][number],
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
): string {
  const engagement = row.engagementId ? engagementById.get(row.engagementId) ?? null : null
  const activity = row.activityId ? activityById.get(row.activityId) ?? null : null

  switch (fieldKey) {
    case 'engagementCode':
      return formatSummaryCodeValue(row.engagementCode, row.isUncategorized)
    case 'engagementName':
      return row.engagementName
    case 'clientName':
      return normalizeDisplayText(row.clientName) ?? '-'
    case 'engagementTags':
      return engagement && engagement.tags.length > 0 ? engagement.tags.join(', ') : '-'
    case 'engagementUsage':
      return normalizeDisplayText(engagement?.describeWhenToUse) ?? '-'
    case 'activityCode':
      return formatSummaryCodeValue(row.activityCode, row.isUncategorized)
    case 'activityName':
      return row.activityName
    case 'activityTags':
      return activity && activity.tags.length > 0 ? activity.tags.join(', ') : '-'
    case 'activityUsage':
      return normalizeDisplayText(activity?.describeWhenToUse) ?? '-'
    default:
      return '-'
  }
}

function formatSummaryRowLabel(row: TimelineWeeklySummary['rows'][number]): string {
  if (row.isUncategorized) {
    return row.engagementId
      ? `${row.engagementName} uncategorized`
      : 'Uncategorized'
  }

  return formatEntityDisplayLabel(row.activityName, row.activityCode)
}

function buildSummaryFreeTextRowKey(row: TimelineWeeklySummary['rows'][number]): string {
  const activityId = normalizeDisplayText(row.activityId)
  if (activityId) {
    return `activity:${activityId}`
  }

  if (row.isUncategorized) {
    const engagementId = normalizeDisplayText(row.engagementId)
    if (engagementId) {
      return `engagement:${engagementId}:uncategorized`
    }
  }

  return 'uncategorized'
}

function resolveSummaryFreeTextValue(
  column: Extract<SummaryLayoutColumn, { kind: 'freeText' }>,
  rowKey: string,
): string {
  return column.repeat ? column.repeatValue : column.rowValues?.[rowKey] ?? ''
}

function formatEngagementTypeLabel(value: EngagementType): string {
  return value === 'external' ? 'External' : 'Internal'
}

function renderSummaryPreviewCell(
  column: SummaryLayoutViewColumn,
  row: TimelineWeeklySummary['rows'][number],
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
) {
  if (column.kind === 'day' && column.dayIndex !== undefined) {
    const cell = row.cells[column.dayIndex]
    return cell && cell.totalMinutes > 0 ? formatMinutesAsHours(cell.totalMinutes) : '-'
  }

  if (column.kind === 'rowTotal') {
    return formatMinutesAsHours(row.rowTotalMinutes)
  }

  if (column.kind === 'freeText') {
    return <span className="summary-layout-editor-placeholder">Blank</span>
  }

  return resolveSummaryFieldValue(
    column.fieldKey ?? 'engagementName',
    row,
    engagementById,
    activityById,
  )
}

function formatReportingExportPreviewHours(minutes: number): string {
  return (minutes / 60)
    .toFixed(2)
    .replace(/(?:\.0+|(\.\d*?)0+)$/, '$1')
}

function renderReportingExportPreviewCell(
  column: ReportingExportPreviewColumn,
  row: TimelineWeeklySummary['rows'][number],
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
) {
  if (column.kind === 'dayHours' && column.dayIndex !== undefined) {
    const totalMinutes = row.cells[column.dayIndex]?.totalMinutes ?? 0
    return totalMinutes > 0 ? formatReportingExportPreviewHours(totalMinutes) : '-'
  }

  if (column.kind === 'dayNotes' && column.dayIndex !== undefined) {
    return ''
  }

  if (column.kind === 'rowTotal') {
    return formatReportingExportPreviewHours(row.rowTotalMinutes)
  }

  if (column.kind === 'freeText') {
    const rowKey = buildSummaryFreeTextRowKey(row)
    const value = column.repeat ? column.repeatValue ?? '' : column.rowValues?.[rowKey] ?? ''
    return value || <span className="summary-layout-editor-placeholder">Blank</span>
  }

  return resolveSummaryFieldValue(
    column.fieldKey ?? 'engagementName',
    row,
    engagementById,
    activityById,
  )
}

function renderReportingExportPreviewFooter(
  column: ReportingExportPreviewColumn,
  weeklySummary: TimelineWeeklySummary | null,
  isFooterLabelColumn: boolean,
): string {
  if (!weeklySummary) {
    return ''
  }

  if (column.kind === 'dayHours' && column.dayIndex !== undefined) {
    const totalMinutes = weeklySummary.dayTotalMinutes[column.dayIndex] ?? 0
    return formatReportingExportPreviewHours(totalMinutes)
  }

  if (column.kind === 'rowTotal') {
    return formatReportingExportPreviewHours(weeklySummary.weekTotalMinutes)
  }

  if (isFooterLabelColumn) {
    return 'Day Totals'
  }

  return ''
}

function renderSummaryPreviewSimpleFooter(
  column: SummaryLayoutViewColumn,
  weeklySummary: TimelineWeeklySummary | null,
): string {
  if (!weeklySummary) {
    return ''
  }

  if (column.kind === 'day' && column.dayIndex !== undefined) {
    return formatReportingExportPreviewHours(weeklySummary.dayTotalMinutes[column.dayIndex] ?? 0)
  }

  if (column.kind === 'rowTotal') {
    return formatReportingExportPreviewHours(weeklySummary.weekTotalMinutes)
  }

  return ''
}

function buildSummaryLayoutInsertOptions(
  preset: SummaryLayoutPreset,
  weeklySummary: TimelineWeeklySummary | null,
): Array<{
  key: string
  label: string
  description: string
  createColumn: () => SummaryLayoutColumn
}> {
  const usedFields = new Set(
    preset.columns
      .filter((column): column is Extract<SummaryLayoutColumn, { kind: 'field' }> => column.kind === 'field')
      .map((column) => column.fieldKey),
  )
  const usedDays = new Set(
    preset.columns
      .filter((column): column is Extract<SummaryLayoutColumn, { kind: 'day' }> => column.kind === 'day')
      .map((column) => column.dayIndex),
  )

  const fieldOptions = SUMMARY_LAYOUT_FIELD_OPTIONS
    .filter((option) => !usedFields.has(option.key))
    .map((option) => ({
      key: `field-${option.key}`,
      label: option.label,
      description: option.description,
      createColumn: (): SummaryLayoutColumn => ({
        kind: 'field',
        id: generateSummaryLayoutId(`field-${option.key}`),
        fieldKey: option.key,
      }),
    }))

  const dayOptions = Array.from({ length: 7 }, (_, dayIndex) => ({
    dayName: getSummaryDayName(weeklySummary, dayIndex),
    dayIndex,
  }))
    .filter(({ dayIndex }) => !usedDays.has(dayIndex))
    .map(({ dayName, dayIndex }) => ({
      key: `day-${dayIndex}`,
      label: dayName,
      description: `Shows the ${dayName.toLowerCase()} hours and notes for the selected week.`,
      createColumn: (): SummaryLayoutColumn => ({
        kind: 'day',
        id: generateSummaryLayoutId(`day-${dayIndex}`),
        dayIndex,
      }),
    }))

  return [
    ...fieldOptions,
    ...dayOptions,
    {
      key: 'free-text',
      label: 'Free Text',
      description: 'Adds a custom column with a user-defined header and empty row values.',
      createColumn: () => createSummaryLayoutFreeTextColumn(),
    },
  ]
}

function countSummaryLayoutNonTotalColumns(columns: SummaryLayoutColumn[]): number {
  return columns.filter((column) => column.kind !== 'rowTotal').length
}

function moveSummaryLayoutColumn(
  columns: SummaryLayoutColumn[],
  sourceIndex: number,
  targetIndex: number,
): SummaryLayoutColumn[] {
  if (
    sourceIndex < 0
    || targetIndex < 0
    || sourceIndex >= columns.length
    || targetIndex >= columns.length
    || sourceIndex === targetIndex
  ) {
    return columns
  }

  const nextColumns = [...columns]
  const [movedColumn] = nextColumns.splice(sourceIndex, 1)
  nextColumns.splice(targetIndex, 0, movedColumn)
  return nextColumns
}

function findSummaryLayoutInsertionIndex(
  clientX: number,
  dragState: SummaryLayoutDragState,
): number {
  if (dragState.columnSnapshots.length <= 1) {
    return dragState.sourceIndex
  }

  const dragDeltaX = clientX - dragState.startClientX
  const draggedSnapshot = dragState.columnSnapshots[dragState.sourceIndex]
  if (!draggedSnapshot) {
    return dragState.sourceIndex
  }

  const draggedCenterX = draggedSnapshot.centerX + dragDeltaX

  let insertionIndex = 0
  for (const [index, snapshot] of dragState.columnSnapshots.entries()) {
    if (index === dragState.sourceIndex) {
      continue
    }

    if (draggedCenterX > snapshot.centerX) {
      insertionIndex += 1
    }
  }

  return Math.min(Math.max(insertionIndex, 0), dragState.columnSnapshots.length - 1)
}

function buildSummaryLayoutDragTransforms(
  columns: SummaryLayoutColumn[],
  dragState: SummaryLayoutDragState | null,
): Map<string, number> {
  const transforms = new Map<string, number>()
  if (!dragState || columns.length === 0) {
    return transforms
  }

  const snapshotById = new Map(
    dragState.columnSnapshots.map((snapshot) => [snapshot.columnId, snapshot]),
  )
  if (snapshotById.size !== columns.length) {
    transforms.set(dragState.columnId, dragState.latestClientX - dragState.startClientX)
    return transforms
  }

  const slotGaps = dragState.columnSnapshots.map((snapshot, index) => {
    const nextSnapshot = dragState.columnSnapshots[index + 1]
    if (!nextSnapshot) {
      return 0
    }

    return nextSnapshot.left - (snapshot.left + snapshot.width)
  })

  const previewColumns = moveSummaryLayoutColumn(
    columns,
    dragState.sourceIndex,
    dragState.insertionIndex,
  )
  const previewLeftById = new Map<string, number>()
  let nextLeft = dragState.columnSnapshots[0]?.left ?? 0
  previewColumns.forEach((column, index) => {
    const snapshot = snapshotById.get(column.id)
    if (!snapshot) {
      return
    }

    previewLeftById.set(column.id, nextLeft)
    nextLeft += snapshot.width + (slotGaps[index] ?? 0)
  })

  columns.forEach((column) => {
    if (column.id === dragState.columnId) {
      transforms.set(column.id, dragState.latestClientX - dragState.startClientX)
      return
    }

    const snapshot = snapshotById.get(column.id)
    const previewLeft = previewLeftById.get(column.id)
    if (!snapshot || previewLeft === undefined) {
      return
    }

    transforms.set(column.id, previewLeft - snapshot.left)
  })

  return transforms
}

function buildSummaryLayoutColumnTransform(offsetX: number, isDragging: boolean): string | undefined {
  if (Math.abs(offsetX) <= 0.01 && !isDragging) {
    return undefined
  }

  const baseTransform = `translateX(${offsetX}px)`
  return isDragging
    ? `${baseTransform} translateY(-2px) rotate(-1deg)`
    : baseTransform
}

function buildNextSummaryLayoutPresetName(
  baseName: string,
  presets: SummaryLayoutPreset[],
): string {
  const trimmedBaseName = baseName.trim() || 'New Preset'
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

function buildComparableReportingDisplayPreset(
  preset: ReportingDisplayPreset,
  name: string,
) {
  return {
    name,
    density: preset.density,
    rowLabelMode: preset.rowLabelMode,
    showCodes: preset.showCodes,
    showClient: preset.showClient,
    showEngagementType: preset.showEngagementType,
    showEmptyDays: preset.showEmptyDays,
    columns: resolveReportingDisplayColumns(preset),
  }
}

function areReportingDisplayPresetDraftsEqual(
  savedPreset: ReportingDisplayPreset,
  savedName: string,
  draftPreset: ReportingDisplayPreset,
  draftName: string,
): boolean {
  return JSON.stringify(buildComparableReportingDisplayPreset(savedPreset, savedName))
    === JSON.stringify(buildComparableReportingDisplayPreset(draftPreset, draftName))
}

function collectReportingDisplayColumnRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>()
  if (typeof document === 'undefined') {
    return rects
  }

  const columnCounts = new Map<string, number>()
  document
    .querySelectorAll<HTMLElement>('.reporting-v2-preset-modal [data-reporting-display-column-id]')
    .forEach((element) => {
      const columnId = element.dataset.reportingDisplayColumnId
      if (!columnId) {
        return
      }

      const surface = getReportingDisplayElementSurface(element)
      const columnKey = `${surface}:${columnId}`
      const count = columnCounts.get(columnKey) ?? 0
      columnCounts.set(columnKey, count + 1)
      rects.set(`${columnKey}:${count}`, element.getBoundingClientRect())
    })

  return rects
}

function animateReportingDisplayColumnRects(previousRects: Map<string, DOMRect>): void {
  if (previousRects.size === 0 || typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }

  const columnCounts = new Map<string, number>()
  document
    .querySelectorAll<HTMLElement>('.reporting-v2-preset-modal [data-reporting-display-column-id]')
    .forEach((element) => {
      const columnId = element.dataset.reportingDisplayColumnId
      if (!columnId) {
        return
      }

      if (element.classList.contains('is-dragging')) {
        return
      }

      const surface = getReportingDisplayElementSurface(element)
      const columnKey = `${surface}:${columnId}`
      const count = columnCounts.get(columnKey) ?? 0
      columnCounts.set(columnKey, count + 1)
      const previousRect = previousRects.get(`${columnKey}:${count}`)
      if (!previousRect) {
        return
      }

      const nextRect = element.getBoundingClientRect()
      const deltaX = previousRect.left - nextRect.left
      const deltaY = previousRect.top - nextRect.top
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        return
      }

      element.style.transition = 'none'
      element.style.transform = `translate(${deltaX}px, ${deltaY}px)`
      element.style.zIndex = '4'

      window.requestAnimationFrame(() => {
        element.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
        element.style.transform = ''
        window.setTimeout(() => {
          element.style.transition = ''
          element.style.transform = ''
          element.style.zIndex = ''
        }, 210)
      })
    })
}

function getReportingDisplayElementSurface(element: HTMLElement): ReportingDisplayDragSurface {
  return element.classList.contains('reporting-v2-column-row') ? 'list' : 'table'
}

function getFirstReportingDisplayColumnElement(
  columnId: string,
  surface: ReportingDisplayDragSurface,
): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  const elements = document.querySelectorAll<HTMLElement>(
    '.reporting-v2-preset-modal [data-reporting-display-column-id]',
  )
  for (const element of elements) {
    if (
      element.dataset.reportingDisplayColumnId === columnId
      && getReportingDisplayElementSurface(element) === surface
    ) {
      return element
    }
  }

  return null
}

interface ReportingTableViewProps {
  summary: TimelineWeeklySummary | null
  preset: ReportingDisplayPreset | undefined
  dayIndexes: number[]
  engagementById: Map<string, Engagement>
  activityById: Map<string, Activity>
  timelineTotalPreferences: TimelineTotalPreferences
  displayedWeekTotalBreakdown: TimelineTotalBreakdown | null
  isLoading?: boolean
  rowsLimit?: number
  isPreview?: boolean
  draggedColumnId?: string | null
  dragPreview?: ReportingDisplayDragPreview | null
  onOpenNotes?: (rowIndex: number, dayIndex: number) => void
  onColumnPointerDown?: (event: ReactPointerEvent<HTMLElement>, columnId: string) => void
}

function ReportingColumnReorderIcon() {
  return (
    <svg
      className="reporting-v2-reorder-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fillRule="evenodd"
        d="M1 11.5a.5.5 0 0 0 .5.5h11.793l-3.147 3.146a.5.5 0 0 0 .708.708l4-4a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 11H1.5a.5.5 0 0 0-.5.5m14-7a.5.5 0 0 1-.5.5H2.707l3.147 3.146a.5.5 0 1 1-.708.708l-4-4a.5.5 0 0 1 0-.708l4-4a.5.5 0 1 1 .708.708L2.707 4H14.5a.5.5 0 0 1 .5.5"
      />
    </svg>
  )
}

function ReportingTableView({
  summary,
  preset,
  dayIndexes,
  engagementById,
  activityById,
  timelineTotalPreferences,
  displayedWeekTotalBreakdown,
  isLoading = false,
  rowsLimit,
  isPreview = false,
  draggedColumnId = null,
  dragPreview = null,
  onOpenNotes,
  onColumnPointerDown,
}: ReportingTableViewProps) {
  const columns = resolveReportingDisplayColumns(preset)
  const visibleRows = rowsLimit === undefined
    ? summary?.rows ?? []
    : (summary?.rows ?? []).slice(0, rowsLimit)
  const firstFieldColumnId = columns.find((column) => column.kind === 'field')?.id ?? null
  const gridColumns = buildReportingDisplayGridColumns(columns, dayIndexes)
  const canReorderColumns = Boolean(onColumnPointerDown)
  const getColumnStateClass = (columnId: string): string => [
    draggedColumnId === columnId ? 'is-dragging' : '',
  ].filter(Boolean).join(' ')
  const getColumnDragStyle = (columnId: string): CSSProperties | undefined => {
    if (
      !dragPreview
      || dragPreview.surface !== 'table'
      || dragPreview.columnId !== columnId
    ) {
      return undefined
    }

    return {
      transform: `translate3d(${dragPreview.offsetX}px, 0, 0)`,
      zIndex: 6,
    }
  }

  const renderDragHandle = (column: ReportingDisplayColumn, label: string) => (
    onColumnPointerDown ? (
      <button
        type="button"
        className="reporting-v2-column-handle"
        aria-label={`Reorder ${label}`}
        onPointerDown={(event) => onColumnPointerDown(event, column.id)}
      >
        <ReportingColumnReorderIcon />
      </button>
    ) : null
  )

  return (
    <div
      className={`reporting-v2-table-wrap ${isPreview ? 'is-preview' : ''}`}
      aria-busy={isLoading}
    >
      {isLoading ? (
        <p className="reporting-empty-state">Loading weekly summary...</p>
      ) : summary ? (
        <div
          className="reporting-v2-table"
          role="table"
          aria-label={isPreview ? 'Reporting table view preview' : 'Reporting table view'}
          style={{ '--reporting-v2-grid-columns': gridColumns } as CSSProperties}
        >
          <div className="reporting-v2-row reporting-v2-head" role="row">
            {columns.map((column) => {
              const columnStateClass = getColumnStateClass(column.id)
              const columnDragStyle = getColumnDragStyle(column.id)

              if (column.kind === 'dayGroup') {
                return dayIndexes.map((dayIndex) => {
                  const headerLabel = getSummaryDayShortName(summary, dayIndex)
                  return (
                    <span
                      key={`${column.id}-${dayIndex}`}
                      data-reporting-display-column-id={column.id}
                      className={`reporting-v2-header-cell reporting-v2-day-header ${canReorderColumns ? 'has-handle' : ''} ${columnStateClass}`}
                      role="columnheader"
                      style={columnDragStyle}
                    >
                      {renderDragHandle(column, 'days')}
                      <span>{headerLabel}</span>
                      <small>{formatMonthDay(getSummaryDayDate(summary, dayIndex) ?? summary.weekStartDate)}</small>
                    </span>
                  )
                })
              }

              const label = getReportingDisplayColumnLabel(column)
              return (
                <span
                  key={column.id}
                  data-reporting-display-column-id={column.id}
                  className={`reporting-v2-header-cell ${canReorderColumns ? 'has-handle' : ''} ${columnStateClass}`}
                  role="columnheader"
                  style={columnDragStyle}
                >
                  {renderDragHandle(column, label)}
                  <span>{label}</span>
                </span>
              )
            })}
          </div>

          <div className="reporting-v2-body">
            {visibleRows.length === 0 ? (
              <p className="reporting-empty-state">No time entries for this week.</p>
            ) : (
              visibleRows.map((row, rowIndex) => {
                const rowKey = getSummaryRowKey(row, rowIndex)
                const isExcludedFromReportingTotal =
                  isReportingRowExcludedFromPrimaryTotal(row, timelineTotalPreferences)

                return (
                  <div
                    key={rowKey}
                    className={`reporting-v2-row ${row.isUncategorized ? 'is-uncategorized' : ''}`}
                    role="row"
                  >
                    {columns.map((column) => {
                      const columnDragStyle = getColumnDragStyle(column.id)

                      if (column.kind === 'dayGroup') {
                        return dayIndexes.map((dayIndex) => {
                          const cell = row.cells[dayIndex]
                          const hasHours = Boolean(cell && cell.totalMinutes > 0)
                          const noteLabel = `Open notes for ${formatEntityDisplayLabel(row.activityName, row.activityCode)} on ${getSummaryDayName(summary, dayIndex)}`
                          const columnStateClass = getColumnStateClass(column.id)

                          return (
                            <span
                              key={`${column.id}-${rowKey}-${dayIndex}`}
                              data-reporting-display-column-id={column.id}
                              className={`reporting-v2-cell reporting-v2-day-cell ${columnStateClass}`}
                              role="cell"
                              style={columnDragStyle}
                            >
                              {hasHours && cell ? (
                                onOpenNotes ? (
                                  <button
                                    type="button"
                                    className={`reporting-hours-button ${cell.notes.length > 0 ? 'has-notes' : ''}`}
                                    onClick={() => onOpenNotes(rowIndex, dayIndex)}
                                    aria-label={noteLabel}
                                  >
                                    {formatMinutesAsHours(cell.totalMinutes)}
                                    {cell.notes.length > 0 ? (
                                      <span className="reporting-note-mark" aria-hidden="true" />
                                    ) : null}
                                  </button>
                                ) : (
                                  <span className={`reporting-hours-button is-static ${cell.notes.length > 0 ? 'has-notes' : ''}`}>
                                    {formatMinutesAsHours(cell.totalMinutes)}
                                    {cell.notes.length > 0 ? (
                                      <span className="reporting-note-mark" aria-hidden="true" />
                                    ) : null}
                                  </span>
                                )
                              ) : (
                                <span className="reporting-zero">-</span>
                              )}
                            </span>
                          )
                        })
                      }

                      if (column.kind === 'rowTotal') {
                        const columnStateClass = getColumnStateClass(column.id)
                        return (
                          <strong
                            key={`${column.id}-${rowKey}`}
                            data-reporting-display-column-id={column.id}
                            className={`reporting-v2-cell reporting-v2-total-cell ${columnStateClass}`}
                            role="cell"
                            style={columnDragStyle}
                          >
                            {isExcludedFromReportingTotal
                              ? 'Excluded'
                              : formatMinutesAsHours(row.rowTotalMinutes)}
                          </strong>
                        )
                      }

                      return (
                        <span
                          key={`${column.id}-${rowKey}`}
                          data-reporting-display-column-id={column.id}
                          className={`reporting-v2-cell reporting-v2-field-cell ${getReportingDisplayColumnWrapClass(column)} ${getColumnStateClass(column.id)}`}
                          role="cell"
                          style={columnDragStyle}
                        >
                          {renderReportingDisplayFieldCell(
                            column.fieldKey,
                            row,
                            engagementById,
                            activityById,
                          )}
                        </span>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>

          <div className="reporting-v2-row reporting-v2-foot" role="row">
            {columns.map((column) => {
              const columnDragStyle = getColumnDragStyle(column.id)

              if (column.kind === 'dayGroup') {
                return dayIndexes.map((dayIndex) => (
                  <span
                    key={`${column.id}-total-${dayIndex}`}
                    data-reporting-display-column-id={column.id}
                    className={getColumnStateClass(column.id)}
                    role="cell"
                    style={columnDragStyle}
                  >
                    {formatMinutesAsHours(
                      finalizeTimelineTotalBreakdown(
                        summary.dayTotalBreakdowns[dayIndex],
                        timelineTotalPreferences,
                      ).primaryMinutes,
                    )}
                  </span>
                ))
              }

              if (column.kind === 'rowTotal') {
                return (
                  <strong
                    key={`${column.id}-week-total`}
                    data-reporting-display-column-id={column.id}
                    className={getColumnStateClass(column.id)}
                    role="cell"
                    style={columnDragStyle}
                  >
                    {displayedWeekTotalBreakdown
                      ? formatMinutesAsHours(displayedWeekTotalBreakdown.primaryMinutes)
                      : formatMinutesAsHours(summary.weekTotalMinutes)}
                  </strong>
                )
              }

              return (
                <strong
                  key={`${column.id}-footer`}
                  data-reporting-display-column-id={column.id}
                  className={getColumnStateClass(column.id)}
                  role="cell"
                  style={columnDragStyle}
                >
                  {column.id === firstFieldColumnId ? 'Day Totals' : ''}
                </strong>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="reporting-empty-state">No summary data available.</p>
      )}
    </div>
  )
}

function resolveReportingDisplayColumns(
  preset: ReportingDisplayPreset | null | undefined,
): ReportingDisplayColumn[] {
  const columns = preset?.columns?.length ? preset.columns : buildDefaultReportingDisplayColumns()
  return columns.map((column) => ({ ...column }))
}

function buildReportingDisplayAllDayIndexes(
  summary: TimelineWeeklySummary | null | undefined,
): number[] {
  return summary ? summary.days.map((_, dayIndex) => dayIndex) : []
}

function buildReportingDisplayGridColumns(
  columns: ReportingDisplayColumn[],
  dayIndexes: number[],
): string {
  return columns.flatMap((column) => {
    if (column.kind === 'dayGroup') {
      return dayIndexes.map(() => 'minmax(0, 0.38fr)')
    }

    if (column.kind === 'rowTotal') {
      return ['minmax(0, 0.38fr)']
    }

    switch (column.fieldKey) {
      case 'details':
        return ['minmax(0, 1.55fr)']
      case 'engagement':
      case 'activity':
        return ['minmax(0, 0.92fr)']
      case 'client':
        return ['minmax(0, 0.78fr)']
      case 'engagementCode':
      case 'activityCode':
      case 'engagementType':
        return ['minmax(0, 0.58fr)']
      default:
        return ['minmax(0, 0.88fr)']
    }
  }).join(' ')
}

function getReportingDisplayColumnLabel(column: ReportingDisplayColumn): string {
  if (column.kind === 'dayGroup') {
    return 'Days'
  }

  if (column.kind === 'rowTotal') {
    return 'Total'
  }

  return getReportingDisplayFieldOption(column.fieldKey)?.label ?? 'Field'
}

function getReportingDisplayColumnWrapClass(column: ReportingDisplayColumn): string {
  if (column.kind !== 'field') {
    return ''
  }

  return getReportingDisplayFieldOption(column.fieldKey)?.wraps ? 'wraps' : ''
}

function getReportingDisplayColumnDropTarget(
  clientX: number,
  clientY: number,
): { columnId: string; insertAfterTarget: boolean } | null {
  const targetElement = document.elementFromPoint(clientX, clientY)
  const targetColumnElement = targetElement
    ?.closest<HTMLElement>('[data-reporting-display-column-id]')
  const columnId = targetColumnElement?.dataset.reportingDisplayColumnId
  if (!targetColumnElement || !columnId) {
    return null
  }

  const targetRect = targetColumnElement.getBoundingClientRect()
  const isVerticalTarget = targetColumnElement.classList.contains('reporting-v2-column-row')
  const insertAfterTarget = isVerticalTarget
    ? clientY > targetRect.top + (targetRect.height / 2)
    : clientX > targetRect.left + (targetRect.width / 2)

  return {
    columnId,
    insertAfterTarget,
  }
}

function moveReportingDisplayColumn(
  columns: ReportingDisplayColumn[],
  sourceColumnId: string,
  targetColumnId: string,
  insertAfterTarget: boolean,
): ReportingDisplayColumn[] {
  const sourceIndex = columns.findIndex((column) => column.id === sourceColumnId)
  const targetIndex = columns.findIndex((column) => column.id === targetColumnId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return columns
  }

  const sourceColumn = columns[sourceIndex]
  const next = columns.filter((column) => column.id !== sourceColumnId)
  const nextTargetIndex = next.findIndex((column) => column.id === targetColumnId)
  if (nextTargetIndex < 0) {
    return columns
  }

  const insertionIndex = nextTargetIndex + (insertAfterTarget ? 1 : 0)
  return [
    ...next.slice(0, insertionIndex),
    sourceColumn,
    ...next.slice(insertionIndex),
  ]
}

function renderReportingDisplayFieldCell(
  fieldKey: ReportingDisplayFieldKey,
  row: TimelineWeeklySummary['rows'][number],
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
) {
  const engagement = row.engagementId ? engagementById.get(row.engagementId) : null
  const activity = row.activityId ? activityById.get(row.activityId) : null

  switch (fieldKey) {
    case 'details': {
      const activityLabel = formatEntityPrimaryLabel(
        row.activityName,
        row.activityCode,
        'Uncategorized',
      )
      const engagementLabel = formatEntityPrimaryLabel(
        row.engagementName,
        row.engagementCode,
        'Uncategorized',
      )

      return (
        <span className="reporting-v2-details-cell">
          <strong>{activityLabel}</strong>
          <span>{engagementLabel}</span>
        </span>
      )
    }
    case 'engagement':
      return formatEntityPrimaryLabel(row.engagementName, row.engagementCode, 'Uncategorized')
    case 'activity':
      return formatEntityPrimaryLabel(row.activityName, row.activityCode, 'Uncategorized')
    case 'client':
      return normalizeDisplayText(row.clientName) ?? '-'
    case 'engagementType':
      return row.engagementType ? formatEngagementTypeLabel(row.engagementType) : '-'
    case 'engagementCode':
      return formatSummaryCodeValue(row.engagementCode, row.isUncategorized)
    case 'activityCode':
      return formatSummaryCodeValue(row.activityCode, row.isUncategorized)
    case 'engagementTags':
      return engagement && engagement.tags.length > 0 ? joinTags(engagement.tags) : '-'
    case 'activityTags':
      return activity && activity.tags.length > 0 ? joinTags(activity.tags) : '-'
    case 'engagementUsage':
      return normalizeDisplayText(engagement?.describeWhenToUse) ?? '-'
    case 'activityUsage':
      return normalizeDisplayText(activity?.describeWhenToUse) ?? '-'
    default:
      return '-'
  }
}

export default App
