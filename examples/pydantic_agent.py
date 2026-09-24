# Copyright (c) 2026 Signature Management Consultants SLU
# Author: @ancongui (https://github.com/ancongui)
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import os

from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider


class Calculation(BaseModel):
    total: int
    explanation: str


async def main():
    # This key is a scoped sab_ bridge token, never a provider credential.
    async with AsyncOpenAI(
        base_url=os.environ.get("BRIDGE_URL", "http://127.0.0.1:8766").rstrip("/") + "/v1",
        api_key=os.environ["BRIDGE_TOKEN"],
        max_retries=0,
        timeout=330.0,
    ) as client:
        model = OpenAIChatModel("bridge/default", provider=OpenAIProvider(openai_client=client))
        agent = Agent(model, output_type=NativeOutput(Calculation))

        @agent.tool_plain
        def add(a: int, b: int) -> int:
            """Add integers in this Python process and return their sum."""
            return a + b

        result = await agent.run("Use add with a=2 and b=5. Return the total and a short explanation.")
        print(result.output.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(main())
