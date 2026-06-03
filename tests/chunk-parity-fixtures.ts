import type { ChunkBoundary } from "../src/chunking/lines.ts";

export interface ChunkParityFixture {
  language: "python" | "go" | "typescript" | "javascript";
  desiredLength: number;
  source: string;
  pythonBoundaries: ChunkBoundary[];
}

export const CHUNK_PARITY_FIXTURES: ChunkParityFixture[] = [
  {
    language: "python",
    desiredLength: 240,
    source: `import os

class Service:
    def __init__(self, db):
        self.db = db

    def run(self, item):
        value = self.db.lookup(item)
        if value is None:
            return {"ok": False, "reason": "missing"}
        total = 0
        for i in range(20):
            total += i
        return {"ok": True, "value": value, "total": total}


def helper(x):
    data = []
    for i in range(50):
        data.append((i, x))
    return data


def render(items):
    out = []
    for item in items:
        out.append("item=" + str(item))
    return "\\n".join(out)
`,
    pythonBoundaries: [
      { start: 0, end: 100 },
      { start: 109, end: 346 },
      { start: 349, end: 568 },
    ],
  },
  {
    language: "go",
    desiredLength: 240,
    source: `package demo

import "fmt"

type Service struct {
    Name string
}

func (s *Service) Run(items []int) []string {
    out := make([]string, 0, len(items))
    for _, item := range items {
        out = append(out, fmt.Sprintf("%s:%d", s.Name, item))
    }
    return out
}

func helper(v int) int {
    total := 0
    for i := 0; i < 100; i++ {
        total += i + v
    }
    return total
}

func render(lines []string) string {
    s := ""
    for _, line := range lines {
        s += line + "\\n"
    }
    return s
}
`,
    pythonBoundaries: [
      { start: 0, end: 67 },
      { start: 69, end: 273 },
      { start: 275, end: 393 },
      { start: 395, end: 522 },
    ],
  },
  {
    language: "typescript",
    desiredLength: 240,
    source: `export class Service {
  constructor(private readonly id: string) {}

  run(items: number[]): string[] {
    const out: string[] = [];
    for (const item of items) {
      out.push(this.id + ":" + item);
    }
    return out;
  }
}

export function helper(v: number): number {
  let total = 0;
  for (let i = 0; i < 100; i++) {
    total += i + v;
  }
  return total;
}

export const render = (lines: string[]): string => {
  return lines.join("\\n");
};
`,
    pythonBoundaries: [
      { start: 0, end: 232 },
      { start: 234, end: 454 },
    ],
  },
  {
    language: "javascript",
    desiredLength: 240,
    source: `class Service {
  constructor(id) {
    this.id = id;
  }

  run(items) {
    const out = [];
    for (const item of items) {
      out.push(this.id + ":" + item);
    }
    return out;
  }
}

function helper(v) {
  let total = 0;
  for (let i = 0; i < 100; i++) {
    total += i + v;
  }
  return total;
}

const render = (lines) => {
  return lines.join("\\n");
};
`,
    pythonBoundaries: [
      { start: 0, end: 191 },
      { start: 193, end: 365 },
    ],
  },
];
