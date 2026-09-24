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

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { QueueStore } from "./store.js";
import { Tokens } from "./auth.js";
import { Workflows } from "./workflows.js";
import { Scheduler } from "./scheduler.js";
import { ClaudeWorker } from "./claude.js";
import { createHttpService } from "./http.js";
import type { BridgeConfig } from "./config.js";
import type { Worker } from "./worker.js";
import type { Job } from "./contracts.js";
export function privateWrite(path: string, value: string): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}
export async function startService(
  config: BridgeConfig,
  options: { managed?: boolean; worker?: (job: Job) => Worker } = {},
) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  let compromised = false;
  let closeService: () => Promise<void> = async () => {};
  // One renewable OS-visible lock protects both SQLite recovery and process ownership.
  const release = await lockfile.lock(join(config.dataDir, "service"), {
    realpath: false,
    stale: 10000,
    update: 2000,
    onCompromised: () => {
      compromised = true;
      void closeService();
    },
  });
  let opened: QueueStore | undefined;
  try {
    const store = (opened = new QueueStore(
      join(config.dataDir, "queue.sqlite"),
      config.queueCapacity,
    ));
    const auth = new Tokens(store),
      flows = new Workflows(store, config.workflows);
    const ownerPath = join(config.dataDir, "owner.token");
    let ownerToken = existsSync(ownerPath)
      ? readFileSync(ownerPath, "utf8").trim()
      : "";
    try {
      auth.verify(ownerToken);
    } catch {
      ownerToken = auth.create({
        id: "owner",
        owner: true,
        profiles: Object.keys(config.profiles),
      }).token;
      privateWrite(ownerPath, ownerToken + "\n");
    }
    chmodSync(ownerPath, 0o600);
    chmodSync(join(config.dataDir, "queue.sqlite"), 0o600);
    const workerFor =
      options.worker ??
      ((job) =>
        new ClaudeWorker({
          path: config.claudePath,
          ...config.profiles[job.profile]!,
        }));
    const scheduler = new Scheduler(
      store,
      flows,
      workerFor,
      config.workspace,
      config.concurrency,
    );
    scheduler.readiness = options.worker
      ? { ready: true }
      : { ready: false, reason: "Checking the official Claude Code login" };
    const instanceId = randomUUID(),
      hosts = new Map<string, number>();
    let closing: Promise<void> | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      idleSince = Date.now();
    const app = createHttpService({
      store,
      auth,
      scheduler,
      flows,
      config,
      persistConfig: (next) =>
        privateWrite(
          join(config.dataDir, "config.json"),
          JSON.stringify(next, null, 2) + "\n",
        ),
      diagnostics: () => ({
        instanceId,
        pid: process.pid,
        managed: Boolean(options.managed),
        hosts: hosts.size,
        dataDir: config.dataDir,
        workspace: config.workspace,
      }),
      heartbeat: (id) => {
        hosts.set(id, Date.now());
        idleSince = Date.now();
      },
      disconnect: (id) => {
        hosts.delete(id);
      },
      shutdown: () => {
        setTimeout(() => void close(), 50);
      },
    });
    function close(): Promise<void> {
      return (closing ??= (async () => {
        if (timer) clearInterval(timer);
        // Close public streams first, then reconcile child processes before releasing the database lock.
        try {
          await app.close();
        } finally {
          try {
            await scheduler.stop();
          } finally {
            try {
              store.close();
            } finally {
              await release().catch(() => {});
            }
          }
        }
      })());
    }
    closeService = close;
    let address: string;
    try {
      address = await app.listen({ host: config.host, port: config.port });
      // A port collision must not mark another instance's work as interrupted.
      store.recover();
      scheduler.start();
      privateWrite(
        join(config.dataDir, "service.json"),
        JSON.stringify({
          address,
          instanceId,
          protocolVersion: 1,
          pid: process.pid,
        }),
      );
      timer = setInterval(() => {
        for (const [id, seen] of hosts)
          if (Date.now() - seen > 7000) hosts.delete(id);
        const newest = store.db
          .prepare("SELECT MAX(id) AS id FROM events")
          .get() as { id: number | null };
        if ((newest.id ?? 0) - store.eventFloor() > 10000)
          store.pruneEvents(newest.id! - 10000);
        if (hosts.size || scheduler.activeCount || store.pending("cli").length)
          idleSince = Date.now();
        if (
          compromised ||
          (options.managed && Date.now() - idleSince > config.idleMs)
        )
          void close();
      }, 1000);
      timer.unref();
      if (!options.worker)
        void new ClaudeWorker({
          path: config.claudePath,
          ...config.profiles.default!,
        })
          .ready()
          .then((ready) => {
            if (!closing && !scheduler.controlState.paused)
              scheduler.readiness = ready;
          });
    } catch (error) {
      await close();
      throw error;
    }
    return { address, ownerToken, instanceId, store, scheduler, close };
  } catch (error) {
    opened?.close();
    await release().catch(() => {});
    throw error;
  }
}
