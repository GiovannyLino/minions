/**
 * Checagem antes de iniciar (`npm run dev` / `npm run share`): portas livres e banco local sem outra instância.
 * Evita os erros EADDRINUSE e, principalmente, dois processos abrindo o mesmo banco (o que o corrompe).
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDatabaseFree } from '@minions/core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function preflight(ports = [3000, 4000]): Promise<string[]> {
  const problems: string[] = [];
  for (const port of ports) {
    if (await portInUse(port)) problems.push(`A porta ${port} já está em uso — provavelmente outro "npm run dev" ou "npm run share" ainda está aberto.`);
  }
  const dataDir = path.resolve(ROOT, 'apps/api', process.env.DATA_DIR ?? '.data', 'pglite');
  try {
    await assertDatabaseFree(dataDir);
  } catch (err) {
    problems.push((err as Error).message);
  }
  return problems;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('dev/preflight.ts');
if (isMain) {
  const problems = await preflight();
  if (problems.length) {
    console.error(`\n[minions] Não é possível iniciar:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n  Feche a outra instância (Ctrl+C no terminal dela) e tente de novo.\n`);
    process.exit(1);
  }
}
