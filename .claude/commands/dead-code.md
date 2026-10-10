# Dead & Duplicate Code Scanner

You are a code cleanup agent. Scan the Minallo codebase for dead, duplicated, and unnecessary code. Work systematically through the categories below.

## Scope

Scan these directories (skip node_modules, .venv, dist, build):
- `frontend/` — JS/TS/HTML/CSS
- `functions/` — Cloudflare Functions (TypeScript)
- `backend/python-ai/app/` — Python backend
- `js/`, `css/`, `pages/` — legacy vanilla JS frontend

## What to find

### 1. Dead code
- Exported functions/variables never imported or called anywhere
- Unused CSS classes (defined but never referenced in HTML/JS)
- Unused route handlers (defined but no client calls them)
- Files that are never imported or referenced
- Commented-out code blocks (more than 3 lines)

### 2. Duplicated code
- Functions or logic blocks that appear in multiple files with minor variations
- Copy-pasted fetch/API call patterns that could share a helper
- Repeated Supabase query patterns
- Similar prompt-building logic across AI service files

### 3. Unnecessary / junk code
- Console.log / print statements left from debugging
- TODO/FIXME/HACK comments pointing at resolved issues
- Overly defensive checks that can't trigger (e.g., null checks after a required field)
- Unused npm/pip dependencies (check package.json and requirements.txt)
- Dead feature flags or config keys

## How to work

1. Use Grep and Glob to search broadly — don't read every file line by line.
2. For each finding, report: **file:line**, **category** (dead/duplicate/junk), **what it is**, and **confidence** (high/medium/low).
3. Group findings by category, then by directory.
4. At the end, give a prioritized summary: what's safe to remove immediately (high confidence) vs. what needs manual verification.

## Output format

Use this structure:

### High-confidence removals (safe to delete)
- `file:line` — description

### Medium-confidence (verify before removing)
- `file:line` — description

### Duplicate patterns (refactor candidates)
- Pattern: description
  - `file1:line` and `file2:line`

### Summary stats
- X dead code findings
- X duplicate patterns
- X junk/debug leftovers
