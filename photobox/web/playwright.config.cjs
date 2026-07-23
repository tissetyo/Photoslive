const { defineConfig, devices } = require("@playwright/test");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.PHOTOSLIVE_E2E_PORT || 18766);
const dataRoot = process.env.PHOTOSLIVE_E2E_DATA_ROOT
  || path.join(os.tmpdir(), `photoslive-e2e-${process.pid}`);
const browserChannel = process.env.PHOTOSLIVE_E2E_CHANNEL || undefined;

module.exports = defineConfig({
  testDir: "./e2e",
  outputDir: "./output/playwright",
  timeout: 45_000,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "output/playwright-report", open: "never" }]] : "line",
  use: {
    ...devices["Desktop Chrome"],
    ...(browserChannel ? { channel: browserChannel } : {}),
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "python3 ../server.py",
    url: `http://127.0.0.1:${port}/api/health`,
    cwd: __dirname,
    // Reusing an arbitrary developer server leaks persisted settings between
    // specs and makes visual/persistence assertions order-dependent. Opt in
    // explicitly when debugging, but keep normal and CI runs hermetic.
    reuseExistingServer: process.env.PHOTOSLIVE_E2E_REUSE_SERVER === "1",
    timeout: 30_000,
    env: {
      ...process.env,
      PHOTOSLIVE_HOST: "127.0.0.1",
      PHOTOSLIVE_PORT: String(port),
      PHOTOSLIVE_DATA_ROOT: dataRoot,
      PHOTOSLIVE_TEST_MODE: "1",
      PHOTOSLIVE_TEST_DISK_TOTAL_BYTES: String(16 * 1024 * 1024 * 1024),
      PHOTOSLIVE_TEST_DISK_FREE_BYTES: String(4 * 1024 * 1024 * 1024),
      PHOTOSLIVE_HARDWARE_SIMULATOR: "1",
      PHOTOSLIVE_SIMULATOR_CAMERA_STATE: "connected",
      PHOTOSLIVE_SIMULATOR_PRINTER_STATE: "connected",
      PHOTOSLIVE_COMPANION_ENABLED: "0",
    },
  },
});
