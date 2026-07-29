import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const download = name => readFile(new URL(`../downloads/${name}`, import.meta.url), "utf8");
const agentArchive = fileURLToPath(new URL("../downloads/photoslive-agent.zip", import.meta.url));

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
  assert.match(linux, /Python sistem belum kompatibel/);
  assert.match(linux, /UV_UNMANAGED_INSTALL/);
  assert.match(linux, /UV_MANAGED_PYTHON=1/);
  assert.match(linux, /uv\/\$\{UV_VERSION\}\/install\.sh/);
  assert.match(linux, /zipfile\.ZipFile/);
  assert.doesNotMatch(linux, /Python 3 wajib tersedia/);
  assert.doesNotMatch(linux, /Photoslive memerlukan Python 3\.10/);
  assert.doesNotMatch(linux, /python3-venv/);
  assert.match(linux, /requirements-controller\.txt/);
  assert.match(linux, /updater\.py/);
  assert.match(linux, /\/api\/health/);

  assert.match(macos, /app\.photoslive\.controller/);
  assert.match(macos, /app\.photoslive\.agent/);
  assert.match(macos, /<key>KeepAlive<\/key><true\/>/);
  assert.match(macos, /launchctl bootstrap/);
  assert.match(macos, /-m venv/);
  assert.match(macos, /requirements-controller\.txt/);
  assert.match(macos, /Python bawaan macOS terlalu lama/);
  assert.match(macos, /UV_UNMANAGED_INSTALL/);
  assert.match(macos, /UV_MANAGED_PYTHON=1/);
  assert.match(macos, /uv\/\$\{UV_VERSION\}\/install\.sh/);
  assert.doesNotMatch(macos, /Photoslive memerlukan Python 3\.10/);
  assert.match(macos, /updater\.py/);
  assert.match(macos, /StandardErrorPath/);
  assert.match(macos, /\/api\/health/);

  assert.match(windows, /Register-ScheduledTask/);
  assert.match(windows, /RestartCount 999/);
  assert.match(windows, /Start-ScheduledTask/);
  assert.match(windows, /-m venv/);
  assert.match(windows, /Python sistem belum kompatibel/);
  assert.match(windows, /UV_NO_MODIFY_PATH/);
  assert.match(windows, /UV_MANAGED_PYTHON/);
  assert.match(windows, /UV_PYTHON_NO_REGISTRY/);
  assert.match(windows, /astral\.sh\/uv\/\$UvVersion\/install\.ps1/);
  assert.doesNotMatch(windows, /Install Python 3 terlebih dahulu/);
  assert.doesNotMatch(windows, /Photoslive memerlukan Python 3\.10/);
  assert.match(windows, /requirements-controller\.txt/);
  assert.match(windows, /updater\.py/);
  assert.match(windows, /\/api\/health/);
});

test("operator installers pin the same managed Python bootstrap", async () => {
  const scripts = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);

  for (const script of scripts) {
    assert.match(script, /0\.11\.32/);
    assert.match(script, /3\.12/);
    assert.match(script, /runtime/);
    assert.match(script, /bootstrap/);
  }
});

test("Linux and Windows installers expose an isolated managed-runtime smoke path", async () => {
  const [linux, windows] = await Promise.all([
    download("install-linux.sh"),
    download("install-windows.ps1"),
  ]);

  for (const script of [linux, windows]) {
    assert.match(script, /PHOTOSLIVE_FORCE_MANAGED_PYTHON/);
    assert.match(script, /PHOTOSLIVE_INSTALLER_RUNTIME_ONLY/);
    assert.match(script, /PHOTOSLIVE_AGENT_ARCHIVE/);
    assert.match(script, /Runtime Python Photoslive siap/);
  }
});

test("all operator installers open local onboarding without legacy pairing", async () => {
  const scripts = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);
  for (const script of scripts) {
    assert.match(script, /--setup-link/);
    assert.doesNotMatch(script, /--setup-code/);
    assert.doesNotMatch(script, /SetupArgument|SETUP_ARGUMENT/);
    assert.match(script, /--setup-link"? --open-setup/);
    assert.ok(
      script.lastIndexOf("--open-setup") < script.indexOf("--status"),
      "status must be printed after local onboarding opens so stale heartbeat errors do not hide setup",
    );
  }
});

test("all operator installers verify the local setup HTML before opening it", async () => {
  const scripts = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);
  for (const script of scripts) {
    assert.match(script, /setup\?local=1/);
    assert.match(script, /<title>Setup Photoslive<\/title>/);
    assert.match(script, /Controller atau halaman setup lokal gagal dijalankan/);
  }
});

test("downloadable Agent archive stays synchronized with the current Agent CLI", async () => {
  const [sourceAgent, archivedAgent] = await Promise.all([
    readFile(new URL("../../agent.py", import.meta.url), "utf8"),
    Promise.resolve(execFileSync("unzip", ["-p", agentArchive, "photobox/agent.py"], { encoding: "utf8" })),
  ]);

  assert.equal(
    archivedAgent,
    sourceAgent,
    "photoslive-agent.zip is stale; run photobox/scripts/build-agent-archive.sh before release",
  );
  assert.match(archivedAgent, /parser\.add_argument\("--setup-link", action="store_true"/);
  assert.match(archivedAgent, /if arguments\.setup_link:[\s\S]*local_setup_url\(config\)/);
  assert.match(archivedAgent, /if arguments\.setup_link:[\s\S]*local_setup_page_ready\(config\)/);
  assert.doesNotMatch(archivedAgent, /parser\.add_argument\("--setup-link", "--setup-code"/);
});

test("downloadable archive includes every Controller runtime module", async () => {
  const [sourceUpdater, archivedUpdater, archiveListing] = await Promise.all([
    readFile(new URL("../../updater.py", import.meta.url), "utf8"),
    Promise.resolve(execFileSync("unzip", ["-p", agentArchive, "photobox/updater.py"], { encoding: "utf8" })),
    Promise.resolve(execFileSync("unzip", ["-Z1", agentArchive], { encoding: "utf8" })),
  ]);
  assert.equal(archivedUpdater, sourceUpdater);
  assert.match(archiveListing, /photobox\/server\.py/);
  assert.match(archiveListing, /photobox\/redaction\.py/);
  assert.match(archiveListing, /photobox\/updater\.py/);
});

test("operator installers retry unstable cloud downloads", async () => {
  const [linux, macos, windows] = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);

  assert.match(linux, /--retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180/);
  assert.match(macos, /--retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180/);
  assert.match(windows, /function Invoke-DownloadWithRetry/);
  assert.match(windows, /-TimeoutSec 180/);
  assert.match(windows, /Download belum stabil/);
});
