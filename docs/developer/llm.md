# OpenAI-compatible LLM API

Point your OpenAI-compatible client at the host's `/llm/v1` base URL. Supply the tenant's fixture LLM API key and a model alias from `GET /llm/v1/models`. The milestone LLM plugin is registered separately from the main fixture app. Use a host configured with a deterministic fixture adapter.

```js
// In an application that already has the OpenAI client installed.
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:3001/llm/v1',
  apiKey: process.env.BS_LLM_API_KEY,
  maxRetries: 0,
});
const completion = await openai.chat.completions.create({
  model: 'tenant-chat',
  messages: [{ role: 'user', content: 'Summarize fictional order ord-001.' }],
  max_completion_tokens: 64,
});
console.log(completion.choices[0].message.content);
```

With the repository SDK, pass the origin or proxy base path without the `/llm/v1` suffix. The SDK includes that suffix when calling `llm.models()`, `llm.chat()`, `llm.streamChat()`, and `llm.embeddings()`. For a streamed reply, iterate chunks and read `choices[n].delta`. An optional usage-only chunk has an empty choices array. A server tool call is a proposal. Execute permitted proposals through the governed gateway and return their results in a subsequent request.

```powershell
$env:BS_LLM_BASE_URL = 'http://127.0.0.1:3001'
node packages/sdk/bin/bs.ts llm chat tenant-chat --prompt 'Summarize fictional order ord-001.' --stream
```

The server selects the native or BYO route from the tenant's current capability binding. An administrator configures the `llm` or `embeddings` binding and stores provider credentials in the platform vault. Keep the client pointed at the same LLM endpoint with its platform API key when switching routes. A configured fallback may make one additional chat attempt within the same pinned binding and policy. Preserve the server's `x-request-id` when diagnosing errors. [LLM request subset, routing, and metering](../personal-plan/llm-api/api.md)
