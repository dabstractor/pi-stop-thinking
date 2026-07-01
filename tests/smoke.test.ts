import { test, expect } from "bun:test";
import stopThinkingExtension from "../src/index";

test("exports a factory function", () => {
  expect(typeof stopThinkingExtension).toBe("function");
});

test("factory accepts an ExtensionAPI-like object without throwing (no-op)", () => {
  expect(() => stopThinkingExtension({} as never)).not.toThrow();
});
