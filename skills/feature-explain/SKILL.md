---
name: feature-explain
description: Explain an implemented code feature or commit for human review as a concise standalone page with one complete design diagram and only findings that change the verdict. Use after code exists; do not use for proposed designs or PR file summaries.
---
# Feature Explain

Produce a post-implementation design explanation. The reader wants to decide whether the feature
is shaped correctly without reconstructing it from a diff.

This is not a proposed `DESIGN.md`, a PR summary, or a replacement for code review. Read code and
tests as evidence, but write about the resulting system rather than the files changed. Never edit
the feature, create a commit, or change branches while explaining it.

## Establish the exact scope

Honor the scope the user supplied:

- `<commit>` means its first parent through that commit.
- `<base>..<head>` means exactly that range.
- `--working-tree` means `HEAD` plus staged, unstaged, and untracked source changes.

With no argument, use a feature already named in the conversation or a Router task whose recorded
`base_sha` and current task branch identify one range. If more than one range is plausible, ask one
question. Never guess a merge base merely because it produces a convenient diff.

Record the resolved base, head, date, and whether this is a historical commit or the current tree.
For a merge commit, explain the merged feature rather than unrelated changes from the other parent.

## Build the explanation from code

1. Read the commit message, diff summary, and changed-path statuses to identify the claimed design.
2. Trace the primary runtime path through the changed implementation. Use `router symbol` when it
   supports the repository; otherwise use targeted search and bounded source slices.
3. Read the tests that exercise the path. Treat a passing test only as evidence for the behavior it
   actually runs; fake executors and mocks do not prove a real integration.
4. For a historical commit, inspect later fixes or reverts that touch the same mechanism. Use them
   to judge that historical version, and state separately when current code has since been repaired.
5. Run a directly relevant, reasonably cheap test when the environment permits. Say nothing was
   proven by a test you did not run.

Before writing, reduce the feature to four internal answers: what changed in the system, where it
sits, which path makes it work, and whether the inspected version is actually complete.

## Write one compact page

By default, write `.router/explanations/<feature-slug>-<short-head>.html`. For working-tree scope use
`<feature-slug>-working-tree.html`. Reuse that path when regenerating the same scope. The page is a
local review artifact: do not stage it. If the user explicitly asks for Markdown, honor that format
instead of producing a second copy.

Read [assets/design-explanation-template.html](assets/design-explanation-template.html) and copy it
as the starting point. Replace every `{{...}}` token; do not leave example content or placeholders.
Keep the page self-contained so it opens directly from disk: no external fonts, scripts, styles,
iframes, or network requests. HTML-escape every value taken from commit messages, paths, source,
tests, or user text; only the page structure and intentionally authored SVG enter as raw markup.

Put the resolved feature, base, head, generation date, and scope in the template's metadata. They
are provenance, not visible sections. Use the user's language and this visible shape:

1. A small feature/scope label.
2. One headline that states the resulting design.
3. A two-to-four-sentence verdict: what the final design is, how it works, and whether the inspected
   version actually achieves it.
4. One complete design diagram.
5. One sentence naming the load-bearing boundary or invariant.
6. One restrained issue strip, only when a concrete problem materially changes the verdict.

Do not add a second timeline below the figure. When ordering matters, put small step numbers on the
arrows of the design diagram so the same figure explains both structure and the representative
interaction.

## Make the single diagram carry the design

Use one inline SVG architecture figure with roughly five to nine primary nodes. It must show the
feature's place in the surrounding system, real process or storage boundaries, important state
ownership, and the path that makes the feature work. Put nouns on nodes and verbs on directed
edges. Use short labels that remain readable without opening the code.

Separate control and execution/storage areas with quiet group boundaries when that distinction is
real. Prefer a left-to-right primary path, mostly straight or orthogonal connectors, and at most one
accent color. Move nodes before accepting crossed arrows or labels laid over lines. The diagram
must still teach the design if every paragraph below it is removed.

The desktop SVG needs an accessible title and description. Also fill the template's compact mobile
representation with the same nodes and ordering; never shrink a wide fixed diagram until its labels
are unreadable. The page must remain legible in light and dark appearance.

This is a design explanation, not a UI demo. Do not add clickable stages, filters, hover-only facts,
animated paths, candidate views, or decorative dashboards.

Every node, edge, label, and verdict must be supported by the inspected code, tests, commit history,
or an observed command result. Keep names consistent between prose and the figure.

## Include only a problem that changes the verdict

When the inspected version has a concrete defect or missing boundary, add one issue strip describing
the consequence and, when known, the later fix. End it with a direct judgment of this inspected
version. Omit the entire strip when no material contradiction was found; do not manufacture
criticism.

## Cut everything the reader will not use

Do not include a “problem being solved” heading, candidate diagrams, a decision-flow diagram, a
component table, a file list, per-file changes, a key-design-choices inventory, a verification
matrix, an evidence appendix, or a separate interaction diagram. Tests belong in the prose only
when they change the verdict.

Lead with the conclusion. Prefer concrete verbs over labels such as “safe”, “robust”, or “clean”.
Delete a paragraph if removing it would not change the reader's understanding or judgment. The
usual result is one diagram, one verdict, and at most one issue strip, not a comprehensive report.

## Check the generated page

Before returning it:

- Search for an unreplaced `{{...}}` token.
- Confirm the file contains no remote URL, executable script, iframe, or network request.
- Open the file locally when browser rendering is available. Check the full desktop diagram and a
  narrow layout; neither may clip, overlap, or create horizontal scrolling.
- Confirm the headline, verdict, diagram, boundary sentence, and optional issue strip all describe
  the same inspected scope.

## Return the result

Show only the verdict and the exact output path. Do not repeat the page contents in the conversation
unless the user asks to see them there.
