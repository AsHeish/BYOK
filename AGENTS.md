# Agent Instructions

<!-- TOKENGUARD:CODE-INDEX:BEGIN -->
<!-- Managed by TokenGuard. Edits inside this block are overwritten when the code index updates. -->

## TokenGuard Code Index (use first for code-symbol lookups, fall back fast)

A local code index is available through the `tokenguard_*` tools. It answers symbol, usage, dependency, file-discovery, and "how/where does X work" questions in one compact call — cheaper than grep/glob/read round-trips. Use it FIRST whenever it can answer, and fall back to native tools the instant it cannot. The goal is fewer, cheaper tool calls — never the index in addition to the native lookup it replaces.

Reach for the index when the task is code navigation or code context:

| Need | Tool |
| --- | --- |
| How/where/why code works; a flow X→Y | `tokenguard_answer` |
| Locate a definition | `tokenguard_search` or `tokenguard_node` |
| References / callers | `tokenguard_callers` |
| Callees / dependencies | `tokenguard_callees` |
| Blast radius before changing a symbol | `tokenguard_impact` |
| Understand a symbol without reading its whole file | `tokenguard_explore` |
| Discover files | `tokenguard_files` |

Rules:
1. For a code-symbol / usage / dependency / structure question, call the matching `tokenguard_*` tool DIRECTLY. You do not need a separate `tokenguard_status` call first — the tool itself reports when the index is unavailable. Pick the narrowest tool: use `tokenguard_search` / `tokenguard_node` for a location, and reserve `tokenguard_answer` for a genuine "how/where does X work" so payloads stay small.
2. TERMINATING: once a `tokenguard_*` call returns a usable result, that IS the answer. Do not re-grep, re-list, or re-read the same files for the same question.
3. Skip the index and go straight to native tools for non-symbol work: reading or editing a file you already know, CSS/markup/styling, UI copy, logs, comments, config strings, or arbitrary text literals. Do not ping-pong between the index and native search/read.
4. If a `tokenguard_*` call returns nothing usable or reports unavailable/not ready, fall back to native search/read immediately — do not retry the index for the same question.

Keep tool-routing commentary minimal; use the available `tokenguard_*` tools directly.
<!-- TOKENGUARD:CODE-INDEX:END -->
