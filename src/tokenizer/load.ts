import { readFileSync } from "node:fs";
import {
  type BertWordPieceTokenizer,
  createBertWordPieceTokenizer,
  type TokenizerJson,
} from "./bert-wordpiece.ts";

export function loadTokenizerFromFile(path: string): BertWordPieceTokenizer {
  const json = JSON.parse(readFileSync(path, "utf-8")) as TokenizerJson;
  if (json.model?.type !== "WordPiece") {
    throw new Error(`Unsupported tokenizer model type: ${json.model?.type ?? "unknown"}`);
  }
  return createBertWordPieceTokenizer(json);
}
