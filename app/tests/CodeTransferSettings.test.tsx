// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeTransferSettings } from '../src/CodeTransferSettings'
import * as api from '../src/lib/api'
import type { Engagement } from '../src/lib/types'

vi.mock('../src/lib/api', () => ({ codesImportFile: vi.fn(), codesExportFile: vi.fn() }))

function engagement(id: string, name: string, isActive = true): Engagement {
  return {
    id, name, isActive, code: `EXAMPLE-${id}`, client: 'Fictional client', engagementType: 'external',
    colorHex: null, tags: [], describeWhenToUse: null, createdAt: 0, updatedAt: 0,
    activities: [{
      id: `${id}-activity`, engagementId: id, name: 'Example activity', code: 'A01', isActive: false,
      colorHex: null, tags: [], describeWhenToUse: null, createdAt: 0, updatedAt: 0,
    }],
  }
}

const engagements = [engagement('inactive', 'Archived example', false), engagement('alpha', 'Alpha example'), engagement('beta', 'Beta example')]
let root: Root
let container: HTMLDivElement
const onImported = vi.fn<() => Promise<void>>()
const onViewCodes = vi.fn()
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom does not provide native modal behavior. Test application transitions and events.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  } })
  onImported.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

async function render(disabled = false) {
  await act(async () => root.render(<StrictMode><CodeTransferSettings engagements={engagements} disabled={disabled} onImported={onImported} onViewCodes={onViewCodes} /></StrictMode>))
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(found).toBeDefined()
  return found!
}

async function click(text: string) {
  await act(async () => button(text).click())
}

async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function check(name: string) {
  const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes(name))!
  expect(label).toBeDefined()
  await act(async () => label.querySelector<HTMLInputElement>('input')!.click())
}

describe('engagement code transfers', () => {
  it('imports immediately from the picker, reports counts, and refreshes codes without a confirmation', async () => {
    vi.mocked(api.codesImportFile).mockResolvedValue({ addedEngagements: 2, addedActivities: 7, skippedEngagements: 1 })
    await render()
    await click('Import…')
    expect(api.codesImportFile).toHaveBeenCalledOnce()
    expect(onImported).toHaveBeenCalledOnce()
    expect(container.querySelector('dialog')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Added 2 engagements and 7 activities. 1 existing engagement skipped.')
    await click('View codes')
    expect(onViewCodes).toHaveBeenCalledOnce()
  })

  it('treats picker cancellation as a no-op', async () => {
    vi.mocked(api.codesImportFile).mockResolvedValue(null)
    await render()
    await click('Import…')
    expect(onImported).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('reports an all-duplicates import without claiming records were added', async () => {
    vi.mocked(api.codesImportFile).mockResolvedValue({ addedEngagements: 0, addedActivities: 0, skippedEngagements: 3 })
    await render()
    await click('Import…')
    expect(container.textContent).toContain('No new engagements added. 3 existing engagements skipped.')
    expect(onImported).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === 'View codes')).toBe(false)
  })

  it('shows import errors and restores controls for retry', async () => {
    vi.mocked(api.codesImportFile).mockRejectedValue(new Error('Invalid code file.'))
    await render()
    await click('Import…')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid code file.')
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(button('Import…').disabled).toBe(false)
    expect(onImported).not.toHaveBeenCalled()
  })

  it('distinguishes a refresh failure from a failed import', async () => {
    vi.mocked(api.codesImportFile).mockResolvedValue({ addedEngagements: 1, addedActivities: 0, skippedEngagements: 0 })
    onImported.mockRejectedValue(new Error('refresh failed'))
    await render()
    await click('Import…')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Added 1 engagement')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The codes were saved')
  })

  it('prevents repeated import clicks while the native picker is pending', async () => {
    let resolve!: (value: null) => void
    vi.mocked(api.codesImportFile).mockReturnValue(new Promise((done) => { resolve = done }))
    await render()
    await act(async () => { button('Import…').click(); button('Import…').click() })
    expect(api.codesImportFile).toHaveBeenCalledOnce()
    expect(button('Importing…').disabled).toBe(true)
    expect(button('Choose engagements…').disabled).toBe(true)
    await act(async () => resolve(null))
    expect(button('Import…').disabled).toBe(false)
  })

  it('exports only chosen engagements, preserving hidden selections and inactive activity counts', async () => {
    vi.mocked(api.codesExportFile).mockResolvedValue({ exportedEngagements: 2, exportedActivities: 2 })
    await render()
    await click('Choose engagements…')
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(button('Export JSON…').disabled).toBe(true)
    expect([...container.querySelectorAll('legend')].map((item) => item.textContent)).toEqual(['Active engagements', 'Inactive engagements'])
    await check('Alpha example')
    await search('Archived')
    await click('Select all matching')
    expect(container.querySelector('footer')?.textContent).toContain('2 engagements · 2 activities selected')
    await click('Export JSON…')
    expect(api.codesExportFile).toHaveBeenCalledWith(['inactive', 'alpha'])
    expect(container.querySelector('dialog')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Exported 2 engagements and 2 activities.')
  })

  it('retains the export checklist after save cancellation or failure and allows retry', async () => {
    vi.mocked(api.codesExportFile).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Could not save.')).mockResolvedValueOnce({ exportedEngagements: 1, exportedActivities: 1 })
    await render()
    await click('Choose engagements…')
    await check('Beta example')
    await click('Export JSON…')
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input:checked')).not.toBeNull()
    await click('Export JSON…')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not save.')
    await click('Export JSON…')
    expect(api.codesExportFile).toHaveBeenCalledTimes(3)
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('clears all selections even when some are filtered out, and canceling resets the dialog', async () => {
    await render()
    await click('Choose engagements…')
    await click('Select all matching')
    await search('Alpha')
    await click('Clear selection')
    expect(container.querySelector('footer')?.textContent).toContain('0 engagements · 0 activities selected')
    await check('Alpha example')
    await click('Cancel')
    expect(api.codesExportFile).not.toHaveBeenCalled()
    await click('Choose engagements…')
    expect(container.querySelector('input:checked')).toBeNull()
    expect(button('Export JSON…').disabled).toBe(true)
  })

  it('closes the export dialog on Escape through the native cancel event', async () => {
    await render()
    await click('Choose engagements…')
    await act(async () => container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })))
    expect(container.querySelector('dialog')).toBeNull()
    expect(api.codesExportFile).not.toHaveBeenCalled()
  })
})
