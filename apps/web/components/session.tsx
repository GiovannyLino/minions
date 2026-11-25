'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Classification, Role } from '@minions/core/contracts';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  area: string | null;
  groups: string[];
  clearance: Classification;
  permissions: string[];
}

const Ctx = createContext<SessionUser | null>(null);

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}

export function useSession(): SessionUser & { can: (permission: string) => boolean } {
  const user = useContext(Ctx);
  if (!user) throw new Error('useSession fora do SessionProvider');
  return { ...user, can: (p) => user.permissions.includes(p) };
}
