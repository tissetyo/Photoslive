const { test, expect } = require("@playwright/test");

async function configureFastFreeSession(request, slots = 1) {
  const reset = await request.post("/api/test/reset-sessions", { data: {} });
  expect(reset.ok()).toBeTruthy();
  const response = await request.patch("/api/settings", {
    data: {
      booth: {
        countdownSeconds: 1,
        photoSlotsPerSession: slots,
        sessionTimeoutSeconds: 180,
        unlimitedRetakes: true,
        printsPerSession: 0,
        maintenanceMode: false,
      },
      payment: {
        qrisEnabled: false,
        voucherEnabled: false,
        paidPrintEnabled: false,
      },
      devices: {
        preferredCamera: "sim-camera",
        preferredPrinter: "sim-printer",
        cameraSource: "controller",
      },
      appearance: {
        activeFrame: "clean-white",
        framePhotoSlots: {
          "clean-white": slots,
          "party-night": slots,
        },
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function useControllerCamera(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => { throw new DOMException("Kamera browser sengaja dinonaktifkan oleh E2E", "NotAllowedError"); },
        enumerateDevices: async () => [],
      },
    });
  });
}

test.afterEach(async ({ request }) => {
  const response = await request.post("/api/test/reset-sessions", { data: {} });
  expect(response.ok()).toBeTruthy();
});

test.describe("booth lokal dan offline", () => {
  test.beforeEach(async ({ request, page }) => {
    await configureFastFreeSession(request);
    await useControllerCamera(page);
  });

  test("menyelesaikan sesi, retake tetap compact, lalu skip goodbye", async ({ page }) => {
    await page.goto("/booth");

    const start = page.locator("#welcome-start");
    await expect(start).toBeEnabled();
    await expect(page.locator("#welcome-button-label")).toHaveText("Mulai foto");
    await start.click();

    await expect(page.locator('[data-booth-screen="frames"]')).toHaveClass(/is-active/);
    await expect(page.locator("#frame-list .frame-option").first()).toBeVisible();
    await expect(page.locator("#frame-continue")).toBeEnabled();
    await page.locator("#frame-continue").click();

    await expect(page.locator('[data-booth-screen="capture"]')).toHaveClass(/is-active/);
    await page.locator("#camera-start").click();
    await expect(page.locator("#photo-review")).toBeVisible({ timeout: 12_000 });

    const firstBox = await page.locator("#photo-review").boundingBox();
    expect(firstBox).not.toBeNull();
    expect(firstBox.width).toBeLessThan(650);
    expect(firstBox.height).toBeLessThan(260);

    await page.locator("#retake-photo").click();
    await expect(page.locator("#photo-review")).toBeVisible({ timeout: 12_000 });
    const retakeBox = await page.locator("#photo-review").boundingBox();
    expect(retakeBox).not.toBeNull();
    expect(retakeBox.width).toBeLessThan(650);
    expect(retakeBox.height).toBeLessThan(260);

    await page.locator("#accept-photo").click();
    await expect(page.locator('[data-booth-screen="result"]')).toHaveClass(/is-active/, { timeout: 15_000 });
    await expect(page.locator("#final-frame")).toBeVisible();
    await page.locator("#finish-session").click();

    const goodbye = page.locator("#goodbye-dialog");
    await expect(goodbye).toBeVisible();
    await page.locator("#skip-goodbye").click();
    await expect(goodbye).not.toBeVisible();
    await expect(page.locator('[data-booth-screen="welcome"]')).toHaveClass(/is-active/);
    await expect(start).toBeEnabled();
  });

  test("memulihkan sesi aktif setelah reload tanpa membuat sesi baru", async ({ request, page }) => {
    await configureFastFreeSession(request, 2);
    await page.goto("/booth");
    await page.locator("#welcome-start").click();
    await page.locator("#frame-continue").click();
    await page.locator("#camera-start").click();
    await expect(page.locator("#photo-review")).toBeVisible({ timeout: 12_000 });
    await page.locator("#accept-photo").click();

    await expect(page.locator("#capture-progress-label")).toHaveText("Foto 2 dari 2");
    const sessionBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("photoslive.activeSession.local")));
    expect(sessionBefore?.shareToken).toBeTruthy();

    await page.reload();
    await expect(page.locator('[data-booth-screen="capture"]')).toHaveClass(/is-active/);
    await expect(page.locator("#capture-progress-label")).toHaveText("Foto 2 dari 2");
    await expect(page.locator("#booth-notice")).toContainText("Sesi dipulihkan");
  });
});

test.describe("kontinuitas kamera browser", () => {
  test("stream kamera dipakai ulang dari pemilihan frame sampai capture", async ({ request, page }) => {
    await configureFastFreeSession(request);
    await page.addInitScript(() => {
      window.__photosliveCameraRequests = 0;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            window.__photosliveCameraRequests += 1;
            return new MediaStream();
          },
          enumerateDevices: async () => [{ kind: "videoinput", deviceId: "e2e-webcam", label: "Webcam E2E" }],
        },
      });
      HTMLMediaElement.prototype.play = async () => {};
    });

    await page.goto("/booth");
    await page.locator("#welcome-start").click();
    await expect(page.locator('[data-booth-screen="frames"]')).toHaveClass(/is-active/);
    await expect.poll(() => page.evaluate(() => window.__photosliveCameraRequests)).toBe(1);

    await page.locator("#frame-continue").click();
    await expect(page.locator('[data-booth-screen="capture"]')).toHaveClass(/is-active/);
    await expect.poll(() => page.evaluate(() => window.__photosliveCameraRequests)).toBe(1);
  });
});
