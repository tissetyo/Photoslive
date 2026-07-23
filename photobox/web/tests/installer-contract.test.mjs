import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const download = name => readFile(new URL(`../downloads/${name}`, import.meta.url), "utf8");

test("technician installers supervise both Controller and Agent", async () => {
  const [linux, macos, windows] = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);

  assert.match(linux, /photoslive-controller\.service/);
  assert.match(linux, /photoslive-agent\.service/);
  assert.match(linux, /Restart=always/);
  assert.match(linux, /systemctl --user enable/);
  assert.match(linux, /python3 -m venv/);
  assert.match(linux, /requirements-controller\.txt/);

  assert.match(macos, /app\.photoslive\.controller/);
  assert.match(macos, /app\.photoslive\.agent/);
  assert.match(macos, /<key>KeepAlive<\/key><true\/>/);
  assert.match(macos, /launchctl bootstrap/);
  assert.match(macos, /-m venv/);
  assert.match(macos, /requirements-controller\.txt/);

  assert.match(windows, /Register-ScheduledTask/);
  assert.match(windows, /RestartCount 999/);
  assert.match(windows, /Start-ScheduledTask/);
  assert.match(windows, /-m venv/);
  assert.match(windows, /requirements-controller\.txt/);
});

test("all operator installers create a setup code and open prefilled setup", async () => {
  const scripts = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);
  for (const script of scripts) {
    assert.match(script, /--setup-code --open-setup/);
  }
});
