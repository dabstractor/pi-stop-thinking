/**
 * # Consumer Harness — stream-generic consumer-simulation harness.
 *
 * **Responsibility**: consume an AssistantMessageEventStream EXACTLY like
 * @earendil-works/pi-agent-core's agent-loop.js consumer (§1 lines ~194–249):
 *   - `partialMessage = event.partial` on `start` and EVERY non-terminal event,
 *     recorded as a shallow copy into `partialHistory` (the real consumer keeps only
 *     the LAST partialMessage; we keep history to expose partial-switching bugs);
 *   - `finalMessage = await response.result()` (resolves to the terminal's
 *     `message`/`error` field).
 *
 * Does NOT index by `contentIndex` (that is the proxy.js `processProxyEvent` path —
 * a different consumer). This harness relies purely on `event.partial` following,
 * exactly like agent-loop.js.
 *
 * **Consumed by**: P1.M2.T3.S1 (Issue 1 integration test) and P1.M3.T2.S1
 * (EC-005/EC-006 shortcut-disabled tests).
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export interface ConsumeResult {
  /** The persisted message — `await stream.result()`, i.e. the terminal event's message field. */
  finalMessage: AssistantMessage;
  /** Every event observed, in order (raw forwarded stream). */
  events: AssistantMessageEvent[];
  /** Shallow-copied `event.partial` at each start/non-terminal step — the streaming
   *  `partialMessage` history (mirrors `partialMessage = event.partial`). */
  partialHistory: AssistantMessage[];
}

const RESULT_TIMEOUT_MS = 5000;

/**
 * Consume an AssistantMessageEventStream EXACTLY like agent-loop.js:
 *   - `partialMessage = event.partial` on `start` and EVERY non-terminal event (recorded as a
 *     shallow copy into `partialHistory` because we keep history, unlike the consumer's single slot);
 *   - `finalMessage = await response.result()` (resolves to the terminal's `message`/`error`).
 *
 * Does NOT index by `contentIndex` (that is the proxy.js processProxyEvent path — a different
 * consumer). This harness relies purely on `event.partial` following, exactly like agent-loop.js.
 *
 * Consumed by P1.M2.T3.S1 (Issue 1 integration test) and P1.M3.T2.S1 (EC-005/EC-006).
 */
export async function consumeLikeAgentLoop(
  stream: AssistantMessageEventStream,
): Promise<ConsumeResult> {
  const events: AssistantMessageEvent[] = [];
  const partialHistory: AssistantMessage[] = [];

  for await (const event of stream) {
    events.push(event);
    // done/error carry `message`/`error` (NOT `partial`); the narrowing also satisfies TS.
    if (event.type !== "done" && event.type !== "error") {
      partialHistory.push({ ...event.partial }); // shallow copy — `partial` is a LIVE ref
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finalMessage = await Promise.race([
      stream.result(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("consumeLikeAgentLoop: stream.result() timed out")),
          RESULT_TIMEOUT_MS,
        );
      }),
    ]);
    return { finalMessage, events, partialHistory };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
