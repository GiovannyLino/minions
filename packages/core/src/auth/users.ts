import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClassificationSchema, RoleSchema, type User } from '../contracts';
import { iso, isoOrNull, type Db } from '../db/client';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors';
import { defaultClearance, type Principal } from './policy';
import type { OidcIdentity } from './tokens';
import { roleFromClaims } from './tokens';

interface UserRow {
  id: string;
  external_id: string | null;
  email: string;
  name: string;
  role: User['role'];
  area: string | null;
  groups: string[];
  clearance: User['clearance'];
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  area: r.area,
  groups: r.groups ?? [],
  clearance: r.clearance,
  active: r.active,
  createdAt: iso(r.created_at),
  lastLoginAt: isoOrNull(r.last_login_at),
});

export const toPrincipal = (u: User): Principal => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  area: u.area,
  groups: u.groups,
  clearance: u.clearance,
});

export const UserUpdateSchema = z.object({
  role: RoleSchema.optional(),
  clearance: ClassificationSchema.optional(),
  groups: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  area: z.string().trim().min(1).max(80).nullable().optional(),
  active: z.boolean().optional(),
});

export class UserService {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<User> {
    const row = await this.db.one<UserRow>('select * from users where id = $1', [id]);
    if (!row) throw new NotFoundError('Usuário não encontrado');
    return toUser(row);
  }

  /** Carrega o principal de uma sessão; usuário inativo/inexistente = não autenticado. */
  async principalFor(id: string): Promise<Principal> {
    const row = await this.db.one<UserRow>('select * from users where id = $1', [id]);
    if (!row || !row.active) throw new UnauthorizedError('Usuário inativo ou inexistente');
    return toPrincipal(toUser(row));
  }

  async list(): Promise<User[]> {
    return (await this.db.query<UserRow>('select * from users order by name')).map(toUser);
  }

  /** Usuários disponíveis para o login de desenvolvimento (somente contas marcadas como dev:). */
  async listDevUsers(): Promise<User[]> {
    return (await this.db.query<UserRow>(`select * from users where external_id like 'dev:%' and active order by role, name`)).map(toUser);
  }

  async upsert(input: { externalId: string; email: string; name: string; role: User['role']; area: string | null; groups: string[]; clearance?: User['clearance'] }): Promise<User> {
    const row = await this.db.one<UserRow>(
      `insert into users (id, external_id, email, name, role, area, groups, clearance)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (external_id) do update set email = excluded.email, name = excluded.name
       returning *`,
      [randomUUID(), input.externalId, input.email.toLowerCase(), input.name, input.role, input.area, input.groups, input.clearance ?? defaultClearance(input.role)],
    );
    return toUser(row!);
  }

  /**
   * Provisionamento JIT a partir do IdP corporativo. Papel e grupos vêm das claims;
   * a habilitação (clearance) é preservada se um admin a definiu.
   */
  async provisionFromOidc(identity: OidcIdentity): Promise<Principal> {
    const role = roleFromClaims(identity.roles);
    // Nunca vincula automaticamente uma conta existente só pelo e-mail (evita sequestro de conta).
    const clash = await this.db.one<{ external_id: string | null }>('select external_id from users where email = $1', [identity.email]);
    if (clash && clash.external_id !== `oidc:${identity.externalId}`) {
      throw new ForbiddenError('Já existe uma conta com este e-mail vinculada a outro provedor. Contate o administrador.');
    }
    const row = await this.db.one<UserRow>(
      `insert into users (id, external_id, email, name, role, groups, clearance, last_login_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (external_id) do update set email = excluded.email, name = excluded.name, role = excluded.role,
         groups = excluded.groups, last_login_at = now()
       returning *`,
      [randomUUID(), `oidc:${identity.externalId}`, identity.email, identity.name, role, identity.groups, defaultClearance(role)],
    );
    if (!row!.active) throw new UnauthorizedError('Usuário desativado no Minions');
    return toPrincipal(toUser(row!));
  }

  async touchLogin(id: string): Promise<void> {
    await this.db.query('update users set last_login_at = now() where id = $1', [id]);
  }

  async update(id: string, patch: z.infer<typeof UserUpdateSchema>): Promise<User> {
    const current = await this.get(id);
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as User;
    const row = await this.db.one<UserRow>(
      'update users set role = $2, clearance = $3, groups = $4, area = $5, active = $6 where id = $1 returning *',
      [id, next.role, next.clearance, next.groups, next.area, next.active],
    );
    return toUser(row!);
  }
}
