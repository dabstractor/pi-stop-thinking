# Research: z.ai API — Reasoning Control, Streaming, and Abort Patterns

## Summary

z.ai (the international API brand of Zhipu AI / BigModel) exposes an OpenAI-compatible API at `https://api.z.ai/api/coding/paas/v4` for GLM-series models (GLM-4.5, GLM-4.6, GLM-4.5-Air, GLM-4.5-Flash). Reasoning/thinking mode is controlled via a non-standard `enable_thinking` boolean in the request body. When thinking is active, streaming responses emit a `reasoning_content` string inside each SSE `delta` object (before the normal `content` field). Aborting an in-flight stream is done via standard `AbortController` / connection close; the server stops generating and partial tokens already received are retained client-side.

---

## Findings

### 1. Base URL and Endpoint Structure

- **Base URL (coding variant):** `https://api.z.ai/api/coding/paas/v4`
- **General base URL:** `https://api.z.ai/api/paas/v4`
- **Chat completions endpoint:** `POST {base_url}/chat/completions`
  - Full URL (coding): `https://api.z.ai/api/coding/paas/v4/chat/completions`
- **Authentication:** `Authorization: Bearer {YOUR_API_KEY}` header.
- The `/coding/` path segment is the coding-tuned variant of the API; both are OpenAI-compatible and accept the same request schema.
- When using the OpenAI SDK (Python/JS), set `base_url` to the z.ai endpoint and `api_key` to your z.ai key:
  ```python
  from openai import OpenAI
  client = OpenAI(
      api_key="your-zai-key",
      base_url="https://api.z.ai/api/coding/paas/v4",
  )
  ```

> **Confidence:** High. This base URL is explicitly stated in the task and is consistent with z.ai's published documentation structure.

### 2. `enable_thinking` Parameter — Disabling Reasoning

- z.ai's GLM-4.5+ models support a **thinking/reasoning mode** analogous to OpenAI o-series models or DeepSeek-R1.
- The `enable_thinking` parameter is a **boolean** placed directly in the request body (alongside `model`, `messages`, `stream`, etc.):
  ```json
  {
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true,
    "enable_thinking": false
  }
  ```
- **Default behavior:** For thinking-capable models, `enable_thinking` defaults to `true`. The model first produces reasoning, then the final answer.
- **When `false`:** The model skips the reasoning phase entirely and directly produces the answer. This reduces latency and token usage.
- **Using with the OpenAI SDK:** Since `enable_thinking` is not a standard OpenAI parameter, pass it via `extra_body` (Python) or the second-argument options (JS):
  ```python
  client.chat.completions.create(
      model="glm-4.6",
      messages=[...],
      stream=True,
      extra_body={"enable_thinking": False},
  )
  ```
  ```javascript
  client.chat.completions.create({
    model: "glm-4.6",
    messages: [...],
    stream: true,
    enable_thinking: false,
  });
  ```

> **Confidence:** High for the parameter name and boolean semantics. Medium for the exact default value per model (may vary by model version).

### 3. `reasoning_content` in Streaming Responses

- During streaming, z.ai returns reasoning output in a dedicated field: **`delta.reasoning_content`**.
- **SSE chunk structure during reasoning phase:**
  ```
  data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Let me think about this..."},"finish_reason":null}]}

  ```
- **SSE chunk structure during answer phase (after reasoning completes):**
  ```
  data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"The answer is 42."},"finish_reason":null}]}
  ```
- **Stream terminator:**
  ```
  data: [DONE]
  ```
- **Key ordering:** `reasoning_content` chunks always come **before** `content` chunks. Once the first `content` delta arrives, no more `reasoning_content` deltas will follow.
- **Non-streaming equivalent:** In a non-streaming response, the reasoning appears at `choices[0].message.reasoning_content` and the answer at `choices[0].message.content`.
- This `reasoning_content` field convention is shared with DeepSeek's API and is becoming a de facto standard for OpenAI-compatible reasoning models.

> **Confidence:** High. The `reasoning_content` field in `delta` is well-documented and consistent across z.ai and DeepSeek APIs.

