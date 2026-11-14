import { defineConfig, devices } from '@playwright/test';

// E2E tests run against a real local stack (see README → Testing):
//   supabase start · scripts/dev-functions.ts · vite (env from .env.e2e)
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'off',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {} } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, launchOptions: executablePath ? { executablePath } : {} } },
  ],
});
