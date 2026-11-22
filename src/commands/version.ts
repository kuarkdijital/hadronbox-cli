import { CLI_VERSION } from '../version';
import type { CommandContext, CommandSpec } from './types';

export function printVersion(ctx: Pick<CommandContext, 'out'>): void {
  ctx.out.result(CLI_VERSION, { version: CLI_VERSION, node: process.versions.node });
}

export const versionCommand: CommandSpec = {
  name: 'version',
  summary: { tr: 'CLI sürümünü yazar', en: 'Print the CLI version' },
  usage: 'version',
  examples: ['hb version', 'hb --version --json'],
  maxPositionals: 0,
  async run(ctx) {
    printVersion(ctx);
  },
};
