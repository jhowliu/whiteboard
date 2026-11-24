import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, snapshot } from './helpers.ts'
import { mockSupabase, signInThroughDialog } from './mock-supabase.ts'

test('after signing in and drawing, sync reaches 已同步 with nothing pending', async ({ page }) => {
  await mockSupabase(page)
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()

  await signInThroughDialog(page)
  const c = await center(page)
  await pacedPenStroke(page, Array.from({ length: 12 }, (_, i) => ({ x: c.x - 60 + i * 10, y: c.y + (i % 3) * 6 })))
  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snapshot(page)).sync).toEqual({ status: 'synced', pending: 0 })
})
