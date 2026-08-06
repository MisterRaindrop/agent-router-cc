#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0
//
// DEMO (not shipped): a repo-map extractor via tree-sitter. Pulls a compact symbol
// map (classes/structs/functions with line numbers) from C++ files and reports the
// token compression vs dumping the raw source -- i.e. what a spec/review agent saves
// by reading the map instead of the files.
//
// NOTE on zero-config: this demo uses the native `tree-sitter` bindings (reliable
// prebuilts) to prove the EFFECT. The production zero-config path is web-tree-sitter
// (WASM: no native build, no per-platform binary) with a version-matched grammar
// bundle -- swappable; the symbol-extraction logic below is identical either way.
//
// Usage: node scripts/demo-repomap.mjs <file.cpp> ...

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');

const estTokens = (chars) => Math.round(chars / 4); // rough chars/4 heuristic
const text = (n, src) => src.slice(n.startIndex, n.endIndex);

function funcName(fnNode, src) {
  let d = fnNode.childForFieldName('declarator');
  for (let hops = 0; d && hops < 6; hops++) {
    if (d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      return inner ? text(inner, src) : null;
    }
    d = d.childForFieldName('declarator') ?? d.namedChildren[0] ?? null;
  }
  return null;
}

function collect(node, src, out, depth = 0) {
  const t = node.type;
  if (t === 'class_specifier' || t === 'struct_specifier') {
    const name = node.childForFieldName('name');
    if (name) out.push({ kind: t === 'class_specifier' ? 'class' : 'struct', name: text(name, src), line: node.startPosition.row + 1 });
  } else if (t === 'function_definition') {
    const nm = funcName(node, src);
    if (nm) out.push({ kind: 'fn', name: nm, line: node.startPosition.row + 1 });
  }
  if (depth < 6) for (const c of node.namedChildren) collect(c, src, out, depth + 1);
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/demo-repomap.mjs <file.cpp> ...');
    process.exit(2);
  }
  const parser = new Parser();
  parser.setLanguage(Cpp);
  // Native tree-sitter rejects string input over ~32KB unless bufferSize is raised to
  // fit the whole file.
  const parse = (src) => parser.parse(src, undefined, { bufferSize: Math.max(32 * 1024, src.length + 4096) });

  let srcChars = 0;
  let mapChars = 0;
  let symCount = 0;
  const blocks = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    srcChars += src.length;
    const syms = [];
    collect(parse(src).rootNode, src, syms);
    symCount += syms.length;
    const rel = f.replace(/^.*\/(src\/.*)$/, '$1');
    const body = syms.map((s) => `${s.kind} ${s.name}:${s.line}`).join('  ');
    const block = `${rel}\n  ${body}`;
    mapChars += block.length;
    blocks.push(block);
  }

  console.log('=== repo map (symbols only, no source) ===\n');
  console.log(blocks.join('\n\n'));
  console.log('\n=== token comparison (rough chars/4) ===');
  console.log(`files:        ${files.length}   symbols: ${symCount}`);
  console.log(`raw source:   ${srcChars.toLocaleString()} chars  ~${estTokens(srcChars).toLocaleString()} tokens`);
  console.log(`symbol map:   ${mapChars.toLocaleString()} chars  ~${estTokens(mapChars).toLocaleString()} tokens`);
  const ratio = srcChars > 0 ? (mapChars / srcChars) * 100 : 0;
  console.log(`map is ${ratio.toFixed(1)}% of raw source  →  ~${(100 - ratio).toFixed(1)}% fewer tokens to give the model the structure`);
}

main();
