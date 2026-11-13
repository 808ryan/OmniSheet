import { useEffect, useId, useRef, useState } from 'react'

import { codesExportFile, codesImportFile } from './lib/api'
import type { Engagement } from './lib/types'
import './CodeTransferSettings.css'

interface CodeTransferSettingsProps {
  engagements: Engagement[]
  disabled: boolean
  onImported: () => Promise<void>
  onViewCodes: () => void
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export function CodeTransferSettings({ engagements, disabled, onImported, onViewCodes }: CodeTransferSettingsProps) {
  const [isExportOpen, setIsExportOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'import' | 'export' | null>(null)
  const inFlight = useRef(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasImported, setHasImported] = useState(false)
  const isBusy = disabled || busyAction !== null

  const importCodes = async () => {
    if (isBusy || inFlight.current) return
    inFlight.current = true
    setBusyAction('import')
    setNotice(null)
    setError(null)
    setHasImported(false)
    try {
      // The native file picker is the only import step; there is no confirmation screen.
      const result = await codesImportFile()
      if (!result) return
      setNotice(result.addedEngagements > 0
        ? `Added ${countLabel(result.addedEngagements, 'engagement')} and ${countLabel(result.addedActivities, 'activity', 'activities')}. ${countLabel(result.skippedEngagements, 'existing engagement')} skipped.`
        : `No new engagements added. ${countLabel(result.skippedEngagements, 'existing engagement')} skipped.`)
      setHasImported(result.addedEngagements > 0)
      if (result.addedEngagements > 0) {
        try {
          await onImported()
        } catch {
          setError('The codes were saved, but the list could not refresh. Restart WhiteRabbit to see them.')
        }
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      inFlight.current = false
      setBusyAction(null)
    }
  }

  const exportCodes = async (ids: string[]) => {
    if (isBusy || inFlight.current) return
    inFlight.current = true
    setBusyAction('export')
    setNotice(null)
    setError(null)
    setHasImported(false)
    try {
      const result = await codesExportFile(ids)
      if (!result) return // Save-dialog cancellation keeps the checklist and selections.
      setIsExportOpen(false)
      setNotice(`Exported ${countLabel(result.exportedEngagements, 'engagement')} and ${countLabel(result.exportedActivities, 'activity', 'activities')}.`)
    } catch (caught) {
      throw new Error(errorMessage(caught))
    } finally {
      inFlight.current = false
      setBusyAction(null)
    }
  }

  return (
    <section className="settings-card code-transfer-card" aria-labelledby="code-transfer-title">
      <div className="settings-card-header"><h3 id="code-transfer-title">Engagement codes</h3></div>
      <div className="settings-preference-row code-transfer-row">
        <div>
          <span className="settings-preference-label">Import codes</span>
          <span className="field-helper">Choose a JSON file to add its engagements immediately. Existing engagements and their activities are skipped.</span>
        </div>
        <button type="button" className="ghost" disabled={isBusy} onClick={() => void importCodes()}>
          {busyAction === 'import' ? 'Importing…' : 'Import…'}
        </button>
      </div>
      <div className="settings-preference-row code-transfer-row">
        <div>
          <span className="settings-preference-label">Export codes</span>
          <span className="field-helper">Choose engagements to share, including their activities and code details.</span>
        </div>
        <button type="button" className="ghost" disabled={isBusy || engagements.length === 0} onClick={() => setIsExportOpen(true)}>
          Choose engagements…
        </button>
      </div>
      {notice || error ? (
        <div className="code-transfer-feedback">
          {notice ? <p className="code-transfer-notice" role="status">{notice}</p> : null}
          {error ? <p className="code-transfer-error" role="alert">{error}</p> : null}
          {hasImported ? <button type="button" className="ghost" onClick={onViewCodes}>View codes</button> : null}
        </div>
      ) : null}
      {isExportOpen ? (
        <CodeExportDialog engagements={engagements} busy={isBusy} onClose={() => setIsExportOpen(false)} onExport={exportCodes} />
      ) : null}
    </section>
  )
}

interface CodeExportDialogProps {
  engagements: Engagement[]
  busy: boolean
  onClose: () => void
  onExport: (ids: string[]) => Promise<void>
}

function CodeExportDialog({ engagements, busy, onClose, onExport }: CodeExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const selectedEngagements = engagements.filter((item) => selected.has(item.id))
  const selectedActivityCount = selectedEngagements.reduce((count, item) => count + item.activities.length, 0)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matching = engagements.filter((item) => [item.name, item.code, item.client]
    .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)))
  const groups = [
    { label: 'Active engagements', items: matching.filter((item) => item.isActive) },
    { label: 'Inactive engagements', items: matching.filter((item) => !item.isActive) },
  ].filter((group) => group.items.length > 0)

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="code-export-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        if (busy || selectedEngagements.length === 0) return
        setError(null)
        void onExport(selectedEngagements.map((item) => item.id)).catch((caught) => setError(errorMessage(caught)))
      }}>
        <header className="code-export-header">
          <h3 id={titleId}>Export engagement codes</h3>
          <p id={descriptionId}>Select engagements to include all their activities, including inactive ones. Client names, descriptions, tags, and colors are included. Time entries and settings stay private.</p>
        </header>
        <div className="code-export-tools">
          <input type="search" aria-label="Search engagements to export" placeholder="Search engagements" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
          <div className="code-export-selection-actions">
            <button type="button" className="ghost" disabled={busy || matching.length === 0} onClick={() => setSelected((previous) => new Set([...previous, ...matching.map((item) => item.id)]))}>Select all matching</button>
            <button type="button" className="ghost" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
        </div>
        <div className="code-export-list">
          {matching.length === 0 ? <p className="code-export-empty">No matching engagements.</p> : groups.map((group) => (
            <fieldset key={group.label} className="code-export-group" disabled={busy}>
              <legend>{group.label}</legend>
              {group.items.map((item) => (
                <label key={item.id} className={`code-export-option ${item.isActive ? '' : 'is-inactive'} ${selected.has(item.id) ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={(event) => {
                    const checked = event.target.checked
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }} />
                  <span className="code-export-option-copy"><strong>{item.name}</strong><span>{item.code ? `${item.code} · ` : ''}{countLabel(item.activities.length, 'activity', 'activities')}</span></span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {error ? <p className="code-transfer-error code-export-error" role="alert">{error}</p> : null}
        <footer className="code-export-footer">
          <p role="status">{countLabel(selectedEngagements.length, 'engagement')} · {countLabel(selectedActivityCount, 'activity', 'activities')} selected</p>
          <div>
            <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="button-soft-primary" disabled={busy || selectedEngagements.length === 0}>{busy ? 'Exporting…' : 'Export JSON…'}</button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
