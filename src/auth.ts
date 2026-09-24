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

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { BridgeError, type Principal } from "./contracts.js";
import { QueueStore } from "./store.js";
const principalSchema = z.strictObject({
  id: z.string().min(1).max(64),
  owner: z.boolean(),
  profiles: z.array(z.string()).max(100),
  scopes: z
    .array(z.enum(["read", "submit", "control", "workflows", "admin"]))
    .default(["read", "submit", "control", "workflows"]),
});
export class Tokens {
  constructor(private store: QueueStore) {}
  create(input: Principal): { token: string; principal: Principal } {
    const principal = principalSchema.parse(input);
    const token = "sab_" + randomBytes(32).toString("base64url");
    this.store.db
      .prepare("INSERT INTO tokens(hash,data) VALUES(?,?)")
      .run(this.hash(token), JSON.stringify(principal));
    return { token, principal };
  }
  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  verify(token: string): Principal {
    if (!/^sab_[A-Za-z0-9_-]{43}$/.test(token))
      throw new BridgeError(
        "unauthorized",
        "Valid bearer authentication is required",
        401,
      );
    const row = this.store.db
      .prepare("SELECT data FROM tokens WHERE hash=? AND revoked=0")
      .get(this.hash(token)) as { data: string } | undefined;
    if (!row)
      throw new BridgeError("unauthorized", "Token is invalid or revoked", 401);
    return JSON.parse(row.data) as Principal;
  }
  revoke(id: string): void {
    for (const row of this.store.db
      .prepare("SELECT hash,data FROM tokens")
      .all() as { hash: string; data: string }[])
      if ((JSON.parse(row.data) as Principal).id === id)
        this.store.db
          .prepare("UPDATE tokens SET revoked=1 WHERE hash=?")
          .run(row.hash);
  }
  list(): { id: string; owner: boolean; revoked: boolean }[] {
    return (
      this.store.db.prepare("SELECT data,revoked FROM tokens").all() as {
        data: string;
        revoked: number;
      }[]
    ).map((r) => {
      const p = JSON.parse(r.data) as Principal;
      return { id: p.id, owner: p.owner, revoked: Boolean(r.revoked) };
    });
  }
}
