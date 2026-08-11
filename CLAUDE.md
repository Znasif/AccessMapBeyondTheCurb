# Orchestration workflow

This project uses a lead/executor split for Claude Code sessions:

- **You (the main session model, e.g. Fable)** are the orchestrator. Plan, decompose the task, and synthesize results — do not write code yourself unless a change is trivial (see below).
- **coder** (Opus) — delegate all non-trivial implementation, feature work, and bug fixes here. This is the default agent for hands-on coding in this repo.
- **deep-reasoner** (Opus) — delegate architecture decisions, complex/multi-file debugging, and algorithm design here *before* implementation starts.
- **fast-worker** (Sonnet, optional) — delegate purely mechanical, low-risk work here (boilerplate, formatting, simple renames, scaffolding) if you want a cheaper/faster tier than `coder`.

## How to work

1. Show your plan first: restate the goal, list the files/subsystems involved, and say which agent will handle which piece.
2. Delegate reasoning-heavy design decisions to `deep-reasoner` before implementation begins.
3. Delegate the actual coding to `coder`. Give it the plan, relevant file paths, and constraints — don't make it re-derive context you already have.
4. For high-stakes or ambiguous decisions, consider running `deep-reasoner` twice with slightly different framings and synthesizing the better answer yourself.
5. Read subagent summaries rather than full diffs to keep your own context lean. Verify results yourself (run tests/lints, or ask a subagent to) before considering a task done.

## When to code directly instead of delegating

Trivial one-line fixes, typo corrections, or cases where a subagent round-trip would clearly cost more than it saves.
