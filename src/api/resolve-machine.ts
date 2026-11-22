import { CliError, cliError } from '../errors/cli-error';
import { apiPath, type ApiClient } from '../http/client';
import { parseMachine, SANDBOX_ID_PATTERN, type Machine } from './machines';

const SEARCH_MAX = 100;
const MAX_PAGES = 10;

function isNotFound(error: unknown): boolean {
  return error instanceof CliError && (error.code === 'SANDBOX_NOT_FOUND' || error.httpStatus === 404);
}

/**
 * Finds a machine by id (`sbx_…`) or by name (commands take names). Names are unique among an org's live
 * machines (checked by the API on create); if two rows still share a name (accepted race) the CLI refuses to guess
 * (AMBIGUOUS_MACHINE, exit 2) and lists the ids. Not found → MACHINE_NOT_FOUND (exit 4) with the given name.
 * `detail: true` returns the GET /sandboxes/:id form (adds envKeys).
 */
export async function resolveMachine(
  api: ApiClient,
  ref: string,
  options: { detail?: boolean } = {},
): Promise<Machine> {
  if (SANDBOX_ID_PATTERN.test(ref)) {
    try {
      return await api.get(apiPath`/sandboxes/${ref}`, parseMachine);
    } catch (error) {
      if (isNotFound(error)) throw cliError('MACHINE_NOT_FOUND', { name: ref });
      throw error;
    }
  }
  if (ref.length === 0 || ref.length > SEARCH_MAX) throw cliError('MACHINE_NOT_FOUND', { name: ref });
  // `search` is a case-insensitive substring match: follow the pages (sorted by name) so an exact match is not
  // missed behind other names that contain it.
  const matches: Machine[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await api.requestPage('/sandboxes', parseMachine, {
      query: { search: ref, limit: 100, page, sortBy: 'name', sortOrder: 'asc' },
    });
    matches.push(...result.data.filter((machine) => machine.name === ref));
    if (page >= result.pagination.totalPages) break;
  }
  const [only, ...others] = matches;
  if (only === undefined) throw cliError('MACHINE_NOT_FOUND', { name: ref });
  if (others.length > 0) {
    throw cliError('AMBIGUOUS_MACHINE', { name: ref, ids: matches.map((m) => m.id).join(', ') });
  }
  if (!options.detail) return only;
  try {
    return await api.get(apiPath`/sandboxes/${only.id}`, parseMachine);
  } catch (error) {
    if (isNotFound(error)) throw cliError('MACHINE_NOT_FOUND', { name: ref });
    throw error;
  }
}
