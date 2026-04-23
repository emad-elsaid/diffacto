import { 
  createCliRenderer, 
  BoxRenderable, 
  TextRenderable, 
  DiffRenderable, 
  ScrollBoxRenderable,
  type KeyEvent,
  t,
  fg,
} from "@opentui/core";
import { $ } from "bun";

// UI Constants
const COLORS = {
  ADDED: "#00ff00",
  DELETED: "#ff0000",
  MODIFIED: "#ffff00",
  MUTED: "#888888",
  HEADER_BG: "#1a1a1a",
  HEADER_BG_SELECTED: "#2a2a2a",
} as const;

const DIFF_COLORS = {
  ADDED_BG: "#d4f8d4",
  REMOVED_BG: "#fdd8d8",
  ADDED_SIGN: "#22c55e",
  REMOVED_SIGN: "#ef4444",
  LINE_NUMBER_FG: "#888888",
  CONTENT_FG: "#000000",
} as const;

const SYMBOLS = {
  ARROW_CLOSED: "▶",
  ARROW_OPEN: "▼",
} as const;

const GIT_MARKERS = {
  DIFF_PREFIX: "diff --git ",
  NEW_FILE: "new file",
  DELETED_FILE: "deleted file",
  ADDITION_LINE: "+",
  DELETION_LINE: "-",
  ADDITION_HEADER: "+++",
  DELETION_HEADER: "---",
} as const;

const LAYOUT = {
  DIFF_CONTEXT_LINES: 3,
  DIFF_VIEW_HEIGHT: 20,
  HEADER_PADDING_VERTICAL: 0,
  HEADER_PADDING_HORIZONTAL: 1,
  BOX_PADDING_HORIZONTAL_TOTAL: 2, // 1 on each side
  PADDING_ADJUSTMENT: 1, // Fine-tune alignment
  EMPTY_STATE_PADDING: 2,
  SPACER_HEIGHT: 1,
  MIN_PADDING: 1,
} as const;

const EXIT_CODE = {
  SUCCESS: 0,
} as const;

interface FileDiff {
  filename: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  rawDiff: string;
}

interface FileBlock {
  file: FileDiff;
  isOpen: boolean;
}

async function getGitDiff(): Promise<FileDiff[]> {
  try {
    // Get both staged and unstaged changes
    const stagedOutput = await $`git diff --cached --unified=${LAYOUT.DIFF_CONTEXT_LINES}`.text();
    const unstagedOutput = await $`git diff --unified=${LAYOUT.DIFF_CONTEXT_LINES}`.text();
    
    const stagedFiles = stagedOutput ? parseDiff(stagedOutput) : [];
    const unstagedFiles = unstagedOutput ? parseDiff(unstagedOutput) : [];
    
    // Merge files with same name
    const fileMap = new Map<string, FileDiff>();
    
    for (const file of [...stagedFiles, ...unstagedFiles]) {
      const existing = fileMap.get(file.filename);
      if (existing) {
        // Merge the diffs for the same file
        existing.additions += file.additions;
        existing.deletions += file.deletions;
        existing.rawDiff += "\n" + file.rawDiff;
      } else {
        fileMap.set(file.filename, file);
      }
    }
    
    return Array.from(fileMap.values());
  } catch (error) {
    return [];
  }
}

