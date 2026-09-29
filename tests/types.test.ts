import { describe, expect, test } from "bun:test";
import {
  chunkFromDict,
  chunkKey,
  chunkToDict,
  DEFAULT_CONTENT_TYPES,
  defaultContentTypes,
  searchResultToDict,
} from "../src/types.ts";

describe("chunk and result serialization", () => {
  test("returns an independent default content list", () => {
    const types = defaultContentTypes();
    expect(types).toEqual([...DEFAULT_CONTENT_TYPES]);
    types.pop();
    expect(defaultContentTypes()).toEqual([...DEFAULT_CONTENT_TYPES]);
  });

  test("serializes and restores chunk values", () => {
    const chunk = {
      content: "x",
      file_path: "src/a.ts",
      start_line: 3,
      end_line: 4,
      language: "ts",
    };
    expect(chunkKey(chunk)).toBe("src/a.ts:3:4");
    const serialized = chunkToDict(chunk);
    expect(serialized.location).toBe("src/a.ts:3-4");
    expect(chunkFromDict(serialized)).toEqual(chunk);
    expect(
      chunkFromDict({
        content: null,
        file_path: 4,
        start_line: "2",
        end_line: "5",
        language: null,
      }),
    ).toEqual({
      content: "null",
      file_path: "4",
      start_line: 2,
      end_line: 5,
      language: null,
    });
  });

  test("serializes search results", () => {
    const chunk = { content: "x", file_path: "a.ts", start_line: 1, end_line: 1, language: null };
    expect(searchResultToDict({ chunk, score: 0.7 })).toEqual({
      chunk: chunkToDict(chunk),
      score: 0.7,
    });
  });
});
