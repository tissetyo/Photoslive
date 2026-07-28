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

test("all operator installers create and open a secure setup link", async () => {
  const scripts = await Promise.all([
    download("install-linux.sh"),
    download("install-macos.sh"),
    download("install-windows.ps1"),
  ]);
  for (const script of scripts) {
    assert.match(script, /--setup-link/);
    assert.match(script, /--setup-code/);
    assert.match(script, /--help/);
    assert.match(script, /SetupArgument|SETUP_ARGUMENT/);
    assert.match(script, /SetupArgument.*--open-setup|SETUP_ARGUMENT}" --open-setup/);
    assert.ok(
      script.lastIndexOf("--open-setup") < script.indexOf("--status"),
      "status must be printed after setup-link creation so stale heartbeat errors do not hide a successful onboarding link",
    );
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
  assert.match(archivedAgent, /parser\.add_argument\("--setup-link", "--setup-code"/);
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
