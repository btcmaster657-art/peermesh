const { test, expect } = require('@playwright/test')
const path = require('path')

const FILE_URL = `file://${path.join(__dirname, '../renderer/index.html').replace(/\\/g, '/')}`

// Mock window.peermesh so tests don't need a live Electron IPC
async function mockPeermesh(page, state) {
  await page.addInitScript((s) => {
    window.peermesh = {
      getState: () => Promise.resolve(s),
      toggleSharing: () => Promise.resolve({ running: !s.running }),
      signIn: () => Promise.resolve({ success: true }),
      signOut: () => Promise.resolve({ success: true }),
      openAuth: () => Promise.resolve(),
      openDashboard: () => Promise.resolve(),
      checkWebsiteAuth: () => Promise.resolve({ pending: true }),
    }
  }, state)
}

// ── Auth screen ───────────────────────────────────────────────────────────────

test.describe('Auth screen', () => {
  test('shown by default', async ({ page }) => {
    await page.goto(FILE_URL)
    await expect(page.locator('#auth-screen')).toHaveClass(/active/)
    await expect(page.locator('#main-screen')).not.toHaveClass(/active/)
  })

  test('logo is visible', async ({ page }) => {
    await page.goto(FILE_URL)
    await expect(page.locator('.logo')).toHaveText('PEERMESH')
  })

  test('sign in button is visible', async ({ page }) => {
    await page.goto(FILE_URL)
    await expect(page.locator('#btn-open-browser')).toBeVisible()
    await expect(page.locator('#btn-open-browser')).toHaveText('SIGN IN WITH BROWSER')
  })

  test('waiting for sign in message is shown', async ({ page }) => {
    await page.goto(FILE_URL)
    await expect(page.locator('#auth-status')).toContainText('WAITING FOR SIGN IN')
  })
})

// ── Main screen (signed in, not sharing) ─────────────────────────────────────

test.describe('Main screen — not sharing', () => {
  test.beforeEach(async ({ page }) => {
    await mockPeermesh(page, {
      running: false,
      config: { userId: 'user-123', country: 'NG', token: '***', trust: 50 },
      stats: { requestsHandled: 0, bytesServed: 0, connectedAt: null },
    })
    await page.goto(FILE_URL)
    // Wait for pollState to run and switch screens
    await expect(page.locator('#main-screen')).toHaveClass(/active/, { timeout: 5000 })
  })

  test('main screen is shown when signed in', async ({ page }) => {
    await expect(page.locator('#auth-screen')).not.toHaveClass(/active/)
  })

  test('status label shows NOT SHARING', async ({ page }) => {
    await expect(page.locator('#status-label')).toHaveText('NOT SHARING')
  })

  test('share toggle is off', async ({ page }) => {
    await expect(page.locator('#share-toggle')).not.toHaveClass(/on/)
  })

  test('stats show zero', async ({ page }) => {
    await expect(page.locator('#stat-requests')).toHaveText('0')
    await expect(page.locator('#stat-bytes')).toHaveText('0B')
  })

  test('user id is displayed', async ({ page }) => {
    await expect(page.locator('#user-label')).toContainText('user-123')
  })

  test('dashboard button is visible', async ({ page }) => {
    await expect(page.locator('#btn-dashboard')).toBeVisible()
  })

  test('sign out button is visible', async ({ page }) => {
    await expect(page.locator('#btn-signout')).toBeVisible()
  })
})

// ── Main screen (signed in, sharing active) ───────────────────────────────────

test.describe('Main screen — sharing active', () => {
  test.beforeEach(async ({ page }) => {
    await mockPeermesh(page, {
      running: true,
      config: { userId: 'user-123', country: 'NG', token: '***', trust: 50 },
      stats: { requestsHandled: 42, bytesServed: 1048576, connectedAt: new Date().toISOString() },
    })
    await page.goto(FILE_URL)
    await expect(page.locator('#main-screen')).toHaveClass(/active/, { timeout: 5000 })
  })

  test('status label shows SHARING with country', async ({ page }) => {
    await expect(page.locator('#status-label')).toHaveText('SHARING — NG')
  })

  test('status card has active class', async ({ page }) => {
    await expect(page.locator('#status-card')).toHaveClass(/active/)
  })

  test('share toggle is on', async ({ page }) => {
    await expect(page.locator('#share-toggle')).toHaveClass(/on/)
  })

  test('stats reflect served data', async ({ page }) => {
    await expect(page.locator('#stat-requests')).toHaveText('42')
    await expect(page.locator('#stat-bytes')).toHaveText('1.0MB')
  })

  test('country flag is shown', async ({ page }) => {
    await expect(page.locator('#status-country')).toHaveText('🇳🇬')
  })
})
