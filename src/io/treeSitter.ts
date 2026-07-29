// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Sym, SymbolKind } from '../domain/types.ts';

// tree-sitter (WASM) symbol extraction. IMPURE (fs + wasm). This is the ONLY place a
// parser is loaded; queries never touch it (they read a prebuilt cache). Zero-config:
// web-tree-sitter is pure JS + wasm, no native build, no per-platform binary.
//
// Loading rules learned in C0 (see docs/design/code-intelligence-impl-plan.md sec.8):
//   - Load the ESM `tree-sitter.js` at a RUNTIME-resolved path via dynamic import, so
//     esbuild leaves it alone (the emscripten glue does not bundle cleanly).
//   - Pass wasm BYTES ourselves (Parser.init({wasmBinary}) / Language.load(Uint8Array));
//     web-tree-sitter's path-based load does `require('fs/promises')` which throws under
//     pure ESM. Reading bytes ourselves also makes the .wasm location our concern, which
//     is exactly what the bundle needs.

interface WtsModule {
  Parser: {
    init(opts?: { wasmBinary?: Uint8Array }): Promise<void>;
    new (): WtsParser;
  };
  Language: { load(bytes: Uint8Array): Promise<WtsLanguage> };
}
interface WtsLanguage {
  readonly version?: number;
}
interface WtsNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: WtsNode[];
  childForFieldName(name: string): WtsNode | null;
}
interface WtsParser {
  setLanguage(lang: WtsLanguage): void;
  parse(src: string): { rootNode: WtsNode };
}

interface Runtime {
  moduleHref: string; // file:// URL of tree-sitter.js (ESM)
  tsWasm: string; // path to tree-sitter.wasm
  cppWasm: string; // path to tree-sitter-cpp.wasm
}

// dev: resolve from node_modules; prod (bundled dist/router.js): dist/vendor/.
function locateRuntime(): Runtime {
  try {
    const req = createRequire(import.meta.url);
    const cjs = req.resolve('web-tree-sitter'); // .../web-tree-sitter/tree-sitter.cjs
    const dir = dirname(cjs);
    return {
      moduleHref: pathToFileURL(join(dir, 'tree-sitter.js')).href,
      tsWasm: join(dir, 'tree-sitter.wasm'),
      cppWasm: req.resolve('tree-sitter-wasms/out/tree-sitter-cpp.wasm'),
    };
  } catch {
    const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
    return {
      moduleHref: pathToFileURL(join(vendor, 'tree-sitter.js')).href,
      tsWasm: join(vendor, 'tree-sitter.wasm'),
      cppWasm: join(vendor, 'tree-sitter-cpp.wasm'),
    };
  }
}

let ready: Promise<{ parser: WtsParser; grammar: string }> | null = null;

async function getParser(): Promise<{ parser: WtsParser; grammar: string }> {
  if (ready === null) {
    ready = (async () => {
      const rt = locateRuntime();
      // Computed specifier => esbuild emits a runtime import() and does not bundle it.
      const mod = (await import(rt.moduleHref)) as WtsModule;
      await mod.Parser.init({ wasmBinary: new Uint8Array(readFileSync(rt.tsWasm)) });
      const parser = new mod.Parser();
      const cpp = await mod.Language.load(new Uint8Array(readFileSync(rt.cppWasm)));
      parser.setLanguage(cpp);
      return { parser, grammar: `cpp@${cpp.version ?? 'x'}` };
    })();
  }
  return ready;
}

const text = (n: WtsNode, src: string): string => src.slice(n.startIndex, n.endIndex);

function funcName(fn: WtsNode, src: string): string | null {
  let d = fn.childForFieldName('declarator');
  for (let hops = 0; d !== null && hops < 6; hops++) {
    if (d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      return inner !== null ? text(inner, src) : null;
    }
    d = d.childForFieldName('declarator') ?? d.namedChildren[0] ?? null;
  }
  return null;
}

function collect(node: WtsNode, src: string, out: Sym[], depth: number): void {
  const t = node.type;
  if (t === 'class_specifier' || t === 'struct_specifier') {
    const name = node.childForFieldName('name');
    if (name !== null) {
      const kind: SymbolKind = t === 'class_specifier' ? 'class' : 'struct';
      out.push({ kind, name: text(name, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  } else if (t === 'function_definition') {
    const nm = funcName(node, src);
    if (nm !== null) out.push({ kind: 'fn', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  } else if (t === 'field_declaration' || t === 'declaration') {
    // function DECLARATIONS (no body) -- important for headers (overrides, interfaces).
    const d = node.childForFieldName('declarator');
    if (d !== null && d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      if (inner !== null)
        out.push({ kind: 'decl', name: text(inner, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  }
  if (depth < 8) for (const c of node.namedChildren) collect(c, src, out, depth + 1);
}

/** Parse one C++ source string into its symbols. `grammar` stamps the ABI for cache busting. */
export async function parseSymbols(src: string): Promise<{ syms: Sym[]; grammar: string }> {
  const { parser, grammar } = await getParser();
  const tree = parser.parse(src);
  const syms: Sym[] = [];
  collect(tree.rootNode, src, syms, 0);
  return { syms, grammar };
}
