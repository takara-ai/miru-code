export interface TokenizerJson {
  normalizer?: {
    type?: string;
    clean_text?: boolean;
    handle_chinese_chars?: boolean;
    strip_accents?: boolean | null;
    lowercase?: boolean;
  };
  pre_tokenizer?: { type?: string };
  model: {
    type?: string;
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
}

export interface BertWordPieceTokenizer {
  encode(text: string): string[];
  count(text: string): number;
}

function isControl(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  // TAB/LF/CR are whitespace in Bert clean_text, not stripped controls.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
    return false;
  }
  return cp === 0 || cp === 0xfffd || (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

function isWhitespace(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function isPunctuation(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(char);
}

function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function cleanText(text: string): string {
  const output: string[] = [];
  for (const char of text) {
    if (isControl(char)) {
      continue;
    }
    output.push(isWhitespace(char) ? " " : char);
  }
  return output.join("");
}

function tokenizeChineseChars(text: string): string {
  const output: string[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (isChineseChar(cp)) {
      output.push(" ", char, " ");
    } else {
      output.push(char);
    }
  }
  return output.join("");
}

function removeAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function whitespaceTokenize(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.split(/\s+/);
}

function splitOnPunctuation(text: string): string[] {
  const chars = [...text];
  if (chars.length === 0) {
    return [];
  }

  const output: string[][] = [];
  let startNewWord = true;

  for (const char of chars) {
    if (isPunctuation(char)) {
      output.push([char]);
      startNewWord = true;
      continue;
    }
    if (startNewWord) {
      output.push([]);
      startNewWord = false;
    }
    output[output.length - 1]?.push(char);
  }

  return output.map((parts) => parts.join("")).filter(Boolean);
}

function bertPreTokenize(text: string): string[] {
  const words = whitespaceTokenize(text);
  const splitTokens: string[] = [];
  for (const word of words) {
    splitTokens.push(...splitOnPunctuation(word));
  }
  return whitespaceTokenize(splitTokens.join(" "));
}

function wordpieceTokenize(
  token: string,
  vocab: Set<string>,
  unkToken: string,
  prefix: string,
  maxInputCharsPerWord: number,
): string[] {
  if (token.length === 0) {
    return [];
  }
  if (token.length > maxInputCharsPerWord) {
    return [unkToken];
  }

  const chars = [...token];
  const subTokens: string[] = [];
  let start = 0;

  while (start < chars.length) {
    let end = chars.length;
    let curSubstr: string | null = null;

    while (start < end) {
      let substr = chars.slice(start, end).join("");
      if (start > 0) {
        substr = `${prefix}${substr}`;
      }
      if (vocab.has(substr)) {
        curSubstr = substr;
        break;
      }
      end -= 1;
    }

    if (!curSubstr) {
      return [unkToken];
    }

    subTokens.push(curSubstr);
    start = end;
  }

  return subTokens;
}

export function createBertWordPieceTokenizer(json: TokenizerJson): BertWordPieceTokenizer {
  const normalizer = json.normalizer ?? {};
  const model = json.model;
  const lowercase = normalizer.lowercase ?? true;
  const stripAccents = normalizer.strip_accents ?? lowercase;
  const vocab = new Set(Object.keys(model.vocab));
  const unkToken = model.unk_token ?? "[UNK]";
  const prefix = model.continuing_subword_prefix ?? "##";
  const maxInputCharsPerWord = model.max_input_chars_per_word ?? 100;
  const clean = normalizer.clean_text ?? true;
  const handleChineseChars = normalizer.handle_chinese_chars ?? true;

  function encode(text: string): string[] {
    let normalized = text;
    if (clean) {
      normalized = cleanText(normalized);
    }
    if (handleChineseChars) {
      normalized = tokenizeChineseChars(normalized);
    }
    if (lowercase) {
      normalized = normalized.toLowerCase();
      if (stripAccents) {
        normalized = removeAccents(normalized);
      }
    }

    const tokens: string[] = [];
    for (const basic of bertPreTokenize(normalized)) {
      tokens.push(...wordpieceTokenize(basic, vocab, unkToken, prefix, maxInputCharsPerWord));
    }
    return tokens;
  }

  return {
    encode,
    count(text: string): number {
      return encode(text).length;
    },
  };
}
