---
description: Out-of-context symbol index -- locate symbols and structure with a few lines instead of reading whole files
allowed-tools: Bash(node:*), Read, Grep
---
Navigate code by querying an out-of-context symbol index instead of reading whole files.
The index is built once and kept OUT of your context; each query returns only a handful
of lines. Measured on real C++: this beats both dumping a repo-map and grep-plus-read
(see the project's code-intelligence A/B). Use it before opening files.

## Build once, then query

Build (or refresh) the index for the code you are working on -- this prints only a
one-line summary; the symbol map itself never enters your context:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" symbol index ${ARGUMENTS}`

Then query (each returns a bounded few lines; the last-built scope is remembered, so you
need not restate the dirs):

- `router symbol find <name>` -- where a symbol is defined/declared (`path:line kind name`)
- `router symbol enclosing <file> <line>` -- the class/function that contains a line
- `router symbol methods <Class>` -- a class's members, without reading its header
- `router symbol callers <name>` -- functions that call `name` (approximate; see below)
- `router symbol callees <fn>` -- names called by `fn` (approximate; see below)
- add `--json` for structured output, `--limit N` to cap rows

## The call graph (`callers` / `callees`) is a REFERENCE ONLY -- hard rule

It is a name-based, syntactic approximation. Treat it as a fast hint that points you at
where to look, NEVER as an authoritative or complete answer. Concretely:

- **Over-approximation** (same-named different symbols): every result carries the count
  of definitions sharing the name; when >1, the callers of several symbols are mixed --
  the banner says so. Open a candidate to see if it's the one you mean.
- **Under-approximation** (it can MISS callers via macros, function pointers, virtual
  dispatch, or template-dependent calls): so it is NEVER complete. For any
  completeness-critical judgment -- "all callers", "blast radius of changing X", "is it
  safe to delete/change this" -- you MUST confirm with `rg` (a text scan that won't miss
  a textual occurrence) and read the actual code. The graph only makes you faster at
  getting there; the conclusion rests on rg + reading, not on the graph.
- Every `callers`/`callees` result prints a `[reference only ...]` banner. Do not strip
  it, and do not present graph output as a definitive caller list.

## Discipline (this is where the token saving comes from)

1. **Query the index first** to locate symbols, structure, and enclosing scopes.
2. **Only then** open a **bounded** slice (`Read` with a small line range) to confirm the
   exact code you actually need. Never dump a whole file, and never paste the symbol map.
3. Report findings as `path:line` references plus the minimal code, not large excerpts.

## Boundaries (be honest, do not fake results)

- `find` returns **definitions/declarations only, not call-sites**. To find *who calls*
  a symbol, use `rg`/`grep` -- combine the two.
- If a query answers `code-intel: ... using rg` (feature disabled by config, scope over
  the cap, or no index yet), that is a **loud degrade, not an empty result** -- fall back
  to `rg` for that query. Run `router doctor` to see the switches and wasm status.
- The index does not do semantic search ("what parses X"); for that, use `rg` on terms.
