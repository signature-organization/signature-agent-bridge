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

import os
import unittest
from openai import AsyncOpenAI, AuthenticationError, BadRequestError
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

class Score(BaseModel):
    total: int
    label: str

class ClientCompatibility(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncOpenAI(base_url=os.environ["BRIDGE_URL"]+"/v1", api_key=os.environ["BRIDGE_TOKEN"], max_retries=0, timeout=180)
        self.model = OpenAIChatModel("bridge/default", provider=OpenAIProvider(openai_client=self.client))

    async def asyncTearDown(self):
        await self.client.close()

    async def test_sdk_text_and_model_discovery(self):
        models = await self.client.models.list()
        self.assertIn("bridge/default", [m.id for m in models.data])
        result = await self.client.chat.completions.create(model="bridge/default", messages=[{"role":"user","content":"Reply exactly BRIDGE_CLIENT_OK."}])
        self.assertIn("BRIDGE_CLIENT_OK", result.choices[0].message.content)

    async def test_sdk_stream(self):
        stream = await self.client.chat.completions.create(model="bridge/default", messages=[{"role":"user","content":"Reply exactly BRIDGE_CLIENT_OK."}], stream=True, stream_options={"include_usage":True})
        text = ""
        finish = None
        async for chunk in stream:
            if chunk.choices:
                text += chunk.choices[0].delta.content or ""
                finish = chunk.choices[0].finish_reason or finish
        self.assertIn("BRIDGE_CLIENT_OK", text)
        self.assertEqual(finish, "stop")

    async def test_pydantic_client_side_tool_loop(self):
        agent = Agent(self.model)
        calls = []
        @agent.tool_plain
        def add(a: int, b: int) -> int:
            """Add two integers."""
            calls.append((a,b))
            return a+b
        result = await agent.run("Use the add function exactly once with a=2 and b=5. Report its result.")
        self.assertEqual(calls, [(2,5)])
        self.assertIn("7", result.output)

    async def test_pydantic_typed_output(self):
        result = await Agent(self.model, output_type=Score).run("Return total=7 and label=verified.")
        self.assertEqual(result.output, Score(total=7,label="verified"))

    async def test_pydantic_native_json_output(self):
        result = await Agent(self.model, output_type=NativeOutput(Score)).run("Return total=7 and label=verified.")
        self.assertEqual(result.output, Score(total=7,label="verified"))

    async def test_pydantic_stream(self):
        async with Agent(self.model).run_stream("Reply exactly BRIDGE_CLIENT_OK.") as result:
            parts = [part async for part in result.stream_text(delta=True)]
        self.assertIn("BRIDGE_CLIENT_OK", "".join(parts))

    async def test_sdk_errors(self):
        with self.assertRaises(BadRequestError):
            await self.client.chat.completions.create(model="bridge/default", messages=[{"role":"user","content":"hello"}], temperature=0.5)
        invalid = AsyncOpenAI(base_url=os.environ["BRIDGE_URL"]+"/v1",api_key="invalid",max_retries=0)
        try:
            with self.assertRaises(AuthenticationError):
                await invalid.models.list()
        finally:
            await invalid.close()

if __name__ == "__main__":
    unittest.main()
