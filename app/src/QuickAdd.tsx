import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { emit, listen } from '@tauri-apps/api/event'

import { ActivityCommandBar } from './ActivityCommandBar'
import { StopIcon, TimerIcon, TrashIcon } from './InterfaceIcons'
import {
  engagementList,
  interpretTextMessage,
  quickAddHideWindow,
  quickAddResizeWindow,
  quickAddShowMainWindow,
  quickAddSuggestions,
  settingsGetStatus,
  timerGetActive,
  timerCancel,
  timerStart,
  timerStop,
  timelineCreateEntry,
} from './lib/api'
import {
  QUICK_ADD_OPEN_TIMELINE_EVENT,
  QUICK_ADD_SUBMITTED_EVENT,
  TIMER_CHANGED_EVENT,
} from './lib/events'
import {
  buildQuickEntryModel,
  QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
  QUICK_ENTRY_DRAG_ACTIVATION_PX,
  quickEntryActivityKey,
  quickEntryDurationFromDrag,
  resolveQuickEntryCreateWindow,
  sanitizeQuickAddPreferences,
} from './lib/quickEntry'
import type { QuickEntryDragState } from './lib/quickEntry'
import { isTauriRuntime } from './lib/runtime'
import { formatDate } from './lib/time'
import type {
  ActiveTimer,
  Activity,
  Engagement,
  OpenAiModelId,
  QuickAddSuggestion,
  SettingsStatus,
} from './lib/types'
import './QuickAdd.css'

type QuickAddStatus = 'idle' | 'loading' | 'submitting' | 'success' | 'error'

const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5.5-instant'
const LLM_ENTRY_EXAMPLE_TEXT = 'Spent an hour on Non-Rev ITACs...'
const MISSING_OPENAI_KEY_HINT = 'No API key is configured in settings'
const QUICK_ADD_MIN_WINDOW_HEIGHT = 260
const QUICK_ADD_MAX_WINDOW_HEIGHT = 680

