import { describe, expect, test } from "bun:test";
import { applyHiddenPromptChar, createHiddenPromptState } from "../src/prompt.ts";

describe("applyHiddenPromptChar", () => {
  test("appends printable characters", () => {
    const state = createHiddenPromptState();
    const a = applyHiddenPromptChar(state, "a");
    expect(a.echo).toBe("*");
    expect(a.state.value).toBe("a");
    const b = applyHiddenPromptChar(a.state, "b");
    expect(b.state.value).toBe("ab");
  });

  test("backspace removes last character", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "x").state;
    state = applyHiddenPromptChar(state, "y").state;
    const del = applyHiddenPromptChar(state, "\u007f");
    expect(del.state.value).toBe("x");
    expect(del.echo).toBe("\b \b");
  });

  test("backspace on empty input is a no-op", () => {
    const result = applyHiddenPromptChar(createHiddenPromptState(), "\b");
    expect(result.state.value).toBe("");
    expect(result.echo).toBe("");
  });

  test("submit on enter", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "k").state;
    const result = applyHiddenPromptChar(state, "\n");
    expect(result.submit).toBe(true);
    expect(result.state.value).toBe("k");
  });

  test("ignores escape sequences", () => {
    let state = createHiddenPromptState();
    state = applyHiddenPromptChar(state, "k").state;
    for (const char of "\x1b[A") {
      state = applyHiddenPromptChar(state, char).state;
    }
    expect(state.value).toBe("k");
  });
});
