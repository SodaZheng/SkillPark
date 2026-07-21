export interface TableColumn {
  header: string;
  maxWidth?: number;
}

type TableCell = string | number | undefined | null;

function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    /^\p{Mark}$/u.test(character)
  ) {
    return 0;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  return isFullWidth(codePoint) ? 2 : 1;
}

function displayWidth(value: string): number {
  return Array.from(value).reduce(
    (width, character) => width + characterWidth(character),
    0,
  );
}

function normalizeCell(value: TableCell): string {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || "—";
}

function wrapCell(value: string, width: number): string[] {
  if (displayWidth(value) <= width) return [value];

  const lines: string[] = [];
  let remaining = Array.from(value);
  while (remaining.length > 0) {
    let usedWidth = 0;
    let take = 0;
    while (take < remaining.length) {
      const nextWidth = characterWidth(remaining[take] as string);
      if (usedWidth + nextWidth > width) break;
      usedWidth += nextWidth;
      take += 1;
    }
    if (take === 0) take = 1;

    if (take < remaining.length) {
      const candidate = remaining.slice(0, take).join("");
      const lastSpace = candidate.lastIndexOf(" ");
      if (lastSpace > 0)
        take = Array.from(candidate.slice(0, lastSpace)).length;
    }

    lines.push(remaining.slice(0, take).join("").trimEnd());
    remaining = remaining.slice(take);
    while (remaining[0] === " ") remaining = remaining.slice(1);
  }
  return lines;
}

function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly TableCell[])[],
): string {
  if (columns.length === 0) return "";
  if (rows.some((row) => row.length !== columns.length)) {
    throw new Error("Table rows must match the column count");
  }

  const normalizedRows = rows.map((row) => row.map(normalizeCell));
  const widths = columns.map((column, index) => {
    const naturalWidth = Math.max(
      displayWidth(column.header),
      ...normalizedRows.map((row) => displayWidth(row[index] as string)),
    );
    return Math.max(
      displayWidth(column.header),
      Math.min(naturalWidth, column.maxWidth ?? Number.POSITIVE_INFINITY),
    );
  });
  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const renderLine = (cells: readonly string[]): string =>
    `│ ${cells.map((cell, index) => padCell(cell, widths[index] as number)).join(" │ ")} │`;

  const lines = [
    border("┌", "┬", "┐"),
    renderLine(columns.map((column) => column.header)),
    border("├", "┼", "┤"),
  ];

  normalizedRows.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, index) =>
      wrapCell(cell, widths[index] as number),
    );
    const height = Math.max(...wrapped.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      lines.push(renderLine(wrapped.map((cell) => cell[lineIndex] ?? "")));
    }
    if (rowIndex < normalizedRows.length - 1) {
      lines.push(border("├", "┼", "┤"));
    }
  });
  lines.push(border("└", "┴", "┘"));
  return lines.join("\n");
}
