const MAX_STATUS_LINES = 50;
const MAX_STATUS_LENGTH = 3500;

function normalizeLine(text: string | null | undefined): string {
  return (text ?? "").trim();
}

function formatAsBlockquote(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => (line.trim() ? `💭 ${line}` : line))
    .join("\n");
}

export function buildThinkingMessage(
  thinkingText: string | null | undefined,
  updates: string[],
): string {
  const thinkingLine = normalizeLine(thinkingText);
  const normalizedUpdates = updates
    .map((update) => normalizeLine(update))
    .filter((update) => update.length > 0 && update !== thinkingLine);

  let block = "";
  if (thinkingLine) {
    block = formatAsBlockquote(thinkingLine);
  }

  const rawUpdates = normalizedUpdates.slice(-(MAX_STATUS_LINES - (thinkingLine ? 1 : 0)));
  const joined = [block, ...rawUpdates].filter(Boolean).join("\n\n").trim();

  if (joined.length <= MAX_STATUS_LENGTH) {
    return joined;
  }

  return `...\n${joined.slice(-(MAX_STATUS_LENGTH - 4))}`;
}

export function hasOnlyThinkingLine(
  thinkingText: string | null | undefined,
  updates: string[],
): boolean {
  return normalizeLine(thinkingText).length > 0 && updates.length === 0;
}
