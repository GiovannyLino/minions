'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Briefcase, LayoutGrid, LogOut, Menu, MessageSquare, Settings, Shield, Users, X } from 'lucide-react';
import { ROLE_LABEL } from '@minions/core/contracts';
import { logout } from '@/app/actions';
import { Logo } from './brand';
import { useSession } from './session';
import { Avatar } from './ui';
import { cx } from '@/lib/format';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutGrid, exact: true },
  { href: '/chat', label: 'Chat com Minions', icon: MessageSquare },
  { href: '/knowledge', label: 'Base de Conhecimento', icon: BookOpen },
  { href: '/proposals', label: 'Propostas e Projetos', icon: Briefcase },
  { href: '/people', label: 'Pessoas e Contatos', icon: Users },
];

export function AppShell({ children, realDataAllowed }: { children: ReactNode; realDataAllowed: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex min-h-dvh">
      <aside className={cx('fixed inset-y-0 left-0 z-40 w-[248px] -translate-x-full border-r border-line bg-surface/80 backdrop-blur-xl transition-transform duration-300 md:translate-x-0', open && 'translate-x-0 shadow-pop')}>
        <Sidebar onClose={() => setOpen(false)} />
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={() => setOpen(false)} /> : null}

      <div className="flex h-dvh min-w-0 flex-1 flex-col md:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur md:hidden">
          <button aria-label="Abrir menu" onClick={() => setOpen(true)} className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-surface-2">
            <Menu className="size-5" />
          </button>
          <Logo />
        </header>
        {!realDataAllowed ? (
          <div className="border-b border-line bg-surface-2/60 px-4 py-1.5 text-center text-[11.5px] text-muted backdrop-blur">
            Ambiente de demonstração — todos os dados são <strong className="font-semibold text-fg-2">fictícios</strong>. Não carregue informações reais da empresa.
          </div>
        ) : null}
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const user = useSession();
  const isActive = (href: string, exact?: boolean) => (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const item = (href: string, label: string, Icon: typeof LayoutGrid, exact?: boolean) => (
    <Link
      key={href}
      href={href}
      className={cx(
        'group relative flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-medium transition-all duration-200',
        isActive(href, exact) ? 'bg-surface-2 text-fg shadow-[var(--shadow-sm)]' : 'text-muted hover:translate-x-0.5 hover:bg-surface-2/60 hover:text-fg',
      )}
    >
      {isActive(href, exact) ? <span className="bg-brand absolute top-2 bottom-2 -left-2.5 w-[3px] rounded-full" aria-hidden /> : null}
      <Icon className={cx('size-4 shrink-0 transition-colors', isActive(href, exact) ? 'text-accent' : 'text-faint group-hover:text-muted')} strokeWidth={1.8} />
      {label}
    </Link>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/" aria-label="Minions — início">
          <Logo />
        </Link>
        <button aria-label="Fechar menu" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-surface-2 md:hidden">
          <X className="size-4" />
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 px-2.5 py-2">
        {NAV.map((n) => item(n.href, n.label, n.icon, n.exact))}
        <div className="px-2.5 pt-5 pb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">Gestão</div>
        {user.can('admin:ingestion') || user.can('admin:users') ? item('/admin', 'Administração', Shield) : null}
        {item('/settings', 'Configurações', Settings)}
      </nav>
      <div className="border-t border-line p-2.5">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <Avatar name={user.name} size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{user.name}</div>
            <div className="truncate text-[11.5px] text-muted">
              {ROLE_LABEL[user.role]}
              {user.area ? ` · ${user.area}` : ''}
            </div>
          </div>
          <form action={logout}>
            <button aria-label="Sair" title="Sair" className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-fg">
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="animate-fade-up flex flex-col gap-3 border-b border-line px-5 py-6 sm:flex-row sm:items-end sm:justify-between md:px-8">
      <div>
        <h1 className="text-[24px] font-semibold tracking-[-0.03em]">{title}</h1>
        {description ? <p className="mt-1 text-[13.5px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