function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileBlocks = diffText.split(new RegExp(`^${GIT_MARKERS.DIFF_PREFIX}`, 'm')).filter(Boolean);

  for (const block of fileBlocks) {
    const fullBlock = GIT_MARKERS.DIFF_PREFIX + block;
    const lines = fullBlock.split("\n");
    
    const firstLine = lines[0];
    const match = firstLine.match(/diff --git a\/(.*?) b\/(.*?)$/);
    if (!match) continue;

    const filename = match[2];
    let status: "modified" | "added" | "deleted" = "modified";
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith(GIT_MARKERS.NEW_FILE)) status = "added";
      if (line.startsWith(GIT_MARKERS.DELETED_FILE)) status = "deleted";
      if (line.startsWith(GIT_MARKERS.ADDITION_LINE) && !line.startsWith(GIT_MARKERS.ADDITION_HEADER)) additions++;
      if (line.startsWith(GIT_MARKERS.DELETION_LINE) && !line.startsWith(GIT_MARKERS.DELETION_HEADER)) deletions++;
    }

    files.push({
      filename,
      status,
      additions,
      deletions,
      rawDiff: fullBlock,
    });
  }

  return files;
}

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  const files = await getGitDiff();

  if (files.length === 0) {
    const container = new BoxRenderable(renderer, {
      id: "empty",
      padding: LAYOUT.EMPTY_STATE_PADDING,
      flexDirection: "column",
    });
    const text = new TextRenderable(renderer, {
      id: "empty-text",
      content: "No changes to display",
      fg: COLORS.MUTED,
    });
    container.add(text);
    renderer.root.add(container);
    return;
  }

  const blocks: FileBlock[] = files.map((file) => ({ file, isOpen: true }));
  let cursor = 0;
  let scrollBox: ScrollBoxRenderable | null = null;
  let diffViewMode: "unified" | "split" = "split";

  function render() {
    if (scrollBox) {
      scrollBox.destroy();
    }

    const contentContainer = new BoxRenderable(renderer, {
      id: "content-container",
      width: "100%",
      flexDirection: "column",
    });

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const isCursor = i === cursor;
      const arrow = block.isOpen ? SYMBOLS.ARROW_OPEN : SYMBOLS.ARROW_CLOSED;
      const statusColor = 
        block.file.status === "added" ? COLORS.ADDED : 
        block.file.status === "deleted" ? COLORS.DELETED : 
        COLORS.MODIFIED;

      const headerBg = isCursor ? COLORS.HEADER_BG_SELECTED : COLORS.HEADER_BG;

      // Calculate padding to align stats to the right
      const termWidth = renderer.width;
      const leftPart = `${arrow} ${block.file.filename}`;
      const additions = `+${block.file.additions}`;
      const deletions = `-${block.file.deletions}`;
      const statsText = `${additions} ${deletions}`;
      const padding = Math.max(
        LAYOUT.MIN_PADDING, 
        termWidth - LAYOUT.BOX_PADDING_HORIZONTAL_TOTAL - leftPart.length - statsText.length
      ) + LAYOUT.PADDING_ADJUSTMENT;
      
      const headerBox = new BoxRenderable(renderer, {
        id: `header-${i}`,
        width: "100%",
        flexDirection: "row",
        backgroundColor: headerBg,
        padding: [LAYOUT.HEADER_PADDING_VERTICAL, LAYOUT.HEADER_PADDING_HORIZONTAL],
        onMouseDown: () => {
          cursor = i;
          blocks[i].isOpen = !blocks[i].isOpen;
          render();
        },
      });

      const headerText = new TextRenderable(renderer, { 
        id: `text-${i}`, 
        content: t`${fg(statusColor)(`${leftPart}`)}${" ".repeat(padding)}${fg(COLORS.ADDED)(additions)} ${fg(COLORS.DELETED)(deletions)}`,
      });

      headerBox.add(headerText);
      contentContainer.add(headerBox);

      if (block.isOpen) {
        // Calculate actual height needed for the diff (count lines in the diff)
        const diffLines = block.file.rawDiff.split("\n").length;
        
        const diffView = new DiffRenderable(renderer, {
          id: `diff-${i}`,
          width: "100%",
          height: diffLines,
          diff: block.file.rawDiff,
          view: diffViewMode,
          showLineNumbers: true,
          syncScroll: true,
          fg: DIFF_COLORS.CONTENT_FG,
          addedBg: DIFF_COLORS.ADDED_BG,
          removedBg: DIFF_COLORS.REMOVED_BG,
          addedSignColor: DIFF_COLORS.ADDED_SIGN,
          removedSignColor: DIFF_COLORS.REMOVED_SIGN,
          lineNumberFg: DIFF_COLORS.LINE_NUMBER_FG,
          onMouseDown: () => {
            cursor = i;
            render();
          },
        });
        
        contentContainer.add(diffView);
      }
    }

    const spacer = new BoxRenderable(renderer, { id: "spacer", height: LAYOUT.SPACER_HEIGHT });
    const helpText = new TextRenderable(renderer, {
      id: "help",
      content: " j/k: navigate  Tab: toggle  Shift+Tab: toggle all  1: unified  2: split  q: quit",
      fg: COLORS.MUTED,
    });

    contentContainer.add(spacer, helpText);

    scrollBox = new ScrollBoxRenderable(renderer, {
      id: "scroll-container",
      width: "100%",
      height: "100%",
    });

    scrollBox.add(contentContainer);
    renderer.root.add(scrollBox);
  }

  render();

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "q") {
      renderer.destroy();
      process.exit(EXIT_CODE.SUCCESS);
    }

    if (key.name === "up" || key.name === "k") {
      cursor = Math.max(0, cursor - 1);
      render();
    }

    if (key.name === "down" || key.name === "j") {
      cursor = Math.min(blocks.length - 1, cursor + 1);
      render();
    }

    if (key.name === "tab") {
      if (key.shift) {
        // Shift+Tab: toggle all blocks based on current cursor block state
        const targetState = !blocks[cursor].isOpen;
        blocks.forEach(block => {
          block.isOpen = targetState;
        });
      } else {
        // Tab: toggle current block only
        blocks[cursor].isOpen = !blocks[cursor].isOpen;
      }
      render();
    }

    if (key.name === "1") {
      diffViewMode = "unified";
      render();
    }

    if (key.name === "2") {
      diffViewMode = "split";
      render();
    }
  });
}

main();
