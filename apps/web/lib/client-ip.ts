/**
 * IP do cliente para rate limit e auditoria.
 * Na Vercel, `x-real-ip` / `x-forwarded-for` são reescritos pela própria Vercel (não falsificáveis).
 * Headers de outros proxies (ex.: `cf-connecting-ip`) são ignorados: qualquer cliente poderia enviá-los.
 */
export function clientIpFrom(h: Headers): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  return (first(h.get('x-real-ip')) ?? first(h.get('x-forwarded-for')) ?? '127.0.0.1').slice(0, 64);
}
