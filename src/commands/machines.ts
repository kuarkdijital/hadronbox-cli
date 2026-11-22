import { randomInt } from 'node:crypto';
import { booleanValue, stringValue } from '../args/parse';
import {
  MACHINE_NAME_PATTERN,
  MACHINE_SIZES,
  parseMachine,
  parseQuota,
  type Machine,
  type Quota,
} from '../api/machines';
import { resolveMachine } from '../api/resolve-machine';
import { CliError, cliError } from '../errors/cli-error';
import { ExitCode } from '../errors/exit-codes';
import { apiPath, type ApiClient } from '../http/client';
import { localize, type Lang, type Localized } from '../i18n';
import type { JsonObject } from '../json';
import {
  formatDateTime,
  formatMib,
  formatMinutes,
  pausedReasonLabel,
  renderFields,
  renderTable,
  statusLabel,
} from '../format';
import type { CommandContext, CommandSpec } from './types';

const STATUS_FILTERS = ['creating', 'running', 'paused', 'stopped', 'error'] as const;
const MAX_PAGES = 50;

function requireMachineArg(ctx: CommandContext): string {
  const ref = ctx.args.positionals[0];
  if (ref === undefined) throw cliError('MISSING_ARGUMENT', { name: ctx.lang === 'tr' ? '<ad>' : '<name>' });
  return ref;
}

async function listAll(
  api: ApiClient,
  status: string | undefined,
): Promise<{ machines: Machine[]; quota: Quota | null }> {
  const machines: Machine[] = [];
  let quota: Quota | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await api.requestPage('/sandboxes', parseMachine, { query: { page, limit: 100, status } });
    machines.push(...result.data);
    if (page === 1 && result.extra.quota !== undefined) {
      try {
        quota = parseQuota(result.extra.quota);
      } catch (error) {
        throw cliError('UNEXPECTED_RESPONSE', { status: 200 }, { cause: error });
      }
    }
    if (page >= result.pagination.totalPages) break;
  }
  return { machines, quota };
}

function sizeText(machine: Machine): string {
  return machine.size ?? '-';
}

function quotaLine(quota: Quota, lang: Lang): string {
  return lang === 'tr' ? `Kota: ${quota.used}/${quota.limit} makine` : `Quota: ${quota.used}/${quota.limit} machines`;
}

const listCommand: CommandSpec = {
  name: 'ls',
  aliases: ['list'],
  summary: { tr: 'Makineleri listeler (kota ile)', en: 'List machines (with quota)' },
  usage: 'machines ls [--status <durum>]',
  examples: ['hb machines ls', 'hb ls --status running', 'hb machines ls --json'],
  maxPositionals: 0,
  options: {
    status: {
      type: 'string',
      valueName: STATUS_FILTERS.join('|'),
      choices: STATUS_FILTERS,
      description: { tr: 'Yalnız bu durumdaki makineler', en: 'Only machines in this state' },
    },
  },
  async run(ctx) {
    const api = await ctx.services.api();
    const { machines, quota } = await listAll(api, stringValue(ctx.args.values, 'status'));
    const json: JsonObject = {
      machines: machines.map((m) => m.raw),
      quota: quota === null ? null : { used: quota.used, limit: quota.limit },
    };
    const { lang } = ctx;
    let human: string;
    if (machines.length === 0) {
      human =
        lang === 'tr'
          ? 'Henüz makinen yok. Oluşturmak için: hb machines create'
          : 'You have no machines yet. Create one: hb machines create';
    } else {
      const headers = lang === 'tr' ? ['AD', 'DURUM', 'BOYUT', 'OLUŞTURULMA'] : ['NAME', 'STATUS', 'SIZE', 'CREATED'];
      human = renderTable(
        headers,
        machines.map((m) => [m.name, statusLabel(m.status, lang), sizeText(m), formatDateTime(m.createdAt, lang)]),
      );
    }
    if (quota !== null) human += `\n${quotaLine(quota, lang)}`;
    ctx.out.result(human, json);
  },
};

