import { expect, test } from '@playwright/test'

test.describe('Agent QA browser mock', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('omnisheet-app-shell')).toBeVisible()
  })

  test('renders the mock app shell with seeded day data', async ({ page }) => {
    await expect(page.getByText('This application requires the Tauri runtime')).toHaveCount(0)
    await expect(page.getByRole('tablist', { name: 'Main views' })).toBeVisible()
    await expect(page.getByTestId('agent-qa-day-timeline')).toBeVisible()
    await expect(page.getByRole('button', {
      name: /Orange ITGC.*Control Testing.*QA seeded control walkthrough/i,
    })).toBeVisible()
    await expect(page.getByRole('button', {
      name: /Uncategorized.*QA seeded uncategorized follow-up/i,
    })).toBeVisible()
  })

  test('opens all primary views with seeded content', async ({ page }) => {
    await page.getByRole('tab', { name: 'Week' }).click()
    await expect(page.getByTestId('agent-qa-week-timeline')).toBeVisible()
    await expect(page.getByRole('button', {
      name: /Orange ITGC.*Control Testing.*QA seeded control walkthrough/i,
    })).toBeVisible()

    await page.getByRole('tab', { name: 'History' }).click()
    await expect(page.getByText('QA seeded history submission')).toBeVisible()

    await page.getByRole('tab', { name: 'Codes' }).click()
    await expect(page.getByTestId('agent-qa-code-list')).toContainText('Orange ITGC')
    await expect(page.getByTestId('agent-qa-code-list')).toContainText('Control Testing')

    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByLabel('Interpretation')).toHaveValue('gpt-5-nano')

    await page.getByRole('tab', { name: 'Diagnostics' }).click()
    await expect(page.locator('.diagnostics-list')).toContainText('agent_qa_seed')

    await page.getByRole('tab', { name: 'Summary View' }).click()
    await expect(page.getByRole('tab', { name: 'Agent QA' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Control Testing' })).toBeVisible()
  })

  test('uses Quick Add search and creates a blank manual entry without opening the editor', async ({ page }) => {
    const quickAdd = page.locator('.quick-add-panel')
    await expect(quickAdd).toBeVisible()
    await expect(quickAdd.getByRole('button', { name: 'Add Control Testing (CTRL)' })).toBeVisible()
    await expect(quickAdd.getByRole('button', { name: 'Add Walkthrough (WALK)' })).toBeVisible()

    const initialTileMetrics = await quickAdd.locator('.quick-add-tile').evaluateAll((tiles) =>
      tiles.map((tile) => {
        const rect = tile.getBoundingClientRect()
        return {
          text: tile.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          height: Math.round(rect.height),
        }
      }),
    )
    expect(initialTileMetrics).toHaveLength(3)
    expect(initialTileMetrics[0].text).toContain('CTRL')
    expect(initialTileMetrics[1].text).toContain('WALK')
    expect(initialTileMetrics[0].top).toBe(initialTileMetrics[1].top)
    expect(initialTileMetrics[0].height).toBe(initialTileMetrics[1].height)
    expect(initialTileMetrics[1].left).toBeGreaterThan(initialTileMetrics[0].left)
    expect(initialTileMetrics[2].top).toBeGreaterThan(initialTileMetrics[0].top)

    await quickAdd.getByLabel('Search quick add activities').fill('walk')
    await expect(quickAdd.getByRole('button', { name: 'Add Walkthrough (WALK)' })).toBeVisible()
    await expect(quickAdd.getByRole('button', { name: 'Add Control Testing (CTRL)' })).toHaveCount(0)

    await quickAdd.getByRole('button', { name: 'Add Walkthrough (WALK)' }).click()
    await expect(page.getByText('Added Walkthrough (WALK).')).toBeVisible()
    await expect(page.getByTestId('agent-qa-timeline-editor')).toContainText(
      'Select a timeline block to edit engagement, activity, and timing.',
    )

    const createdBlankEntries = await page.locator('.timeline-block').evaluateAll((blocks) =>
      blocks
        .map((block) => ({
          ariaLabel: block.getAttribute('aria-label') ?? '',
          className: block.className,
        }))
        .filter((block) => block.ariaLabel === 'Orange ITGC (A100) | Walkthrough (WALK). .'),
    )
    expect(createdBlankEntries).toHaveLength(1)
    expect(createdBlankEntries[0].className).toContain('selected')
  })

  test('creates, edits, saves, and closes an entry without alerts', async ({ page }) => {
    await page.getByTestId('agent-qa-entry-message').fill('Browser QA smoke entry')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('button', {
      name: /Orange ITGC.*Control Testing.*QA interpreted: Browser QA smoke entry/i,
    })).toBeVisible()

    await page.getByRole('button', {
      name: /Orange ITGC.*Control Testing.*QA seeded control walkthrough/i,
    }).click()
    await expect(page.getByTestId('agent-qa-timeline-editor')).toContainText('Edit Entry')

    await page.getByLabel('Entry description').fill('QA browser edited control walkthrough')
    await page.getByRole('button', { name: 'Save Entry' }).click()
    await expect(page.getByRole('button', {
      name: /Orange ITGC.*Control Testing.*QA browser edited control walkthrough/i,
    })).toBeVisible()

    await page.getByRole('button', { name: 'Close edit entry' }).click()
    await expect(page.getByTestId('agent-qa-timeline-editor')).toContainText(
      'Select a timeline block to edit engagement, activity, and timing.',
    )
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
