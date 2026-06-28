import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { emit } from '@tauri-apps/api/event'

import {
  interpretTextMessage,
  quickAddHideWindow,
  quickAddShowMainWindow,
  settingsGetStatus,
  transcribeAudioClip,
  voiceRequestMicrophonePermission,
} from './lib/api'
import { QUICK_ADD_SUBMITTED_EVENT } from './lib/events'
import { isTauriRuntime } from './lib/runtime'
import { formatDate } from './lib/time'
import type { CaptureSourceId, OpenAiModelId, SettingsStatus, TranscriptionModelId } from './lib/types'
import microphoneIcon from './assets/icons/microphone.svg'
import './QuickAdd.css'

type VoiceCaptureState = 'idle' | 'recording' | 'transcribing'
type QuickAddStatus = 'idle' | 'submitting' | 'success' | 'error'

interface VoiceDraftMetadata {
  capturedAtMs: number
  transcriptionModelUsed: TranscriptionModelId
  transcriptionModelUsedLabel: string
  transcriptionDurationMs: number
}

interface RecordingResult {
  blob: Blob
  mimeType: string
  capturedAtMs: number
  durationMs: number
}

const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-5.5-instant'
const PREFERRED_VOICE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
] as const

function QuickAdd() {
  const tauriRuntime = isTauriRuntime()
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [message, setMessage] = useState('')
  const [voiceDraftMetadata, setVoiceDraftMetadata] = useState<VoiceDraftMetadata | null>(null)
  const [voiceCaptureState, setVoiceCaptureState] = useState<VoiceCaptureState>('idle')
  const [status, setStatus] = useState<QuickAddStatus>(tauriRuntime ? 'idle' : 'error')
  const [statusMessage, setStatusMessage] = useState(
    tauriRuntime
      ? 'Ready.'
      : 'Quick Add requires the Tauri desktop runtime.',
  )

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtMsRef = useRef<number | null>(null)
  const voiceMimeTypeRef = useRef('audio/webm')

  useEffect(() => {
    if (!tauriRuntime) {
      return
    }

    let isMounted = true

    settingsGetStatus()
      .then((nextStatus) => {
        if (!isMounted) {
          return
        }

        setSettingsStatus(nextStatus)
        if (!nextStatus.hasOpenAiKey) {
          setStatus('error')
          setStatusMessage('Add your OpenAI key in OmniSheet settings before submitting entries.')
        }
      })
      .catch((error) => {
        if (!isMounted) {
          return
        }

        setStatus('error')
        setStatusMessage(extractErrorMessage(error))
      })

    return () => {
      isMounted = false
    }
  }, [tauriRuntime])

  const stopVoiceCaptureStream = useCallback(() => {
    for (const track of mediaStreamRef.current?.getTracks() ?? []) {
      track.stop()
    }

    mediaStreamRef.current = null
  }, [])

  const finalizeRecording = useCallback(async (): Promise<RecordingResult | null> => {
    const recorder = mediaRecorderRef.current
    const startedAtMs = voiceStartedAtMsRef.current

    if (!recorder || recorder.state === 'inactive' || startedAtMs === null) {
      return null
    }

    const capturedAtMs = Date.now()
    const durationMs = Math.max(1, capturedAtMs - startedAtMs)
    setVoiceCaptureState('transcribing')
    setStatus('submitting')
    setStatusMessage('Transcribing voice note...')

    const blob = await new Promise<Blob>((resolve, reject) => {
      const handleStop = () => {
        recorder.removeEventListener('error', handleError)
        stopVoiceCaptureStream()
        mediaRecorderRef.current = null
        const mimeType = recorder.mimeType || voiceMimeTypeRef.current || 'audio/webm'
        const nextBlob = new Blob(voiceChunksRef.current, { type: mimeType })
        voiceChunksRef.current = []
        voiceStartedAtMsRef.current = null
        resolve(nextBlob)
      }

      const handleError = () => {
        recorder.removeEventListener('stop', handleStop)
        stopVoiceCaptureStream()
        mediaRecorderRef.current = null
        voiceChunksRef.current = []
        voiceStartedAtMsRef.current = null
        reject(new Error('Audio recording failed.'))
      }

      recorder.addEventListener('stop', handleStop, { once: true })
      recorder.addEventListener('error', handleError, { once: true })
      recorder.stop()
    })

    return {
      blob,
      mimeType: blob.type || voiceMimeTypeRef.current || 'audio/webm',
      capturedAtMs,
      durationMs,
    }
  }, [stopVoiceCaptureStream])

  const transcribeRecording = useCallback(async (recording: RecordingResult) => {
    const audioBase64 = await blobToBase64(recording.blob)
    const transcription = await transcribeAudioClip({
      audioBase64,
      mimeType: recording.mimeType,
      durationMs: recording.durationMs,
      captureTimestampIso: new Date(recording.capturedAtMs).toISOString(),
    })

    return {
      ...transcription,
      capturedAtMs: recording.capturedAtMs,
    }
  }, [])

  const submitMessage = useCallback(async (
    rawText: string,
    submittedAt: Date,
    captureSource: CaptureSourceId,
    metadata?: VoiceDraftMetadata | null,
  ) => {
    setStatus('submitting')
    setStatusMessage('Adding entry...')

    const result = await interpretTextMessage({
      rawText,
      openAiModel: settingsStatus?.selectedOpenAiModel ?? DEFAULT_OPENAI_MODEL,
      clientTimestampIso: submittedAt.toISOString(),
      clientLocalDate: formatDate(submittedAt),
      clientLocalTime: formatLocalTime(submittedAt),
      clientUtcOffsetMinutes: -submittedAt.getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      captureSource,
      transcriptionModel: metadata?.transcriptionModelUsed,
      transcriptionDurationMs: metadata?.transcriptionDurationMs,
    })

    setMessage('')
    setVoiceDraftMetadata(null)
    void emit(QUICK_ADD_SUBMITTED_EVENT, {
      createdEntryIds: result.createdEntryIds,
      touchedMonthKeys: result.touchedMonthKeys,
    })
    setStatus('success')
    setStatusMessage(
      result.createdEntryIds.length === 0
        ? 'No open gaps found.'
        : `Added ${result.createdEntryIds.length} entr${result.createdEntryIds.length === 1 ? 'y' : 'ies'}.`,
    )
  }, [settingsStatus])

  const submitCurrentMessage = useCallback(async () => {
    const text = message.trim()
    if (text.length === 0) {
      return
    }

    await submitMessage(text, new Date(voiceDraftMetadata?.capturedAtMs ?? Date.now()), voiceDraftMetadata ? 'voice' : 'text', voiceDraftMetadata)
  }, [message, submitMessage, voiceDraftMetadata])

  const startVoiceRecording = useCallback(async () => {
    if (voiceCaptureState !== 'idle') {
      return
    }

    if (!canUseMediaRecorder()) {
      setStatus('error')
      setStatusMessage('Voice recording is unavailable in this runtime.')
      return
    }

    if (isMacRuntime()) {
      const permission = await voiceRequestMicrophonePermission()
      if (permission.status !== 'granted' && permission.status !== 'unsupported') {
        setStatus('error')
        setStatusMessage('Microphone access is not available. Enable OmniSheet in macOS privacy settings, then try again.')
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
      voiceStartedAtMsRef.current = Date.now()
      voiceMimeTypeRef.current = recorder.mimeType || preferredMimeType || 'audio/webm'

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data)
        }
      })

      recorder.start()
      setVoiceCaptureState('recording')
      setStatus('idle')
      setStatusMessage('Recording voice note...')
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop()
      }

      mediaStreamRef.current = null
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceStartedAtMsRef.current = null
      setVoiceCaptureState('idle')
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [voiceCaptureState])

  const stopVoiceRecordingToDraft = useCallback(async () => {
    try {
      const recording = await finalizeRecording()
      if (!recording) {
        return
      }

      const transcription = await transcribeRecording(recording)
      setMessage(transcription.transcriptText)
      setVoiceDraftMetadata({
        capturedAtMs: transcription.capturedAtMs,
        transcriptionModelUsed: transcription.transcriptionModelUsed,
        transcriptionModelUsedLabel: transcription.transcriptionModelUsedLabel,
        transcriptionDurationMs: transcription.transcriptionDurationMs,
      })
      setVoiceCaptureState('idle')
      setStatus('success')
      setStatusMessage(`Transcript ready using ${transcription.transcriptionModelUsedLabel}.`)
    } catch (error) {
      stopVoiceCaptureStream()
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceStartedAtMsRef.current = null
      setVoiceCaptureState('idle')
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [finalizeRecording, stopVoiceCaptureStream, transcribeRecording])

  const stopVoiceRecordingAndSubmit = useCallback(async () => {
    try {
      const recording = await finalizeRecording()
      if (!recording) {
        return
      }

      const transcription = await transcribeRecording(recording)
      setVoiceCaptureState('idle')
      await submitMessage(
        transcription.transcriptText,
        new Date(transcription.capturedAtMs),
        'voice',
        {
          capturedAtMs: transcription.capturedAtMs,
          transcriptionModelUsed: transcription.transcriptionModelUsed,
          transcriptionModelUsedLabel: transcription.transcriptionModelUsedLabel,
          transcriptionDurationMs: transcription.transcriptionDurationMs,
        },
      )
    } catch (error) {
      stopVoiceCaptureStream()
      mediaRecorderRef.current = null
      voiceChunksRef.current = []
      voiceStartedAtMsRef.current = null
      setVoiceCaptureState('idle')
      setStatus('error')
      setStatusMessage(extractErrorMessage(error))
    }
  }, [finalizeRecording, stopVoiceCaptureStream, submitMessage, transcribeRecording])

  useEffect(() => () => {
    stopVoiceCaptureStream()
    mediaRecorderRef.current = null
    voiceChunksRef.current = []
    voiceStartedAtMsRef.current = null
  }, [stopVoiceCaptureStream])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void quickAddHideWindow()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (voiceCaptureState === 'recording') {
      void stopVoiceRecordingAndSubmit()
      return
    }

    void submitCurrentMessage()
  }

  const isBusy = status === 'submitting' || voiceCaptureState === 'transcribing'
  const canSubmit = voiceCaptureState === 'recording' || message.trim().length > 0

  return (
    <main className="quick-add-shell">
      <header className="quick-add-header">
        <div>
          <h1>Add timesheet entry</h1>
        </div>
        <button
          type="button"
          className="quick-add-close"
          onClick={() => void quickAddHideWindow()}
          aria-label="Close Quick Add"
          title="Close"
        >
          x
        </button>
      </header>

      <form className="quick-add-form" onSubmit={onSubmit}>
        <textarea
          value={message}
          onChange={(event) => {
            setMessage(event.target.value)
            setVoiceDraftMetadata(null)
            if (status !== 'submitting') {
              setStatus('idle')
              setStatusMessage('Ready.')
            }
          }}
          placeholder="Finished a 30 minute SAP ITGC meeting with Apple"
          rows={4}
          disabled={isBusy}
          autoFocus
        />

        <p className={`quick-add-status ${status} ${voiceCaptureState === 'recording' ? 'recording' : ''}`}>
          {statusMessage}
        </p>

        <div className="quick-add-actions">
          <button
            type="button"
            className={`quick-add-mic-button ${voiceCaptureState === 'recording' ? 'recording' : ''}`}
            onClick={() => {
              if (voiceCaptureState === 'recording') {
                void stopVoiceRecordingToDraft()
                return
              }

              void startVoiceRecording()
            }}
            disabled={isBusy && voiceCaptureState !== 'recording'}
            aria-label={voiceCaptureState === 'recording' ? 'Stop recording' : 'Start recording'}
            title={voiceCaptureState === 'recording' ? 'Stop recording' : 'Start recording'}
          >
            <img src={microphoneIcon} alt="" aria-hidden="true" />
          </button>

          <button type="submit" className="quick-add-send" disabled={isBusy || !canSubmit}>
            {voiceCaptureState === 'recording' ? 'Stop & Send' : 'Send'}
          </button>

          <button
            type="button"
            className="quick-add-open-app"
            onClick={() => void quickAddShowMainWindow()}
          >
            Open App
          </button>
        </div>
      </form>
    </main>
  )
}

function canUseMediaRecorder(): boolean {
  return (
    typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices !== 'undefined'
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined'
  )
}

function isMacRuntime(): boolean {
  if (!isTauriRuntime() || typeof navigator === 'undefined') {
    return false
  }

  const platformText = [
    navigator.userAgent,
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform,
    navigator.platform,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return platformText.includes('mac')
}

function selectPreferredVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined
  }

  const supportsCheck = typeof MediaRecorder.isTypeSupported === 'function'
  return PREFERRED_VOICE_MIME_TYPES.find(
    (candidate) => !supportsCheck || MediaRecorder.isTypeSupported(candidate),
  )
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

      const [, base64] = value.split(',', 2)
      if (!base64) {
        reject(new Error('Audio recording could not be prepared for transcription.'))
        return
      }

      resolve(base64)
    }
    reader.readAsDataURL(blob)
  })
}

function formatLocalTime(value: Date): string {
  const hour = `${value.getHours()}`.padStart(2, '0')
  const minute = `${value.getMinutes()}`.padStart(2, '0')
  return `${hour}:${minute}`
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
