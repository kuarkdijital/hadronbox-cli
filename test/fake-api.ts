import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TEST_KEY } from './helpers';

/**
 * In-process fake of the panel API on 127.0.0.1 (real HTTP, real fetch) with the routes the CLI commands use. Shapes follow
 * the panel API: envelope `{ data, meta }`, list `{ data, pagination, quota, meta }`, errors `{ statusCode, error, code,
 * message }`, lifecycle routes are POST (pause/resume/stop/destroy) and answer 201.
 */
export interface FakeMachine {
  sandboxId: string;
  name: string;
  status: 'creating' | 'running' | 'paused' | 'stopped' | 'error';
  size: 'small' | 'medium' | 'large' | null;
  vcpuCount: number | null;
  memoryMib: number | null;
  diskMib: number | null;
  autoPause: boolean;
  idleTimeoutMinutes: number | null;
  pausedReason: 'user' | 'idle' | 'max_runtime' | null;
  statusReason: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  runningSince: string | null;
  templateCode: string | null;
  sourceSnapshotId: string | null;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  userAgent: string | undefined;
  body: unknown;
}

export interface FakeApiOptions {
  validKeys?: string[];
  /** Max page size the fake honours (to exercise CLI paging). */
  pageCap?: number;
  quotaLimit?: number;
  /** Respond to GET /me with this error instead (status, code). */
  meError?: { status: number; code: string };
  /** Reject creates with 402 PLAN_LIMIT_MACHINES. */
  quotaFull?: boolean;
  /** Reject the first N creates of generated names (hb-…) with NAME_TAKEN. */
  takenGeneratedNames?: number;
}

