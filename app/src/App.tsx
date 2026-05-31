import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
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
  settingsGetStatus,
  settingsSetCalendarBulkModel,
  settingsSetCalendarBulkPreferences,
  settingsSetOpenAiKey,
  settingsSetOpenAiModel,
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
import { isTauriRuntime } from './lib/runtime'
import { QUICK_ADD_SUBMITTED_EVENT } from './lib/events'
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
  MicrophonePermissionStatus,
  OpenAiModelId,
  SettingsStatus,
  SummaryLayoutColumn,
  SummaryLayoutFieldKey,
  SummaryLayoutPreset,
  SummaryLayoutState,
  TimelineDaySummary,
  TimelineEntry,
  TimelineWeekView,
  TimelineWeeklySummary,
  TimelineWeeklySummaryNote,
  TranscriptionModelId,
  WarningType,
} from './lib/types'
import deleteIcon from './assets/icons/delete.svg'
import editIcon from './assets/icons/edit.svg'
import calendarIcon from './assets/icons/calendar.svg'
import microphoneIcon from './assets/icons/microphone.svg'
import './App.css'

type View = 'timeline' | 'week' | 'codes' | 'settings' | 'diagnostics' | 'summary'
type DiagnosticsFilter = 'all' | 'errors' | 'warnings' | 'capture' | 'settings'
type MonthSummaryCache = Record<string, TimelineDaySummary[]>
type CodeEditorSurface =
  | 'create-engagement'
  | 'edit-engagement'
  | 'create-activity'
  | 'edit-activity'
type TimelineSurface = 'day' | 'week'

type SubmissionQueueItemState = 'pending' | 'running' | 'success' | 'error'

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
  timezone: string
  state: SubmissionQueueItemState
  statusMessage: string
  correlationId?: string
  createdEntryCount?: number
  completedAtMs?: number
  completedDurationMs?: number
  modelUsed?: OpenAiModelId
  modelUsedLabel?: string
  transcriptionModelUsed?: TranscriptionModelId
  transcriptionModelUsedLabel?: string
  transcriptionDurationMs?: number
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

type CalendarBulkTab = 'submission' | 'review'
type CalendarCandidateReviewState = 'pending' | 'accepted' | 'rejected' | 'ignored'

interface CalendarReviewCandidate extends CalendarExtractCandidate {
  reviewState: CalendarCandidateReviewState
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

interface TimelineTotalBreakdown {
  primaryMinutes: number
  categorizedMinutes: number
  uncategorizedMinutes: number
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

type TimelineContextMenuKind = 'entry' | 'empty'

type TimelineContextMenuState =
  | {
    kind: 'entry'
    entryId: string
    createDate: string
    createStartMinute: number
    x: number
    y: number
  }
  | {
    kind: 'empty'
    createDate: string
    createStartMinute: number
    x: number
    y: number
  }

interface TimelineDragState {
  surface: TimelineSurface
  entryId: string
  pointerId: number
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

function getDefaultActivityEngagementId(engagements: Engagement[]): string {
  return engagements[0]?.id ?? ''
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
const WEEK_TIMELINE_HEADER_HEIGHT = 64
const WEEK_TIMELINE_GUTTER_LEFT = 68
const WEEK_TIMELINE_DAY_WIDTH = 176
const COMPACT_WEEK_TIMELINE_GUTTER_LEFT = 58
const COMPACT_WEEK_TIMELINE_DAY_WIDTH = 154
const WEEK_TIMELINE_COMPACT_MEDIA_QUERY = '(max-width: 720px)'
const FULL_DAY_TIMELINE_WINDOW: TimelineWindow = {
  startMinute: 0,
  endMinute: MINUTES_IN_DAY,
}
const END_OF_DAY_INPUT_SENTINEL = '23:59'
const MAX_CONCURRENT_SUBMISSIONS = 5
const MAX_FINISHED_QUEUE_HISTORY = 10
const CALENDAR_REVIEW_LOW_CONFIDENCE_THRESHOLD = 0.75
const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5-nano'
const DEFAULT_CALENDAR_BULK_MODEL: OpenAiModelId = 'gpt-5.4'
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
const SEGMENTED_VIEWS: Array<{ id: View; label: string }> = [
  { id: 'timeline', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'codes', label: 'Codes' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'summary', label: 'Summary View' },
]
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
const SUMMARY_DAY_NAMES = [
  'Saturday',
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
] as const
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
  const todayDate = useMemo(() => formatDate(new Date()), [])

  const [activeView, setActiveView] = useState<View>('timeline')
  const [isBusy, setIsBusy] = useState(false)
  const [isTimelineLoading, setIsTimelineLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [openAiKey, setOpenAiKey] = useState('')
  const [selectedOpenAiModelDraft, setSelectedOpenAiModelDraft] =
    useState<OpenAiModelId>(DEFAULT_OPENAI_MODEL)
  const [selectedCalendarBulkModelDraft, setSelectedCalendarBulkModelDraft] =
    useState<OpenAiModelId>(DEFAULT_CALENDAR_BULK_MODEL)
  const [selectedTranscriptionModelDraft, setSelectedTranscriptionModelDraft] =
    useState<TranscriptionModelId>(DEFAULT_TRANSCRIPTION_MODEL)

  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [codeEditorSurface, setCodeEditorSurface] = useState<CodeEditorSurface | null>(null)
  const [editorActivationKey, setEditorActivationKey] = useState(0)
  const [expandedEngagementId, setExpandedEngagementId] = useState<string | null>(null)
  const [engagementForm, setEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [activityForm, setActivityForm] = useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)

  const [captureMessage, setCaptureMessage] = useState('')
  const [captureDraftMetadata, setCaptureDraftMetadata] = useState<VoiceDraftMetadata | null>(null)
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle')
  const [voiceCaptureStatusMessage, setVoiceCaptureStatusMessage] = useState<string | null>(null)
  const [submissionQueue, setSubmissionQueue] = useState<SubmissionQueueItem[]>([])
  const [isSubmissionQueueOpen, setIsSubmissionQueueOpen] = useState(false)
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
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null)
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
  const [monthSummaryLoadingMonth, setMonthSummaryLoadingMonth] = useState<string | null>(null)
  const [monthSummaryError, setMonthSummaryError] = useState<string | null>(null)
  const codeFormsBodyRef = useRef<HTMLDivElement | null>(null)
  const engagementNameInputRef = useRef<HTMLInputElement | null>(null)
  const activityEngagementSelectRef = useRef<HTMLSelectElement | null>(null)
  const timelineGridRef = useRef<HTMLDivElement | null>(null)
  const weekTimelineGridRef = useRef<HTMLDivElement | null>(null)
  const timelineContextMenuRef = useRef<HTMLDivElement | null>(null)
  const calendarFileInputRef = useRef<HTMLInputElement | null>(null)
  const calendarDropZoneRef = useRef<HTMLDivElement | null>(null)
  const hasInitializedRef = useRef(false)
  const lastLoadedTimelineDateRef = useRef<string | null>(null)
  const pendingAutoCenterDateRef = useRef<string | null>(todayDate)
  const selectedDateRef = useRef(selectedDate)
  const timelineDragStateRef = useRef<TimelineDragState | null>(null)
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
  const visibleMonthSummaryError = monthSummaryCache[visibleMonth] ? null : monthSummaryError
  const hasVisibleMonthSummary = monthSummaryCache[visibleMonth] !== undefined
  const summaryWeekHighlightedDates = useMemo(() => {
    if (activeView !== 'summary' || !weeklySummary) {
      return new Set<string>()
    }

    return new Set(weeklySummary.days.map((day) => day.date))
  }, [activeView, weeklySummary])
  const weekViewHighlightedDates = useMemo(() => {
    if (activeView !== 'week' || !weekTimeline) {
      return new Set<string>()
    }

    return new Set(weekTimeline.days.map((day) => day.date))
  }, [activeView, weekTimeline])
  const miniCalendarHighlightedDates = useMemo(
    () => (activeView === 'week' ? weekViewHighlightedDates : summaryWeekHighlightedDates),
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
  const summaryViewColumns = useMemo(
    () => buildSummaryViewColumns(selectedSummaryLayoutPreset),
    [selectedSummaryLayoutPreset],
  )
  const summaryFooterLabelIndex = useMemo(
    () => summaryViewColumns.findIndex((column) => column.kind !== 'day' && column.kind !== 'rowTotal'),
    [summaryViewColumns],
  )
  const summaryLayoutPreviewRows = useMemo(
    () => weeklySummary?.rows.slice(0, 3) ?? [],
    [weeklySummary],
  )
  const summaryLayoutDragTransforms = useMemo(
    () => buildSummaryLayoutDragTransforms(
      summaryLayoutDraft?.columns ?? [],
      summaryLayoutDragState,
    ),
    [summaryLayoutDraft, summaryLayoutDragState],
  )
  const activeSummaryLayoutDragPointerId = summaryLayoutDragState?.pointerId ?? null
  const submissionQueueDisplayItems = useMemo(() => {
    const processing = submissionQueue.filter((item) => item.state === 'running')
    const pending = submissionQueue.filter((item) => item.state === 'pending')
    const finished = submissionQueue
      .filter((item) => item.state === 'success' || item.state === 'error')
      .sort(
        (left, right) =>
          (right.completedAtMs ?? right.submittedAtMs) - (left.completedAtMs ?? left.submittedAtMs),
      )

    return [...processing, ...pending, ...finished]
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
    timezone,
    captureSource,
    transcriptionModelUsed,
    transcriptionModelUsedLabel,
    transcriptionDurationMs,
  }: {
    rawText: string
    submittedAtMs: number
    clientTimestampIso: string
    clientLocalDate: string
    clientLocalTime: string
    clientUtcOffsetMinutes: number
    timezone: string
    captureSource: CaptureSourceId
    transcriptionModelUsed?: TranscriptionModelId
    transcriptionModelUsedLabel?: string
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
      timezone,
      state: 'pending',
      statusMessage: 'Queued for processing.',
      transcriptionModelUsed,
      transcriptionModelUsedLabel,
      transcriptionDurationMs,
    }

    setSubmissionQueue((previous) => [...previous, queueItem])
    setIsSubmissionQueueOpen(true)
  }, [settingsStatus])

  const timelineExcludeUncategorizedFromDailyTotals =
    settingsStatus?.timelineExcludeUncategorizedFromDailyTotals ?? true
  const timelineShowUncategorizedDailyTotal =
    settingsStatus?.timelineShowUncategorizedDailyTotal ?? true
  const shouldShowTimelineUncategorizedDailyTotal =
    timelineExcludeUncategorizedFromDailyTotals && timelineShowUncategorizedDailyTotal

  const timelineWindow = FULL_DAY_TIMELINE_WINDOW
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
  const timelineEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(timelineEntries, timelineDragState),
    [timelineDragState, timelineEntries],
  )
  const timelineDayTotalBreakdown = useMemo(
    () => buildTimelineTotalBreakdown(
      timelineEntriesForLayout,
      timelineExcludeUncategorizedFromDailyTotals,
    ),
    [timelineEntriesForLayout, timelineExcludeUncategorizedFromDailyTotals],
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
    if (!timelineDragState?.isDragging) {
      return null
    }

    return baselinePositionedTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === timelineDragState.entryId,
    ) ?? null
  }, [baselinePositionedTimelineEntries, timelineDragState])
  const weekTimelineDays = useMemo(
    () => weekTimeline?.days ?? buildWeekViewDays(selectedDate),
    [selectedDate, weekTimeline],
  )
  const weekTimelineEntries = useMemo(
    () => weekTimeline?.entries ?? [],
    [weekTimeline],
  )
  const weekTimelineEntriesForLayout = useMemo(
    () => applyDragPreviewToTimelineEntries(weekTimelineEntries, timelineDragState),
    [timelineDragState, weekTimelineEntries],
  )
  const weekTimelineDayTotalBreakdowns = useMemo(
    () => buildTimelineDayTotalBreakdowns(
      weekTimelineEntriesForLayout,
      weekTimelineDays,
      timelineExcludeUncategorizedFromDailyTotals,
    ),
    [
      timelineExcludeUncategorizedFromDailyTotals,
      weekTimelineDays,
      weekTimelineEntriesForLayout,
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
    if (!timelineDragState?.isDragging) {
      return null
    }

    return baselinePositionedWeekTimelineEntries.find(
      (positionedEntry) => positionedEntry.entry.id === timelineDragState.entryId,
    ) ?? null
  }, [baselinePositionedWeekTimelineEntries, timelineDragState])

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

