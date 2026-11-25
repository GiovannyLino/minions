'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { CLASSIFICATION_LABEL, ROLE_LABEL } from '@minions/core/contracts';
import { setTheme } from '@/app/actions';
import { useSession } from '@/components/session';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Card } from '@/components/ui';

export default function SettingsPage() {
  const user = useSession();
  const router = useRouter();
  const [pending, start] = useTransition();
  const choose = (t: 'light' | 'dark' | 'system') => start(async () => { await setTheme(t); router.refresh(); });
  return (
    <>
      <PageHeader title="Configurações" description="Preferências pessoais e informações da sua conta." />
      <div className="grid max-w-4xl gap-6 px-5 py-5 md:px-8 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Sua conta</h2>
          <div className="mt-4 flex items-center gap-3">
            <Avatar name={user.name} size={44} />
            <div>
              <p className="text-[14px] font-semibold">{user.name}</p>
              <p className="text-[12.5px] text-muted">{user.email}</p>
            </div>
          </div>
          <dl className="mt-5 space-y-3 text-[13px]">
            <div className="flex justify-between"><dt className="text-muted">Papel</dt><dd><Badge tone="accent">{ROLE_LABEL[user.role]}</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-muted">Habilitação</dt><dd><Badge>{CLASSIFICATION_LABEL[user.clearance]}</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-muted">Área</dt><dd className="font-medium">{user.area ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Grupos</dt><dd className="font-medium">{user.groups.join(', ') || '—'}</dd></div>
          </dl>
          <p className="mt-5 text-[12px] text-faint">Permissões são gerenciadas pela administração e aplicadas no servidor a cada consulta dos agentes.</p>
        </Card>
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Aparência</h2>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {([['light', 'Claro', Sun], ['dark', 'Escuro', Moon], ['system', 'Sistema', Monitor]] as const).map(([v, label, Icon]) => (
              <button key={v} disabled={pending} onClick={() => choose(v)} className="flex flex-col items-center gap-2 rounded-xl border border-line px-3 py-4 text-[12.5px] font-medium text-fg-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent-text">
                <Icon className="size-5" />
                {label}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