function QuickAdd() {
  const tauriRuntime = isTauriRuntime()
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [quickAddSuggestionItems, setQuickAddSuggestionItems] = useState<QuickAddSuggestion[]>([])
  const [quickAddSuggestedKeys, setQuickAddSuggestedKeys] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null)
  const [isTimerSelectionMode, setIsTimerSelectionMode] = useState(false)
  const [isBulkEntryOpen, setIsBulkEntryOpen] = useState(false)
  const [timerClock, setTimerClock] = useState(() => new Date())
  const [status, setStatus] = useState<QuickAddStatus>(tauriRuntime ? 'loading' : 'error')
  const [statusMessage, setStatusMessage] = useState(
    tauriRuntime
      ? 'Loading Quick Entry...'
      : 'Quick Add requires the Tauri desktop runtime.',
  )
  const [quickBlockDragState, setQuickBlockDragState] = useState<QuickEntryDragState | null>(null)

  const quickBlockDragStateRef = useRef<QuickEntryDragState | null>(null)
  const quickAddPaletteRef = useRef<HTMLElement | null>(null)
  const quickAddLlmPanelRef = useRef<HTMLElement | null>(null)
  const quickAddStatusRef = useRef<HTMLParagraphElement | null>(null)
  const lastQuickAddWindowHeightRef = useRef<number | null>(null)
  const statusRef = useRef(status)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const updateSuggestedKeys = useCallback((suggestions: QuickAddSuggestion[]) => {
    setQuickAddSuggestedKeys((previous) => {
      const incomingKeys = suggestions.map((suggestion) =>
        quickEntryActivityKey(suggestion.engagementId, suggestion.activityId),
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
  }, [])

  const loadQuickAddData = useCallback(async () => {
    if (!tauriRuntime) {
      return
    }

    setStatus((previous) => previous === 'submitting' ? previous : 'loading')
    setStatusMessage((previous) => statusRef.current === 'submitting' ? previous : 'Loading Quick Entry...')
    try {
      const [nextSettingsStatus, nextEngagements, nextSuggestions, nextActiveTimer] = await Promise.all([
        settingsGetStatus(),
        engagementList(),
        quickAddSuggestions(),
        timerGetActive(),
      ])

      setSettingsStatus(nextSettingsStatus)
      setEngagements(nextEngagements)
      setQuickAddSuggestionItems(nextSuggestions.suggestions)
      setActiveTimer(nextActiveTimer)
      updateSuggestedKeys(nextSuggestions.suggestions)

      setStatus((previous) => previous === 'submitting' ? previous : 'idle')
      setStatusMessage((previous) => statusRef.current === 'submitting' ? previous : '')
    } catch (error) {
      const messageText = extractErrorMessage(error)
      setStatus('error')
      setStatusMessage(messageText)
    }
  }, [tauriRuntime, updateSuggestedKeys])

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | null = null
    void listen(TIMER_CHANGED_EVENT, () => {
      void timerGetActive().then((nextTimer) => {
        if (!cancelled) {
          setActiveTimer(nextTimer)
        }
      })
    }).then((nextUnlisten) => {
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
  }, [tauriRuntime])

  useEffect(() => {
    if (!activeTimer) {
      return
    }

    const interval = window.setInterval(() => setTimerClock(new Date()), 1000)
    return () => window.clearInterval(interval)
  }, [activeTimer])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadQuickAddData()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadQuickAddData])

  useEffect(() => {
    const handleFocus = () => {
      void loadQuickAddData()
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [loadQuickAddData])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void quickAddHideWindow()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handleBlur = () => {
      window.setTimeout(() => {
        if (statusRef.current !== 'submitting' && !document.hasFocus()) {
          void quickAddHideWindow()
        }
      }, 120)
    }

    window.addEventListener('blur', handleBlur)
    return () => window.removeEventListener('blur', handleBlur)
  }, [])

  const quickAddPreferences = useMemo(
    () => sanitizeQuickAddPreferences(settingsStatus?.quickAddPreferences, engagements),
    [engagements, settingsStatus?.quickAddPreferences],
  )
  const quickEntryModel = useMemo(
    () => buildQuickEntryModel({
      engagements,
      preferences: quickAddPreferences,
      suggestions: quickAddSuggestionItems,
      suggestedKeys: quickAddSuggestedKeys,
    }),
    [
      engagements,
      quickAddPreferences,
      quickAddSuggestedKeys,
      quickAddSuggestionItems,
    ],
  )
  const activityCommandItems = useMemo(
    () => buildQuickEntryModel({
      engagements,
      preferences: quickAddPreferences,
      suggestions: [],
      suggestedKeys: [],
      includeDefaultHiddenActivities: true,
    }).orderedActivities,
    [engagements, quickAddPreferences],
  )
  const shouldShowStatus = status !== 'idle' && statusMessage.trim().length > 0

  const resizeQuickAddWindowToContent = useCallback(() => {
    if (!tauriRuntime) {
      return
    }

    const palette = quickAddPaletteRef.current
    const llmPanel = quickAddLlmPanelRef.current

    if (!palette || !llmPanel) {
      return
    }

    const paletteStyles = window.getComputedStyle(palette)
    const topLevelRows = shouldShowStatus ? 2 : 1
    const topLevelGap = parseCssPixels(paletteStyles.rowGap || paletteStyles.gap)
    const targetHeight = Math.ceil(clampNumber(
      parseCssPixels(paletteStyles.paddingTop) +
        parseCssPixels(paletteStyles.paddingBottom) +
        llmPanel.getBoundingClientRect().height +
        (quickAddStatusRef.current?.getBoundingClientRect().height ?? 0) +
        topLevelGap * Math.max(topLevelRows - 1, 0),
      QUICK_ADD_MIN_WINDOW_HEIGHT,
      QUICK_ADD_MAX_WINDOW_HEIGHT,
    ))

    if (lastQuickAddWindowHeightRef.current !== null
      && Math.abs(lastQuickAddWindowHeightRef.current - targetHeight) < 1
    ) {
      return
    }

    lastQuickAddWindowHeightRef.current = targetHeight
    void quickAddResizeWindow(targetHeight)
      .catch((error) => {
        console.warn('Failed to resize Quick Add window', error)
      })
  }, [shouldShowStatus, tauriRuntime])

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(resizeQuickAddWindowToContent)
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeTimer,
    isBulkEntryOpen,
    isTimerSelectionMode,
    quickEntryModel.orderedActivities,
    resizeQuickAddWindowToContent,
    status,
    statusMessage,
  ])

  const setQuickBlockDragStateWithRef = useCallback(
    (updater: (previous: QuickEntryDragState | null) => QuickEntryDragState | null) => {
      setQuickBlockDragState((previous) => {
        const next = updater(previous)
        quickBlockDragStateRef.current = next
        return next
      })
    },
    [],
  )

  const submitCurrentMessage = useCallback(async () => {
    const rawText = message.trim()
    if (rawText.length === 0 || statusRef.current === 'submitting') {
      return
    }

    if (settingsStatus?.hasOpenAiKey !== true) {
      setStatus('idle')
      setStatusMessage('')
      return
    }

    const submittedAt = new Date()
    setStatus('submitting')
    setStatusMessage('Adding entry...')

    try {
      const result = await interpretTextMessage({
        rawText,
        openAiModel: settingsStatus.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
        clientTimestampIso: submittedAt.toISOString(),
        clientLocalDate: formatDate(submittedAt),
        clientLocalTime: formatLocalTime(submittedAt),
        clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        captureSource: 'text',
      })

      setMessage('')
      setStatus('success')
      setStatusMessage(
        result.createdEntryIds.length === 0
          ? 'No open gaps found.'
          : `Added ${result.createdEntryIds.length} entr${result.createdEntryIds.length === 1 ? 'y' : 'ies'}.`,
      )
      await emit(QUICK_ADD_SUBMITTED_EVENT, {
        createdEntryIds: result.createdEntryIds,
        touchedMonthKeys: result.touchedMonthKeys,
      })
      await quickAddHideWindow()
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [message, settingsStatus])

  const createQuickBlockEntry = useCallback(async (
    engagement: Engagement,
    activity: Activity,
    durationMinutes: number,
  ) => {
    if (statusRef.current === 'submitting' || activity.isActive === false) {
      return
    }

    const date = formatDate(new Date())
    const { startMinute, endMinute } = resolveQuickEntryCreateWindow(durationMinutes)
    setStatus('submitting')
    setStatusMessage(`Adding ${activity.name || activity.code || 'entry'}...`)

    try {
      const result = await timelineCreateEntry({
        date,
        startMinute,
        endMinute,
        engagementId: engagement.id,
        activityId: activity.id,
        description: '',
      })

      setStatus('success')
      setStatusMessage(`Added ${activity.name || activity.code || 'entry'}.`)
      await emit(QUICK_ADD_SUBMITTED_EVENT, {
        createdEntryIds: [result.id],
        touchedMonthKeys: [monthKeyFromDate(date)],
      })
      await quickAddHideWindow()
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [])

  const startActivityTimer = useCallback(async (
    engagement: Engagement,
    activity: Activity,
  ) => {
    if (statusRef.current === 'submitting' || activeTimer) {
      return
    }

    const now = new Date()
    setStatus('submitting')
    setStatusMessage(`Starting ${activity.name || activity.code || 'timer'}...`)

    try {
      const timer = await timerStart({
        engagementId: engagement.id,
        activityId: activity.id,
        startDate: formatDate(now),
        startMinute: now.getHours() * 60 + now.getMinutes(),
      })
      setActiveTimer(timer)
      setTimerClock(now)
      setIsTimerSelectionMode(false)
      setStatus('success')
      setStatusMessage(`Tracking ${activity.name || activity.code || 'activity'}.`)
      await emit(TIMER_CHANGED_EVENT)
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [activeTimer])

  const stopCurrentTimer = useCallback(async () => {
    if (!activeTimer || statusRef.current === 'submitting') {
      return
    }

    const now = new Date()
    const elapsedHours = (now.getTime() - activeTimer.startedAt * 1000) / 3_600_000
    if (
      elapsedHours >= 12
      && !window.confirm(`This timer has been running for ${Math.floor(elapsedHours)} hours. Save the full range?`)
    ) {
      return
    }
    setStatus('submitting')
    setStatusMessage(`Stopping ${activeTimer.activityName}...`)

    try {
      const result = await timerStop({
        stopDate: formatDate(now),
        stopMinute: now.getHours() * 60 + now.getMinutes(),
      })
      setActiveTimer(null)
      setStatus('success')
      setStatusMessage(`Saved ${activeTimer.activityName}.`)
      await emit(TIMER_CHANGED_EVENT)
      await emit(QUICK_ADD_SUBMITTED_EVENT, {
        createdEntryIds: result.createdEntryIds,
        touchedMonthKeys: result.touchedMonthKeys,
      })
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [activeTimer])

  const discardCurrentTimer = useCallback(async () => {
    if (!activeTimer || statusRef.current === 'submitting') {
      return
    }

    setStatus('submitting')
    setStatusMessage('Discarding timer...')
    try {
      await timerCancel()
      setActiveTimer(null)
      setStatus('success')
      setStatusMessage('Timer discarded.')
      await emit(TIMER_CHANGED_EVENT)
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [activeTimer])

  const activeTimerElapsedLabel = activeTimer
    ? formatElapsedTimer(Math.max(0, timerClock.getTime() - activeTimer.startedAt * 1000))
    : null

  const onQuickBlockActivityPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    engagement: Engagement,
    activity: Activity,
    initialDurationMinutes = QUICK_ENTRY_DEFAULT_DURATION_MINUTES,
  ) => {
    if (event.button !== 0 || statusRef.current === 'submitting' || activity.isActive === false) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setQuickBlockDragStateWithRef(() => ({
      engagementId: engagement.id,
      activityId: activity.id,
      activityName: activity.name,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      currentClientX: event.clientX,
      baseDurationMinutes: initialDurationMinutes,
      durationMinutes: initialDurationMinutes,
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

    const nextDuration = quickEntryDurationFromDrag(
      current.originClientX,
      event.clientX,
      current.baseDurationMinutes,
    )
    const nextIsDragging =
      current.isDragging
      || Math.abs(event.clientX - current.originClientX) >= QUICK_ENTRY_DRAG_ACTIVATION_PX

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
    void createQuickBlockEntry(engagement, activity, current.durationMinutes)
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

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitCurrentMessage()
  }

  const openMainTimeline = useCallback(async () => {
    if (statusRef.current === 'submitting') {
      return
    }

    try {
      await quickAddShowMainWindow()
      await emit(QUICK_ADD_OPEN_TIMELINE_EVENT)
    } catch (error) {
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [])

  const onMessageKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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

  const canSubmitText =
    status !== 'submitting'
    && settingsStatus?.hasOpenAiKey === true
    && message.trim().length > 0
  const sendButtonTitle = settingsStatus === null
    ? 'Checking API key status'
    : settingsStatus.hasOpenAiKey
      ? 'Send entry'
      : MISSING_OPENAI_KEY_HINT
  return (
    <main
      ref={quickAddPaletteRef}
      className="quick-add-shell quick-add-palette"
      aria-busy={status === 'loading' || status === 'submitting'}
    >
      <h1 className="sr-only">Quick Add</h1>

      <section
        ref={quickAddLlmPanelRef}
        className="quick-add-command-panel"
        aria-labelledby="quick-add-command-title"
      >
        <div className="quick-add-command-header">
          <h2 id="quick-add-command-title" className="quick-add-section-title">Quick Entry</h2>
          <div className="quick-add-header-actions">
            {!activeTimer ? (
              <button
                type="button"
                className={`quick-add-timer-mode-button ${isTimerSelectionMode ? 'is-active' : ''}`}
                onClick={() => setIsTimerSelectionMode((previous) => !previous)}
                disabled={status === 'submitting'}
                aria-pressed={isTimerSelectionMode}
                aria-label={isTimerSelectionMode ? 'Cancel start timer selection' : 'Start timer'}
                title={isTimerSelectionMode ? 'Cancel start timer selection' : 'Start timer'}
              >
                <TimerIcon className="quick-add-timer-mode-icon" />
              </button>
            ) : null}
            <button
              type="button"
              className="quick-add-home-button"
              onClick={() => void openMainTimeline()}
              disabled={status === 'submitting'}
              aria-label="Open OmniSheet timeline"
              title="Open OmniSheet timeline"
            >
              <svg
                className="quick-add-home-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M4.25 10.75 12 4.25l7.75 6.5v8.75H4.25z" />
              </svg>
            </button>
          </div>
        </div>

        {activeTimer ? (
          <div
            className="quick-add-active-timer"
            style={{ '--quick-add-timer-color': activeTimer.activityColorHex ?? activeTimer.engagementColorHex ?? '#1f7aff' } as CSSProperties}
          >
            <span className="quick-add-active-timer-accent" aria-hidden="true" />
            <span className="quick-add-active-timer-copy">
              <strong>{activeTimer.activityName || activeTimer.activityCode}</strong>
              <small>{activeTimer.engagementName || activeTimer.engagementCode}</small>
            </span>
            <span className="quick-add-active-timer-controls">
              <time>{activeTimerElapsedLabel}</time>
              <span className="quick-add-active-timer-actions">
                <button
                  type="button"
                  className="quick-add-discard-button"
                  onClick={() => void discardCurrentTimer()}
                  disabled={status === 'submitting'}
                  aria-label="Discard running timer"
                  title="Discard running timer"
                >
                  <TrashIcon className="quick-add-timer-action-icon" />
                </button>
                <button
                  type="button"
                  className="quick-add-stop-button"
                  onClick={() => void stopCurrentTimer()}
                  disabled={status === 'submitting'}
                  aria-label="Stop and save timer"
                  title="Stop and save timer"
                >
                  <StopIcon className="quick-add-timer-action-icon quick-add-timer-stop-icon" />
                </button>
              </span>
            </span>
          </div>
        ) : null}

        <ActivityCommandBar
          key={isTimerSelectionMode ? 'tray-timer-command' : 'tray-entry-command'}
          activities={activityCommandItems}
          defaultActivities={quickEntryModel.orderedActivities}
          disabled={status === 'submitting' || status === 'loading'}
          autoFocus
          alwaysShowResults
          placeholder={isTimerSelectionMode ? 'Choose activity to start' : 'Search activities'}
          ariaLabel={isTimerSelectionMode ? 'Choose an activity to start tracking' : 'Search for an activity to add'}
          actionLabel={isTimerSelectionMode ? 'Start' : 'Add'}
          actionIcon="plus"
          defaultEmptyMessage={status === 'loading'
            ? 'Loading activities...'
            : quickEntryModel.allActivities.length === 0
              ? 'No active activities yet.'
              : 'No activities are shown by default. Search to find any active activity.'}
          resultsMaterial="opaque"
          resultsPresentation="inline"
          showDuration={!isTimerSelectionMode}
          contextLabel={isTimerSelectionMode ? 'Starting now — choose what you are working on' : undefined}
          onCancel={() => setIsTimerSelectionMode(false)}
          resultDragState={isTimerSelectionMode ? null : quickBlockDragState}
          onResultPointerDown={isTimerSelectionMode
            ? undefined
            : (event, item, durationMinutes) => onQuickBlockActivityPointerDown(
              event,
              item.engagement,
              item.activity,
              durationMinutes,
            )}
          onResultPointerMove={isTimerSelectionMode
            ? undefined
            : onQuickBlockActivityPointerMove}
          onResultPointerUp={isTimerSelectionMode
            ? undefined
            : (event, item) => onQuickBlockActivityPointerUp(
              event,
              item.engagement,
              item.activity,
            )}
          onResultPointerCancel={isTimerSelectionMode
            ? undefined
            : onQuickBlockActivityPointerCancel}
          onSubmit={(item, durationMinutes) => {
            if (isTimerSelectionMode) {
              void startActivityTimer(item.engagement, item.activity)
              return
            }

            void createQuickBlockEntry(item.engagement, item.activity, durationMinutes)
          }}
        />

        <button
          type="button"
          className="quick-add-bulk-toggle"
          onClick={() => setIsBulkEntryOpen((previous) => !previous)}
          aria-expanded={isBulkEntryOpen}
          aria-controls="quick-add-bulk-entry"
        >
          <span>Bulk entry with AI</span>
          <span aria-hidden="true">{isBulkEntryOpen ? '−' : '+'}</span>
        </button>

        {isBulkEntryOpen ? (
          <form id="quick-add-bulk-entry" className="quick-add-command" onSubmit={onSubmit}>
            <label className="quick-add-entry-bar">
              <span className="sr-only">Describe several timesheet entries</span>
              <textarea
                value={message}
                onKeyDown={onMessageKeyDown}
                onChange={(event) => {
                  setMessage(event.target.value)
                  if (statusRef.current === 'submitting') {
                    return
                  }

                  setStatus('idle')
                  setStatusMessage('')
                }}
                placeholder={LLM_ENTRY_EXAMPLE_TEXT}
                rows={1}
                disabled={status === 'submitting'}
              />
              <span className="quick-add-send-hint" title={sendButtonTitle}>
                <button
                  type="submit"
                  className="quick-add-send-button"
                  disabled={!canSubmitText}
                  aria-label="Create bulk entries"
                >
                  <svg
                    className="quick-add-send-icon"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M8 13V3.75" />
                    <path d="M4.25 7.5 8 3.75 11.75 7.5" />
                  </svg>
                </button>
              </span>
            </label>
          </form>
        ) : null}
      </section>

      {shouldShowStatus ? (
        <p ref={quickAddStatusRef} className={`quick-add-status ${status}`}>
          {statusMessage}
        </p>
      ) : null}
    </main>
  )
}

function parseCssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function formatLocalTime(value: Date): string {
  const hour = `${value.getHours()}`.padStart(2, '0')
  const minute = `${value.getMinutes()}`.padStart(2, '0')
  return `${hour}:${minute}`
}

function formatElapsedTimer(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => `${value}`.padStart(2, '0')).join(':')
}

function monthKeyFromDate(date: string): string {
  return date.slice(0, 7)
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }

  return 'Something went wrong.'
}

export default QuickAdd
