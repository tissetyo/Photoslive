import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { commandSignature } from "../api/bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const photoboxRoot = path.resolve(here, "../..");

test("Cloud signature is accepted by the real Python Agent canonical verifier", async () => {
  const secret = "contract-secret";
  const job = {
    id: "job_contract_1",
    machineId: "machine_contract_1",
    type: "devices.refresh",
    payload: { force: true },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  job.signature = await commandSignature(secret, job);

  const canonical = JSON.stringify({ id: job.id, machineId: job.machineId, type: job.type, payload: job.payload, expiresAt: job.expiresAt });
  assert.equal(job.signature, crypto.createHmac("sha256", secret).update(canonical).digest("hex"));

  const program = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(photoboxRoot)})`,
    "import agent",
    "payload = json.loads(sys.stdin.read())",
    "error = agent.validate_job(payload['config'], payload['job'], now_timestamp=1800000000)",
    "print(json.dumps({'valid': error is None, 'error': error}))",
  ].join("; ");
  const result = spawnSync("python3", ["-c", program], {
    cwd: photoboxRoot,
    input: JSON.stringify({ config: { commandKey: secret, machineId: job.machineId }, job }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, error: null });
});

test("hardware job schema and Agent route allowlists remain aligned", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(photoboxRoot, "contracts/v2/hardware-job.schema.json"), "utf8"));
  const schemaTypes = schema.properties.type.enum;
  const source = fs.readFileSync(path.join(photoboxRoot, "agent.py"), "utf8");
  const routedTypes = [...source.matchAll(/^\s{4}"([a-z._]+)": \("\/api\//gm)].map(match => match[1]);
  const agentTypes = [...routedTypes, "controller.request", "privacy.delete_session"].sort();
  assert.deepEqual([...schemaTypes].sort(), agentTypes);
});
