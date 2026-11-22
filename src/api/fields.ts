import { isRecord } from '../json';

/** Small readers for API response objects. They throw on a wrong shape; ApiClient maps that to UNEXPECTED_RESPONSE. */

export function obj(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  return value;
}

export function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key}: expected a string`);
  return value;
}

export function optStr(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key}: expected a string or null`);
  return value;
}

export function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key}: expected a number`);
  return value;
}

export function optNum(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key}: expected a number or null`);
  return value;
}

export function bool(record: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const value = record[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key}: expected a boolean`);
  return value;
}
