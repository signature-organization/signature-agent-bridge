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

import type { ToolObservation } from "./audit.js";
import type { Attempt, Job, Outcome } from "./contracts.js";
export type Execution = { job: Job; attempt: Attempt; cwd: string };
export type WorkerEvent = {
  kind:
    | "tool"
    | "output"
    | "progress"
    | "session"
    | "compaction"
    | "activity"
    | "rate_limit"
    | "subagent";
  tool?: ToolObservation;
  text: string;
  data?: Record<string, unknown>;
};
export interface Worker {
  ready(): Promise<{ ready: boolean; reason?: string }>;
  run(
    input: Execution,
    emit: (event: WorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<Outcome>;
}
