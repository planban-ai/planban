// The name people see for an agent's app, from what the app calls itself:
// "Claude", "Codex", "ChatGPT", or its own short name. Shared by boards on a
// computer and the online service.
export function appName(raw: string | undefined | null) {
  const name = (raw ?? "").trim();
  if (/claude/i.test(name)) return "Claude";
  if (/codex/i.test(name)) return "Codex";
  if (/chatgpt|openai/i.test(name)) return "ChatGPT";
  return name.slice(0, 40) || "An agent";
}
