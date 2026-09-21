export const DEFAULT_PLATFORM_SOURCE = 'claude';

/**
 * The 'claude-code' hook wire format is not exclusive to genuine Claude Code:
 * any host speaking the same hook protocol -- e.g. a VS Code Copilot Chat
 * agent with a Claude-compatible plugin loader -- invokes the exact same
 * hook script with no other signal to tell them apart (both the claude-code
 * adapter and hookCommand's own literal-platform-string assignment treat
 * every 'claude-code'-invoked hook identically). Genuine Claude Code (CLI or
 * the real Anthropic VS Code extension) always sets CLAUDE_CODE_ENTRYPOINT
 * (confirmed empirically: 'claude-vscode' inside the real extension); nothing
 * else speaking this protocol has a reason to set it. Its absence is treated
 * as "something Claude-compatible, but not actually Claude" rather than
 * silently defaulting to 'claude'.
 */
export function resolveClaudeCodeHookPlatform(): string {
  return process.env.CLAUDE_CODE_ENTRYPOINT ? 'claude' : 'vscode-copilot';
}

function sanitizeRawSource(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizePlatformSource(value?: string | null): string {
  if (!value) return DEFAULT_PLATFORM_SOURCE;

  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;

  if (source === 'transcript') return 'codex';
  if (source.includes('codex')) return 'codex';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('claude')) return 'claude';

  return source;
}

export function normalizePlatformSourceOrNull(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  return normalizePlatformSource(value);
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude', 'codex', 'cursor'];

  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);

    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }

    return a.localeCompare(b);
  });
}
