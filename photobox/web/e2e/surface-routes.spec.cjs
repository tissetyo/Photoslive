const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const surfaces = [
  { name: "landing", path: "/" },
  { name: "setup", path: "/setup" },
  { name: "booth", path: "/booth" },
  { name: "status", path: "/status" },
  { name: "local-manager", path: "/local-agent" },
  { name: "companion", path: "/companion" },
  { name: "superadmin", path: "/superadmin" },
  { name: "customer-session", path: "/session.html?booth=local&session=0123456789abcdef0123456789abcdef" },
  { name: "admin", path: "/admin.html?booth=local&view=overview", admin: true },
];

async function prepare(page, surface) {
  if (surface.admin) {
    await page.route("**/api/platform?action=me", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "route-owner", role: "owner", boothCode: "local" },
        booth: { boothCode: "local", machineId: null },
      }),
    }));
  }
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const response = await page.goto(surface.path);
  expect(response?.status() || 200, `${surface.name} gagal dimuat`).toBeLessThan(500);
  await expect(page.locator("body")).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(pageErrors, `${surface.name} memiliki page error`).toEqual([]);
}

test.describe("seluruh route produk", () => {
  for (const surface of surfaces) {
    test(`${surface.name} dapat dimuat dan lolos accessibility utama`, async ({ page }) => {
      await prepare(page, surface);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = result.violations.filter(item => ["serious", "critical"].includes(item.impact));
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }
});

test.describe("layout route utama", () => {
  const viewports = [
    { name: "desktop-landscape", width: 1440, height: 900 },
    { name: "tablet-landscape", width: 1024, height: 768 },
    { name: "tablet-portrait", width: 768, height: 1024 },
  ];
  for (const viewport of viewports) {
    for (const surface of surfaces) {
      test(`${surface.name} muat pada ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await prepare(page, surface);
        const dimensions = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        }));
        expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
      });
    }
  }
});

test.describe("visual regression route pelanggan", () => {
  for (const viewport of [
    { name: "landscape", width: 1440, height: 900 },
    { name: "portrait", width: 768, height: 1024 },
  ]) {
    for (const surface of surfaces.filter(item => ["booth", "setup"].includes(item.name))) {
      test(`${surface.name} ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await prepare(page, surface);
        await expect(page).toHaveScreenshot(`${surface.name}-${viewport.name}.png`, {
          animations: "disabled",
          fullPage: true,
          // CI runs on Linux while local visual baselines are produced on macOS.
          // Keep the route-level guard useful for large visual regressions without
          // failing on small OS font/antialiasing differences.
          maxDiffPixelRatio: 0.05,
        });
      });
    }
  }
});
