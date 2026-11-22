import { toJsonObject, type JsonObject } from '../json';
import { bool, num, obj, optNum, optStr, str } from './fields';

/**
 * Machine as the CLI reads it from the panel API machine response. `raw` is the validated response object, printed
 * as is with --json.
 */
export interface Machine {
  readonly id: string;
  readonly name: string;
  /** creating | running | paused | stopped | error (Prisma SandboxStatus); unknown future values are shown raw. */
  readonly status: string;
  readonly statusReason: string | null;
  readonly pausedReason: string | null;
  readonly size: string | null;
  readonly vcpuCount: number | null;
  readonly memoryMib: number | null;
  readonly diskMib: number | null;
  readonly autoPause: boolean;
  readonly idleTimeoutMinutes: number | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly runningSince: string | null;
  readonly sourceType: string | null;
  readonly sourceLabel: string | null;
  /** Only on GET /sandboxes/:id: env var names (never values). */
  readonly envKeys: readonly string[] | null;
  readonly raw: JsonObject;
}

function parseEnvKeys(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error('envKeys: expected a string array');
  return value.map((key: unknown) => {
    if (typeof key !== 'string') throw new Error('envKeys: expected a string array');
    return key;
  });
}

export function parseMachine(value: unknown): Machine {
  const raw = toJsonObject(value);
  const record = obj(raw, 'machine');
  const source = record.source === undefined || record.source === null ? null : obj(record.source, 'source');
  const envKeys = parseEnvKeys(record.envKeys);
  return {
    id: str(record, 'sandboxId'),
    name: str(record, 'name'),
    status: str(record, 'status'),
    statusReason: optStr(record, 'statusReason'),
    pausedReason: optStr(record, 'pausedReason'),
    size: optStr(record, 'size'),
    vcpuCount: optNum(record, 'vcpuCount'),
    memoryMib: optNum(record, 'memoryMib'),
    diskMib: optNum(record, 'diskMib'),
    autoPause: bool(record, 'autoPause', true),
    idleTimeoutMinutes: optNum(record, 'idleTimeoutMinutes'),
    createdAt: str(record, 'createdAt'),
    lastActiveAt: optStr(record, 'lastActiveAt'),
    runningSince: optStr(record, 'runningSince'),
    sourceType: source === null ? null : optStr(source, 'type'),
    sourceLabel: source === null ? null : optStr(source, 'label'),
    envKeys,
    raw,
  };
}

export interface Quota {
  readonly used: number;
  readonly limit: number;
}

/** `quota` sibling of GET /sandboxes (`{ data, pagination, quota: { used, limit }, meta }`). */
export function parseQuota(value: unknown): Quota {
  const record = obj(value, 'quota');
  return { used: num(record, 'used'), limit: num(record, 'limit') };
}

/** Sandbox ids are `sbx_<uuid>` (DB default); machine names cannot contain "_", so the two never overlap. */
export const SANDBOX_ID_PATTERN = /^sbx_[0-9a-f-]{36}$/;
/** Same as the server-side machine name rule (checked again by the API). */
export const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const MACHINE_SIZES = ['small', 'medium', 'large'] as const;