/** Default name for `create` without a name: `hb-<word>-NN` (like the landing demo `hb-ajan-01`). */
const NAME_WORDS = ['ajan', 'bulut', 'deniz', 'nehir', 'orman', 'kuzey', 'yildiz', 'ruzgar', 'kaya', 'gunes'] as const;
const NAME_ATTEMPTS = 5;

export function generateMachineName(pick: (max: number) => number = randomInt): string {
  const word = NAME_WORDS[pick(NAME_WORDS.length)] ?? 'ajan';
  return `hb-${word}-${String(pick(99) + 1).padStart(2, '0')}`;
}

const createCommand: CommandSpec = {
  name: 'create',
  aliases: ['new'],
  summary: { tr: 'Yeni makine oluşturur; adı stdout’a yazar', en: 'Create a machine; prints its name on stdout' },
  usage: 'machines create [ad] [--size small|medium|large] [--template <kod>] [--snapshot <id>] [--no-auto-pause]',
  examples: ['hb machines create', 'hb create web --size large', 'NAME=$(hb create) && hb status "$NAME"'],
  maxPositionals: 1,
  options: {
    size: {
      type: 'string',
      valueName: MACHINE_SIZES.join('|'),
      choices: MACHINE_SIZES,
      description: {
        tr: 'Boyut (varsayılan medium; plan izin vermeli)',
        en: 'Size (default medium; must be allowed by the plan)',
      },
    },
    template: {
      type: 'string',
      valueName: 'kod',
      description: { tr: 'Şablon kodu (ör. standard)', en: 'Template code (e.g. standard)' },
    },
    snapshot: {
      type: 'string',
      valueName: 'snp_…',
      description: { tr: 'Snapshot’tan oluştur', en: 'Create from a snapshot' },
    },
    'no-auto-pause': {
      type: 'boolean',
      description: { tr: 'Boşta kalınca otomatik duraklatma', en: 'Do not auto-pause when idle' },
    },
  },
  async run(ctx) {
    const given = ctx.args.positionals[0];
    if (given !== undefined && !MACHINE_NAME_PATTERN.test(given)) {
      throw cliError('INVALID_MACHINE_NAME', { name: given });
    }
    const template = stringValue(ctx.args.values, 'template');
    const snapshot = stringValue(ctx.args.values, 'snapshot');
    if (template !== undefined && snapshot !== undefined) {
      throw cliError('CONFLICTING_OPTIONS', { first: '--template', second: '--snapshot' });
    }
    const size = stringValue(ctx.args.values, 'size');
    const base: JsonObject = {};
    if (size !== undefined) base.size = size;
    if (template !== undefined) base.templateCode = template;
    if (snapshot !== undefined) base.snapshotId = snapshot;
    if (booleanValue(ctx.args.values, 'no-auto-pause')) base.autoPause = false;

    const api = await ctx.services.api();
    let machine: Machine | undefined;
    for (let attempt = 0; machine === undefined; attempt += 1) {
      const name = given ?? generateMachineName();
      try {
        machine = await api.post('/sandboxes', parseMachine, { body: { ...base, name } });
      } catch (error) {
        // A generated name may collide with an existing machine: pick another one.
        const retry = given === undefined && error instanceof CliError && error.code === 'NAME_TAKEN';
        if (!retry || attempt + 1 >= NAME_ATTEMPTS) throw error;
      }
    }
    if (!ctx.out.json) {
      ctx.out.info(
        ctx.lang === 'tr'
          ? `Makine oluşturuldu: ${machine.name} (${statusLabel(machine.status, 'tr')})`
          : `Machine created: ${machine.name} (${statusLabel(machine.status, 'en')})`,
      );
    }
    ctx.out.result(machine.name, machine.raw);
  },
};

/**
 * Gate for irreversible actions (rm, stop --hard): `--yes` skips; on a terminal ask (e/H); otherwise
 * CONFIRMATION_REQUIRED (exit 2) before anything is sent. Returns false when the user said no.
 */
async function confirmIrreversible(ctx: CommandContext, question: string): Promise<boolean> {
  if (booleanValue(ctx.args.values, 'yes')) return true;
  if (!ctx.interactive) throw cliError('CONFIRMATION_REQUIRED');
  return ctx.prompt.confirm(question, ctx.lang);
}

