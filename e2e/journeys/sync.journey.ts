import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, snapshot } from '../helpers.ts'
import { mockSupabase, signInThroughDialog } from '../mock-supabase.ts'

// Journey: draw while signed out → ‹ 白板列表 → sign in with an email code → reopen the board → the strokes sync and it shows 已同步.
test('Sync: draw signed out → sign in → synced', async ({ page }) => {
  await mockSupabase(page)
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  const c = await center(page)
  const wave = (y: number) =>
    Array.from({ length: 24 }, (_, i) => ({ x: c.x - 120 + i * 10, y: y + Math.round(Math.sin(i / 3) * 20) }))
  await pacedPenStroke(page, wave(c.y - 60))
  await pause(page)

  await page.getByTestId('back-to-list').click()
  await expect(page.getByTestId('board-list')).toBeVisible()
  await signInThroughDialog(page, { pauseMs: 500 })
  await pause(page)
  await page.getByTestId('open-board').first().click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)
  await pacedPenStroke(page, wave(c.y + 40))
  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snapshot(page)).sync).toEqual({ status: 'synced', pending: 0 })
  await pause(page)
})
