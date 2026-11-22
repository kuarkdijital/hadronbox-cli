import { cliError } from '../errors/cli-error';
import {
  commandJson,
  exitCodesJson,
  renderCommandHelp,
  renderExitCodes,
  renderRootHelp,
  rootHelpJson,
} from './help-text';
import { findCommand, suggestCommand } from './resolve';
import type { CommandContext, CommandSpec } from './types';

export const EXIT_CODES_TOPIC = 'exit-codes';

/** Prints help for a command path (`[]` = root). Shared by `hb help …` and `--help`. */
export function printHelp(ctx: Pick<CommandContext, 'out' | 'lang' | 'registry'>, path: readonly CommandSpec[]): void {
  const last = path[path.length - 1];
  if (last === undefined) {
    ctx.out.result(renderRootHelp(ctx.registry, ctx.lang), rootHelpJson(ctx.registry, ctx.lang));
  } else {
    ctx.out.result(renderCommandHelp(path, ctx.lang), commandJson(last, ctx.lang));
  }
}

export const helpCommand: CommandSpec = {
  name: 'help',
  summary: { tr: 'Yardım gösterir (komut veya "exit-codes")', en: 'Show help (for a command or "exit-codes")' },
  usage: 'help [komut…]',
  examples: ['hb help', 'hb help exit-codes', 'hb help help --lang en'],
  async run(ctx) {
    const words = ctx.args.positionals;
    if (words.length === 1 && words[0] === EXIT_CODES_TOPIC) {
      ctx.out.result(renderExitCodes(ctx.lang), exitCodesJson(ctx.lang));
      return;
    }
    const path: CommandSpec[] = [];
    let level: readonly CommandSpec[] = ctx.registry;
    for (const word of words) {
      const next = findCommand(level, word);
      if (next === undefined) {
        const typed = [...path.map((c) => c.name), word].join(' ');
        const hint = suggestCommand(level, word);
        throw cliError('UNKNOWN_COMMAND', { command: typed, suggestion: suggestionText(ctx.lang, hint) });
      }
      path.push(next);
      level = next.subcommands ?? [];
    }
    printHelp(ctx, path);
  },
};

export function suggestionText(lang: CommandContext['lang'], hint: string | undefined): string {
  if (hint === undefined) return '';
  return lang === 'tr' ? ` Bunu mu demek istedin: ${hint}?` : ` Did you mean: ${hint}?`;
}
