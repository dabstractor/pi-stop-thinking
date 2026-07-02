import { describe, test, expect } from "bun:test";
import { RequestBuilder, renderReasoningText } from "../src/request/builder";
import type { ReplacementRequest } from "../src/request/builder";
import { ReasoningBuffer } from "../src/buffer";
import type { ThinkingEntry } from "../src/buffer";
import type { Diagnostics } from "../src/diagnostics";
import { DEFAULT_CONFIG } from "../src/config";

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

/** Build a frozen ReasoningBuffer snapshot from the given deltas (mirrors the buffer lifecycle). */
function makeSnapshot(diagnostics: Diagnostics, ...deltas: string[]): readonly ThinkingEntry[] {
  const buffer = new ReasoningBuffer(diagnostics, 1_000_000);
  for (const delta of deltas) buffer.append(delta);
  buffer.freeze();
  return buffer.snapshot();
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

describe("renderReasoningText — pure snapshot renderer (PRD §53 h3.70)", () => {
  const mk = (offset: number, content: string, timestamp = offset): ThinkingEntry =>
    ({ offset, timestamp, content });

  test("empty snapshot → empty string", () => {
    expect(renderReasoningText([])).toBe("");
  });

  test("single entry → its content verbatim", () => {
    expect(renderReasoningText([mk(0, "hello")])).toBe("hello");
  });

  test("multiple entries → concatenated in offset/array order", () => {
    expect(renderReasoningText([mk(0, "a"), mk(1, "b"), mk(2, "c")])).toBe("abc");
  });

  test("output contains ONLY content (no offset/timestamp leakage)", () => {
    const out = renderReasoningText([mk(7, "reason"), mk(99, "ing")]);
    expect(out).toBe("reasoning");
    // Numbers 7 and 99 must not appear as text; verify no accidental envelope leakage.
    expect(out.includes("7")).toBe(false);
    expect(out.includes("99")).toBe(false);
    expect(out.includes("offset")).toBe(false);
    expect(out.includes("timestamp")).toBe(false);
  });

  test("content is NOT interpreted/trimmed (opaque buffer, §13.4 h2.41)", () => {
    // Whitespace and newlines preserved verbatim — no normalization.
    expect(renderReasoningText([mk(0, "  spaced\n"), mk(1, "end ")])).toBe("  spaced\nend ");
  });

  test("purity — no mutation of input entries/array", () => {
    const entries = [mk(0, "x"), mk(1, "y")] as readonly ThinkingEntry[];
    const snapshot = entries.map((e) => ({ ...e })); // defensive copy
    renderReasoningText(snapshot);
    expect(snapshot).toEqual(entries);          // unchanged
    expect(snapshot.map((e) => e.content)).toEqual(["x", "y"]);
  });

  test("referentially transparent — same input ⇒ same output", () => {
    const a = renderReasoningText([mk(0, "ab"), mk(1, "cd")]);
    const b = renderReasoningText([mk(0, "ab"), mk(1, "cd")]);
    expect(a).toBe(b);
    expect(a).toBe("abcd");
  });

  test("works against a real frozen ReasoningBuffer.snapshot()", () => {
    const { diag } = makeCaptureDiag();
    const buffer = new ReasoningBuffer(diag, 1_000_000);
    buffer.append("delta-one ");
    buffer.append("delta-two");
    buffer.freeze();
    expect(renderReasoningText(buffer.snapshot())).toBe("delta-one delta-two");
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

  test("fields remain {} even when directive injection is active (reasoning text present)", () => {
    const { diag, events } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high", apiKey: "secret-key" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "sensitive reasoning content"); // NON-empty → injection active

    builder.buildReplacement(model, context, options, snapshot);

    const builtEvents = events.filter((c) => c.event === "request.replacement-built");
    expect(builtEvents).toHaveLength(1);
    // Even with reasoning text + directive flowing through, the debug payload leaks NOTHING.
    expect(builtEvents[0].fields).toEqual({});
  });
});

describe("RequestBuilder — Ephemeral Execution Directive (§53 / ADR-006)", () => {
  test("directive content — non-empty snapshot appends exactly one fenced UserMessage directive", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag); // DEFAULT: injection enabled, default delimiter
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high", temperature: 0.7 } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "Step 1: analyze. ", "Step 2: conclude.");

    const triple = builder.buildReplacement(model, context, options, snapshot);

    // Augmented context is a NEW reference (§53 h3.73 fresh copy).
    expect(triple.context).not.toBe(context);
    // Exactly ONE directive message appended.
    expect(triple.context.messages.length).toBe(context.messages.length + 1);
    // The appended message is a UserMessage.
    const directive = triple.context.messages[triple.context.messages.length - 1] as { role: string; content: string };
    expect(directive.role).toBe("user");
    // Content: rendered reasoning wrapped in the delimiter fence + non-continuation positioning.
    expect(directive.content).toContain("Step 1: analyze. Step 2: conclude."); // rendered, offset-ordered
    expect(directive.content.startsWith(DEFAULT_CONFIG.reasoningInjectionDelimiter.open)).toBe(true); // fenced open
    expect(directive.content).toContain(DEFAULT_CONFIG.reasoningInjectionDelimiter.close); // fenced close
    expect(directive.content).toContain("reference context only"); // §53 h3.72 positioning
    expect(directive.content).toContain("Do not continue or extend reasoning."); // non-continuation
  });

  test("gated fallback — reasoningInjection: false returns the SAME context reference (no directive)", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag, false); // injection DISABLED
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "reasoning that should be ignored"); // non-empty

    const triple = builder.buildReplacement(model, context, options, snapshot);

    // Gated fallback (disabled): context IS the same reference; no directive appended.
    expect(triple.context).toBe(context);
    expect(triple.context.messages.length).toBe(context.messages.length);
    // INV-014 holds regardless of the injection gate.
    expect(triple.options.reasoning).toBeUndefined();
  });

  test("gated fallback — empty snapshot returns the SAME context reference (no directive)", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag); // injection DEFAULT true
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;

    const triple = builder.buildReplacement(model, context, options, []); // empty snapshot

    // Gated fallback (empty): context IS the same reference; no directive appended.
    expect(triple.context).toBe(context);
    expect(triple.context.messages.length).toBe(context.messages.length);
  });

  test("INV-013 — by default (constructor defaults), a non-empty snapshot is reused, not discarded", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag); // NO explicit injection arg → DEFAULT true (INV-013)
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "captured material reasoning");

    const triple = builder.buildReplacement(model, context, options, snapshot);

    // INV-013: reasoning is reused — the directive is present (augmented context).
    expect(triple.context).not.toBe(context);
    expect(triple.context.messages.length).toBeGreaterThan(context.messages.length);
    const directive = triple.context.messages[triple.context.messages.length - 1] as { content: string };
    expect(directive.content).toContain("captured material reasoning");
  });

  test("custom delimiter — the builder renders reasoning inside the supplied open/close fence", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag, true, { open: "<<<OPEN>>>", close: "<<<CLOSE>>>" });
    const model = makeModel();
    const context = makeContext();
    const options = {} as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "MYTEXT");

    const triple = builder.buildReplacement(model, context, options, snapshot);

    const directive = triple.context.messages[triple.context.messages.length - 1] as { content: string };
    expect(directive.content).toContain("<<<OPEN>>>");
    expect(directive.content).toContain("<<<CLOSE>>>");
    expect(directive.content).toContain("MYTEXT");
  });
});

