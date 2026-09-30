import type { Node } from "web-tree-sitter";
import { Parser } from "web-tree-sitter";
import { getLanguageForFile } from "./grammars.ts";
import { type ChunkBoundary, mergeAdjacentChunks } from "./lines.ts";

const RECURSION_DEPTH = 500;
const MIN_CHUNK_SIZE = 50;

const SMALL_CHUNK_SIZE = 200;
const DEFINITION_TYPE_RE =
  /^(?:function|method|class|interface|struct|enum|trait|impl|module|namespace|object|record|constructor)(?:_[a-z]+)*_(?:declaration|definition|item|specifier)$|^(?:function|method|class)$/;
const WRAPPER_TYPES = new Set(["export_statement", "decorated_definition"]);

interface Piece extends ChunkBoundary {
  definition: boolean;
}

function astChunkingEnabled(): boolean {
  return process.env.MIRU_AST_CHUNKING !== "0";
}

function definitionChunkingEnabled(): boolean {
  return process.env.MIRU_AST_DEFINITIONS === "1";
}

function isDefinition(node: Node): boolean {
  const type = node.type ?? "";
  if (DEFINITION_TYPE_RE.test(type)) {
    return true;
  }
  return WRAPPER_TYPES.has(type) && node.children.some((c) => c && isDefinition(c));
}

/** For each child, the index of the definition its leading comment run attaches to, else -1. */
function leadingCommentTargets(children: Array<Node | null>): number[] {
  const targets = new Array<number>(children.length).fill(-1);
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child) {
      continue;
    }
    if (isDefinition(child)) {
      targets[i] = i;
    } else if ((child.type ?? "").includes("comment") && i + 1 < children.length) {
      const next = targets[i + 1] ?? -1;
      const nextChild = children[i + 1];
      if (next >= 0 && nextChild && child.endPosition?.row + 1 >= nextChild.startPosition?.row) {
        targets[i] = next;
      }
    }
  }
  return targets;
}

function mergeNodeInner(node: Node, desiredLength: number, depth: number): Piece[] {
  if (node.childCount === 0) {
    return [{ start: node.startIndex, end: node.endIndex, definition: false }];
  }

  const length = node.endIndex - node.startIndex;
  if (depth > RECURSION_DEPTH) {
    return [{ start: node.startIndex, end: node.endIndex, definition: false }];
  }
  if (length < MIN_CHUNK_SIZE) {
    return [{ start: node.startIndex, end: node.endIndex, definition: false }];
  }

  const groups: Piece[] = [];
  const children = node.children;
  const targets = definitionChunkingEnabled()
    ? leadingCommentTargets(children)
    : new Array<number>(children.length).fill(-1);
  let index = 0;

  while (index < children.length) {
    const child = children[index];
    if (!child) {
      break;
    }

    const target = targets[index] ?? -1;
    if (target >= 0) {
      const last = children[target];
      const start = child.startIndex;
      const end = (last ?? child).endIndex;
      index = target + 1;
      if (end - start > desiredLength && last) {
        // Oversized definition: keep leading comments, split the body by its members.
        if (child !== last) {
          groups.push({ start, end: last.startIndex, definition: false });
        }
        groups.push(...mergeNodeInner(last, desiredLength, depth + 1));
      } else {
        groups.push({ start, end, definition: true });
      }
      continue;
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
      if (!nextChild || (targets[index] ?? -1) >= 0) {
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

    groups.push({ start, end, definition: false });
  }

  return groups;
}

/** Merge pieces up to `desiredLength`, never joining a definition to unrelated neighbours. */
function mergePieces(pieces: Piece[], desiredLength: number): ChunkBoundary[] {
  const merged: ChunkBoundary[] = [];
  let current: (Piece & { hasDefinition: boolean }) | null = null;
  for (const piece of pieces) {
    if (current) {
      const small = current.end - current.start < SMALL_CHUNK_SIZE;
      const joinable = small || (!piece.definition && !current.hasDefinition);
      if (joinable && piece.end - current.start <= desiredLength) {
        current.end = piece.end;
        current.hasDefinition ||= piece.definition;
        continue;
      }
      merged.push({ start: current.start, end: current.end });
    }
    current = { ...piece, hasDefinition: piece.definition };
  }
  if (current) {
    merged.push({ start: current.start, end: current.end });
  }
  return merged;
}

function mergeNode(node: Node, desiredLength: number): ChunkBoundary[] {
  const pieces = mergeNodeInner(node, desiredLength, 0);
  if (!definitionChunkingEnabled()) {
    return mergeAdjacentChunks(pieces, desiredLength);
  }
  return mergePieces(pieces, desiredLength);
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
  dependencies: {
    getLanguage?: typeof getLanguageForFile;
    createParser?: () => Pick<Parser, "setLanguage" | "parse">;
  } = {},
): Promise<ChunkBoundary[] | null> {
  if (!source.trim() || !astChunkingEnabled()) {
    return null;
  }

  const languageObj = await (dependencies.getLanguage ?? getLanguageForFile)(filePath, language);
  if (!languageObj) {
    return null;
  }

  const parser = dependencies.createParser?.() ?? new Parser();
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
