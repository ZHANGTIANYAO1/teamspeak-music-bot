export interface ParsedCommand {
  name: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
}

/**
 * The fixed set of "admin" chat commands. This is the SINGLE source of truth
 * for which commands the permission gate restricts; reclassifying a command is
 * a one-line edit here. Everything not in this set is public.
 */
export const ADMIN_COMMANDS = new Set([
  "stop", "clear", "remove", "move", "vol", "mode",
]);

export function parseCommand(
  message: string,
  prefix: string,
  aliases: Record<string, string> = {},
): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const withoutPrefix = trimmed.slice(prefix.length);
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(/\s+/);
  let name = parts[0].toLowerCase();

  if (aliases[name]) {
    name = aliases[name];
  }

  const flags = new Set<string>();
  const argParts: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    if (
      parts[i].startsWith("-") &&
      parts[i].length === 2 &&
      /[a-zA-Z]/.test(parts[i][1])
    ) {
      flags.add(parts[i][1].toLowerCase());
    } else {
      argParts.push(parts[i]);
    }
  }

  return {
    name,
    args: argParts.join(" "),
    rawArgs: argParts,
    flags,
  };
}

export function isAdminCommand(commandName: string): boolean {
  return ADMIN_COMMANDS.has(commandName);
}

/**
 * Decide whether a chat command may run, given the invoker's TS server groups
 * and the configured admin groups. Pure + synchronous so it is trivially unit
 * tested and reused by the async gate in BotInstance.
 *
 * Allowed iff: (1) it is a public command, OR (2) enforcement is off
 * (adminGroups empty), OR (3) some invoker group is in adminGroups.
 * invokerGroups (strings from TS) and adminGroups (numbers) are normalized to
 * strings before comparison so "6" matches 6.
 */
export function canRunCommand(
  commandName: string,
  invokerGroups: readonly (string | number)[],
  adminGroups: readonly number[],
): boolean {
  if (!isAdminCommand(commandName)) return true;
  if (adminGroups.length === 0) return true;
  const admin = new Set(adminGroups.map((g) => String(g)));
  return invokerGroups.some((g) => admin.has(String(g)));
}
