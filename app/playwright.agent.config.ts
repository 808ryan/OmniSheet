import { defineConfig, devices } from '@playwright/test'

const port = 5174

export default defineConfig({
  testDir: './tests/agent',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    viewport: {
      width: 1440,
      height: 920,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: {
      VITE_OMNISHEET_AGENT_MOCK: '1',
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
