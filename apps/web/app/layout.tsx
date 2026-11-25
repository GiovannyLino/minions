import type { Metadata, Viewport } from 'next';
// Fontes empacotadas localmente (pacote `geist`): nenhuma requisição externa — funciona offline.
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { cookies } from 'next/headers';
import { THEME_COOKIE } from '@/lib/session';
import './globals.css';


export const metadata: Metadata = {
  title: { default: 'Minions', template: '%s · Minions' },
  description: 'Plataforma inteligente de conhecimento corporativo',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f8f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0f' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Tema resolvido no servidor (cookie) → sem script inline e sem "flash". Padrão: escuro.
  const theme = (await cookies()).get(THEME_COOKIE)?.value ?? 'dark';
  return (
    <html lang="pt-BR" data-theme={theme === 'dark' || theme === 'light' ? theme : undefined} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
