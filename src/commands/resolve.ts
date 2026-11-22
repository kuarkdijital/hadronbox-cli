import type { CommandSpec } from './types';

export function findCommand(commands: readonly CommandSpec[], word: string): CommandSpec | undefined {
  return commands.find((c) => c.name === word || (c.aliases ?? []).includes(word));
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      const left = prev[j - 1] ?? 0;
      prev[j] = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** Closest visible command name or alias within edit distance 2, for "Bunu mu demek istedin?" hints. */
export function suggestCommand(commands: readonly CommandSpec[], word: string): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const command of commands) {
    if (command.hidden) continue;
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const score = distance(word, name);
      if (score <= 2 && (best === undefined || score < best.score)) best = { name, score };
    }
  }
  return best?.name;
}