const YES_OPTION = {
  type: 'boolean',
  short: 'y',
  description: { tr: 'Onay sorma', en: 'Do not ask for confirmation' },
} as const;

type Transition = 'pause' | 'resume' | 'stop';

function transitionPath(transition: Transition, id: string): string {
  if (transition === 'pause') return apiPath`/sandboxes/${id}/pause`;
  if (transition === 'resume') return apiPath`/sandboxes/${id}/resume`;
  return apiPath`/sandboxes/${id}/stop`;
}

const ALREADY: Readonly<Record<Transition, { status: string; text: Localized }>> = {
  pause: {
    status: 'paused',
    text: { tr: 'Makine zaten duraklatılmış: {name}', en: 'The machine is already paused: {name}' },
  },
  resume: {
    status: 'running',
    text: { tr: 'Makine zaten çalışıyor: {name}', en: 'The machine is already running: {name}' },
  },
  stop: {
    status: 'stopped',
    text: { tr: 'Makine zaten durdurulmuş: {name}', en: 'The machine is already stopped: {name}' },
  },
};

const RESUME_STOPPED: Localized = {
  tr: 'Durdurulmuş makine yeniden başlatılamaz: {name}. Yeni makine oluştur: hb create',
  en: 'A stopped machine cannot be started again: {name}. Create a new one: hb create',
};

const NOT_ALLOWED: Localized = {
  tr: 'Makine bu işlem için uygun durumda değil: {name} (durum: {status})',
  en: 'The machine is not in a state that allows this: {name} (status: {status})',
};

const DONE: Readonly<Record<Transition, Localized>> = {
  pause: { tr: 'Makine duraklatıldı: {name}', en: 'Machine paused: {name}' },
  resume: { tr: 'Makine devam ettirildi: {name}', en: 'Machine resumed: {name}' },
  stop: { tr: 'Makine durduruldu: {name}', en: 'Machine stopped: {name}' },
};

/** 409 INVALID_STATE gets a message that names the machine and its known state , exit 6. */
function stateError(error: CliError, transition: Transition, machine: Machine, lang: Lang): CliError {
  const already = ALREADY[transition];
  const message =
    machine.status === already.status
      ? localize(already.text, { name: machine.name })
      : transition === 'resume' && machine.status === 'stopped'
        ? localize(RESUME_STOPPED, { name: machine.name })
        : localize(NOT_ALLOWED, { name: machine.name, status: statusLabel(machine.status, lang) });
  return new CliError({
    code: error.code,
    exitCode: ExitCode.INVALID_STATE,
    message,
    details: { ...(error.details ?? {}), machine: machine.name, status: machine.status },
    httpStatus: error.httpStatus,
  });
}

async function runTransition(ctx: CommandContext, transition: Transition): Promise<void> {
  const ref = requireMachineArg(ctx);
  const api = await ctx.services.api();
  const machine = await resolveMachine(api, ref);
  if (transition === 'stop') {
    const question =
      ctx.lang === 'tr'
        ? `"${machine.name}" makinesi tamamen durdurulsun mu? Durdurulan makine yeniden başlatılamaz, yalnız silinebilir.`
        : `Stop machine "${machine.name}" for good? A stopped machine cannot be started again, only deleted.`;
    if (!(await confirmIrreversible(ctx, question))) {
      ctx.out.info(ctx.lang === 'tr' ? 'Durdurma iptal edildi.' : 'Stop cancelled.');
      return;
    }
  }
  let updated: Machine;
  try {
    updated = await api.post(transitionPath(transition, machine.id), parseMachine);
  } catch (error) {
    if (error instanceof CliError && error.code === 'INVALID_STATE')
      throw stateError(error, transition, machine, ctx.lang);
    throw error;
  }
  ctx.out.result(localize(DONE[transition], { name: updated.name })[ctx.lang], updated.raw);
}

