import { createCliRenderer, Box, Text, type KeyEvent } from "@opentui/core";
import { $ } from "bun";

interface FileDiff {
  filename: string;
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  diffContent: string;
  hunks: Hunk[];
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface FileBlock {
  file: FileDiff;
  isOpen: boolean;
}

async function getGitDiff(): Promise<FileDiff[]> {
  try {
    const output = await $`git diff --unified=3`.text();
    if (!output) return [];
    return parseDiff(output);
  } catch (error) {
    console.error("Error getting git diff:", error);
    return [];
  }
}

function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    const firstLine = "diff --git " + lines[0];

    const match = firstLine.match(/diff --git a\/(.*?) b\/(.*?)$/);
    if (!match) continue;

    const oldPath = match[1];
    const newPath = match[2];

    let status: "modified" | "added" | "deleted" = "modified";
    let additions = 0;
    let deletions = 0;
    const hunks: Hunk[] = [];

    let i = 1;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      if (lines[i].startsWith("new file")) status = "added";
      if (lines[i].startsWith("deleted file")) status = "deleted";
      i++;
    }

    let currentHunk: Hunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("@@")) {
        if (currentHunk) hunks.push(currentHunk);

        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1]);
          const oldLen = hunkMatch[2] ? parseInt(hunkMatch[2]) : 1;
          const newStart = parseInt(hunkMatch[3]);
          const newLen = hunkMatch[4] ? parseInt(hunkMatch[4]) : 1;

          oldLineNum = oldStart;
          newLineNum = newStart;

          currentHunk = {
            oldStart,
            oldLines: oldLen,
            newStart,
            newLines: newLen,
            lines: [],
          };
        }
      } else if (currentHunk) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          currentHunk.lines.push({
            type: "add",
            content: line.slice(1),
            newLineNum: newLineNum++,
          });
          additions++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          currentHunk.lines.push({
            type: "remove",
            content: line.slice(1),
            oldLineNum: oldLineNum++,
          });
          deletions++;
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({
            type: "context",
            content: line.slice(1),
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        }
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    files.push({
      filename: newPath,
      oldPath,
      newPath,
      status,
      additions,
      deletions,
      diffContent: block,
      hunks,
    });
  }

  return files;
}

function renderSideBySideDiff(hunks: Hunk[]): string {
  const lines: string[] = [];
  const maxWidth = 80;
  const halfWidth = Math.floor(maxWidth / 2) - 2;

  for (const hunk of hunks) {
    lines.push(`  ${"=".repeat(maxWidth - 4)}`);

    let leftBuf: DiffLine[] = [];
    let rightBuf: DiffLine[] = [];

    for (const diffLine of hunk.lines) {
      if (diffLine.type === "context") {
        flushBuffers();
        const leftNum = diffLine.oldLineNum?.toString().padStart(4) || "    ";
        const rightNum = diffLine.newLineNum?.toString().padStart(4) || "    ";
        const content = truncate(diffLine.content, halfWidth);
        lines.push(
          `  ${leftNum} ${content.padEnd(halfWidth)}  ${rightNum} ${content.padEnd(halfWidth)}`
        );
      } else if (diffLine.type === "remove") {
        leftBuf.push(diffLine);
      } else if (diffLine.type === "add") {
        rightBuf.push(diffLine);
      }
    }

    flushBuffers();

    function flushBuffers() {
      const maxLen = Math.max(leftBuf.length, rightBuf.length);
      for (let i = 0; i < maxLen; i++) {
        const left = leftBuf[i];
        const right = rightBuf[i];

        const leftNum = left?.oldLineNum?.toString().padStart(4) || "    ";
        const rightNum = right?.newLineNum?.toString().padStart(4) || "    ";

        const leftContent = left
          ? `\x1b[31m${truncate(left.content, halfWidth).padEnd(halfWidth)}\x1b[0m`
          : " ".repeat(halfWidth);
        const rightContent = right
          ? `\x1b[32m${truncate(right.content, halfWidth).padEnd(halfWidth)}\x1b[0m`
          : " ".repeat(halfWidth);

        lines.push(`  ${leftNum} ${leftContent}  ${rightNum} ${rightContent}`);
      }
      leftBuf = [];
      rightBuf = [];
    }
  }

  return lines.join("\n");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  const files = await getGitDiff();

  if (files.length === 0) {
    renderer.root.add(
      Box(
        { padding: 2, flexDirection: "column" },
        Text({ content: "No changes to display", fg: "#888888" })
      )
    );
    return;
  }

  const blocks: FileBlock[] = files.map((file) => ({ file, isOpen: false }));
  let cursor = 0;

  function render() {
    renderer.root.removeAllChildren();

    const children = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const isCursor = i === cursor;
      const arrow = block.isOpen ? "▼" : "▶";
      const statusColor = block.file.status === "added" ? "#00ff00" : block.file.status === "deleted" ? "#ff0000" : "#ffff00";
      const diffStats = `+${block.file.additions} -${block.file.deletions}`;

      const headerBg = isCursor ? "#333333" : undefined;

      children.push(
        Box(
          { width: "100%", flexDirection: "row", backgroundColor: headerBg, padding: [0, 1] },
          Text({ content: arrow, fg: "#888888" }),
          Text({ content: " " }),
          Text({ content: block.file.filename, fg: statusColor }),
          Text({ content: " " }),
          Text({ content: diffStats, fg: "#888888" })
        )
      );

      if (block.isOpen) {
        const diffText = renderSideBySideDiff(block.file.hunks);
        children.push(
          Box(
            { width: "100%", flexDirection: "column", padding: [0, 2] },
            Text({ content: diffText })
          )
        );
      }
    }

    renderer.root.add(
      Box(
        { width: "100%", height: "100%", flexDirection: "column" },
        ...children,
        Box({ height: 1 }),
        Text({ content: " ↑/↓: navigate  Tab: toggle  q: quit", fg: "#888888" })
      )
    );
  }

  render();

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "q") {
      renderer.destroy();
      process.exit(0);
    }

    if (key.name === "up") {
      cursor = Math.max(0, cursor - 1);
      render();
    }

    if (key.name === "down") {
      cursor = Math.min(blocks.length - 1, cursor + 1);
      render();
    }

    if (key.name === "tab") {
      blocks[cursor].isOpen = !blocks[cursor].isOpen;
      render();
    }
  });
}

main();
// Test comment
