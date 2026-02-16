import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  activityDelete,
  activityUpsert,
  diagnosticsCopyBundle,
  diagnosticsList,
  engagementDelete,
  engagementList,
  engagementUpsert,
  interpretTextMessage,
  maintenanceRepairSuspiciousEntries,
  isAppCommandError,
  settingsGetStatus,
  settingsSetOpenAiKey,
  timelineListForDate,
  timelineUpdateEntry,
} from './lib/api'
import { isTauriRuntime } from './lib/runtime'
import {
  durationToHourLabel,
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
  DiagnosticsEvent,
  Engagement,
  InterpretResult,
  SettingsStatus,
  TimelineEntry,
  WarningType,
} from './lib/types'
import './App.css'

type View = 'capture' | 'timeline' | 'codes' | 'settings' | 'diagnostics'
type DiagnosticsFilter = 'all' | 'errors' | 'warnings' | 'capture' | 'settings'

interface CaptureStatus {
  state: 'idle' | 'running' | 'success' | 'error'
  message: string
  correlationId?: string
}

interface EngagementFormState {
  id?: string
  code: string
  name: string
  client: string
  tags: string
  isActive: boolean
}

interface ActivityFormState {
  id?: string
  engagementId: string
  code: string
  name: string
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
}

interface TimelineWindow {
  startMinute: number
  endMinute: number
}

const EMPTY_ENGAGEMENT_FORM: EngagementFormState = {
  code: '',
  name: '',
  client: '',
  tags: '',
  isActive: true,
}

const EMPTY_ACTIVITY_FORM: ActivityFormState = {
  engagementId: '',
  code: '',
  name: '',
  tags: '',
  isActive: true,
}

const DEFAULT_TIMELINE_START = 6 * 60
const DEFAULT_TIMELINE_END = 18 * 60
const TIMELINE_PADDING_MINUTES = 30
const MINUTES_IN_DAY = 24 * 60
const HOUR_IN_MINUTES = 60
const PIXELS_PER_MINUTE = 1
const EMPTY_CAPTURE_STATUS: CaptureStatus = {
  state: 'idle',
  message: 'No capture submitted yet.',
}

