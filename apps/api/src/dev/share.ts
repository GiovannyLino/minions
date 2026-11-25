/**
 * `npm run share` — publica o Minions do seu computador para outras pessoas, sem custo:
 *   1. confere portas e banco (nenhuma outra instância aberta);
 *   2. compila o web em modo produção;
 *   3. sobe a API (Ollama local) e o web e ESPERA ambos responderem;
 *   4. só então abre o Cloudflare Tunnel (link HTTPS público *.trycloudflare.com, sem conta);
 *   5. exige um código de acesso antes de qualquer página.
 * Só a porta 3000 (web/BFF) é exposta. API (4000), Ollama (11434) e banco continuam apenas locais.
 * Encerrar: Ctrl+C (a API faz backup do banco e libera a trava antes de sair).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, preflight } from './preflight';

const args = new Set(process.argv.slice(2));
const node = process.execPath;
const bin = (rel: string) => path.join(ROOT, 'node_modules', rel);

function findCloudflared(): string {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? 'cloudflared';
}

/** Código legível (ex.: "nuvem-farol-7342"), novo a cada execução se DEMO_ACCESS_CODE não estiver definido. */
function generateCode(): string {
  const words = ['aurora', 'farol', 'nuvem', 'cometa', 'orbita', 'prisma', 'vetor', 'lince', 'trilha', 'mosaico', 'pixel', 'radar', 'quartzo', 'delta', 'bussola', 'jade'];
  return `${words[randomInt(words.length)]}-${words[randomInt(words.length)]}-${randomInt(1000, 10000)}`;
}

async function waitFor(url: string, child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} encerrou durante a inicialização (código ${child.exitCode}). Veja as mensagens acima.`);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`${label} não respondeu em ${Math.round(timeoutMs / 1000)} s.`);
}

const children: ChildProcess[] = [];
let stopping = false;

/** Encerramento: espera a saída limpa (o Ctrl+C chega a todos os processos do console); força só se travar. */
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n[share] Encerrando… (aguardando a API salvar o banco)');
  const alive = () => children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (process.platform !== 'win32') for (const c of alive()) c.kill('SIGINT');
  const deadline = Date.now() + 12_000;
  while (alive().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  for (const c of alive()) {
    if (process.platform === 'win32' && c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGKILL');
  }
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

const problems = await preflight();
if (problems.length) {
  console.error(`\n[share] Não é possível publicar agora:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n  Feche a outra instância (Ctrl+C no terminal dela) e rode "npm run share" de novo.\n`);
  process.exit(1);
}

const code = process.env.DEMO_ACCESS_CODE?.trim() || generateCode();
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', FORCE_COLOR: '1' };

if (!args.has('--skip-build')) {
  console.log('[share] Compilando o web em modo produção…');
  const build = spawnSync(node, [bin('next/dist/bin/next'), 'build'], { cwd: path.join(ROOT, 'apps/web'), stdio: 'inherit', env });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

console.log('[share] Iniciando API e web…');
const api = spawn(node, [bin('tsx/dist/cli.mjs'), '--env-file-if-exists=../../.env', 'src/server.ts'], {
  cwd: path.join(ROOT, 'apps/api'),
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...env, TRUST_PROXY: 'true', EMBEDDED_WORKER: 'true' },
});
const web = spawn(node, [bin('next/dist/bin/next'), 'start', '-p', '3000'], {
  cwd: path.join(ROOT, 'apps/web'),
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...env, DEMO_ACCESS_CODE: code, SESSION_COOKIE_SECURE: 'true' },
});
children.push(api, web);
for (const [child, label] of [[api, 'A API'], [web, 'O web']] as const) {
  child.on('exit', (c) => {
    if (!stopping) {
      console.error(`\n[share] ${label} parou (código ${c}). Encerrando a publicação.`);
      void stop(1);
    }
  });
}

try {
  await waitFor('http://127.0.0.1:4000/health', api, 'A API', 120_000);
  await waitFor('http://127.0.0.1:3000/acesso', web, 'O web', 60_000);
} catch (err) {
  console.error(`\n[share] ${(err as Error).message}`);
  await stop(1);
}

console.log('[share] API e web prontos. Abrindo o túnel público…');
const tunnel = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', 'http://localhost:3000'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
let announced = false;
const watch = (chunk: Buffer) => {
  const text = chunk.toString();
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
  if (url && !announced) {
    announced = true;
    const line = '─'.repeat(66);
    console.log(`\n${line}\n  Minions publicado (demonstração, dados fictícios)\n\n  Link:   ${url}\n  Código: ${code}\n\n  Envie o link e o código só para quem deve testar.\n  Pode levar ~30 s até o link responder na primeira vez.\n  Para encerrar: Ctrl+C (o link deixa de funcionar).\n${line}\n`);
  }
  if (args.has('--verbose')) process.stderr.write(text);
};
tunnel.stdout?.on('data', watch);
tunnel.stderr?.on('data', watch);
tunnel.on('exit', (c) => {
  if (stopping) return;
  console.error(`\n[share] O túnel encerrou (código ${c}). Verifique a instalação: winget install Cloudflare.cloudflared`);
  void stop(1);
});
