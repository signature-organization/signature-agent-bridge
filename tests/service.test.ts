/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { it, expect, vi } from "vitest";
import lockfile from "proper-lockfile";
import { mkdtempSync, rmSync } from "node:fs";
import { QueueStore } from "../src/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
it("shares a locked service, authenticates host leases, and releases ownership on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-service-"));
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    claudePath: process.execPath,
    port: 0,
  });
  const service = await startService(config, {
    worker: () => ({
      ready: async () => ({ ready: true }),
      run: async () => ({ status: "succeeded", result: "ok" }),
    }),
  });
  try {
    const headers = {
      authorization: "Bearer " + service.ownerToken,
      "content-type": "application/json",
    };
    const response = await fetch(service.address + "/v1/status", { headers });
    expect(response.status).toBe(200);
    await expect(startService(config)).rejects.toThrow(/lock/i);
    const lease = await fetch(service.address + "/v1/hosts/heartbeat", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "host-one" }),
    });
    expect(lease.status).toBe(200);
    const submit = await fetch(service.address + "/v1/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "smoke" }),
    });
    const job = (await submit.json()) as { id: string };
    await expect
      .poll(
        async () =>
          (
            (await (
              await fetch(service.address + "/v1/jobs/" + job.id, { headers })
            ).json()) as { status: string }
          ).status,
      )
      .toBe("succeeded");
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("releases the service lock when database initialization fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-bad-db-")),
    db = join(dir, "queue.sqlite");
  const store = new QueueStore(db);
  store.db.exec("PRAGMA user_version=999");
  store.close();
  const config = parseConfig({
    dataDir: dir,
    workspace: join(dir, "jobs"),
    claudePath: process.execPath,
    port: 0,
  });
  await expect(startService(config)).rejects.toThrow(/newer/);
  const repair = new QueueStore(":memory:");
  repair.close();
  const { DatabaseSync } = await import("node:sqlite");
  const connection = new DatabaseSync(db);
  connection.exec("PRAGMA user_version=1");
  connection.close();
  const service = await startService(config);
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

it("closes the listener when renewable ownership is compromised", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-compromised-"));
  let compromise: ((error: Error) => void) | undefined;
  const original = lockfile.lock;
  const spy = vi
    .spyOn(lockfile, "lock")
    .mockImplementation(async (path, options) => {
      compromise = options?.onCompromised;
      return original(path, options);
    });
  const service = await startService(
    parseConfig({
      dataDir: dir,
      workspace: join(dir, "jobs"),
      claudePath: process.execPath,
      port: 0,
    }),
    {
      worker: () => ({
        ready: async () => ({ ready: true }),
        run: async () => ({ status: "succeeded" }),
      }),
    },
  );
  spy.mockRestore();
  try {
    expect(() => compromise!(new Error("Ownership lost"))).not.toThrow();
    // Observe completed cleanup before probing HTTP; a request racing socket shutdown
    // can itself stall on a reused connection and hide the actual lifecycle result.
    await expect
      .poll(() => service.store.db.isOpen, { timeout: 5000 })
      .toBe(false);
    await expect(
      fetch(service.address, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