  const calendarVisibleCandidates = useMemo(
    () => calendarReviewCandidates.filter((candidate) => candidate.reviewState === 'pending'),
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
  const positionedCalendarReviewEntries = useMemo(
    () => positionTimelineEntries(calendarReviewTimelineEntries, timelineWindow),
    [calendarReviewTimelineEntries, timelineWindow],
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
  const calendarReadyToSaveCandidates = useMemo(
    () =>
      calendarVisibleCandidates.filter((candidate) => !hasCalendarCandidateBlockingIssue(candidate)),
    [calendarVisibleCandidates],
  )

  const selectedActivityEngagement = useMemo(
    () => engagements.find((engagement) => engagement.id === activityForm.engagementId) ?? null,
    [activityForm.engagementId, engagements],
  )
  const isEngagementEditorOpen =
    codeEditorSurface === 'create-engagement' || codeEditorSurface === 'edit-engagement'
  const isActivityEditorOpen =
    codeEditorSurface === 'create-activity' || codeEditorSurface === 'edit-activity'
  const isEditingEngagement = codeEditorSurface === 'edit-engagement'
  const isEditingActivity = codeEditorSurface === 'edit-activity'
  const canCreateActivity = engagements.length > 0

  const engagementFormColorValue = normalizeColorHexInput(engagementForm.colorHex)
  const activityFormColorValue = normalizeColorHexInput(activityForm.colorHex)
  const selectedEngagementColorValue = normalizeColorHexInput(selectedActivityEngagement?.colorHex)

  useEffect(() => {
    if (!expandedEngagementId) {
      return
    }

    const isExpandedEngagementPresent = engagements.some(
      (engagement) => engagement.id === expandedEngagementId,
    )
    if (!isExpandedEngagementPresent) {
      setExpandedEngagementId(null)
    }
  }, [engagements, expandedEngagementId])

  const openCreateEngagementEditor = useCallback(() => {
    setEngagementForm(EMPTY_ENGAGEMENT_FORM)
    setCodeEditorSurface('create-engagement')
    setEditorActivationKey((previous) => previous + 1)
  }, [])

  const openCreateActivityEditor = useCallback(() => {
    if (engagements.length === 0) {
      return
    }

    setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
    setCodeEditorSurface('create-activity')
    setEditorActivationKey((previous) => previous + 1)
  }, [engagements])

  const closeCodeEditor = useCallback(() => {
    if (isEngagementEditorOpen) {
      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
    }

    if (isActivityEditorOpen) {
      setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
    }

    setCodeEditorSurface(null)
  }, [engagements, isActivityEditorOpen, isEngagementEditorOpen])

  const toggleEngagementEditor = useCallback(() => {
    if (isEngagementEditorOpen) {
      closeCodeEditor()
      return
    }

    openCreateEngagementEditor()
  }, [closeCodeEditor, isEngagementEditorOpen, openCreateEngagementEditor])

  const toggleActivityEditor = useCallback(() => {
    if (isActivityEditorOpen) {
      closeCodeEditor()
      return
    }

    openCreateActivityEditor()
  }, [closeCodeEditor, isActivityEditorOpen, openCreateActivityEditor])

  useEffect(() => {
    if (!codeEditorSurface) {
      return
    }

    if (codeFormsBodyRef.current) {
      codeFormsBodyRef.current.scrollTop = 0
    }

    const targetInput = isActivityEditorOpen
      ? activityEngagementSelectRef.current
      : engagementNameInputRef.current

    if (!targetInput) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      targetInput.focus()
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [codeEditorSurface, editorActivationKey, isActivityEditorOpen])

  useEffect(() => {
    if (isEditingEngagement && engagementForm.id) {
      const engagementStillExists = engagements.some((engagement) => engagement.id === engagementForm.id)
      if (!engagementStillExists) {
        setEngagementForm(EMPTY_ENGAGEMENT_FORM)
        setCodeEditorSurface(null)
      }
      return
    }

    if (!isActivityEditorOpen) {
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

    if (isEditingActivity && activityForm.id) {
      const activityStillExists = engagements.some((engagement) =>
        engagement.activities.some((activity) => activity.id === activityForm.id),
      )

      if (!activityStillExists || !hasSelectedEngagement) {
        setActivityForm(buildEmptyActivityForm(getDefaultActivityEngagementId(engagements)))
        setCodeEditorSurface(null)
      }

      return
    }

    if (!hasSelectedEngagement) {
      const defaultEngagementId = getDefaultActivityEngagementId(engagements)
      setActivityForm((previous) => (
        previous.engagementId === defaultEngagementId
          ? previous
          : {
              ...previous,
              engagementId: defaultEngagementId,
            }
      ))
    }
  }, [
    activityForm.engagementId,
    activityForm.id,
    codeEditorSurface,
    engagementForm.id,
    engagements,
    isActivityEditorOpen,
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
    return rows
  }, [])

  const loadWeeklySummary = useCallback(async (date: string) => {
    const summary = await timelineWeeklySummary({ date })
    setWeeklySummary(summary)
    return summary
  }, [])

  const invalidateMonthSummaries = useCallback((monthKeys: string[]) => {
    setMonthSummaryCache((previous) => {
      let changed = false
      const next = { ...previous }

      for (const monthKey of monthKeys) {
        if (next[monthKey]) {
          delete next[monthKey]
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
    tauriRuntime,
  ])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    const initialize = async () => {
      try {
        setIsBusy(true)
        await Promise.all([
          loadEngagements(),
          loadSettings(),
          loadSummaryLayoutState(),
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
    loadSettings,
    loadSummaryLayoutState,
    loadTimeline,
    tauriRuntime,
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
    if (!tauriRuntime || !hasInitializedRef.current) {
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
  }, [loadTimeline, selectedDate, tauriRuntime])

  useEffect(() => () => {
    if (calendarImagePreviewUrl) {
      URL.revokeObjectURL(calendarImagePreviewUrl)
    }
  }, [calendarImagePreviewUrl])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    if (hasVisibleMonthSummary) {
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
  }, [hasVisibleMonthSummary, loadTimelineMonthSummary, tauriRuntime, visibleMonth])

  useEffect(() => {
    if (selectedEntryId && loadedTimelineEntries.every((entry) => entry.id !== selectedEntryId)) {
      setSelectedEntryId(null)
      setEntryDraft(null)
    }

    if (
      timelineContextMenu
      && timelineContextMenu.kind === 'entry'
      && timelineContextMenu.entryId
      && loadedTimelineEntries.every((entry) => entry.id !== timelineContextMenu.entryId)
    ) {
      setTimelineContextMenu(null)
    }
  }, [loadedTimelineEntries, selectedEntryId, timelineContextMenu])

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
    if (!tauriRuntime || activeView !== 'diagnostics') {
      return
    }

    void loadDiagnostics(diagnosticsFilter)
  }, [activeView, diagnosticsFilter, loadDiagnostics, tauriRuntime])

  useEffect(() => {
    if (!tauriRuntime || !hasInitializedRef.current || activeView !== 'week') {
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
  }, [activeView, loadWeekTimeline, selectedDate, tauriRuntime])

  useEffect(() => {
    if (!tauriRuntime || !hasInitializedRef.current || activeView !== 'summary') {
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
  }, [activeView, loadWeeklySummary, selectedDate, tauriRuntime])

  useEffect(() => {
    if (activeView !== 'timeline' && activeView !== 'week' && timelineContextMenu) {
      setTimelineContextMenu(null)
    }
  }, [activeView, timelineContextMenu])

  useEffect(() => {
    if (activeView !== 'summary' && summaryNotesModal) {
      setSummaryNotesModal(null)
    }
  }, [activeView, summaryNotesModal])

  useEffect(() => {
    if (activeView !== 'summary' && summaryLayoutModal) {
      resetSummaryLayoutEditor()
    }
  }, [activeView, resetSummaryLayoutEditor, summaryLayoutModal])

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

  useEffect(() => () => {
    if (summaryLayoutDropCommitFrameRef.current !== null) {
      window.cancelAnimationFrame(summaryLayoutDropCommitFrameRef.current)
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
      const maxScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight)
      const clampedScrollTop = Math.min(Math.max(0, targetTop), maxScrollTop)

      grid.scrollTo({
        top: clampedScrollTop,
        behavior: 'auto',
      })
      pendingAutoCenterDateRef.current = null
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeView, baselinePositionedTimelineEntries, selectedDate])

  useEffect(() => {
    if (!successMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null)
    }, 5000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [successMessage])

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([
      loadEngagements(),
      loadTimeline(selectedDate),
      loadWeekTimeline(selectedDate),
      loadSettings(),
      loadWeeklySummary(selectedDate),
    ])
  }, [loadEngagements, loadSettings, loadTimeline, loadWeekTimeline, loadWeeklySummary, selectedDate])

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

  const clearTimelineSelection = useCallback(() => {
    setSelectedEntryId(null)
    setEntryDraft(null)
    setTimelineContextMenu(null)
    setTimelineDragStateWithRef(() => null)
  }, [setTimelineDragStateWithRef])

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

      setIsBusy(true)
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
      setEntryDraft((previous) =>
        previous && previous.id === draggedEntry.id
          ? {
              ...previous,
              date: refreshDate,
              startTime: minuteToTimeInput(nextStartMinute),
              endTime: nextDraftEndState.endTime,
              preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
            }
          : previous,
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
          setEntryDraft(previousEntryDraft)
          setErrorMessage(formatActionErrorMessage(error))
          setIsBusy(false)
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
          setIsBusy(false)
        }
      })()
    },
    [
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

  const trimSubmissionQueue = useCallback((items: SubmissionQueueItem[]) => {
    const activeItems = items.filter((item) => item.state === 'pending' || item.state === 'running')
    const recentFinishedItems = items
      .filter((item) => item.state === 'success' || item.state === 'error')
      .sort(
        (left, right) =>
          (right.completedAtMs ?? right.submittedAtMs) - (left.completedAtMs ?? left.submittedAtMs),
      )
      .slice(0, MAX_FINISHED_QUEUE_HISTORY)

    return [...activeItems, ...recentFinishedItems]
  }, [])

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
          timezone: item.timezone,
          captureSource: item.captureSource,
          transcriptionModel: item.transcriptionModelUsed,
          transcriptionDurationMs: item.transcriptionDurationMs,
        })

        const completedAt = Date.now()
        const completedDurationMs = completedAt - item.submittedAtMs
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'success',
                    statusMessage: formatSubmissionQueueSuccessMessage(
                      result.createdEntryIds.length,
                      new Date(completedAt),
                    ),
                    correlationId: result.correlationId,
                    createdEntryCount: result.createdEntryIds.length,
                    completedAtMs: completedAt,
                    completedDurationMs,
                    modelUsed: result.modelUsed,
                    modelUsedLabel: result.modelUsedLabel,
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
        ])
      } catch (error) {
        const completedAt = Date.now()
        const correlationId = isAppCommandError(error) ? error.correlationId : undefined
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    state: 'error',
                    statusMessage: extractErrorMessage(error),
                    correlationId,
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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        state: 'running',
        statusMessage: 'Transcribing audio note...',
      }
      queueItemId = queueItem.id
      setSubmissionQueue((previous) => [...previous, queueItem])
      setIsSubmissionQueueOpen(true)

      const transcription = await transcribeRecordedVoiceBlob(recording)
      setSubmissionQueue((previous) =>
        previous.map((candidate) =>
          candidate.id === queueItem.id
            ? {
              ...candidate,
              rawText: transcription.transcriptText,
              state: 'pending',
              statusMessage: 'Queued for processing.',
              transcriptionModelUsed: transcription.transcriptionModelUsed,
              transcriptionModelUsedLabel: transcription.transcriptionModelUsedLabel,
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
      const correlationId = isAppCommandError(error) ? error.correlationId : undefined
      if (queueItemId) {
        const completedAt = Date.now()
        setSubmissionQueue((previous) =>
          trimSubmissionQueue(
            previous.map((candidate) =>
              candidate.id === queueItemId
                ? {
                  ...candidate,
                  state: 'error',
                  statusMessage: extractErrorMessage(error),
                  correlationId,
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

      const grid = current.surface === 'week' ? weekTimelineGridRef.current : timelineGridRef.current
      if (!grid) {
        return
      }

      if (
        !current.isDragging
        && Math.abs(event.clientY - current.initialClientY) < TIMELINE_DRAG_ACTIVATION_PX
      ) {
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
          && previous.previewDate === pointerSlot.date
          && previous.previewStartMinute === clampedStartMinute
          && previous.previewEndMinute === nextEndMinute
        ) {
          return previous
        }

        return {
          ...previous,
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
              statusMessage: 'Your message is sent and is being processed.',
            }
          : item,
      ),
    )

    for (const pendingItem of pendingItems) {
      inFlightSubmissionIdsRef.current.add(pendingItem.id)
      void processSubmissionQueueItem(pendingItem)
    }
  }, [processSubmissionQueueItem, submissionQueue])

  const openCalendarBulkModal = () => {
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
  }, [calendarImagePreviewUrl])

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
    if (!selectedCalendarCandidate || selectedCalendarCandidateHasBlockingIssue || calendarIsImporting) {
      return
    }

    const candidateToSave = selectedCalendarCandidate
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
      ])
      setCalendarReviewCandidates((previous) =>
        previous.map((candidate) =>
          candidate.id === candidateToSave.id
            ? { ...candidate, reviewState: 'accepted' }
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
      ])
      setCalendarReviewCandidates((previous) =>
        previous.map((candidate) =>
          candidateIdsToSave.has(candidate.id)
            ? { ...candidate, reviewState: 'accepted' }
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

    const candidateToDelete = selectedCalendarCandidate
    const nextCandidateId = resolveNextCalendarCandidateId(candidateToDelete.id)
    updateCalendarCandidate(candidateToDelete.id, (candidate) => ({
      ...candidate,
      reviewState: 'rejected',
    }))
    setSelectedCalendarCandidateId(nextCandidateId)
    setCalendarUploadStatusMessage('Deleted staged calendar event.')
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
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      captureSource: captureDraftMetadata?.captureSource ?? 'text',
      transcriptionModelUsed: captureDraftMetadata?.transcriptionModelUsed,
      transcriptionModelUsedLabel: captureDraftMetadata?.transcriptionModelUsedLabel,
      transcriptionDurationMs: captureDraftMetadata?.transcriptionDurationMs,
    })
    setCaptureDraftMetadata(null)
    setVoiceCaptureStatusMessage(null)
  }

  const onSubmitEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const isEditing = codeEditorSurface === 'edit-engagement'

    void runAction(async () => {
      const describeWhenToUse = engagementForm.describeWhenToUse.trim()
      if (describeWhenToUse.length === 0) {
        throw new Error('"Describe when to use" is required for matching.')
      }

      const colorHex = normalizeColorHexInput(engagementForm.colorHex)
      if (engagementForm.colorHex.trim().length > 0 && !colorHex) {
        throw new Error('Engagement color must be a valid #RRGGBB value.')
      }

      await engagementUpsert({
        id: engagementForm.id,
        code: engagementForm.code.trim() || null,
        name: engagementForm.name,
        client: engagementForm.client || null,
        colorHex,
        describeWhenToUse,
        tags: parseTagInput(engagementForm.tags),
        isActive: engagementForm.isActive,
      })

      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
      await refreshAfterMutation()
      if (isEditing) {
        setCodeEditorSurface(null)
      } else {
        setCodeEditorSurface('create-engagement')
        setEditorActivationKey((previous) => previous + 1)
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
    setExpandedEngagementId(engagement.id)
    setCodeEditorSurface('edit-engagement')
    setEngagementForm({
      id: engagement.id,
      code: engagement.code ?? '',
      name: engagement.name,
      client: engagement.client ?? '',
      colorHex: engagement.colorHex ?? '',
      describeWhenToUse: engagement.describeWhenToUse ?? '',
      tags: joinTags(engagement.tags),
      isActive: engagement.isActive,
    })
    setEditorActivationKey((previous) => previous + 1)
  }

  const onSubmitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const isEditing = codeEditorSurface === 'edit-activity'
    const nextEngagementId =
      activityForm.engagementId || getDefaultActivityEngagementId(engagements)

    void runAction(async () => {
      const describeWhenToUse = activityForm.describeWhenToUse.trim()
      if (describeWhenToUse.length === 0) {
        throw new Error('"Describe when to use" is required for matching.')
      }

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
      if (isEditing) {
        setCodeEditorSurface(null)
      } else {
        setCodeEditorSurface('create-activity')
        setEditorActivationKey((previous) => previous + 1)
      }
      setSuccessMessage('Activity saved.')
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
    setExpandedEngagementId(activity.engagementId)
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
    setEditorActivationKey((previous) => previous + 1)
  }

  const onSetDate = (nextDate: string) => {
    updateSelectedDate(nextDate)
  }

  const onJumpToToday = () => {
    onSetDate(formatDate(new Date()))
  }

  const onJumpToThisWeek = () => {
    updateSelectedDate(formatDate(new Date()))
  }

  const onSelectCalendarDate = (nextDate: string) => {
    onSetDate(nextDate)
  }

  const onSelectEntry = (
    entry: TimelineEntry,
    options?: {
      syncSelectedDate?: boolean
    },
  ) => {
    setTimelineContextMenu(null)
    if (options?.syncSelectedDate) {
      updateSelectedDate(entry.date, { clearSelection: false })
    }
    setSelectedEntryId(entry.id)
    setEntryDraft(buildEntryDraft(entry))
  }

  const onSelectTimelineBlock = (entry: TimelineEntry) => {
    if (suppressTimelineClickRef.current) {
      suppressTimelineClickRef.current = false
      return
    }

    onSelectEntry(entry)
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
      entryId: entry.id,
      createDate: entry.date,
      createStartMinute: startMinute,
      x: position.x,
      y: position.y,
    })
  }

  const onCreateTimelineEntryAtMinute = useCallback(
    (date: string, anchorMinute: number) => {
      const { startMinute, endMinute } = resolveManualTimelineCreateWindow(anchorMinute, timelineWindow)

      void runAction(async () => {
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
          setSelectedEntryId(createdEntry.id)
          setEntryDraft(buildEntryDraft(createdEntry))
        }
        setTimelineContextMenu(null)
        setSuccessMessage('Timeline entry created.')
      })
    },
    [invalidateMonthSummaries, loadTimeline, loadWeekTimeline, loadWeeklySummary, runAction, timelineWindow, updateSelectedDate],
  )

  const onCreateTimelineEntryFromContextMenu = () => {
    if (!timelineContextMenu) {
      return
    }

    const date = timelineContextMenu.createDate
    const startMinute = timelineContextMenu.createStartMinute
    setTimelineContextMenu(null)
    onCreateTimelineEntryAtMinute(date, startMinute)
  }

  const onOpenTimelineEmptyContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    surface: TimelineSurface = 'day',
  ) => {
    event.preventDefault()

    if (
      isBusy
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
      createDate: pointerSlot.date,
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

  const onSaveEntryDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!entryDraft) {
      return
    }

    if (entryDraft.startTime.trim().length === 0) {
      setSuccessMessage(null)
      setErrorMessage('Start time is required.')
      return
    }

    if (entryDraft.endTime.trim().length === 0) {
      setSuccessMessage(null)
      setErrorMessage('End time is required.')
      return
    }

    const startMinute = timeInputToMinute(entryDraft.startTime)
    const endMinute = resolveEntryDraftEndMinute(entryDraft)
    if (endMinute <= startMinute) {
      setSuccessMessage(null)
      setErrorMessage('End time must be later than start time.')
      return
    }

    void runAction(async () => {
      const previousEntryDate = selectedEntry?.date ?? selectedDate
      const previousMonthKey = monthKeyFromDate(previousEntryDate)
      const nextMonthKey = monthKeyFromDate(entryDraft.date)
      const refreshDate = entryDraft.date

      await timelineUpdateEntry({
        id: entryDraft.id,
        engagementId: entryDraft.engagementId || null,
        activityId: entryDraft.activityId || null,
        mode: 'manual',
        date: entryDraft.date,
        startMinute,
        endMinute,
        description: entryDraft.description,
      })

      updateSelectedDate(refreshDate, { clearSelection: false })
      await Promise.all([
        loadTimeline(refreshDate),
        loadWeekTimeline(refreshDate),
        loadWeeklySummary(refreshDate),
      ])
      invalidateMonthSummaries([previousMonthKey, nextMonthKey])
      const nextDraftEndState = buildEntryDraftEndState(endMinute)
      setEntryDraft((previous) =>
        previous && previous.id === entryDraft.id
          ? {
              ...previous,
              date: refreshDate,
              startTime: minuteToTimeInput(startMinute),
              endTime: nextDraftEndState.endTime,
              preserveEndOfDay: nextDraftEndState.preserveEndOfDay,
            }
          : previous,
      )
      setSuccessMessage('Timeline entry updated.')
    })
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
        await timelineDeleteEntry(id)
        await Promise.all([
          loadTimeline(selectedDateRef.current),
          loadWeekTimeline(selectedDateRef.current),
          loadWeeklySummary(selectedDateRef.current),
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
        throw new Error(
          `Key save verification failed. Storage health: ${status.storageHealth}. ${status.lastError ?? ''}`.trim(),
        )
      }

      if (status.statusLevel === 'warning') {
        setSuccessMessage(
          'OpenAI API key saved for this app session only because OS keyring is unavailable.',
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

  const onSaveTimelinePreferences = (
    timelineExcludeUncategorizedFromDailyTotals: boolean,
    timelineShowUncategorizedDailyTotal: boolean,
  ) => {
    const previousStatus = settingsStatus
    if (!previousStatus) {
      return
    }

    setSettingsStatus({
      ...previousStatus,
      timelineExcludeUncategorizedFromDailyTotals,
      timelineShowUncategorizedDailyTotal,
    })

    void runAction(async () => {
      try {
        await settingsSetTimelinePreferences({
          timelineExcludeUncategorizedFromDailyTotals,
          timelineShowUncategorizedDailyTotal,
        })
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

    if (!selectedSummaryLayoutPreset) {
      setErrorMessage('No summary layout preset is selected.')
      return
    }

    void runAction(async () => {
      setIsSummaryExporting(true)
      try {
        const result = await summaryExportWeeklyExcel({
          date: selectedDate,
          layoutPreset: selectedSummaryLayoutPreset,
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

  const openSummaryLayoutEditor = useCallback((mode: 'create' | 'edit') => {
    const basePreset = selectedSummaryLayoutPreset
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
    selectedSummaryLayoutPreset,
  ])

  const onSelectSummaryLayoutPreset = (presetId: string) => {
    if (
      isSummaryLayoutSaving
      || presetId === resolvedSummaryLayoutState.selectedPresetId
    ) {
      return
    }

    void (async () => {
      try {
        await persistSummaryLayoutState({
          ...resolvedSummaryLayoutState,
          selectedPresetId: presetId,
        })
      } catch (error) {
        setErrorMessage(extractErrorMessage(error))
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
          selectedPresetId: draftToSave.id,
          presets: nextPresets,
        }, {
          successMessage:
            summaryLayoutModal.mode === 'create'
              ? 'Summary layout preset created.'
              : 'Summary layout preset updated.',
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

    void (async () => {
      try {
        await persistSummaryLayoutState({
          ...resolvedSummaryLayoutState,
          selectedPresetId: nextSelectedPresetId,
          presets: remainingPresets,
        }, {
          successMessage: 'Summary layout preset deleted.',
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
    return formatTimelineWeekRange(startDate, endDate)
  }, [selectedDate, weekTimelineDays])

  const onSelectView = (view: View) => {
    if (view === 'week' && activeView !== 'week') {
      clearTimelineSelection()
    }

    setActiveView(view)
  }

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
            disabled={isBusy || isTimelineDeleteBusy}
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
            <button type="submit" className="button-soft-primary" disabled={isBusy}>
              <span className="control-icon save-icon" aria-hidden="true" />
              Save Entry
            </button>
            <button
              type="button"
              className="button-soft-danger"
              onClick={() => onDeleteTimelineEntry(entryDraft.id)}
              disabled={isBusy || isTimelineDeleteBusy}
            >
              <span className="control-icon trash-icon" aria-hidden="true" />
              Delete Entry
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
              {calendarVisibleCandidates.length} reviewable
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
            <div className="segmented-control calendar-bulk-tabs" role="tablist" aria-label="Calendar bulk workflows">
              <button
                type="button"
                role="tab"
                aria-selected={calendarBulkTab === 'submission'}
                className={calendarBulkTab === 'submission' ? 'active' : ''}
                onClick={() => setCalendarBulkTab('submission')}
              >
                Calendar Submission
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={calendarBulkTab === 'review'}
                className={calendarBulkTab === 'review' ? 'active' : ''}
                onClick={() => setCalendarBulkTab('review')}
              >
                Review Events
              </button>
            </div>

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
                  || selectedCalendarCandidateHasBlockingIssue
                  || calendarIsImporting
                }
              >
                <span className="control-icon save-icon" aria-hidden="true" />
                {calendarIsImporting ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className="button-soft-danger"
                onClick={onDeleteSelectedCalendarCandidate}
                disabled={!selectedCalendarCandidate || calendarIsImporting}
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
                }`}
                role="list"
                aria-label="Calendar review timeline"
              >
                <div
                  className="timeline-canvas"
                  style={{ minHeight: `${timelineCanvasHeight}px` }}
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

                      if (candidate.reviewState === 'accepted') {
                        return (
                          <div
                            key={entry.id}
                            className={blockClassName}
                            style={blockStyle}
                            title={title}
                            aria-label={title}
                          >
                            <TimelineBlockContent label={blockLabel.label} />
                          </div>
                        )
                      }

                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={blockClassName}
                          style={blockStyle}
                          onClick={() => setSelectedCalendarCandidateId(candidate.id)}
                          title={title}
                          aria-label={title}
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

  if (!tauriRuntime) {
    return (
      <div className="runtime-shell">
        <h1>OmniSheet</h1>
        <p>This application requires the Tauri runtime.</p>
        <p>Start it with `npm run tauri dev` after installing Rust toolchain.</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className={`workspace-shell ${activeView === 'timeline' ? 'with-timeline' : 'without-timeline'}`}>
        <aside className="sidebar-panel">
          <section className="sidebar-section sidebar-capture">
            <div className="sidebar-section-header">
              <h2>Submit an entry</h2>
              <p>Submit what you worked on.</p>
            </div>
            <form onSubmit={onSubmitCapture} className="stack">
              <textarea
                value={captureMessage}
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
                placeholder="Example: Just finished a 30 minute SAP ITGC meeting with the Orange team"
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
            </form>

            <div className="submission-queue">
              <button
                type="button"
                className="submission-queue-toggle"
                aria-expanded={isSubmissionQueueOpen}
                onClick={() => setIsSubmissionQueueOpen((previous) => !previous)}
              >
                <span>Submission Queue</span>
                <span
                  className={`submission-queue-toggle-icon ${isSubmissionQueueOpen ? 'open' : ''}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>

              {isSubmissionQueueOpen ? (
                <div className="submission-queue-list" role="list" aria-label="Submission queue items">
                  {submissionQueueDisplayItems.length === 0 ? (
                    <p className="submission-queue-empty">Submission queue is empty</p>
                  ) : (
                    submissionQueueDisplayItems.map((item) => (
                      <div key={item.id} className={`submission-queue-item ${item.state}`} role="listitem">
                        <div className="submission-queue-item-header">
                          <p className="submission-queue-item-text">{item.rawText}</p>
                          <span className={`submission-queue-item-badge ${item.state}`}>
                            {formatSubmissionQueueStateLabel(item.state)}
                          </span>
                        </div>
                        <p className="submission-queue-item-meta">
                          Submitted {formatSubmissionQueueTimestamp(item.submittedAtMs)}
                        </p>
                        <p className="submission-queue-item-status">{item.statusMessage}</p>
                        {item.state === 'success' && item.createdEntryCount !== undefined ? (
                          <p className="submission-queue-item-meta">
                            Entries created: {item.createdEntryCount}
                          </p>
                        ) : null}
                        {item.correlationId ? (
                          <p className="submission-queue-item-meta">
                            Correlation ID: <code>{item.correlationId}</code>
                          </p>
                        ) : null}
                        {item.state === 'success' && item.completedDurationMs !== undefined ? (
                          <p className="submission-queue-item-meta">
                            Completed in: {formatSubmissionQueueDuration(item.completedDurationMs)}
                          </p>
                        ) : null}
                        {item.state === 'success' && item.modelUsedLabel ? (
                          <p className="submission-queue-item-meta">
                            Model used: {item.modelUsedLabel}
                          </p>
                        ) : null}
                        {item.captureSource === 'voice' && item.transcriptionModelUsedLabel ? (
                          <p className="submission-queue-item-meta">
                            Transcription model: {item.transcriptionModelUsedLabel}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
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
          <div className="segmented-control" role="tablist" aria-label="Main views">
            {SEGMENTED_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                role="tab"
                aria-selected={activeView === view.id}
                className={activeView === view.id ? 'active' : ''}
                onClick={() => onSelectView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </div>

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
                  <span className="timeline-range-separator" aria-hidden="true">•</span>
                  <span className="timeline-range-total">
                    {formatTimelineHoursCompact(timelineDayTotalBreakdown.primaryMinutes)} total
                  </span>
                  {shouldShowTimelineDayUncategorizedDailyTotal ? (
                    <>
                      <span className="timeline-range-separator" aria-hidden="true">•</span>
                      <span className="timeline-range-total timeline-range-total-secondary">
                        {formatTimelineHoursCompact(timelineDayTotalBreakdown.uncategorizedMinutes)} uncategorized
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="timeline-controls timeline-stepper" aria-label="Day navigation">
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-prev"
                  aria-label="Previous day"
                  title="Previous day"
                  onClick={() => onSetDate(shiftDate(selectedDate, -1))}
                  disabled={isBusy || isTimelineLoading}
                >
                  <span className="control-icon chevron-left" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="stepper-button stepper-center"
                  onClick={onJumpToToday}
                  disabled={isBusy || isTimelineLoading}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-next"
                  aria-label="Next day"
                  title="Next day"
                  onClick={() => onSetDate(shiftDate(selectedDate, 1))}
                  disabled={isBusy || isTimelineLoading}
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
                        && timelineDragState.entryId === entry.id
                      const blockPalette = buildTimelineBlockPalette(blockColor)

                      if (isDragPreview) {
                        return (
                          <div
                            key={entry.id}
                            className={`timeline-block drag-preview tier-${blockLabel.tier}`}
                            style={{
                              top: positionedEntry.top,
                              height: positionedEntry.height,
                              left: `${positionedEntry.leftPercent}%`,
                              width: `${positionedEntry.widthPercent}%`,
                              ...buildTimelineBlockCssVariables(blockPalette),
                            } as CSSProperties}
                            aria-hidden="true"
                          >
                            <TimelineBlockContent label={blockLabel.label} />
                          </div>
                        )
                      }

                      const blockClassName = [
                        'timeline-block',
                        `tier-${blockLabel.tier}`,
                        selectedEntryId === entry.id ? 'selected' : '',
                        needsReview ? 'needs-review' : '',
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
                          <TimelineBlockContent label={blockLabel.label} />
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
                  <strong>{weekTimelineRangeLabel}</strong>
                </h2>
                <p className="timeline-range">Sunday - Saturday</p>
              </div>
              <div className="timeline-controls timeline-stepper" aria-label="Week navigation">
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-prev"
                  aria-label="Previous week"
                  title="Previous week"
                  onClick={() => onSetDate(shiftDate(selectedDate, -7))}
                  disabled={isBusy || isWeekTimelineLoading}
                >
                  <span className="control-icon chevron-left" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="stepper-button stepper-center"
                  onClick={onJumpToThisWeek}
                  disabled={isBusy || isWeekTimelineLoading}
                >
                  This Week
                </button>
                <button
                  type="button"
                  className="timeline-arrow-button stepper-button stepper-next"
                  aria-label="Next week"
                  title="Next week"
                  onClick={() => onSetDate(shiftDate(selectedDate, 7))}
                  disabled={isBusy || isWeekTimelineLoading}
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
                            <span>
                              {formatTimelineHoursCompact(dayTotalBreakdown.primaryMinutes)}
                              {shouldShowTimelineUncategorizedDailyTotal ? ' total' : ''}
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
                          && timelineDragState.entryId === entry.id
                        const blockPalette = buildTimelineBlockPalette(blockColor)

                        if (isDragPreview) {
                          return (
                            <div
                              key={entry.id}
                              className={`timeline-block drag-preview tier-${blockLabel.tier}`}
                              style={{
                                top: positionedEntry.top,
                                height: positionedEntry.height,
                                left: positionedEntry.left,
                                width: positionedEntry.width,
                                ...buildTimelineBlockCssVariables(blockPalette),
                              } as CSSProperties}
                              aria-hidden="true"
                            >
                              <TimelineBlockContent label={blockLabel.label} />
                            </div>
                          )
                        }

                        const blockClassName = [
                          'timeline-block',
                          `tier-${blockLabel.tier}`,
                          selectedEntryId === entry.id ? 'selected' : '',
                          needsReview ? 'needs-review' : '',
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
                            <TimelineBlockContent label={blockLabel.label} />
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
          <section className="panel code-panel">
            <div className="code-forms">
              <div className="code-panel-header">
                <h2>Engagements and Activities</h2>
                <p>These are the projects/engagements that OmniSheet will match to your submitted activity.</p>
              </div>

              <div ref={codeFormsBodyRef} className="code-forms-body">
                <div className="code-editor-accordion">
                  <section className={`code-editor-section ${isEngagementEditorOpen ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="code-editor-trigger"
                      aria-expanded={isEngagementEditorOpen}
                      aria-controls="engagement-editor-panel"
                      onClick={toggleEngagementEditor}
                    >
                      <span className="code-editor-trigger-title">
                        {isEditingEngagement ? 'Edit Engagement' : 'Create Engagement'}
                      </span>
                      <span
                        className={`code-editor-trigger-icon ${isEngagementEditorOpen ? 'open' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {isEngagementEditorOpen ? (
                      <div id="engagement-editor-panel" className="code-editor-panel">
                        <form className="stack code-editor-form" onSubmit={onSubmitEngagement}>
                          <label>
                            <span className="field-label-row">
                              Name
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
                            <input
                              ref={engagementNameInputRef}
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
                            Code
                            <input
                              value={engagementForm.code}
                              onChange={(event) =>
                                setEngagementForm((previous) => ({
                                  ...previous,
                                  code: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            <span className="field-label-row">
                              Describe when to use this engagement
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                              required
                            />
                          </label>
                          <label>
                            Tags / Key Words (comma separated)
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
                          <div className="code-editor-actions">
                            <button type="submit" disabled={isBusy}>
                              {isEditingEngagement ? 'Update Engagement' : 'Create Engagement'}
                            </button>
                            <button type="button" className="ghost" onClick={closeCodeEditor}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : null}
                  </section>

                  <section className={`code-editor-section ${isActivityEditorOpen ? 'expanded' : ''}`}>
                    <button
                      type="button"
                      className="code-editor-trigger"
                      aria-expanded={isActivityEditorOpen}
                      aria-controls="activity-editor-panel"
                      onClick={toggleActivityEditor}
                      disabled={!canCreateActivity}
                    >
                      <span className="code-editor-trigger-title">
                        {isEditingActivity ? 'Edit Activity' : 'Create Activity'}
                      </span>
                      <span
                        className={`code-editor-trigger-icon ${isActivityEditorOpen ? 'open' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {isActivityEditorOpen ? (
                      <div id="activity-editor-panel" className="code-editor-panel">
                        {isEditingActivity && selectedActivityEngagement ? (
                          <p className="code-editor-context">
                            Editing activity in <strong>{selectedActivityEngagement.code}</strong>
                            {' '}{selectedActivityEngagement.name}
                          </p>
                        ) : null}
                        <form className="stack code-editor-form" onSubmit={onSubmitActivity}>
                          <label>
                            Engagement
                            <select
                              ref={activityEngagementSelectRef}
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
                              Name
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                            Code
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
                              <span className="required-indicator" aria-hidden="true">*</span>
                            </span>
                            <span className="field-helper">Required for matching</span>
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
                              required
                            />
                          </label>
                          <label>
                            Tags / Key Words (comma separated)
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
                          <div className="code-editor-actions">
                            <button type="submit" disabled={isBusy || engagements.length === 0}>
                              {isEditingActivity ? 'Update Activity' : 'Create Activity'}
                            </button>
                            <button type="button" className="ghost" onClick={closeCodeEditor}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : null}

                    {!canCreateActivity ? (
                      <p className="code-editor-choice-hint">Create an engagement first.</p>
                    ) : null}
                  </section>
                </div>
              </div>
            </div>

            <div className="code-browse-panel">
              <div className="code-panel-header">
                <h2>Existing Engagements & Activities</h2>
                <p>Click to expand and review/edit the related activities.</p>
              </div>

              <div className="code-list" aria-label="Existing engagements and activities">
                {engagements.length === 0 ? (
                  <p className="code-list-empty">No engagements yet. Create one to get started.</p>
                ) : (
                  engagements.map((engagement) => {
                    const engagementColor =
                      normalizeColorHexInput(engagement.colorHex) ?? TIMELINE_NEUTRAL_COLOR
                    const engagementUsage =
                      engagement.describeWhenToUse?.trim() || 'Usage guidance not added yet.'
                    const isExpanded = engagement.id === expandedEngagementId
                    const engagementPanelId = `engagement-panel-${engagement.id}`

                    return (
                      <article
                        key={engagement.id}
                        className={`engagement-card ${isExpanded ? 'expanded' : ''}`}
                        style={{ borderLeftColor: engagementColor }}
                      >
                        <div className="engagement-card-header">
                          <div className="engagement-card-main">
                            <h3 className="engagement-card-heading">
                              <button
                                type="button"
                                className="engagement-disclosure"
                                aria-expanded={isExpanded}
                                aria-controls={engagementPanelId}
                                onClick={() =>
                                  setExpandedEngagementId((previous) =>
                                    previous === engagement.id ? null : engagement.id,
                                  )
                                }
                              >
                                <span className="engagement-disclosure-main">
                                  <span className="engagement-disclosure-icon" aria-hidden="true" />
                                    <span className="code-item-copy">
                                      <span className="code-item-title">
                                      {engagement.code ? (
                                        <span className="code-item-badge">{engagement.code}</span>
                                      ) : null}
                                      <span className="code-item-name">{engagement.name}</span>
                                    </span>
                                    <span
                                      className={`code-item-usage ${engagement.describeWhenToUse?.trim() ? '' : 'is-placeholder'}`}
                                    >
                                      {engagementUsage}
                                    </span>
                                    <ResponsiveCodeTagList tags={engagement.tags} itemKeyPrefix={engagement.id} />
                                  </span>
                                </span>
                                <span className="activity-count-pill">
                                  {formatActivityCount(engagement.activities.length)}
                                </span>
                              </button>
                            </h3>
                          </div>

                          <div className="code-item-actions">
                            <button
                              type="button"
                              className="icon-action-button"
                              aria-label={`Edit engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              title={`Edit engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => onEditEngagement(engagement)}
                            >
                              <img src={editIcon} alt="" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-action-button is-danger"
                              aria-label={`Delete engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              title={`Delete engagement ${formatEntityDisplayLabel(engagement.name, engagement.code)}`}
                              onClick={() => onDeleteEngagement(engagement.id)}
                            >
                              <img src={deleteIcon} alt="" aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div id={engagementPanelId} className="engagement-activities" hidden={!isExpanded}>
                          {engagement.activities.length === 0 ? (
                            <p className="engagement-empty-state">No activities yet.</p>
                          ) : (
                            <ul>
                              {engagement.activities.map((activity) => {
                                const activityColor =
                                  normalizeColorHexInput(activity.colorHex)
                                  ?? normalizeColorHexInput(engagement.colorHex)
                                  ?? TIMELINE_NEUTRAL_COLOR
                                const activityUsage =
                                  activity.describeWhenToUse?.trim() || 'Usage guidance not added yet.'

                                return (
                                  <li
                                    key={activity.id}
                                    className="activity-row"
                                    style={{ borderLeftColor: activityColor }}
                                  >
                                    <div className="code-item-copy">
                                      <div className="code-item-title">
                                        {activity.code ? (
                                          <span className="code-item-badge">{activity.code}</span>
                                        ) : null}
                                        <span className="code-item-name">{activity.name}</span>
                                      </div>
                                      <p
                                        className={`code-item-usage ${activity.describeWhenToUse?.trim() ? '' : 'is-placeholder'}`}
                                      >
                                        {activityUsage}
                                      </p>
                                      <ResponsiveCodeTagList tags={activity.tags} itemKeyPrefix={activity.id} />
                                    </div>

                                    <div className="code-item-actions">
                                      <button
                                        type="button"
                                        className="icon-action-button"
                                        aria-label={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        title={`Edit activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        onClick={() => onEditActivity(activity)}
                                      >
                                        <img src={editIcon} alt="" aria-hidden="true" />
                                      </button>
                                      <button
                                        type="button"
                                        className="icon-action-button is-danger"
                                        aria-label={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        title={`Delete activity ${formatEntityDisplayLabel(activity.name, activity.code)}`}
                                        onClick={() => onDeleteActivity(activity.id)}
                                      >
                                        <img src={deleteIcon} alt="" aria-hidden="true" />
                                      </button>
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
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
                <form className="settings-preference-row" onSubmit={onSaveApiKey}>
                  <label htmlFor="settings-openai-key">OpenAI API Key</label>
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
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-exclude-uncategorized">
                    Exclude uncategorized time from daily totals
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-exclude-uncategorized"
                      type="checkbox"
                      checked={timelineExcludeUncategorizedFromDailyTotals}
                      onChange={(event) =>
                        onSaveTimelinePreferences(
                          event.target.checked,
                          timelineShowUncategorizedDailyTotal,
                        )
                      }
                      disabled={isBusy || settingsStatus === null}
                    />
                  </div>
                </div>
                <div className="settings-preference-row settings-toggle-row">
                  <label htmlFor="settings-timeline-show-uncategorized">
                    Display uncategorized time alongside categorized time in daily totals
                  </label>
                  <div className="settings-toggle-group">
                    <input
                      id="settings-timeline-show-uncategorized"
                      type="checkbox"
                      checked={timelineShowUncategorizedDailyTotal}
                      onChange={(event) =>
                        onSaveTimelinePreferences(
                          timelineExcludeUncategorizedFromDailyTotals,
                          event.target.checked,
                        )
                      }
                      disabled={
                        isBusy ||
                        settingsStatus === null ||
                        !timelineExcludeUncategorizedFromDailyTotals
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card-header">
                  <h3>Calendar Bulk Add</h3>
                </div>
                <form className="settings-preference-row" onSubmit={onSaveCalendarBulkPreferences}>
                  <label htmlFor="settings-calendar-ignore-keywords">Ignored keywords</label>
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
                  <h3>Status</h3>
                </div>
                <div className="settings-status-grid">
                  <div className="settings-status-item">
                    <span>Key configured</span>
                    <strong
                      className={`settings-status-pill ${
                        settingsStatus?.hasOpenAiKey ? 'is-success' : 'is-warning'
                      }`}
                    >
                      {settingsStatus?.hasOpenAiKey ? 'Yes' : 'No'}
                    </strong>
                  </div>
                  <div className="settings-status-item">
                    <span>Interpretation</span>
                    <strong>
                      {settingsStatus
                        ? settingsStatus.availableOpenAiModels.find(
                            (model) => model.id === settingsStatus.selectedOpenAiModel,
                          )?.label ?? 'unknown'
                        : 'unknown'}
                    </strong>
                  </div>
                  <div className="settings-status-item">
                    <span>Calendar Bulk Add</span>
                    <strong>
                      {settingsStatus
                        ? settingsStatus.availableOpenAiModels.find(
                            (model) => model.id === settingsStatus.selectedCalendarBulkModel,
                          )?.label ?? 'unknown'
                        : 'unknown'}
                    </strong>
                  </div>
                  <div className="settings-status-item">
                    <span>Speech-to-Text</span>
                    <strong>
                      {settingsStatus
                        ? settingsStatus.availableTranscriptionModels.find(
                            (model) => model.id === settingsStatus.selectedTranscriptionModel,
                          )?.label ?? 'unknown'
                        : 'unknown'}
                    </strong>
                  </div>
                  <div className="settings-status-item">
                    <span>Storage health</span>
                    <strong
                      className={`settings-status-pill ${
                        settingsStatus?.statusLevel === 'error'
                          ? 'is-danger'
                          : settingsStatus?.statusLevel === 'warning'
                            ? 'is-warning'
                            : 'is-success'
                      }`}
                    >
                      {settingsStatus?.storageHealth ?? 'unknown'}
                    </strong>
                  </div>
                  <div className="settings-status-item">
                    <span>Key source</span>
                    <strong>{formatKeySource(settingsStatus?.keySource)}</strong>
                  </div>
                </div>
              </section>
            </div>
            {settingsStatus?.lastError ? (
              <p className={`settings-alert alert ${settingsStatus?.statusLevel === 'error' ? 'error' : 'warning'}`}>
                Last key status: {settingsStatus.lastError}
              </p>
            ) : null}
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

        {activeView === 'summary' ? (
          <section className="panel summary-panel">
            <div className="summary-toolbar">
              <div className="summary-title-block">
                <h2>Weekly Summary</h2>
                {weeklySummary ? (
                  <p className="summary-week-range">
                    Week: {weeklySummary.weekStartDate} - {weeklySummary.weekEndDate}
                  </p>
                ) : (
                  <p className="summary-week-range">Week: {selectedDate}</p>
                )}
              </div>
              <div className="summary-week-controls">
                <button
                  type="button"
                  onClick={() => onShiftSummaryWeek(-1)}
                  disabled={isBusy || isWeeklySummaryLoading || isSummaryExporting}
                >
                  Previous Week
                </button>
                <button
                  type="button"
                  onClick={() => onShiftSummaryWeek(1)}
                  disabled={isBusy || isWeeklySummaryLoading || isSummaryExporting}
                >
                  Next Week
                </button>
                <button
                  type="button"
                  onClick={onExportSummaryWeek}
                  disabled={
                    isBusy
                    || isWeeklySummaryLoading
                    || isSummaryExporting
                    || isSummaryLayoutSaving
                    || !weeklySummary
                    || !selectedSummaryLayoutPreset
                  }
                >
                  {isSummaryExporting ? 'Exporting...' : 'Export'}
                </button>
              </div>
            </div>

            <section className="summary-layout-toolbar" aria-label="Table layout presets">
              <div className="summary-layout-toolbar-copy">
                <span className="summary-layout-toolbar-eyebrow">Table Layout Presets</span>
                <p>Choose a saved layout or open the editor to change columns and ordering.</p>
              </div>
              <div className="summary-layout-toolbar-main">
                <div className="summary-layout-preset-list" role="tablist" aria-label="Summary layout presets">
                  {resolvedSummaryLayoutState.presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={preset.id === selectedSummaryLayoutPreset?.id ? 'active' : ''}
                      role="tab"
                      aria-selected={preset.id === selectedSummaryLayoutPreset?.id}
                      onClick={() => onSelectSummaryLayoutPreset(preset.id)}
                      disabled={isBusy || isSummaryLayoutSaving}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <div className="summary-layout-toolbar-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openSummaryLayoutEditor('edit')}
                    disabled={isBusy || isSummaryLayoutSaving || !selectedSummaryLayoutPreset}
                  >
                    Edit Layout
                  </button>
                  <button
                    type="button"
                    onClick={() => openSummaryLayoutEditor('create')}
                    disabled={isBusy || isSummaryLayoutSaving || !selectedSummaryLayoutPreset}
                  >
                    New Preset
                  </button>
                </div>
              </div>
            </section>

            <div className="summary-week-total">
              <span>Week Total Hours</span>
              <strong>
                {weeklySummary
                  ? formatMinutesAsHours(weeklySummary.weekTotalMinutes)
                  : '--'}
              </strong>
            </div>

            {weeklySummaryError ? (
              <p className="mini-calendar-error">{weeklySummaryError}</p>
            ) : null}

            <div className="summary-table-wrap" aria-busy={isWeeklySummaryLoading}>
              {isWeeklySummaryLoading ? (
                <p>Loading weekly summary...</p>
              ) : weeklySummary ? (
                <table className="summary-table">
                  <thead>
                    <tr>
                      {summaryViewColumns.map((column) => (
                        <th
                          key={column.id}
                          className={column.wraps ? 'summary-cell-wrap' : ''}
                          style={{ minWidth: column.width }}
                        >
                          {column.kind === 'day' && column.dayIndex !== undefined
                            ? `${SUMMARY_DAY_NAMES[column.dayIndex]} (${formatMonthDay(weeklySummary.days[column.dayIndex]?.date ?? weeklySummary.weekStartDate)})`
                            : column.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weeklySummary.rows.length === 0 ? (
                      <tr>
                        <td colSpan={summaryViewColumns.length} className="summary-empty-row">
                          No time entries for this week.
                        </td>
                      </tr>
                    ) : (
                      weeklySummary.rows.map((row, rowIndex) => (
                        <tr key={`${row.engagementCode}-${row.activityCode}-${rowIndex}`}>
                          {summaryViewColumns.map((column) => (
                            <td
                              key={`${rowIndex}-${column.id}`}
                              className={buildSummaryTableCellClassName(column, row)}
                              style={{ minWidth: column.width }}
                            >
                              {renderSummaryTableCell(
                                column,
                                row,
                                rowIndex,
                                engagementById,
                                activityById,
                                onOpenSummaryNotes,
                              )}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="summary-total-row">
                      {summaryViewColumns.map((column, columnIndex) => (
                        <td
                          key={`total-${column.id}`}
                          className={(
                            column.wraps
                            || (
                              summaryFooterLabelIndex >= 0
                              && columnIndex === summaryFooterLabelIndex
                              && column.kind !== 'day'
                              && column.kind !== 'rowTotal'
                            )
                          ) ? 'summary-cell-wrap' : ''}
                          style={{ minWidth: column.width }}
                        >
                          {renderSummaryFooterCell(column, columnIndex, summaryFooterLabelIndex, weeklySummary)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <p>No summary data available.</p>
              )}
            </div>
          </section>
        ) : null}
          </div>
        </main>
      </div>
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
            disabled={isBusy || isTimelineDeleteBusy}
          >
            <span className="control-icon plus-icon" aria-hidden="true" />
            Create new entry
          </button>
          {timelineContextMenu.kind === 'entry' && timelineContextMenu.entryId ? (
            <button
              type="button"
              className="timeline-context-menu-item is-danger"
              role="menuitem"
              onClick={() => onDeleteTimelineEntry(timelineContextMenu.entryId)}
              disabled={isBusy || isTimelineDeleteBusy}
            >
              <span className="control-icon trash-icon" aria-hidden="true" />
              Delete entry
            </button>
          ) : null}
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
            className="summary-layout-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-label={summaryLayoutModal.mode === 'create' ? 'Create summary layout preset' : 'Edit summary layout preset'}
            >
              <div className="summary-layout-editor-header">
              <div>
                <h3>{summaryLayoutModal.mode === 'create' ? 'New Layout Preset' : 'Edit Layout Preset'}</h3>
                <p>Reorder, remove, or insert columns. Row Total stays required, but you can move it.</p>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={resetSummaryLayoutEditor}
              >
                Close
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
                    const previewColumn = buildSummaryViewColumn(column)
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
                          className={`summary-layout-editor-column ${previewColumn.wraps ? 'wraps' : ''} ${previewColumn.kind === 'rowTotal' ? 'summary-layout-editor-column-required' : ''} ${isDragging ? 'dragging' : ''} ${isDisplaced ? 'displaced' : ''} ${isCommitReset ? 'commit-reset' : ''}`}
                          style={{
                            width: previewColumn.width,
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
                          <div className={`summary-layout-editor-cell summary-layout-editor-header-cell ${previewColumn.wraps ? 'wraps' : ''}`}>
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
                                ? `${SUMMARY_DAY_NAMES[previewColumn.dayIndex]} (${formatMonthDay(weeklySummary.days[previewColumn.dayIndex]?.date ?? weeklySummary.weekStartDate)})`
                                : previewColumn.header
                            )}
                          </div>
                          {(summaryLayoutPreviewRows.length > 0 ? summaryLayoutPreviewRows : [null, null, null]).map((row, previewRowIndex) => (
                            <div
                              key={`${column.id}-preview-${previewRowIndex}`}
                              className={`summary-layout-editor-cell ${previewColumn.wraps ? 'wraps' : ''}`}
                            >
                              {row
                                ? renderSummaryPreviewCell(
                                  previewColumn,
                                  row,
                                  engagementById,
                                  activityById,
                                )
                                : <span className="summary-layout-editor-placeholder">Preview</span>}
                            </div>
                          ))}
                          <div className="summary-layout-editor-cell summary-layout-editor-footer-cell">
                            {renderSummaryPreviewFooter(previewColumn, weeklySummary)}
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
                      {buildSummaryLayoutInsertOptions(summaryLayoutDraft).map((option) => (
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
            </div>

            <div className="summary-layout-editor-actions">
              {summaryLayoutModal.mode === 'edit' ? (
                <button
                  type="button"
                  className="danger"
                  onClick={onDeleteSummaryLayoutPreset}
                  disabled={isSummaryLayoutSaving || resolvedSummaryLayoutState.presets.length <= 1}
                >
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
                className="ghost"
                onClick={onCloseSummaryNotes}
              >
                Close
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
              {' '}on {SUMMARY_DAY_NAMES[selectedSummaryNotesContext.dayIndex]} ({formatMonthDay(selectedSummaryNotesContext.day.date)})
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
        {WEEKDAY_LABELS.map((label, index) => (
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
}: {
  label: string
}) {
  return (
    <span className="timeline-block-content">
      <span className="timeline-block-label">{label}</span>
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
  }
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

function formatSubmissionQueueStateLabel(state: SubmissionQueueItemState): string {
  if (state === 'pending') {
    return 'Queued'
  }

  if (state === 'running') {
    return 'Processing'
  }

  if (state === 'success') {
    return 'Completed'
  }

  return 'Failed'
}

function formatSubmissionQueueSuccessMessage(createdEntryCount: number, completedAt: Date): string {
  return `Added ${createdEntryCount} new entr${createdEntryCount === 1 ? 'y' : 'ies'} on ${formatSubmissionQueueOutcomeTimestamp(completedAt)}.`
}

function formatSubmissionQueueOutcomeTimestamp(value: Date): string {
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).format(value)
  const showMinutes = value.getMinutes() !== 0
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: showMinutes ? '2-digit' : undefined,
  }).format(value)
  return `${date} at ${time}`
}

function formatSubmissionQueueTimestamp(timestampMs: number): string {
  return formatSubmissionQueueOutcomeTimestamp(new Date(timestampMs))
}

function formatSubmissionQueueDuration(durationMs: number): string {
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }

  const totalSeconds = durationMs / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60

  return `${minutes}m ${seconds.toFixed(1)}s`
}

function formatKeySource(value: SettingsStatus['keySource'] | undefined): string {
  if (value === 'keyring') {
    return 'OS keyring'
  }

  if (value === 'session_cache') {
    return 'In-memory session cache'
  }

  if (value === 'none') {
    return 'None'
  }

  return 'unknown'
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

function buildWeekViewDays(anchorDate: string): TimelineWeekView['days'] {
  const anchor = new Date(`${anchorDate}T00:00:00`)
  const weekStart = new Date(anchor)
  weekStart.setDate(anchor.getDate() - anchor.getDay())

  return Array.from({ length: 7 }, (_, dayIndex) => {
    const value = new Date(weekStart)
    value.setDate(weekStart.getDate() + dayIndex)
    return {
      date: formatDate(value),
    }
  })
}

function formatTimelineWeekRange(startDate: string, endDate: string): string {
  const startValue = new Date(`${startDate}T00:00:00`)
  const endValue = new Date(`${endDate}T00:00:00`)
  const startLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(startValue)
  const endLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(endValue)

  return `${startLabel} - ${endLabel}`
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

function createEmptyTimelineTotalBreakdown(): TimelineTotalBreakdown {
  return {
    primaryMinutes: 0,
    categorizedMinutes: 0,
    uncategorizedMinutes: 0,
  }
}

function finalizeTimelineTotalBreakdown(
  breakdown: TimelineTotalBreakdown,
  excludeUncategorized: boolean,
): TimelineTotalBreakdown {
  return {
    ...breakdown,
    primaryMinutes: excludeUncategorized
      ? breakdown.categorizedMinutes
      : breakdown.categorizedMinutes + breakdown.uncategorizedMinutes,
  }
}

function addEntryToTimelineTotalBreakdown(
  breakdown: TimelineTotalBreakdown,
  entry: TimelineEntry,
): void {
  if (isTimelineEntryUncategorized(entry)) {
    breakdown.uncategorizedMinutes += entry.durationMinutes
    return
  }

  breakdown.categorizedMinutes += entry.durationMinutes
}

function buildTimelineTotalBreakdown(
  entries: TimelineEntry[],
  excludeUncategorized: boolean,
): TimelineTotalBreakdown {
  const breakdown = createEmptyTimelineTotalBreakdown()

  for (const entry of entries) {
    addEntryToTimelineTotalBreakdown(breakdown, entry)
  }

  return finalizeTimelineTotalBreakdown(breakdown, excludeUncategorized)
}

function buildTimelineDayTotalBreakdowns(
  entries: TimelineEntry[],
  days: TimelineWeekView['days'],
  excludeUncategorized: boolean,
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
    totalsByDate.set(date, finalizeTimelineTotalBreakdown(breakdown, excludeUncategorized))
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
      positionedEntries.push({
        ...positionedEntry,
        dayIndex,
        left:
          layoutMetrics.gutterLeft
          + (dayIndex * layoutMetrics.dayWidth)
          + ((positionedEntry.leftPercent / 100) * layoutMetrics.dayWidth),
        width: (positionedEntry.widthPercent / 100) * layoutMetrics.dayWidth,
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

function buildSummaryViewColumns(preset: SummaryLayoutPreset | undefined): SummaryLayoutViewColumn[] {
  return (preset?.columns ?? []).map((column) => buildSummaryViewColumn(column))
}

function buildSummaryViewColumn(column: SummaryLayoutColumn): SummaryLayoutViewColumn {
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
      header: SUMMARY_DAY_NAMES[column.dayIndex] ?? 'Day',
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

function buildSummaryTableCellClassName(
  column: SummaryLayoutViewColumn,
  row: TimelineWeeklySummary['rows'][number],
): string {
  const classNames: string[] = []

  if (column.kind === 'rowTotal') {
    classNames.push('summary-row-total')
  }

  if (
    column.kind === 'field'
    && (column.fieldKey === 'engagementCode' || column.fieldKey === 'activityCode')
    && row.isUncategorized
  ) {
    classNames.push('summary-uncategorized')
  }

  if (column.wraps) {
    classNames.push('summary-cell-wrap')
  }

  return classNames.join(' ')
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

function renderSummaryTableCell(
  column: SummaryLayoutViewColumn,
  row: TimelineWeeklySummary['rows'][number],
  rowIndex: number,
  engagementById: Map<string, Engagement>,
  activityById: Map<string, Activity>,
  onOpenSummaryNotes: (rowIndex: number, dayIndex: number) => void,
) {
  if (column.kind === 'day' && column.dayIndex !== undefined) {
    const cell = row.cells[column.dayIndex]
    if (!cell || cell.totalMinutes <= 0) {
      return <span className="summary-zero">-</span>
    }

    return (
      <div className="summary-cell-value-wrap">
        <span>{formatMinutesAsHours(cell.totalMinutes)}</span>
        <button
          type="button"
          className="ghost summary-notes-button"
          onClick={() => onOpenSummaryNotes(rowIndex, column.dayIndex ?? 0)}
        >
          Notes
        </button>
      </div>
    )
  }

  if (column.kind === 'rowTotal') {
    return formatMinutesAsHours(row.rowTotalMinutes)
  }

  if (column.kind === 'freeText') {
    return <span className="summary-free-text-cell" aria-hidden="true" />
  }

  return resolveSummaryFieldValue(
    column.fieldKey ?? 'engagementName',
    row,
    engagementById,
    activityById,
  )
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

function renderSummaryPreviewFooter(
  column: SummaryLayoutViewColumn,
  weeklySummary: TimelineWeeklySummary | null,
) {
  if (!weeklySummary) {
    return ''
  }

  if (column.kind === 'day' && column.dayIndex !== undefined) {
    return formatMinutesAsHours(weeklySummary.dayTotalMinutes[column.dayIndex] ?? 0)
  }

  if (column.kind === 'rowTotal') {
    return formatMinutesAsHours(weeklySummary.weekTotalMinutes)
  }

  return ''
}

function renderSummaryFooterCell(
  column: SummaryLayoutViewColumn,
  columnIndex: number,
  summaryFooterLabelIndex: number,
  weeklySummary: TimelineWeeklySummary,
) {
  if (column.kind === 'day' && column.dayIndex !== undefined) {
    return formatMinutesAsHours(weeklySummary.dayTotalMinutes[column.dayIndex] ?? 0)
  }

  if (column.kind === 'rowTotal') {
    return formatMinutesAsHours(weeklySummary.weekTotalMinutes)
  }

  return (
    summaryFooterLabelIndex >= 0
    && columnIndex === summaryFooterLabelIndex
    && column.kind !== 'day'
  ) ? 'Day Totals' : ''
}

function buildSummaryLayoutInsertOptions(preset: SummaryLayoutPreset): Array<{
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

  const dayOptions = SUMMARY_DAY_NAMES
    .map((dayName, dayIndex) => ({ dayName, dayIndex }))
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

export default App

