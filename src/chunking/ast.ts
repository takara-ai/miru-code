import type { Node } from "web-tree-sitter";
import { Parser } from "web-tree-sitter";
import { getLanguageForFile } from "./grammars.ts";
import { type ChunkBoundary, mergeAdjacentChunks } from "./lines.ts";

const RECURSION_DEPTH = 500;
const MIN_CHUNK_SIZE = 50;

function astChunkingEnabled(): boolean {
  return process.env.MIRU_AST_CHUNKING !== "0";
}

function mergeNodeInner(node: Node, desiredLength: number, depth: number): ChunkBoundary[] {
  if (node.childCount === 0) {
    return [{ start: node.startIndex, end: node.endIndex }];
  }

  const length = node.endIndex - node.startIndex;
  if (depth > RECURSION_DEPTH) {
    return [{ start: node.startIndex, end: node.endIndex }];
  }
  if (length < MIN_CHUNK_SIZE) {
    return [{ start: node.startIndex, end: node.endIndex }];
  }

  const groups: ChunkBoundary[] = [];
  const children = node.children;
  let index = 0;

  while (index < children.length) {
    const child = children[index];
    if (!child) {
      break;
    }

    const start = child.startIndex;
    let end = child.endIndex;
    let groupLength = end - start;
    index += 1;

    if (groupLength > desiredLength) {
      groups.push(...mergeNodeInner(child, desiredLength, depth + 1));
      continue;
    }

    while (index < children.length) {
      const nextChild = children[index];
      if (!nextChild) {
        break;
      }
      const childLength = nextChild.endIndex - nextChild.startIndex;
      if (groupLength + childLength > desiredLength) {
        break;
      }
      end = nextChild.endIndex;
      groupLength += childLength;
      index += 1;
    }

    groups.push({ start, end });
  }

  return groups;
}

function mergeNode(node: Node, desiredLength: number): ChunkBoundary[] {
  const rawChunks = mergeNodeInner(node, desiredLength, 0);
  return mergeAdjacentChunks(rawChunks, desiredLength);
}

function byteBoundariesToCharBoundaries(
  source: string,
  byteBoundaries: ChunkBoundary[],
): ChunkBoundary[] {
  const sourceBytes = new TextEncoder().encode(source);
  const decoder = new TextDecoder();

  return byteBoundaries.map((boundary) => ({
    start: decoder.decode(sourceBytes.subarray(0, boundary.start)).length,
    end: decoder.decode(sourceBytes.subarray(0, boundary.end)).length,
  }));
}

/** AST-aware chunk boundaries via vendored tree-sitter grammars; null to fall back. */
export async function chunkAst(
  source: string,
  filePath: string,
  language: string | null,
  desiredLength: number,
): Promise<ChunkBoundary[] | null> {
  if (!source.trim() || !astChunkingEnabled()) {
    return null;
  }

  const languageObj = await getLanguageForFile(filePath, language);
  if (!languageObj) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(languageObj);

  let tree: ReturnType<Parser["parse"]>;
  try {
    tree = parser.parse(source);
  } catch {
    return null;
  }
  if (!tree) {
    return null;
  }

  try {
    const byteBoundaries = mergeNode(tree.rootNode, desiredLength);
    return byteBoundariesToCharBoundaries(source, byteBoundaries);
  } finally {
    tree.delete();
  }
}