function App() {
  const tauriRuntime = isTauriRuntime()

  const [activeView, setActiveView] = useState<View>('capture')
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [openAiKey, setOpenAiKey] = useState('')

  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [engagementForm, setEngagementForm] =
    useState<EngagementFormState>(EMPTY_ENGAGEMENT_FORM)
  const [activityForm, setActivityForm] = useState<ActivityFormState>(EMPTY_ACTIVITY_FORM)

  const [captureMessage, setCaptureMessage] = useState('')
  const [interpretResult, setInterpretResult] = useState<InterpretResult | null>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>(EMPTY_CAPTURE_STATUS)

  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()))
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryDraft | null>(null)
  const [diagnosticsFilter, setDiagnosticsFilter] = useState<DiagnosticsFilter>('all')
  const [diagnosticsEvents, setDiagnosticsEvents] = useState<DiagnosticsEvent[]>([])
  const [diagnosticsBundleText, setDiagnosticsBundleText] = useState('')

  const selectedEntry = useMemo(
    () => timelineEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [selectedEntryId, timelineEntries],
  )

  const timelineWindow = useMemo(
    () => computeTimelineWindow(timelineEntries),
    [timelineEntries],
  )

  const timelineWindowMinutes = timelineWindow.endMinute - timelineWindow.startMinute
  const timelineGridHeight = timelineWindowMinutes * PIXELS_PER_MINUTE + 20

  const timelineHourMarks = useMemo(() => {
    const marks: number[] = []
    for (
      let minute = timelineWindow.startMinute;
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
  }, [])

  const loadTimeline = useCallback(async (date: string) => {
    const entries = await timelineListForDate({ date })
    setTimelineEntries(entries)
    return entries
  }, [])

  const loadDiagnostics = useCallback(async (filter: DiagnosticsFilter = diagnosticsFilter) => {
    const events = await diagnosticsList({
      limit: 100,
      filter: filter === 'all' ? undefined : filter,
    })
    setDiagnosticsEvents(events)
  }, [diagnosticsFilter])

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
          loadTimeline(selectedDate),
          loadDiagnostics(),
        ])
      } catch (error) {
        setErrorMessage((error as Error).message)
      } finally {
        setIsBusy(false)
      }
    }

    void initialize()
  }, [loadDiagnostics, loadEngagements, loadSettings, loadTimeline, selectedDate, tauriRuntime])

  useEffect(() => {
    if (!selectedEntryId) {
      return
    }

    if (timelineEntries.every((entry) => entry.id !== selectedEntryId)) {
      setSelectedEntryId(null)
      setEntryDraft(null)
    }
  }, [selectedEntryId, timelineEntries])

  useEffect(() => {
    if (!tauriRuntime || activeView !== 'diagnostics') {
      return
    }

    void loadDiagnostics()
  }, [activeView, loadDiagnostics, tauriRuntime, diagnosticsFilter])

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([loadEngagements(), loadTimeline(selectedDate), loadSettings()])
  }, [loadEngagements, loadSettings, loadTimeline, selectedDate])

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      try {
        setIsBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        await action()
      } catch (error) {
        if (isAppCommandError(error)) {
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          setErrorMessage((error as Error).message)
        }
      } finally {
        setIsBusy(false)
      }
    },
    [],
  )

  const onSubmitCapture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void (async () => {
      const messageToSend = captureMessage

      try {
        setIsBusy(true)
        setErrorMessage(null)
        setSuccessMessage(null)
        setCaptureStatus({
          state: 'running',
          message: 'Submitting message for interpretation...',
        })

        const submittedAt = new Date()
        const result = await interpretTextMessage({
          rawText: messageToSend,
          clientTimestampIso: submittedAt.toISOString(),
          clientLocalDate: formatDate(submittedAt),
          clientLocalTime: formatLocalTime(submittedAt),
          clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        })

        const selectedDayEntries = await loadTimeline(selectedDate)
        const createdOnSelectedDate = selectedDayEntries.filter((entry) =>
          result.createdEntryIds.includes(entry.id),
        ).length

        setInterpretResult(result)
        setCaptureMessage('')
        const normalizationNote =
          result.normalizationNotes.length > 0
            ? ` ${result.normalizationNotes[0]}`
            : ''

        setCaptureStatus({
          state: 'success',
          message:
            createdOnSelectedDate > 0
              ? `Interpretation completed. ${createdOnSelectedDate} new timeline entr${createdOnSelectedDate === 1 ? 'y' : 'ies'} on selected day.${normalizationNote}`
              : `Interpretation completed, but no new entries landed on the selected day.${normalizationNote}`,
          correlationId: result.correlationId,
        })
        setSuccessMessage('Message interpretation finished.')
      } catch (error) {
        if (isAppCommandError(error)) {
          setCaptureStatus({
            state: 'error',
            message: error.message,
            correlationId: error.correlationId,
          })
          setErrorMessage(
            `${error.message} (command: ${error.command}, correlationId: ${error.correlationId})`,
          )
        } else {
          const message = (error as Error).message
          setCaptureStatus({
            state: 'error',
            message,
          })
          setErrorMessage(message)
        }
      } finally {
        setIsBusy(false)
      }
    })()
  }

  const onSubmitEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await engagementUpsert({
        id: engagementForm.id,
        code: engagementForm.code,
        name: engagementForm.name,
        client: engagementForm.client || null,
        tags: parseTagInput(engagementForm.tags),
        isActive: engagementForm.isActive,
      })

      setEngagementForm(EMPTY_ENGAGEMENT_FORM)
      await refreshAfterMutation()
      setSuccessMessage('Engagement saved.')
    })
  }

  const onDeleteEngagement = (id: string) => {
    void runAction(async () => {
      await engagementDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Engagement deleted.')
    })
  }

  const onEditEngagement = (engagement: Engagement) => {
    setEngagementForm({
      id: engagement.id,
      code: engagement.code,
      name: engagement.name,
      client: engagement.client ?? '',
      tags: joinTags(engagement.tags),
      isActive: engagement.isActive,
    })
  }

  const onSubmitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await activityUpsert({
        id: activityForm.id,
        engagementId: activityForm.engagementId,
        code: activityForm.code,
        name: activityForm.name,
        tags: parseTagInput(activityForm.tags),
        isActive: activityForm.isActive,
      })

      setActivityForm((previous) => ({
        ...EMPTY_ACTIVITY_FORM,
        engagementId: previous.engagementId,
      }))
      await refreshAfterMutation()
      setSuccessMessage('Activity saved.')
    })
  }

  const onDeleteActivity = (id: string) => {
    void runAction(async () => {
      await activityDelete(id)
      await refreshAfterMutation()
      setSuccessMessage('Activity deleted.')
    })
  }

  const onEditActivity = (activity: Activity) => {
    setActivityForm({
      id: activity.id,
      engagementId: activity.engagementId,
      code: activity.code,
      name: activity.name,
      tags: joinTags(activity.tags),
      isActive: activity.isActive,
    })
  }

  const onSetDate = (nextDate: string) => {
    setSelectedDate(nextDate)
    setSelectedEntryId(null)
    setEntryDraft(null)
  }

  const onSelectEntry = (entry: TimelineEntry) => {
    setSelectedEntryId(entry.id)
    setEntryDraft({
      id: entry.id,
      date: entry.date,
      engagementId: entry.engagementId ?? '',
      activityId: entry.activityId ?? '',
      description: entry.description,
      startTime: minuteToTimeInput(entry.startMinute),
      endTime: minuteToTimeInput(entry.endMinute),
    })
  }

  const onSaveEntryDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!entryDraft) {
      return
    }

    void runAction(async () => {
      await timelineUpdateEntry({
        id: entryDraft.id,
        engagementId: entryDraft.engagementId || null,
        activityId: entryDraft.activityId || null,
        date: entryDraft.date,
        startMinute: timeInputToMinute(entryDraft.startTime),
        endMinute: timeInputToMinute(entryDraft.endTime),
        description: entryDraft.description,
      })

      await loadTimeline(selectedDate)
      setSuccessMessage('Timeline entry updated.')
    })
  }

  const onSaveApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void runAction(async () => {
      await settingsSetOpenAiKey(openAiKey)
      setOpenAiKey('')
      const status = await settingsGetStatus()
      setSettingsStatus(status)

      if (!status.hasOpenAiKey) {
        throw new Error(
          `Key save verification failed. Storage health: ${status.storageHealth}. ${status.lastError ?? ''}`.trim(),
        )
      }

      if (status.statusLevel === 'warning') {
        setSuccessMessage(
          'OpenAI API key saved. Running from in-memory session key because keyring readback is unavailable.',
        )
      } else {
        setSuccessMessage('OpenAI API key saved securely.')
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

  const onRepairSuspiciousEntries = () => {
    void runAction(async () => {
      const result = await maintenanceRepairSuspiciousEntries({ limit: 300 })
      await Promise.all([loadTimeline(selectedDate), loadDiagnostics(diagnosticsFilter)])
      setSuccessMessage(
        `Temporal repair complete. Repaired ${result.repairedCount} of ${result.scannedCount} suspicious entries.`,
      )
    })
  }

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
      <header className="app-header">
        <div>
          <p className="app-eyebrow">OmniSheet</p>
          <h1>Time Capture Console</h1>
        </div>
        <div className="header-right">
          <span>{selectedDate}</span>
          {isBusy && <span className="status-chip">Working...</span>}
        </div>
      </header>

      <nav className="app-nav">
        <button
          type="button"
          className={activeView === 'capture' ? 'active' : ''}
          onClick={() => setActiveView('capture')}
        >
          Capture
        </button>
        <button
          type="button"
          className={activeView === 'timeline' ? 'active' : ''}
          onClick={() => setActiveView('timeline')}
        >
          Timeline
        </button>
        <button
          type="button"
          className={activeView === 'codes' ? 'active' : ''}
          onClick={() => setActiveView('codes')}
        >
          Codes
        </button>
        <button
          type="button"
          className={activeView === 'settings' ? 'active' : ''}
          onClick={() => setActiveView('settings')}
        >
          Settings
        </button>
        <button
          type="button"
          className={activeView === 'diagnostics' ? 'active' : ''}
          onClick={() => setActiveView('diagnostics')}
        >
          Diagnostics
        </button>
      </nav>

      {errorMessage ? <p className="alert error">{errorMessage}</p> : null}
      {successMessage ? <p className="alert success">{successMessage}</p> : null}

      <main className="app-content">
        {activeView === 'capture' ? (
          <section className="panel">
            <h2>Message Input</h2>
            <form onSubmit={onSubmitCapture} className="stack">
              <textarea
                value={captureMessage}
                onChange={(event) => setCaptureMessage(event.target.value)}
                placeholder="Example: Just finished a 30 minute SAP ITGC meeting with the Apple team"
                rows={5}
                required
              />
              <button type="submit" disabled={isBusy || captureMessage.trim().length === 0}>
                Interpret + Save
              </button>
            </form>

            <div className={`result-card capture-status ${captureStatus.state}`}>
              <h3>Capture Status</h3>
              <p>{captureStatus.message}</p>
              {captureStatus.correlationId ? (
                <p>
                  Correlation ID: <code>{captureStatus.correlationId}</code>
                </p>
              ) : null}
              {interpretResult ? (
                <>
                  <p>Raw message ID: {interpretResult.rawMessageId}</p>
                  <p>Entries created: {interpretResult.createdEntryIds.length}</p>
                  <div className="warning-row">
                    {interpretResult.warnings.map((warning) => (
                      <WarningBadge key={`${warning.entryId}-${warning.warningType}`} type={warning.warningType} />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeView === 'timeline' ? (
          <section className="panel timeline-panel">
            <div className="timeline-toolbar">
              <div>
                <h2>Daily Timeline</h2>
                <p className="timeline-range">
                  Visible range: {minuteToLabel(timelineWindow.startMinute)} -{' '}
                  {formatTimelineRangeEndLabel(timelineWindow.endMinute)}
                </p>
              </div>
              <div className="timeline-controls">
                <button type="button" onClick={() => onSetDate(shiftDate(selectedDate, -1))}>
                  Previous
                </button>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => onSetDate(event.target.value)}
                />
                <button type="button" onClick={() => onSetDate(shiftDate(selectedDate, 1))}>
                  Next
                </button>
              </div>
            </div>

            <div className="timeline-layout">
              <div
                className="timeline-grid"
                role="list"
                aria-label="Timeline entries"
                style={{ minHeight: `${timelineGridHeight}px` }}
              >
                {timelineHourMarks.map((minute) => (
                  <div
                    key={minute}
                    className="timeline-hour-mark"
                    style={{
                      top:
                        (minute - timelineWindow.startMinute) * PIXELS_PER_MINUTE,
                    }}
                  >
                    <span>{minuteToLabel(minute)}</span>
                  </div>
                ))}

                {timelineEntries.map((entry) => {
                  const clippedStart = Math.max(entry.startMinute, timelineWindow.startMinute)
                  const clippedEnd = Math.min(entry.endMinute, timelineWindow.endMinute)

                  if (clippedEnd <= clippedStart) {
                    return null
                  }

                  const top =
                    (clippedStart - timelineWindow.startMinute) * PIXELS_PER_MINUTE
                  const height = Math.max(
                    (clippedEnd - clippedStart) * PIXELS_PER_MINUTE,
                    30,
                  )

                  return (
                    <button
                      type="button"
                      key={entry.id}
                      className={`timeline-block ${selectedEntryId === entry.id ? 'selected' : ''}`}
                      style={{
                        top,
                        height,
                        backgroundColor: colorForEngagement(entry.engagementId),
                      }}
                      onClick={() => onSelectEntry(entry)}
                      title={entry.description}
                      aria-label={`${entry.engagementCode ?? 'UNCAT'} ${entry.activityCode ?? 'UNCAT'} ${entry.description}`}
                    >
                      <strong>{entry.engagementCode ?? 'UNCAT'} / {entry.activityCode ?? 'UNCAT'}</strong>
                      <span className="timeline-block-meta">
                        {durationToHourLabel(entry.durationMinutes)}
                        {entry.warningFlags.length > 0
                          ? ` | ${entry.warningFlags.length} warning${entry.warningFlags.length === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </button>
                  )
                })}
              </div>

              <aside className="timeline-editor">
                <h3>Edit Entry</h3>
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
                            {engagement.code} {engagement.name}
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
                            {activity.code} {activity.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Start
                      <input
                        type="time"
                        step={1800}
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
                    </label>
                    <label>
                      End
                      <input
                        type="time"
                        step={1800}
                        value={entryDraft.endTime}
                        onChange={(event) =>
                          setEntryDraft((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  endTime: event.target.value,
                                }
                              : previous,
                          )
                        }
                      />
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
                    <button type="submit" disabled={isBusy}>
                      Save Entry
                    </button>
                  </form>
                ) : (
                  <p>Select a timeline block to edit engagement, activity, and timing.</p>
                )}

                {selectedEntry ? (
                  <div className="entry-metadata">
                    <p>
                      Confidence: {(selectedEntry.confidence * 100).toFixed(0)}%
                    </p>
                    <p>Source: {selectedEntry.source}</p>
                    <p>Description: {selectedEntry.description}</p>
                    {selectedEntry.warningFlags.length > 0 ? (
                      <div className="warning-row">
                        {selectedEntry.warningFlags.map((warningType) => (
                          <WarningBadge key={`${selectedEntry.id}-${warningType}`} type={warningType} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </aside>
            </div>
          </section>
        ) : null}

        {activeView === 'codes' ? (
          <section className="panel code-panel">
            <div className="code-forms">
              <form className="stack" onSubmit={onSubmitEngagement}>
                <h2>{engagementForm.id ? 'Edit Engagement' : 'Add Engagement'}</h2>
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
                    required
                  />
                </label>
                <label>
                  Name
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
                  Tags (comma separated)
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
                <button type="submit" disabled={isBusy}>
                  {engagementForm.id ? 'Update Engagement' : 'Create Engagement'}
                </button>
                {engagementForm.id ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setEngagementForm(EMPTY_ENGAGEMENT_FORM)}
                  >
                    Cancel Editing
                  </button>
                ) : null}
              </form>

              <form className="stack" onSubmit={onSubmitActivity}>
                <h2>{activityForm.id ? 'Edit Activity' : 'Add Activity'}</h2>
                <label>
                  Engagement
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
                        {engagement.code} {engagement.name}
                      </option>
                    ))}
                  </select>
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
                    required
                  />
                </label>
                <label>
                  Name
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
                  Tags (comma separated)
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
                <button type="submit" disabled={isBusy || engagements.length === 0}>
                  {activityForm.id ? 'Update Activity' : 'Create Activity'}
                </button>
                {activityForm.id ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setActivityForm((previous) => ({
                        ...EMPTY_ACTIVITY_FORM,
                        engagementId: previous.engagementId,
                      }))
                    }
                  >
                    Cancel Editing
                  </button>
                ) : null}
              </form>
            </div>

            <div className="code-list">
              {engagements.map((engagement) => (
                <article key={engagement.id} className="engagement-card">
                  <header>
                    <div>
                      <h3>
                        {engagement.code} {engagement.name}
                      </h3>
                      <p>{engagement.client ?? 'No client'}</p>
                      <p>{joinTags(engagement.tags) || 'No tags'}</p>
                    </div>
                    <div className="row-actions">
                      <button type="button" onClick={() => onEditEngagement(engagement)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => onDeleteEngagement(engagement.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </header>
                  <ul>
                    {engagement.activities.map((activity) => (
                      <li key={activity.id}>
                        <div>
                          <strong>{activity.code} {activity.name}</strong>
                          <span>{joinTags(activity.tags) || 'No tags'}</span>
                        </div>
                        <div className="row-actions">
                          <button type="button" onClick={() => onEditActivity(activity)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => onDeleteActivity(activity.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {activeView === 'settings' ? (
          <section className="panel">
            <h2>Settings</h2>
            <form className="stack" onSubmit={onSaveApiKey}>
              <label>
                OpenAI API Key
                <input
                  type="password"
                  value={openAiKey}
                  onChange={(event) => setOpenAiKey(event.target.value)}
                  placeholder="sk-..."
                  required
                />
              </label>
              <button type="submit" disabled={isBusy || openAiKey.trim().length === 0}>
                Save Key to Secure Storage
              </button>
            </form>
            <p>
              Key configured: <strong>{settingsStatus?.hasOpenAiKey ? 'Yes' : 'No'}</strong>
            </p>
            <p>
              Storage health:{' '}
              <strong>{settingsStatus?.storageHealth ?? 'unknown'}</strong>
            </p>
            <p>
              Key source: <strong>{formatKeySource(settingsStatus?.keySource)}</strong>
            </p>
            {settingsStatus?.lastError ? (
              <p className={`alert ${settingsStatus?.statusLevel === 'error' ? 'error' : 'warning'}`}>
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
                <button type="button" onClick={onRepairSuspiciousEntries} disabled={isBusy}>
                  Repair Midnight Entries
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
      </main>
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

function formatDiagnosticsTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

function formatLocalTime(value: Date): string {
  const hours = `${value.getHours()}`.padStart(2, '0')
  const minutes = `${value.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
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

function formatTimelineRangeEndLabel(minute: number): string {
  if (minute >= MINUTES_IN_DAY) {
    return '12:00 AM (next day)'
  }

  return minuteToLabel(minute)
}

function computeTimelineWindow(entries: TimelineEntry[]): TimelineWindow {
  if (entries.length === 0) {
    return {
      startMinute: DEFAULT_TIMELINE_START,
      endMinute: DEFAULT_TIMELINE_END,
    }
  }

  const earliestStart = Math.max(
    0,
    Math.min(...entries.map((entry) => entry.startMinute)) - TIMELINE_PADDING_MINUTES,
  )
  const latestEnd = Math.min(
    MINUTES_IN_DAY,
    Math.max(...entries.map((entry) => entry.endMinute)) + TIMELINE_PADDING_MINUTES,
  )

  const startMinute = Math.max(
    0,
    Math.floor(earliestStart / HOUR_IN_MINUTES) * HOUR_IN_MINUTES,
  )
  let endMinute = Math.min(
    MINUTES_IN_DAY,
    Math.ceil(latestEnd / HOUR_IN_MINUTES) * HOUR_IN_MINUTES,
  )

  if (endMinute <= startMinute) {
    endMinute = Math.min(startMinute + HOUR_IN_MINUTES, MINUTES_IN_DAY)
  }

  return {
    startMinute,
    endMinute,
  }
}

function colorForEngagement(engagementId: string | null): string {
  if (!engagementId) {
    return '#6f7b89'
  }

  const palette = ['#1570ef', '#0f766e', '#d97706', '#b42318', '#4f46e5', '#0e7490']

  let hash = 0
  for (let index = 0; index < engagementId.length; index += 1) {
    hash = (hash << 5) - hash + engagementId.charCodeAt(index)
    hash |= 0
  }

  return palette[Math.abs(hash) % palette.length]
}

export default App

