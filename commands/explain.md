---
description: Explain a completed feature as a concise standalone page with one complete, code-grounded design diagram
argument-hint: "[<commit> | <base>..<head> | --working-tree]"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---
Read `${CLAUDE_PLUGIN_ROOT}/skills/feature-explain/SKILL.md` completely and follow it.

Treat `$ARGUMENTS` as the requested code scope. It may name one commit, an explicit Git range,
or `--working-tree`. If it is empty, use a feature the user named in the conversation or a
single unambiguous Router task range. If two bases or features are plausible, ask one question
and stop; a polished explanation of the wrong diff is still wrong.

This command explains code that already exists. Do not redirect the user to `/router:design`,
which is for agreeing on a design before implementation. Do not edit source code, create commits,
or change branches. The only write is the explanation under `.router/explanations/`, unless the
user explicitly chooses another output path.

When the page is complete, show only its two-to-four-sentence verdict and exact path. Do not dump
the page into the conversation unless the user asks.
