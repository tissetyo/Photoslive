const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

async function seriousAccessibilityViolations(page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations.filter(item => ["serious", "critical"].includes(item.impact));
}

async function openLocalAdmin(page, route = "access") {
  await page.route("**/api/platform?action=me", async intercepted => {
    await intercepted.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "e2e-owner", role: "owner", boothCode: "local" },
        booth: { boothCode: "local", machineId: null },
      }),
    });
  });
  await page.goto(`/admin.html?booth=local&view=${route}`);
}

test.describe("persistence pengaturan admin", () => {
  let originalSettings;

  test.beforeEach(async ({ request }) => {
    const response = await request.get("/api/settings");
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    originalSettings = payload.settings || payload;
  });

  test.afterEach(async ({ request }) => {
    if (!originalSettings) return;
    const response = await request.patch("/api/settings", { data: originalSettings });
    expect(response.ok()).toBeTruthy();
  });

  test("perubahan sesi tetap tersimpan setelah reload", async ({ page }) => {
    await openLocalAdmin(page);
    const countdown = page.locator('[data-setting="booth.countdownSeconds"]');
    await expect(countdown).toBeVisible();
    await countdown.fill("7");

    const save = page.locator("#save-button");
    await expect(save).toBeVisible();
    await save.click();
    await expect(page.locator("#notice-message")).toContainText("berhasil disimpan");

    await page.reload();
    await expect(page.locator('[data-setting="booth.countdownSeconds"]')).toHaveValue("7");
  });

  test("perubahan dari satu browser terbaca oleh browser admin lain", async ({ browser, page }) => {
    await openLocalAdmin(page);
    const countdown = page.locator('[data-setting="booth.countdownSeconds"]');
    await countdown.fill("11");
    await page.locator("#save-button").click();
    await expect(page.locator("#notice-message")).toContainText("berhasil disimpan");

    const secondContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
    });
    const secondPage = await secondContext.newPage();
    try {
      await openLocalAdmin(secondPage);
      await expect(secondPage.locator('[data-setting="booth.countdownSeconds"]')).toHaveValue("11");
    } finally {
      await secondContext.close();
    }
  });

  test("seluruh kontrol setting aktif tetap sama setelah reload", async ({ page }) => {
    await openLocalAdmin(page);
    await expect(page.locator('[data-setting="booth.countdownSeconds"]')).toBeVisible();
    await expect(page.locator("#save-button")).toBeEnabled();
    const expected = await page.evaluate(() => {
      const values = {};
      const seen = new Set();
      for (const control of document.querySelectorAll("[data-setting]")) {
        const path = control.dataset.setting;
        if (!path || control.disabled || seen.has(path)) continue;
        seen.add(path);
        if (control.type === "checkbox") {
          control.checked = !control.checked;
          values[path] = control.checked;
        } else if (control.tagName === "SELECT") {
          const options = [...control.options].filter(option => !option.disabled);
          if (options.length > 1) {
            const currentIndex = options.findIndex(option => option.value === control.value);
            control.value = options[(currentIndex + 1) % options.length].value;
          }
          values[path] = control.value;
        } else if (control.type === "color") {
          control.value = control.value.toLowerCase() === "#123456" ? "#654321" : "#123456";
          values[path] = control.value;
        } else if (["number", "range"].includes(control.type)) {
          const current = Number(control.value || control.min || 0);
          const step = Math.max(1, Number(control.step || 1));
          const min = control.min === "" ? Number.NEGATIVE_INFINITY : Number(control.min);
          const max = control.max === "" ? Number.POSITIVE_INFINITY : Number(control.max);
          const candidate = current + step <= max ? current + step : current - step >= min ? current - step : current;
          control.value = String(candidate);
          values[path] = control.value;
        } else if (path === "storage.localPhotoPath") {
          control.value = "/tmp/photoslive-e2e-photos";
          values[path] = control.value;
        } else {
          const suffix = " · e2e";
          const maximum = Number(control.maxLength || -1);
          const base = String(control.value || "Photoslive").replace(/ · e2e$/, "");
          control.value = maximum > 0 ? `${base}${suffix}`.slice(0, maximum) : `${base}${suffix}`;
          values[path] = control.value;
        }
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return values;
    });

    expect(Object.keys(expected).length).toBeGreaterThan(20);
    await page.locator("#save-button").click();
    await expect(page.locator("#notice-message")).toContainText("berhasil disimpan");
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-settings-ready", "true");

    const actual = await page.evaluate(paths => Object.fromEntries(paths.map(path => {
      const control = document.querySelector(`[data-setting="${CSS.escape(path)}"]`);
      return [path, control?.type === "checkbox" ? Boolean(control.checked) : String(control?.value ?? "")];
    })), Object.keys(expected));
    expect(actual).toEqual(expected);
  });
});

test.describe("accessibility browser", () => {
  for (const route of ["/booth", "/setup", "admin:access"]) {
    test(`${route} tidak memiliki pelanggaran accessibility serious/critical`, async ({ page }) => {
      if (route.startsWith("admin:")) await openLocalAdmin(page, route.split(":")[1]);
      else await page.goto(route);
      await expect(page.locator("body")).toBeVisible();
      const violations = await seriousAccessibilityViolations(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }
});

test.describe("layout lintas viewport", () => {
  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet-landscape", width: 1024, height: 768 },
    { name: "tablet-portrait", width: 768, height: 1024 },
  ];
  const routes = ["/booth", "/setup", "admin:access"];

  for (const viewport of viewports) {
    for (const route of routes) {
      test(`${route} tidak overflow horizontal pada ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        if (route.startsWith("admin:")) await openLocalAdmin(page, route.split(":")[1]);
        else await page.goto(route);
        await expect(page.locator("body")).toBeVisible();
        const dimensions = await page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth;
          const offenders = [...document.querySelectorAll("body *")]
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                id: element.id,
                className: String(element.className || "").slice(0, 120),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                width: Math.round(rect.width),
              };
            })
            .filter(item => item.left < -1 || item.right > viewportWidth + 1)
            .slice(0, 12);
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth,
            offenders,
          };
        });
        expect(
          dimensions.documentWidth,
          `Elemen overflow: ${JSON.stringify(dimensions.offenders, null, 2)}`,
        ).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
      });
    }
  }
});
