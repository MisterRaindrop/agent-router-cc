// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CallEdge, Sym, SymbolKind } from '../domain/types.ts';

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
interface WtsTree {
  rootNode: WtsNode;
  delete(): void; // frees the wasm-side tree; without this the emscripten heap grows unbounded
}
interface WtsParser {
  setLanguage(lang: WtsLanguage): void;
  parse(src: string): WtsTree;
}

interface Runtime {
  moduleHref: string; // file:// URL of tree-sitter.js (ESM)
  tsWasm: string; // path to tree-sitter.wasm
  cppWasm: string; // path to tree-sitter-cpp.wasm
}

// web-tree-sitter renamed its runtime files in 0.26 (`tree-sitter.js` / `.wasm` ->
// `web-tree-sitter.js` / `.wasm`), so probe both names rather than hardcoding one: a
// hardcoded name turns a routine dependency bump into ERR_MODULE_NOT_FOUND at runtime.
// The vendored copies keep the canonical `tree-sitter.*` names (scripts/build.mjs
// normalizes them), so the bundled layout is unaffected by upstream renames.
const WTS_BASENAMES = ['web-tree-sitter', 'tree-sitter'] as const;

function wtsRuntimeFile(dir: string, suffix: string): string {
  for (const base of WTS_BASENAMES) {
    const candidate = join(dir, `${base}${suffix}`);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, `tree-sitter${suffix}`); // absent either way: fail later with a real path
}

// dev: resolve from node_modules; prod (bundled dist/router.js): dist/vendor/.
function locateRuntime(): Runtime {
  try {
    const req = createRequire(import.meta.url);
    const cjs = req.resolve('web-tree-sitter'); // .../web-tree-sitter/<name>.cjs
    const dir = dirname(cjs);
    return {
      moduleHref: pathToFileURL(wtsRuntimeFile(dir, '.js')).href,
      tsWasm: wtsRuntimeFile(dir, '.wasm'),
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

// The trailing identifier of a call target: `foo()`, `a->foo()`, `A::foo()` -> "foo".
function calleeName(callNode: WtsNode, src: string): string | null {
  const f = callNode.childForFieldName('function');
  if (f === null) return null;
  if (f.type === 'field_expression') {
    const fld = f.childForFieldName('field');
    return fld !== null ? text(fld, src) : null;
  }
  if (f.type === 'qualified_identifier') {
    const name = f.childForFieldName('name');
    return name !== null ? text(name, src).split('::').pop() ?? null : null;
  }
  if (f.type === 'identifier') return text(f, src);
  return null;
}

// Single traversal: gather symbols AND call edges. `stack` tracks the enclosing function
// so each call is attributed to its caller. Full recursion (no depth cap) so calls deep
// in a body are not missed.
function extract(node: WtsNode, src: string, syms: Sym[], calls: CallEdge[], stack: string[]): void {
  const t = node.type;
  let pushed = false;
  if (t === 'class_specifier' || t === 'struct_specifier') {
    const name = node.childForFieldName('name');
    if (name !== null) {
      const kind: SymbolKind = t === 'class_specifier' ? 'class' : 'struct';
      syms.push({ kind, name: text(name, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  } else if (t === 'function_definition') {
    const nm = funcName(node, src);
    if (nm !== null) {
      syms.push({ kind: 'fn', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      stack.push(nm);
      pushed = true;
    }
  } else if (t === 'field_declaration' || t === 'declaration') {
    // function DECLARATIONS (no body) -- important for headers (overrides, interfaces).
    const d = node.childForFieldName('declarator');
    if (d !== null && d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      if (inner !== null)
        syms.push({ kind: 'decl', name: text(inner, src), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    }
  } else if (t === 'call_expression') {
    const callee = calleeName(node, src);
    if (callee !== null) calls.push({ caller: stack[stack.length - 1] ?? '<global>', callee, line: node.startPosition.row + 1 });
  }
  for (const c of node.namedChildren) extract(c, src, syms, calls, stack);
  if (pushed) stack.pop();
}

/** Parse one C++ source string into its symbols and (approximate) call edges. */
export async function parseSymbols(src: string): Promise<{ syms: Sym[]; calls: CallEdge[]; grammar: string }> {
  const { parser, grammar } = await getParser();
  const tree = parser.parse(src);
  const syms: Sym[] = [];
  const calls: CallEdge[] = [];
  try {
    extract(tree.rootNode, src, syms, calls, []);
  } finally {
    tree.delete(); // free the wasm tree so a full-project build doesn't balloon the heap
  }
  return { syms, calls, grammar };
}
