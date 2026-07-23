import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../../.github/workflows/quality.yml", import.meta.url), "utf8");
const requirements = fs.readFileSync(new URL("../../requirements-controller.txt", import.meta.url), "utf8");
const packageLock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("CI scans complete git history for secrets with a commit-pinned action", () => {
  assert.match(workflow, /secret-scan:/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /gitleaks\/gitleaks-action@[a-f0-9]{40}/);
  assert.doesNotMatch(workflow, /gitleaks\/gitleaks-action@(master|main|v\d+)/);
});

test("CI audits pinned JavaScript and Python production dependencies", () => {
  assert.match(workflow, /dependency-audit:/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /pip-audit==2\.9\.0/);
  assert.match(workflow, /pip_audit -r photobox\/requirements-controller\.txt/);
  assert.match(requirements, /^Pillow==\d+\.\d+\.\d+$/m);
  assert.equal(packageLock.lockfileVersion, 3);
});
