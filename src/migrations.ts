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

import type { DatabaseSync } from "node:sqlite";
export function migrate(db: DatabaseSync): void {
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > 1) throw new Error("Database requires a newer bridge version");
  db.exec(`
 PRAGMA journal_mode=WAL;
 PRAGMA synchronous=FULL;
 PRAGMA foreign_keys=ON;
 PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,mode);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job_id);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, job_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS idempotency(principal_id TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(principal_id,route,key));
 CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 PRAGMA user_version=1;
 `);
}
