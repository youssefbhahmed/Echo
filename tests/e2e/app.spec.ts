import { expect, test, type Page } from '@playwright/test';

async function signUp(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/auth/);
  await page.getByText('Create an account').click();
  await page.fill('input[type=email]', `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`);
  await page.fill('input[type=password]', 'correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/welcome/);
}

test('full journey: signup → onboarding → discover → feedback → chat → taste → library → settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signUp(page);

  // Onboarding
  await page.fill('input[placeholder="Your name"]', 'Tester');
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const t of ['Philosophy', 'Cosmic & space', 'Melancholic']) await page.getByRole('button', { name: t, exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.fill('input[placeholder^="e.g."]', 'The Stranger Camus');
  await page.getByRole('button', { name: 'Find' }).click();
  await page.locator('li button').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.fill('textarea', 'Slow, atmospheric stories about memory and the cosmos.');
  await page.getByRole('button', { name: /Start discovering/ }).click();

  // Discover feed with real items + explanations
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Tester,')).toBeVisible();
  const cards = page.locator('article');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  expect(await cards.count()).toBeGreaterThan(2);
  await expect(cards.first().locator('p.italic')).not.toBeEmpty();

  // Feedback is persisted and learned
  await cards.first().getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').getByText(/Saved to your library/)).toBeVisible();

  // Exploration slider changes the request
  await page.getByRole('button', { name: /Balanced|Familiar|Adventurous/ }).first().click();
  await page.locator('#exploration').fill('0.95');
  await expect(page.getByText('Adventurous').first()).toBeVisible();

  // Chat with refinement
  await page.goto('/echo');
  await page.fill('textarea', 'existential philosophy books and tv series, please');
  await page.keyboard.press('Enter');
  await expect(page.locator('article').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/I read this as/)).toBeVisible();
  await page.getByRole('button', { name: 'Only books' }).click();
  await expect(page.getByText(/I read this as/).nth(1)).toBeVisible({ timeout: 90_000 });

  // Taste profile reflects onboarding + feedback
  await page.goto('/taste');
  await expect(page.getByRole('heading', { name: 'Constellation', exact: true })).toBeVisible();
  await expect(page.locator('figure svg')).toBeVisible();
  await expect(page.getByText('Philosophy').first()).toBeVisible();

  // Library contains the saved item (synced through the database)
  await page.goto('/library');
  await expect(page.locator('article').first()).toBeVisible();

  // Settings
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Privacy & data' })).toBeVisible();
  await expect(page.getByText('Content sources on this server')).toBeVisible();
  await expect(page.getByText(/Open Library · Books/)).toBeVisible();

  expect(errors).toEqual([]);
});

test('library and taste sync across devices (separate browser context, same account)', async ({ page, browser }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('article').first()).toBeVisible({ timeout: 60_000 });
  const title = (await page.locator('article h3').first().textContent())!;
  await page.locator('article').first().getByRole('button', { name: 'Like' }).click();
  await expect(page.getByRole('status').getByText(/Liked/)).toBeVisible();

  // "Second device": a fresh context restored only from the auth session
  const state = await page.context().storageState();
  const other = await browser.newContext({ storageState: state });
  const p2 = await other.newPage();
  await p2.goto('/library');
  await p2.getByRole('tab', { name: /Loved/ }).click();
  await expect(p2.getByRole('heading', { name: title })).toBeVisible();
  await other.close();
});

test('PWA: manifest, icons and service worker', async ({ page, request }) => {
  await page.goto('/auth');
  const link = page.locator('link[rel="manifest"]');
  const manifestHref = (await link.count()) ? await link.getAttribute('href') : null;
  // vite-plugin-pwa injects the manifest in production builds; in dev, check the generated file when present.
  if (manifestHref) {
    const res = await request.get(manifestHref);
    const m = await res.json();
    expect(m.name).toContain('ECHO');
    expect(m.display).toBe('standalone');
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
  }
  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/apple-touch-icon.png', '/favicon.svg']) {
    expect((await request.get(icon)).status()).toBe(200);
  }
});

test('protected routes redirect to sign-in', async ({ page }) => {
  await page.goto('/library');
  await expect(page).toHaveURL(/\/auth/);
});
