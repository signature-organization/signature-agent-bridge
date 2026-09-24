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

import type { FastifyReply } from "fastify";
import { BridgeError, type Principal } from "./contracts.js";
import { QueueStore } from "./store.js";
import { Tokens } from "./auth.js";
export class EventStreams {
  private streams = new Map<FastifyReply, string>();
  constructor(
    private store: QueueStore,
    private tokens: Tokens,
  ) {}
  open(reply: FastifyReply, p: Principal, token: string, after: number): void {
    this.store.events(p, after, 1);
    if (
      this.streams.size >= 100 ||
      [...this.streams.values()].filter((id) => id === p.id).length >= 4
    )
      throw new BridgeError(
        "stream_limit",
        "SSE connection limit reached",
        429,
      );
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    this.streams.set(reply, p.id);
    let cursor = after,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pumpTimer);
      clearInterval(heartbeat);
      this.streams.delete(reply);
      reply.raw.end();
    };
    const write = (text: string) => {
      if (!reply.raw.write(text)) {
        close();
        return false;
      }
      return true;
    };
    const pump = () => {
      try {
        const principal = this.tokens.verify(token);
        for (const event of this.store.events(principal, cursor)) {
          if (
            !write(
              "id: " +
                event.id +
                "\nevent: " +
                event.type +
                "\ndata: " +
                JSON.stringify(event) +
                "\n\n",
            )
          )
            return;
          cursor = event.id;
        }
      } catch {
        close();
      }
    };
    const pumpTimer = setInterval(pump, 150),
      heartbeat = setInterval(() => write(": heartbeat\n\n"), 15000);
    reply.raw.on("close", close);
    reply.raw.on("error", close);
    write(": connected\n\n");
    pump();
  }
  close(): void {
    for (const reply of this.streams.keys()) reply.raw.destroy();
    this.streams.clear();
  }
  get count(): number {
    return this.streams.size;
  }
}
