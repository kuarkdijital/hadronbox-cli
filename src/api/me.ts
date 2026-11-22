import { toJsonObject, type JsonObject } from '../json';
import { bool, obj, optStr, str } from './fields';

/** `GET /me` (server-side MeResponse), the fields the CLI shows. */
export interface Me {
  readonly email: string;
  readonly userName: string;
  readonly emailVerified: boolean;
  readonly organizationName: string;
  readonly organizationIsPersonal: boolean;
  readonly role: string;
  readonly planName: string;
  readonly planTier: string;
  readonly authType: string;
  readonly apiKeyName: string | null;
  readonly raw: JsonObject;
}

export function parseMe(value: unknown): Me {
  const raw = toJsonObject(value);
  const record = obj(raw, 'me');
  const user = obj(record.user, 'user');
  const organization = obj(record.organization, 'organization');
  const membership = obj(record.membership, 'membership');
  const plan = obj(record.plan, 'plan');
  const auth = obj(record.auth, 'auth');
  const apiKey = auth.apiKey === undefined || auth.apiKey === null ? null : obj(auth.apiKey, 'auth.apiKey');
  return {
    email: str(user, 'email'),
    userName: str(user, 'name'),
    emailVerified: bool(user, 'emailVerified', true),
    organizationName: str(organization, 'name'),
    organizationIsPersonal: bool(organization, 'isPersonal', false),
    role: str(membership, 'role'),
    planName: str(plan, 'name'),
    planTier: str(plan, 'tier'),
    authType: str(auth, 'type'),
    apiKeyName: apiKey === null ? null : optStr(apiKey, 'name'),
    raw,
  };
}
