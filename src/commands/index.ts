import { AUTH_COMMANDS } from './auth';
import { helpCommand } from './help';
import { MACHINE_SHORTCUTS, machinesCommand } from './machines';
import type { CommandSpec } from './types';
import { versionCommand } from './version';

/**
 * Command registry. Order is the order shown in `hb --help`. Machine subcommands are also reachable at the top level
 * (`hb ls`, `hb rm web`; hidden shortcuts). Later tasks add exec, sh, ports, snapshots, cp.
 */
export const COMMANDS: readonly CommandSpec[] = [
  ...AUTH_COMMANDS,
  machinesCommand,
  helpCommand,
  versionCommand,
  ...MACHINE_SHORTCUTS,
];
