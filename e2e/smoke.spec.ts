import { expect, test } from '@playwright/test'

test('app shell loads: the board list at #/ and a board at /', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByRole('heading', { name: 'Whiteboard' })).toBeVisible()
  await expect(page.getByTestId('board-list')).toBeVisible()

  await page.goto('/')
  await expect(page.getByTestId('board-root')).toBeVisible()
})