describe("RequestBuilder — directive non-mutation & INV-014 (§53 h3.73)", () => {
  test("non-mutation — original context, messages array, systemPrompt, and options are unchanged after injection", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const originalMessagesRef = context.messages; // capture BEFORE the call
    const options = { reasoning: "high", temperature: 0.7 } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "prior reasoning");

    builder.buildReplacement(model, context, options, snapshot);

    // §53 h3.73: the directive is ephemeral — original context & options are NOT mutated.
    expect(context.messages).toBe(originalMessagesRef);    // same messages array reference
    expect(context.messages.length).toBe(1);               // unchanged length
    expect(context.systemPrompt).toBe("You are helpful."); // untouched
    expect(options.reasoning).toBe("high");                // original reasoning level intact
    expect(options.temperature).toBe(0.7);                 // original sampling intact
    expect("maxTokens" in options).toBe(false);            // no new keys added to original options
  });

  test("INV-014 — triple.options.reasoning === undefined (fresh options); directive message carries NO reasoning field", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const options = { reasoning: "high" } as import("@earendil-works/pi-ai").SimpleStreamOptions;
    const snapshot = makeSnapshot(diag, "some reasoning");

    const triple = builder.buildReplacement(model, context, options, snapshot);

    // INV-014: reasoning disabled for EXACTLY this one request via a FRESH options object.
    expect(triple.options).not.toBe(options);              // fresh object (not the original ref)
    expect(triple.options.reasoning).toBeUndefined();      // reasoning OFF for the replacement
    expect(options.reasoning).toBe("high");                // original options UNMUTATED
    // The directive message is plain message CONTENT — it carries no reasoning-level field.
    const directive = triple.context.messages[triple.context.messages.length - 1] as Record<string, unknown>;
    expect("reasoning" in directive).toBe(false);
    expect(Object.keys(directive).sort()).toEqual(["content", "role", "timestamp"]);
  });
});

describe("RequestBuilder — maxTokens bound (§25.6 h2.97)", () => {
  test("maxTokens — caller value preserved; bounded default applied only when absent", () => {
    const { diag } = makeCaptureDiag();
    const builder = new RequestBuilder(diag);
    const model = makeModel();
    const context = makeContext();
    const snapshot = makeSnapshot(diag, "x");

    // Absent maxTokens → bounded default (DEFAULT_REPLACEMENT_MAX_TOKENS = 16384).
    const absent = builder.buildReplacement(
      model, context,
      { temperature: 0.5 } as import("@earendil-works/pi-ai").SimpleStreamOptions,
      snapshot,
    );
    expect(absent.options.maxTokens).toBe(16384);

    // Caller-supplied maxTokens → preserved verbatim.
    const present = builder.buildReplacement(
      model, context,
      { maxTokens: 4096 } as import("@earendil-works/pi-ai").SimpleStreamOptions,
      snapshot,
    );
    expect(present.options.maxTokens).toBe(4096);
  });
});
