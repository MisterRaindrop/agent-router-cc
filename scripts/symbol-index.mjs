#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0
//
// DEMO (not shipped): an OUT-OF-CONTEXT queryable symbol index. Unlike demo-repomap.mjs
// (which dumps the whole map into the model's context), this builds the index ONCE into a
// cache file and prints ONLY a one-line summary; each query returns at most a handful of
// lines. The A/B question: does a query-only index beat plain `rg`+`Read` on model tokens?
//
// Subcommands (all read/write a cache file, default ./.symidx.json):
//   index <rootdir...>            parse *.cpp/*.h under roots -> cache. Prints ONLY a summary.
//   find <name>                   symbols whose name contains <name>  -> `path:line  kind name`
//   enclosing <file> <line>       innermost class/fn containing that line -> one line
//   methods <ClassName>           functions whose span is inside that class -> member list
//
// Usage:
//   node scripts/symbol-index.mjs index <dir...> [--cache p]
//   node scripts/symbol-index.mjs find <name>    [--cache p] [--limit N]
//   node scripts/symbol-index.mjs enclosing <file> <line> [--cache p]
//   node scripts/symbol-index.mjs methods <ClassName>      [--cache p] [--limit N]

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');

const text = (n, src) => src.slice(n.startIndex, n.endIndex);

function funcName(fnNode, src)
{
  let d = fnNode.childForFieldName('declarator');
  for (let hops = 0; d && hops < 6; hops++)
  {
    if (d.type === 'function_declarator')
    {
      const inner = d.childForFieldName('declarator');
      return inner ? text(inner, src) : null;
    }
    d = d.childForFieldName('declarator') ?? d.namedChildren[0] ?? null;
  }
  return null;
}

function collect(node, src, out, depth = 0)
{
  const t = node.type;
  if (t === 'class_specifier' || t === 'struct_specifier')
  {
    const name = node.childForFieldName('name');
    if (name)
      out.push({ kind: t === 'class_specifier' ? 'class' : 'struct', name: text(name, src),
        line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  else if (t === 'function_definition')
  {
    const nm = funcName(node, src);
    if (nm)
      out.push({ kind: 'fn', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  else if (t === 'field_declaration' || t === 'declaration')
  {
    // capture method/function DECLARATIONS (no body) too -- important for headers
    const d = node.childForFieldName('declarator');
    if (d && d.type === 'function_declarator')
    {
      const inner = d.childForFieldName('declarator');
      if (inner)
        out.push({ kind: 'decl', name: text(inner, src), line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1 });
    }
  }
  if (depth < 8)
    for (const c of node.namedChildren)
      collect(c, src, out, depth + 1);
}

function walkFiles(root, acc)
{
  let st;
  try { st = statSync(root); } catch { return; }
  if (st.isFile())
  {
    if (/\.(cpp|h|hpp|cc)$/.test(root)) acc.push(root);
    return;
  }
  if (!st.isDirectory()) return;
  for (const e of readdirSync(root))
    walkFiles(join(root, e), acc);
}

function parseArgs(argv)
{
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++)
  {
    if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++; }
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function buildIndex(roots, cachePath)
{
  const parser = new Parser();
  parser.setLanguage(Cpp);
  const parse = (src) => parser.parse(src, undefined, { bufferSize: Math.max(32 * 1024, src.length + 4096) });
  const files = [];
  for (const r of roots) walkFiles(r, files);
  const index = [];
  let symCount = 0;
  for (const f of files)
  {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const syms = [];
    collect(parse(src).rootNode, src, syms);
    symCount += syms.length;
    index.push({ file: f, symbols: syms });
  }
  writeFileSync(cachePath, JSON.stringify(index));
  // Print ONLY a summary -- the whole point is that building the index costs ~0 model tokens.
  console.log(`indexed ${files.length} files, ${symCount} symbols -> ${cachePath}`);
}

function loadCache(cachePath)
{
  return JSON.parse(readFileSync(cachePath, 'utf8'));
}

function cmdFind(cache, name, limit)
{
  const hits = [];
  for (const entry of cache)
    for (const s of entry.symbols)
      if (s.name.includes(name)) hits.push({ file: entry.file, ...s });
  hits.sort((a, b) => (a.kind === 'decl') - (b.kind === 'decl')); // defs before decls
  const shown = hits.slice(0, limit);
  for (const h of shown)
    console.log(`${h.file}:${h.line}\t${h.kind} ${h.name}`);
  if (hits.length > shown.length)
    console.log(`... (${hits.length - shown.length} more; refine the name)`);
  if (hits.length === 0)
    console.log(`no symbol matches "${name}"`);
}

function cmdEnclosing(cache, file, line)
{
  const entry = cache.find((e) => e.file === file || e.file.endsWith('/' + file));
  if (!entry) { console.log(`file not in index: ${file}`); return; }
  const L = Number(line);
  let best = null;
  for (const s of entry.symbols)
    if (s.line <= L && L <= s.endLine)
      if (!best || (s.endLine - s.line) < (best.endLine - best.line)) best = s;
  if (best) console.log(`${entry.file}:${best.line}-${best.endLine}\t${best.kind} ${best.name} (encloses line ${L})`);
  else console.log(`no enclosing class/function for ${file}:${L}`);
}

function cmdMethods(cache, className, limit)
{
  let cls = null;
  let clsFile = null;
  for (const entry of cache)
    for (const s of entry.symbols)
      if ((s.kind === 'class' || s.kind === 'struct') && s.name === className) { cls = s; clsFile = entry.file; }
  if (!cls) { console.log(`class not found: ${className}`); return; }
  const entry = cache.find((e) => e.file === clsFile);
  const members = entry.symbols.filter((s) =>
    (s.kind === 'fn' || s.kind === 'decl') && s.line > cls.line && s.endLine <= cls.endLine);
  const shown = members.slice(0, limit);
  console.log(`${className} (${clsFile}:${cls.line}-${cls.endLine})`);
  for (const m of shown) console.log(`  ${m.line}\t${m.name}`);
  if (members.length > shown.length) console.log(`  ... (${members.length - shown.length} more)`);
}

function main()
{
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const cachePath = opt.cache || './.symidx.json';
  const limit = opt.limit ? Number(opt.limit) : 20;
  if (cmd === 'index') { buildIndex(pos.slice(1), cachePath); return; }
  if (cmd === 'find') { cmdFind(loadCache(cachePath), pos[1], limit); return; }
  if (cmd === 'enclosing') { cmdEnclosing(loadCache(cachePath), pos[1], pos[2]); return; }
  if (cmd === 'methods') { cmdMethods(loadCache(cachePath), pos[1], limit); return; }
  console.error('usage: index <dir...> | find <name> | enclosing <file> <line> | methods <ClassName>  [--cache p] [--limit N]');
  process.exit(2);
}

main();