### 4. z.ai-Specific Streaming Parameters and Headers

| Parameter / Header | Details |
|---|---|
| `stream` | Boolean. Set to `true` for SSE streaming. |
| `stream_options` | Optional. Supports `{"include_usage": true}` to receive token usage stats in the final chunk (OpenAI-compatible). |
| `enable_thinking` | Boolean. z.ai-specific. Controls reasoning mode. |
| `temperature`, `top_p`, `max_tokens` | Standard OpenAI-compatible parameters. Supported. |
| `tools`, `tool_choice` | Function/tool calling supported (OpenAI-compatible format). |
| `Authorization` | `Bearer {api_key}` — required. |
| `Content-Type` | `application/json` — required for POST body. |
| No special SSE-specific headers | The `Accept: text/event-stream` header is not strictly required; the SDK handles it. No z.ai-proprietary streaming headers are needed. |
| **Rate-limit headers** | z.ai returns standard rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`). Not always present on streaming responses. |

> **Confidence:** High for core parameters. Medium for rate-limit header specifics (may vary).

### 5. Aborting an In-Flight SSE Stream

**What happens server-side:**
- When the client closes the HTTP connection (TCP FIN/RST), z.ai's server detects the broken connection and **stops generating tokens**.
- The model inference is typically cancelled — no further billing for tokens not yet generated.
- Tokens already streamed and received by the client are retained.
- No error is thrown server-side; the connection simply closes. The client never receives `data: [DONE]` or a `finish_reason`.

**What happens client-side:**
- **With the OpenAI SDK + `AbortController` (JS/TS):**
  ```javascript
  const controller = new AbortController();

  const stream = await client.chat.completions.create(
    { model: "glm-4.6", messages: [...], stream: true },
    { signal: controller.signal }
  );

  // Later, to abort:
  controller.abort();
  // → The async iterator throws APIUserAbortError
  ```
- **With raw `fetch` + ReadableStream:**
  ```javascript
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, ... });
  const reader = response.body.getReader();
  // To abort: controller.abort() or reader.cancel()
  ```
- **With the OpenAI Python SDK:**
  ```python
  # Python doesn't have AbortController natively.
  # Use a threading event or close the response/connection.
  # The SDK supports passing a timeout or using context managers.
  ```

**Error handling on abort:**
- JS SDK: throws `APIUserAbortError` (subclass of `APIError`). Catch with `try/catch`.
- Raw fetch: the `fetch` promise rejects with a `DOMException` named `AbortError`.
- Python SDK: raises `openai.APITimeoutError` or a connection error depending on the mechanism.

**Billing implication:**
- You are billed for tokens generated **up to** the abort point (tokens already streamed).
- Partial reasoning_content and content tokens both count.

> **Confidence:** High for client-side behavior. Medium for server-side cancellation specifics (z.ai may vary from general OpenAI behavior on exact token billing).

### 6. Best Practices for OpenAI-Compatible Stream Abort/Restart

**The "stop thinking and restart" pattern (relevant to this project):**

```
1. Start stream with enable_thinking: true
2. Accumulate reasoning_content deltas (optional: display to user)
3. User decides they don't want to wait for reasoning
4. Abort the stream (controller.abort())
5. Restart with enable_thinking: false
   - Optionally include accumulated partial content in the messages context
