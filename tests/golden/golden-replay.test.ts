import { describe, test, expect } from "bun:test";
import { replayEvents } from "./replay";
import { NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY } from "./fixtures";

describe("Golden Replay — Phase 1 inactive baseline (PRD §55.178 / §50)", () => {
  test("NORMAL_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(NORMAL_REPLAY)).toEqual(NORMAL_REPLAY);
  });

  test("NO_REASONING_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(NO_REASONING_REPLAY)).toEqual(NO_REASONING_REPLAY);
  });

  test("ERROR_REPLAY replays byte-for-byte through StreamProxy", async () => {
    expect(await replayEvents(ERROR_REPLAY)).toEqual(ERROR_REPLAY);
  });

  test("every replay's terminal event is preserved (single-terminal, PRD §13.2)", async () => {
    for (const fixture of [NORMAL_REPLAY, NO_REASONING_REPLAY, ERROR_REPLAY]) {
      const out = await replayEvents(fixture);
      expect(out.length).toBe(fixture.length); // no duplicates / no drops
      expect(["done", "error"]).toContain(out.at(-1)!.type); // last event IS a terminal
      expect(out.at(-1)).toEqual(fixture.at(-1)); // terminal preserved byte-for-byte
    }
  });
});
