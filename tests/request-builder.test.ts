import { describe, test, expect } from "bun:test";
import { RequestBuilder } from "../src/request/builder";
import type { ReplacementRequest } from "../src/request/builder";
import { ReasoningBuffer } from "../src/buffer";
import type { ThinkingEntry } from "../src/buffer";
import type { Diagnostics } from "../src/diagnostics";

// --- test doubles ---------------------------------------------------------

type Level = "trace" | "debug" | "info" | "warn" | "error";
interface Captured {
  level: Level;
  event: string;
  fields?: Record<string, unknown>;
}

/** Capturing Diagnostics stub — records every call (adapted from transition-controller.test.ts). */
function makeCaptureDiag(): { diag: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  const diag: Diagnostics = {
    trace: (e, f) => events.push({ level: "trace", event: e, fields: f }),
    debug: (e, f) => events.push({ level: "debug", event: e, fields: f }),
    info: (e, f) => events.push({ level: "info", event: e, fields: f }),
    warn: (e, f) => events.push({ level: "warn", event: e, fields: f }),
    error: (e, f) => events.push({ level: "error", event: e, fields: f }),
  };
  return { diag, events };
}

/** Minimal Model<Api> stand-in (mirror tests/stream-proxy-abort.test.ts makeModel()). */
function makeModel() {
  return {
    id: "glm-4.7",
    api: "openai-completions",
    provider: "zai",
    reasoning: true,
    baseUrl: "https://api.zai.example.com",
    compat: { thinkingFormat: "zai" as const },
  } as unknown as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
}

/** Minimal Context mock. */
function makeContext() {
  return {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user" as const, content: "Hello" }],
  } as unknown as import("@earendil-works/pi-ai").Context;
}

// --- tests ----------------------------------------------------------------

describe("RequestBuilder — thinking-disabled transform", () => {
  test("overrides an active reasoning level to undefined", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high", temperature: 0.7, apiKey: "k" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(triple.options.reasoning).toBeUndefined();
  });

  test("already-undefined reasoning stays undefined (idempotent)", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: undefined, temperature: 0.5 } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(triple.options.reasoning).toBeUndefined();
  });

  test("absent reasoning key (no reasoning property) → undefined", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { temperature: 0.3 } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(triple.options.reasoning).toBeUndefined();
  });
});

describe("RequestBuilder — full option preservation", () => {
  test("every other SimpleStreamOptions field is preserved verbatim", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const signal = new AbortController().signal;
    const headers = { "X-Custom": "test" };
    const budgets = { high: 10000, medium: 5000 } as import("@earendil-works/pi-ai").ThinkingBudgets;
    const metadata = { key: "value" };

    const options = {
      reasoning: "high",
      temperature: 0.7,
      maxTokens: 4096,
      apiKey: "k",
      sessionId: "sess-123",
      headers,
      signal,
      timeoutMs: 30000,
      maxRetries: 3,
      thinkingBudgets: budgets,
      metadata,
    } as unknown as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    // Spot-check by value
    expect(triple.options.temperature).toBe(0.7);
    expect(triple.options.maxTokens).toBe(4096);
    expect(triple.options.apiKey).toBe("k");
    expect(triple.options.sessionId).toBe("sess-123");
    expect(triple.options.signal).toBe(signal);
    expect(triple.options.timeoutMs).toBe(30000);
    expect(triple.options.maxRetries).toBe(3);
    expect(triple.options.thinkingBudgets).toBe(budgets);
    expect(triple.options.metadata).toBe(metadata);
    // headers preserved by reference (shallow share is expected)
    expect(triple.options.headers).toBe(headers);
    // reasoning forced off
    expect(triple.options.reasoning).toBeUndefined();
  });
});

describe("RequestBuilder — model & context pass-through (PRD §25.3/§25.4/§25.7)", () => {
  test("model is the same reference as the input (no copy)", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(triple.model).toBe(model); // strict identity
  });

  test("context is the same reference as the input (no rewrite)", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(triple.context).toBe(context); // strict identity
  });
});

describe("RequestBuilder — input NOT mutated (purity)", () => {
  test("original options.reasoning is unchanged after the call", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high", temperature: 0.7 } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    builder.buildReplacement(model, context, options, []);

    // Original must be untouched
    expect(options.reasoning).toBe("high");
    expect(options.temperature).toBe(0.7);
    // No new keys added to the original
    const originalKeys = new Set(Object.keys(options));
    expect(originalKeys.has("reasoning")).toBe(true);
    expect(originalKeys.has("temperature")).toBe(true);
    expect(originalKeys.size).toBe(2);
  });
});

describe("RequestBuilder — frozen snapshot accepted", () => {
  test("passing a real frozen ReasoningBuffer snapshot does not throw", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    // Build a real ReasoningBuffer, append, freeze, take snapshot
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    buffer.append("reasoning delta one");
    buffer.append("reasoning delta two");
    buffer.freeze();
    const frozenSnapshot: readonly ThinkingEntry[] = buffer.snapshot();

    expect(Object.isFrozen(frozenSnapshot)).toBe(true);

    // Must not throw
    const triple = builder.buildReplacement(model, context, options, frozenSnapshot);

    expect(triple.options.reasoning).toBeUndefined();
  });
});

describe("RequestBuilder — exact triple shape", () => {
  test("returned object has exactly three keys: context, model, options", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    expect(Object.keys(triple).sort()).toEqual(["context", "model", "options"]);
  });
});

describe("RequestBuilder — replacement options is a fresh unfrozen object", () => {
  test("triple.options is a different reference from the input AND not frozen", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "medium", temperature: 0.5 } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []);

    // Fresh object (not the same reference)
    expect(triple.options).not.toBe(options);
    // NOT frozen (P1.M7 needs to spread/override, e.g. inject a fresh abort signal)
    expect(Object.isFrozen(triple.options)).toBe(false);
    // Verify P1.M7 can spread/override
    const overridden = { ...triple.options, signal: new AbortController().signal };
    expect(overridden.signal).not.toBe(options.signal);
  });
});

describe("RequestBuilder — no network / no streaming", () => {
  test("constructor takes only a diagnostics stub; call returns synchronously", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;

    // No stream function is passed anywhere; the call returns synchronously
    const triple = builder.buildReplacement(model, context, options, []);

    // Verify the return type satisfies ReplacementRequest
    expect(triple).toBeDefined();
    expect(triple.model).toBeDefined();
    expect(triple.context).toBeDefined();
    expect(triple.options).toBeDefined();
  });
});

describe("RequestBuilder — privacy guard (Appendix H)", () => {
  test("debug event fires once with fields === {} (no content/prompt/options keys)", () => {
    const { diag, events } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high", apiKey: "secret-key" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    builder.buildReplacement(model, context, options, []);

    // Exactly one replacement-built event
    const builtEvents = events.filter((c) => c.event === "request.replacement-built");
    expect(builtEvents).toHaveLength(1);
    // Fields must be exactly {} — no content, no prompt, no options, no reasoning
    expect(builtEvents[0].fields).toEqual({});
  });
});