const pauseCommand: CommandSpec = {
  name: 'pause',
  aliases: ['stop'],
  summary: {
    tr: 'Makineyi duraklatır (resume ile devam eder); --hard kalıcı olarak durdurur',
    en: 'Pause a machine (continue with resume); --hard stops it for good',
  },
  usage: 'machines pause <ad> [--hard [--yes]]',
  examples: ['hb machines pause web', 'hb stop web', 'hb stop web --hard --yes'],
  maxPositionals: 1,
  options: {
    hard: {
      type: 'boolean',
      description: {
        tr: 'Kalıcı durdur: makine yeniden başlatılamaz, yalnız silinebilir (onay ister)',
        en: 'Stop for good: the machine cannot be started again, only deleted (asks first)',
      },
    },
    yes: {
      ...YES_OPTION,
      description: { tr: '--hard için onay sorma', en: 'Do not ask for confirmation with --hard' },
    },
  },
  run: (ctx) => runTransition(ctx, booleanValue(ctx.args.values, 'hard') ? 'stop' : 'pause'),
};

const resumeCommand: CommandSpec = {
  name: 'resume',
  aliases: ['start'],
  summary: {
    tr: 'Duraklatılmış (paused) makineyi devam ettirir; durdurulmuş makine başlatılamaz',
    en: 'Resume a paused machine; a stopped machine cannot be started',
  },
  usage: 'machines resume <ad>',
  examples: ['hb machines resume web', 'hb start web'],
  maxPositionals: 1,
  run: (ctx) => runTransition(ctx, 'resume'),
};

const removeCommand: CommandSpec = {
  name: 'rm',
  aliases: ['delete'],
  summary: { tr: 'Makineyi siler (onay ister; --yes ile atlanır)', en: 'Delete a machine (asks first; --yes skips)' },
  usage: 'machines rm <ad> [--yes]',
  examples: ['hb machines rm web', 'hb rm web --yes'],
  maxPositionals: 1,
  options: { yes: YES_OPTION },
  async run(ctx) {
    const ref = requireMachineArg(ctx);
    const api = await ctx.services.api();
    const machine = await resolveMachine(api, ref);
    const question =
      ctx.lang === 'tr'
        ? `"${machine.name}" makinesi silinsin mi? Bu işlem geri alınamaz.`
        : `Delete machine "${machine.name}"? This cannot be undone.`;
    if (!(await confirmIrreversible(ctx, question))) {
      ctx.out.info(ctx.lang === 'tr' ? 'Silme iptal edildi.' : 'Deletion cancelled.');
      return ExitCode.OK;
    }
    const deleted = await api.post(apiPath`/sandboxes/${machine.id}/destroy`, parseMachine);
    ctx.out.result(
      ctx.lang === 'tr' ? `Makine silindi: ${deleted.name}` : `Machine deleted: ${deleted.name}`,
      deleted.raw,
    );
    return ExitCode.OK;
  },
};

export interface IdleInfo {
  readonly idleMinutes: number | null;
  readonly autoPauseInMinutes: number | null;
}

/** Idle time since lastActiveAt and the minutes left until auto-pause (running + autoPause only). */
export function idleInfo(machine: Machine, now: number): IdleInfo {
  const last = machine.lastActiveAt === null ? Number.NaN : Date.parse(machine.lastActiveAt);
  const idleMinutes = Number.isNaN(last) ? null : Math.max(0, Math.floor((now - last) / 60_000));
  const autoPauseInMinutes =
    machine.status === 'running' && machine.autoPause && machine.idleTimeoutMinutes !== null && idleMinutes !== null
      ? Math.max(0, machine.idleTimeoutMinutes - idleMinutes)
      : null;
  return { idleMinutes, autoPauseInMinutes };
}

function resourcesText(machine: Machine): string {
  const parts = [machine.size ?? '-'];
  if (machine.vcpuCount !== null) parts.push(`${machine.vcpuCount} vCPU`);
  if (machine.memoryMib !== null) parts.push(`${formatMib(machine.memoryMib)} RAM`);
  if (machine.diskMib !== null) parts.push(`${formatMib(machine.diskMib)} disk`);
  return parts.join(' · ');
}