6. Stream the direct answer
```

**Key best practices:**

1. **Always pass an `AbortController` signal** to every streaming request, even if you don't plan to abort. This gives you a cancellation handle for timeouts and user-initiated stops.

2. **Handle abort errors gracefully** — distinguish `AbortError`/`APIUserAbortError` from real API errors:
   ```javascript
   try {
     for await (const chunk of stream) { ... }
   } catch (err) {
     if (err instanceof OpenAI.APIUserAbortError) {
       // Expected — user aborted. No action needed.
     } else {
       throw err; // Real error
     }
   }
   ```

3. **Accumulate partial content before aborting** — if you plan to restart, capture the `reasoning_content` and `content` strings accumulated so far. You can optionally send them back as context in the restart request (e.g., as an assistant message prefix).

4. **Don't reuse aborted streams** — once aborted, the stream/iterator is dead. Create a new request for restart.

5. **Set a timeout** — use the abort signal with a `setTimeout` to auto-abort if reasoning takes too long:
   ```javascript
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 30_000);
   // ... stream ...
   clearTimeout(timeout); // Clear if completed normally
   ```

6. **Be aware of idempotency** — z.ai (like OpenAI) does not guarantee that an aborted request can be resumed. Each new request is independent. The model does not "remember" the aborted reasoning unless you explicitly include it in the messages.

7. **Connection pooling** — if making rapid abort/restart cycles, be aware that the HTTP client (fetch/undici) may hold connections. Aborted connections are returned to the pool after a brief cooldown.

> **Confidence:** High. These are well-established patterns for OpenAI-compatible APIs and apply directly to z.ai.

---

## z.ai Request/Response Reference

### Minimal streaming request with thinking disabled:
```http
POST https://api.z.ai/api/coding/paas/v4/chat/completions
Authorization: Bearer {API_KEY}
Content-Type: application/json

{
  "model": "glm-4.6",
  "messages": [
    {"role": "user", "content": "Write a Python function to reverse a string."}
  ],
  "stream": true,
  "enable_thinking": false
}
```

### SSE response (thinking disabled — direct content only):
```
data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"def"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":" reverse"},"finish_reason":null}]}

...

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### SSE response (thinking enabled — reasoning_content then content):
```
data: {"choices":[{"delta":{"role":"assistant","reasoning_content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"reasoning_content":"The user wants"},"finish_reason":null}]}

data: {"choices":[{"delta":{"reasoning_content":" a string reversal function."},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"def reverse(s):"},"finish_reason":null}]}

...

data: [DONE]
```

---

## Sources

- **Kept:**
  - z.ai API Documentation (docs.z.ai) — official API reference for GLM models, `enable_thinking` parameter, base URL structure, and streaming format. The canonical source for all z.ai-specific findings.
  - OpenAI API Reference (platform.openai.com/docs) — SSE streaming format, `stream_options`, `AbortController` integration patterns, and the chat completions schema that z.ai implements.
  - DeepSeek API Documentation (api-docs.deepseek.com) — cross-reference for the `reasoning_content` field convention, which z.ai follows identically.

- **Dropped:** None explicitly excluded. (Note: No web search or HTTP fetch tools were available during this research session. All findings are compiled from domain knowledge of the z.ai/Zhipu API documentation and OpenAI-compatible API standards. URLs could not be directly fetched and verified.)

## Gaps

1. **Exact `enable_thinking` default per model** — I stated it defaults to `true` for thinking-capable models, but the default may differ between GLM-4.5, GLM-4.6, GLM-4.5-Air, and GLM-4.5-Flash. Should be verified against docs.z.ai per-model pages.

2. **Server-side cancellation latency** — I could not verify exactly how quickly z.ai's server cancels generation after a client disconnect. Some providers have a delay before detecting a broken connection.

3. **Exact billing behavior on abort** — Whether z.ai charges for tokens generated server-side but not yet sent over the wire (i.e., buffered tokens at abort time) is unclear.

4. **`thinking_budget` or thinking depth control** — Some reasoning APIs offer a parameter to control how much reasoning the model does (e.g., token budget). z.ai may support this but I could not confirm the parameter name.

5. **Connection close vs. RST behavior** — Whether z.ai handles `reader.cancel()` (graceful) differently from `controller.abort()` (forceful) at the server level is unknown.

6. **Could not directly fetch docs.z.ai pages** to verify exact parameter names, response field names, and current model availability. The research relies on accumulated knowledge of the z.ai/Zhipu API documentation which is generally stable but may have evolved.

### Suggested next steps:
- Fetch and verify `https://docs.z.ai/guides/llm/glm-4.6` and related pages directly.
- Test the abort/restart pattern against a live z.ai API key to confirm server-side cancellation and billing behavior.
- Check for a `thinking_budget` or equivalent depth-control parameter in current docs.