let counter = 0;
export function fakeId(): string {
  counter += 1;
  return `sbx_00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function fakeMachine(overrides: Partial<FakeMachine> = {}): FakeMachine {
  return {
    sandboxId: fakeId(),
    name: 'web',
    status: 'running',
    size: 'medium',
    vcpuCount: 2,
    memoryMib: 4096,
    diskMib: 20480,
    autoPause: true,
    idleTimeoutMinutes: 30,
    pausedReason: null,
    statusReason: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActiveAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    runningSince: '2026-11-20T10:00:05.000Z',
    templateCode: 'standard',
    sourceSnapshotId: null,
    ...overrides,
  };
}

/** GET/POST machine response; checked against the server's SandboxResponse type in a private contract check. */
export interface FakeMachineResponse extends FakeMachine {
  goldenImage: string;
  imageTag: string | null;
  imageKind: 'terminal';
  displayGeometry: string | null;
  organizationId: string;
  ownerUserId: string | null;
  updatedAt: string;
  deletedAt: string | null;
  source: { type: 'template'; ref: string; label: string };
}

export interface FakeMachineDetailResponse extends FakeMachineResponse {
  envKeys: string[];
}

export function toResponse(m: FakeMachine): FakeMachineResponse {
  return {
    ...m,
    goldenImage: 'hadronbox/golden',
    imageTag: null,
    imageKind: 'terminal',
    displayGeometry: null,
    organizationId: 'org_1',
    ownerUserId: 'usr_1',
    updatedAt: m.createdAt,
    deletedAt: null,
    source: { type: 'template', ref: `t:${m.templateCode ?? 'standard'}`, label: m.templateCode ?? 'standard' },
  };
}

export function toDetailResponse(m: FakeMachine): FakeMachineDetailResponse {
  return { ...toResponse(m), envKeys: ['NODE_ENV'] };
}

/** GET /me fixture; checked against the server's MeResponse type in a private contract check. */
export const ME = {
  user: { id: 'usr_1', email: 'sen@ornek.com', name: 'Sen', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
  organization: { id: 'org_1', name: 'Kişisel', slug: 'kisisel', isPersonal: true },
  membership: { role: 'owner' as const },
  memberships: [{ organizationId: 'org_1', name: 'Kişisel', isPersonal: true, role: 'owner' as const }],
  plan: {
    code: 'free',
    name: 'Ücretsiz',
    tier: 'free' as const,
    source: 'free_default' as const,
    expiresAt: null,
    limits: {
      maxSandboxes: 2,
      maxVcpu: 2,
      maxMemoryMib: 4096,
      maxStorageMib: 10240,
      desktopAllowed: false,
      maxMembers: 1,
      maxSnapshots: 2,
      idleTimeoutMinutes: 30,
      maxRunMinutes: 480,
      premiumTemplates: false,
      maxExposedPorts: 2,
      publicPortsAllowed: false,
      maxTerminalSessions: 3,
    },
    machineSizes: [{ size: 'medium' as const, vcpu: 2, memoryGib: 4, diskGib: 20, allowed: true }],
  },
  betaInvites: { total: 0, used: 0 },
  auth: { type: 'api_key' as const, apiKey: { id: 'key_1', name: 'dizüstü' } },
};

/** GET /sandboxes envelope; checked against the server's PaginatedApiResponse type in a private contract check. */
export type FakeListResponse = {
  quota: { used: number; limit: number };
  data: FakeMachineResponse[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  meta: { timestamp: string };
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, message = code): void {
  send(res, status, { statusCode: status, error: 'Error', code, message });
}

function data(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, { data: value, meta: { timestamp: new Date().toISOString() } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  machines: FakeMachine[] = [];
  private server: Server | undefined;
  private generatedRejected = 0;
  url = '';

  constructor(private readonly options: FakeApiOptions = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => error(res, 500, 'FAKE_FAILURE', String(e)));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  paths(): string[] {
    return this.requests.map((r) => `${r.method} ${r.url}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://fake');
    this.requests.push({
      method,
      url: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
      userAgent: req.headers['user-agent'],
      body,
    });
    const valid = this.options.validKeys ?? [TEST_KEY];
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!valid.includes(token)) return error(res, 401, 'INVALID_API_KEY', 'API key is invalid');

    const segments = url.pathname.split('/').filter(Boolean);
    if (method === 'GET' && url.pathname === '/me') {
      if (this.options.meError) return error(res, this.options.meError.status, this.options.meError.code);
      return data(res, 200, ME);
    }
    if (segments[0] !== 'sandboxes') return error(res, 404, 'NOT_FOUND');

    if (segments.length === 1 && method === 'GET') {
      const search = url.searchParams.get('search');
      const status = url.searchParams.get('status');
      const page = Number(url.searchParams.get('page') ?? '1');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), this.options.pageCap ?? 100);
      const filtered = this.machines.filter(
        (m) => (!search || m.name.toLowerCase().includes(search.toLowerCase())) && (!status || m.status === status),
      );
      const items = filtered.slice((page - 1) * limit, page * limit);
      const list: FakeListResponse = {
        quota: { used: this.machines.length, limit: this.options.quotaLimit ?? 2 },
        data: items.map(toResponse),
        pagination: { page, limit, total: filtered.length, totalPages: Math.ceil(filtered.length / limit) },
        meta: { timestamp: 'x' },
      };
      return send(res, 200, list);
    }
    if (segments.length === 1 && method === 'POST') {
      const input = body as Record<string, unknown>;
      if (this.options.quotaFull) return error(res, 402, 'PLAN_LIMIT_MACHINES', 'Machine quota reached');
      const name = String(input.name);
      if (name.startsWith('hb-') && this.generatedRejected < (this.options.takenGeneratedNames ?? 0)) {
        this.generatedRejected += 1;
        return error(res, 409, 'NAME_TAKEN');
      }
      if (this.machines.some((m) => m.name === name)) return error(res, 409, 'NAME_TAKEN');
      const machine = fakeMachine({
        name,
        status: 'creating',
        size: input.size === 'small' || input.size === 'large' ? input.size : 'medium',
        autoPause: input.autoPause !== false,
        templateCode: typeof input.templateCode === 'string' ? input.templateCode : 'standard',
        lastActiveAt: null,
      });
      this.machines.push(machine);
      return data(res, 201, toResponse(machine));
    }
    const machine = this.machines.find((m) => m.sandboxId === segments[1]);
    if (!machine) return error(res, 404, 'SANDBOX_NOT_FOUND', 'Machine not found');
    if (segments.length === 2 && method === 'GET') return data(res, 200, toDetailResponse(machine));
    const action = segments[2];
    if (method === 'POST' && action === 'pause') {
      if (machine.status !== 'running') return error(res, 409, 'INVALID_STATE');
      machine.status = 'paused';
      machine.pausedReason = 'user';
      return data(res, 201, toResponse(machine));
    }
    if (method === 'POST' && action === 'resume') {
      if (machine.status !== 'paused') return error(res, 409, 'INVALID_STATE');
      machine.status = 'running';
      machine.pausedReason = null;
      return data(res, 201, toResponse(machine));
    }
    if (method === 'POST' && action === 'stop') {
      if (machine.status === 'stopped') return error(res, 409, 'INVALID_STATE');
      machine.status = 'stopped';
      return data(res, 201, toResponse(machine));
    }
    if (method === 'POST' && action === 'destroy') {
      this.machines = this.machines.filter((m) => m !== machine);
      return data(res, 201, toResponse(machine));
    }
    return error(res, 404, 'NOT_FOUND');
  }
}
