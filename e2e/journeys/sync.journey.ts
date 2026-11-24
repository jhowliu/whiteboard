import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, snapshot } from '../helpers.ts'
import { mockSupabase, signInThroughDialog } from '../mock-supabase.ts'

// Journey: draw while signed out → sign in with an email code → the strokes sync and the header shows 已同步.
test('同步:未登入先畫 → 驗證碼登入 → 顯示「已同步」', async ({ page }) => {
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

  await signInThroughDialog(page, { pauseMs: 500 })
  await pause(page)
  await pacedPenStroke(page, wave(c.y + 40))
  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snapshot(page)).sync).toEqual({ status: 'synced', pending: 0 })
  await pause(page)
})
