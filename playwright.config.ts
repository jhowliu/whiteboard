import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: '**/journeys/**', use: { ...devices['Desktop Chrome'] } },
    // Closest automated stand-in for iPad Safari + Apple Pencil.
    // Service workers are blocked: they bypass page.route() mocks in WebKit, and the offline test is chromium-only.
    {
      name: 'webkit-ipad',
      testIgnore: '**/journeys/**',
      use: { ...devices['iPad Pro 11'], serviceWorkers: 'block' },
    },
    // Paced walkthroughs recorded as video; scripts/journey-gif.mjs turns them into GIF evidence for the PR.
    {
      name: 'journey',
      testMatch: '**/journeys/**/*.journey.ts',
      use: { ...devices['iPad Pro 11'], serviceWorkers: 'block', video: 'on', screenshot: 'off' },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Fake Supabase settings so the sign-in UI is built in; tests mock /auth/v1/*.
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'e2e-fake-anon-key',
    },
  },
})
