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

  const joined = [block, ...normalizedUpdates].filter(Boolean).join("\n\n").trim();

  return joined;
}

export function hasOnlyThinkingLine(
  thinkingText: string | null | undefined,
  updates: string[],
): boolean {
  return normalizeLine(thinkingText).length > 0 && updates.length === 0;
}
