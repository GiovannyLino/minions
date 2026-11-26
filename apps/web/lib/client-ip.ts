/**
 * IP do cliente a partir dos headers do proxy de borda em que o web está publicado.
 * - Vercel: `x-real-ip` / `x-forwarded-for` são reescritos pela própria Vercel (não falsificáveis).
 *   `cf-connecting-ip` é IGNORADO aqui — qualquer cliente poderia enviá-lo e burlar o rate limit.
 * - Cloudflare Tunnel (npm run share): `cf-connecting-ip` é definido pela Cloudflare.
 */
export function clientIpFrom(h: Headers): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  const ip = process.env.VERCEL
    ? (first(h.get('x-real-ip')) ?? first(h.get('x-forwarded-for')))
    : (first(h.get('cf-connecting-ip')) ?? first(h.get('x-forwarded-for')));
  return (ip ?? '127.0.0.1').slice(0, 64);
}
