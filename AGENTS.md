# Agent Instructions for diffacto

## Project Overview

Terminal UI application for viewing git diffs using OpenTUI and Bun.

## Stack & Tools

- **Runtime**: Bun (not Node.js)
- **UI Framework**: OpenTUI (@opentui/core)
- **Language**: TypeScript

## Key Commands

```bash
./diffacto                # Run the diff viewer (executable file)
bun install               # Install dependencies
git diff --unified=3      # Generate diff output (used internally)
```

## Architecture

- Single-file application: `diffacto` (executable TypeScript file)
- No build step required - Bun runs TypeScript directly
- OpenTUI renders TUI in the terminal using native Zig core
- File watcher monitors changes with debouncing and filtering

## OpenTUI Critical Patterns

### Renderables vs Constructs

**DO NOT MIX THEM** - OpenTUI has two APIs:

1. **Renderables** (imperative): `new BoxRenderable(renderer, {...})`
2. **Constructs** (declarative): `Box({...})`

**This codebase uses Renderables exclusively.** Mixing causes console overlay split-screen bugs.

### Correct Pattern (Renderables only)

```typescript
const container = new BoxRenderable(renderer, { id: "main" });
const text = new TextRenderable(renderer, { id: "text", content: "Hello" });
container.add(text);
```

### WRONG Pattern (mixing - causes bugs)

```typescript
const container = new BoxRenderable(renderer, { id: "main" });
container.add(Box({ content: "Hello" })); // DON'T DO THIS
```

### Re-rendering

- Store reference to top-level container
- Call `container.destroy()` before recreating
- Recreate entire tree and add to `renderer.root`

```typescript
let container: BoxRenderable | null = null;

function render() {
  if (container) {
    container.destroy();
  }
  container = new BoxRenderable(renderer, {...});
  // build UI...
  renderer.root.add(container);
}
```

### Text Styling

Use `t` template literal with `fg()` for inline colors:

```typescript
import { t, fg } from "@opentui/core";

const text = new TextRenderable(renderer, {
  content: t`${fg("#00ff00")("green")} ${fg("#ff0000")("red")}`,
});
```

## Code Style Rules

### No Magic Numbers or Strings

**ALWAYS use named constants** for any hardcoded value:

```typescript
// GOOD
const COLORS = {
  ADDED: "#00ff00",
  DELETED: "#ff0000",
} as const;

const diffView = new DiffRenderable(renderer, {
  addedBg: COLORS.ADDED,
});

// BAD
const diffView = new DiffRenderable(renderer, {
  addedBg: "#00ff00", // What does this color mean?
});
```

Apply this to:
- Colors (`#00ff00` → `COLORS.ADDED`)
- Numbers (`20` → `LAYOUT.DIFF_VIEW_HEIGHT`)
- Strings (`"new file"` → `GIT_MARKERS.NEW_FILE`)
- Exit codes (`0` → `EXIT_CODE.SUCCESS`)

## OpenTUI Gotchas

- **Console overlay**: By default, `console.log` opens a split-screen overlay. Avoid `console.*` unless debugging.
- **Terminal dimensions**: Use `renderer.width` and `renderer.height` for dynamic sizing, never hardcode terminal dimensions.
- **Diff component**: OpenTUI provides `DiffRenderable` with built-in split view - use it instead of manual diff rendering.

## Git Diff Parsing

- Split on `^diff --git ` (multiline mode)
- Status detection: check for `new file` (added) or `deleted file` (deleted)
- Count additions/deletions: lines starting with `+`/`-` excluding `+++`/`---` headers

## Project-Specific Notes

- Single file viewer showing collapsible file blocks
- Arrow keys navigate, Tab toggles, q quits
- Stats (+/-) must be color-coded and right-aligned using dynamic terminal width
- File watcher uses 500ms debounce and filters `.git/` directory changes to prevent flicker
- Re-rendering only occurs when diff content actually changes
- Empty state properly transitions to/from non-empty state with component cleanup

