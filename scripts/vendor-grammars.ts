#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
/**
 * Vendor .wasm grammars from tree-sitter-* devDependencies into grammars/.
 *
 * Requires grammar packages as devDependencies. Run after adding/updating them:
 *   bun run vendor-grammars
 *
 * Packages that ship a prebuilt .wasm are copied verbatim. Packages marked `build`
 * ship only generated C sources, so their .wasm is built with the tree-sitter-cli
 * devDependency (`tree-sitter build --wasm`).
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dir, "..");
const outDir = join(root, "grammars");
const treeSitterCli = join(root, "node_modules", ".bin", "tree-sitter");

/** npm package → wasm files to copy, or (with `build`) the single wasm to build from source. */
const GRAMMAR_PACKAGES: { package: string; wasms: string[]; build?: boolean }[] = [
  { package: "tree-sitter-astro", wasms: ["tree-sitter-astro.wasm"], build: true },
  { package: "@derekstride/tree-sitter-sql", wasms: ["tree-sitter-sql.wasm"], build: true },
  { package: "tree-sitter-vue", wasms: ["tree-sitter-vue.wasm"], build: true },
  {
    package: "@tree-sitter-grammars/tree-sitter-svelte",
    wasms: ["tree-sitter-svelte.wasm"],
  },
  { package: "tree-sitter-bash", wasms: ["tree-sitter-bash.wasm"] },
  { package: "tree-sitter-c", wasms: ["tree-sitter-c.wasm"] },
  { package: "tree-sitter-c-sharp", wasms: ["tree-sitter-c_sharp.wasm"] },
  { package: "tree-sitter-cpp", wasms: ["tree-sitter-cpp.wasm"] },
  { package: "tree-sitter-css", wasms: ["tree-sitter-css.wasm"] },
  { package: "tree-sitter-dart", wasms: ["tree-sitter-dart.wasm"] },
  { package: "tree-sitter-elixir", wasms: ["tree-sitter-elixir.wasm"] },
  { package: "tree-sitter-embedded-template", wasms: ["tree-sitter-embedded_template.wasm"] },
  { package: "tree-sitter-go", wasms: ["tree-sitter-go.wasm"] },
  { package: "tree-sitter-haskell", wasms: ["tree-sitter-haskell.wasm"] },
  { package: "tree-sitter-html", wasms: ["tree-sitter-html.wasm"] },
  { package: "tree-sitter-java", wasms: ["tree-sitter-java.wasm"] },
  { package: "tree-sitter-javascript", wasms: ["tree-sitter-javascript.wasm"] },
  { package: "tree-sitter-json", wasms: ["tree-sitter-json.wasm"] },
  {
    package: "tree-sitter-ocaml",
    wasms: [
      "tree-sitter-ocaml.wasm",
      "tree-sitter-ocaml_interface.wasm",
      "tree-sitter-ocaml_type.wasm",
    ],
  },
  { package: "tree-sitter-php", wasms: ["tree-sitter-php.wasm", "tree-sitter-php_only.wasm"] },
  { package: "tree-sitter-python", wasms: ["tree-sitter-python.wasm"] },
  { package: "tree-sitter-ruby", wasms: ["tree-sitter-ruby.wasm"] },
  { package: "tree-sitter-rust", wasms: ["tree-sitter-rust.wasm"] },
  { package: "tree-sitter-scala", wasms: ["tree-sitter-scala.wasm"] },
  { package: "tree-sitter-solidity", wasms: ["tree-sitter-solidity.wasm"] },
  {
    package: "tree-sitter-typescript",
    wasms: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  },
];

/** Miru language id (from detectLanguage) → wasm basename in grammars/. */
const LANGUAGE_TO_WASM: Record<string, string> = {
  astro: "tree-sitter-astro.wasm",
  bash: "tree-sitter-bash.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  css: "tree-sitter-css.wasm",
  dart: "tree-sitter-dart.wasm",
  elixir: "tree-sitter-elixir.wasm",
  embeddedtemplate: "tree-sitter-embedded_template.wasm",
  go: "tree-sitter-go.wasm",
  haskell: "tree-sitter-haskell.wasm",
  html: "tree-sitter-html.wasm",
  java: "tree-sitter-java.wasm",
  javascript: "tree-sitter-javascript.wasm",
  json: "tree-sitter-json.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  php: "tree-sitter-php.wasm",
  python: "tree-sitter-python.wasm",
  ruby: "tree-sitter-ruby.wasm",
  rust: "tree-sitter-rust.wasm",
  scala: "tree-sitter-scala.wasm",
  solidity: "tree-sitter-solidity.wasm",
  sql: "tree-sitter-sql.wasm",
  svelte: "tree-sitter-svelte.wasm",
  typescript: "tree-sitter-typescript.wasm",
  vue: "tree-sitter-vue.wasm",
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copied = new Set<string>();
let errors = 0;

for (const { package: pkg, wasms, build } of GRAMMAR_PACKAGES) {
  let pkgDir: string;
  try {
    pkgDir = join(require.resolve(`${pkg}/package.json`), "..");
  } catch {
    console.error(`skip ${pkg}: not installed (bun install)`);
    errors++;
    continue;
  }

  for (const wasm of wasms) {
    const src = join(pkgDir, wasm);
    const dest = join(outDir, wasm);
    try {
      if (build) {
        const result = Bun.spawnSync([treeSitterCli, "build", "--wasm", "--output", dest, pkgDir], {
          stdout: "inherit",
          stderr: "inherit",
        });
        if (result.exitCode !== 0) {
          throw new Error(`tree-sitter build exited ${result.exitCode}`);
        }
      } else {
        cpSync(src, dest);
      }
      copied.add(wasm);
      console.log(`copied ${wasm}`);
    } catch {
      console.error(`skip ${pkg}: missing ${wasm}`);
      errors++;
    }
  }
}

const manifest = {
  version: 1,
  runtime: "web-tree-sitter@^0.26.9",
  languages: Object.fromEntries(
    Object.entries(LANGUAGE_TO_WASM).filter(([, wasm]) => copied.has(wasm)),
  ),
  files: [...copied].sort(),
};

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `\n${copied.size} wasm files → grammars/ (${Object.keys(manifest.languages).length} languages)`,
);
if (errors > 0) {
  process.exit(1);
}