export function renderStatus(machine: Machine, info: IdleInfo, lang: Lang): string {
  const tr = lang === 'tr';
  let status = statusLabel(machine.status, lang);
  if (machine.status === 'paused' && machine.pausedReason !== null) {
    status += ` (${pausedReasonLabel(machine.pausedReason, lang)})`;
  }
  if (machine.statusReason !== null && machine.status === 'error') status += ` (${machine.statusReason})`;
  const autoPause = !machine.autoPause
    ? tr
      ? 'kapalı'
      : 'off'
    : info.autoPauseInMinutes !== null
      ? tr
        ? `${formatMinutes(info.autoPauseInMinutes, lang)} sonra`
        : `in ${formatMinutes(info.autoPauseInMinutes, lang)}`
      : machine.idleTimeoutMinutes !== null
        ? tr
          ? `${formatMinutes(machine.idleTimeoutMinutes, lang)} boşta kalınca`
          : `after ${formatMinutes(machine.idleTimeoutMinutes, lang)} idle`
        : '-';
  const lastActive =
    machine.lastActiveAt === null
      ? '-'
      : `${formatDateTime(machine.lastActiveAt, lang)}${
          info.idleMinutes === null
            ? ''
            : tr
              ? ` (${formatMinutes(info.idleMinutes, lang)} önce)`
              : ` (${formatMinutes(info.idleMinutes, lang)} ago)`
        }`;
  const source =
    machine.sourceLabel === null
      ? '-'
      : `${machine.sourceLabel}${machine.sourceType === null ? '' : ` (${machine.sourceType})`}`;
  const fields: [string, string][] = [
    [tr ? 'Ad' : 'Name', machine.name],
    [tr ? 'Kimlik' : 'Id', machine.id],
    [tr ? 'Durum' : 'Status', status],
    [tr ? 'Kaynaklar' : 'Resources', resourcesText(machine)],
    [tr ? 'Kaynak imaj' : 'Source', source],
    [tr ? 'Oluşturulma' : 'Created', formatDateTime(machine.createdAt, lang)],
    [tr ? 'Son etkinlik' : 'Last active', lastActive],
    [tr ? 'Otomatik duraklatma' : 'Auto-pause', autoPause],
  ];
  if (machine.envKeys !== null) {
    fields.push([
      tr ? 'Ortam değişkenleri' : 'Env vars',
      machine.envKeys.length === 0 ? '-' : machine.envKeys.join(', '),
    ]);
  }
  return renderFields(fields);
}

const statusCommand: CommandSpec = {
  name: 'status',
  aliases: ['show'],
  summary: {
    tr: 'Makinenin durumu, boşta kalma süresi ve otomatik duraklatma',
    en: 'Machine state, idle time and auto-pause',
  },
  usage: 'machines status <ad>',
  examples: ['hb machines status web', 'hb status web --json'],
  maxPositionals: 1,
  async run(ctx) {
    const ref = requireMachineArg(ctx);
    const api = await ctx.services.api();
    const machine = await resolveMachine(api, ref, { detail: true });
    const info = idleInfo(machine, Date.now());
    ctx.out.result(renderStatus(machine, info, ctx.lang), {
      ...machine.raw,
      idleMinutes: info.idleMinutes,
      autoPauseInMinutes: info.autoPauseInMinutes,
    });
  },
};

export const MACHINE_SUBCOMMANDS: readonly CommandSpec[] = [
  listCommand,
  createCommand,
  statusCommand,
  pauseCommand,
  resumeCommand,
  removeCommand,
];

export const machinesCommand: CommandSpec = {
  name: 'machines',
  aliases: ['machine', 'm'],
  summary: {
    tr: 'Makine yönetimi (ls, create, status, pause, resume, rm)',
    en: 'Manage machines (ls, create, status, pause, resume, rm)',
  },
  usage: 'machines <alt komut> [ad] [seçenekler]',
  examples: ['hb machines ls', 'hb machines create web', 'hb machines rm web --yes'],
  notes: {
    tr: 'Kısa yollar: hb ls · hb create · hb status · hb pause · hb resume · hb rm',
    en: 'Shortcuts: hb ls · hb create · hb status · hb pause · hb resume · hb rm',
  },
  subcommands: MACHINE_SUBCOMMANDS,
};

/** Top-level shortcuts (`hb ls`, `hb rm web`), hidden from the root help to keep it short. */
export const MACHINE_SHORTCUTS: readonly CommandSpec[] = MACHINE_SUBCOMMANDS.map((command) => ({
  ...command,
  hidden: true,
}));
