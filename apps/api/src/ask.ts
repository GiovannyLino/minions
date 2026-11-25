/**
 * CLI de desenvolvimento: pergunta ao Minions como um usuário fictício e imprime a resposta + trace.
 * Uso: npm run ask -w @minions/api -- --as engineer "Como preencho a planilha da proposta?"
 */
import { createMinions, loadEnv, toPrincipal } from '@minions/core';

const args = process.argv.slice(2);
const asIdx = args.indexOf('--as');
const who = asIdx >= 0 ? args[asIdx + 1]! : 'collaborator';
const question = args.filter((_, i) => i !== asIdx && i !== asIdx + 1).join(' ');
if (!question) {
  console.error('Informe a pergunta.');
  process.exit(1);
}

const minions = await createMinions(loadEnv());
const users = await minions.users.listDevUsers();
const user = users.find((u) => u.email.startsWith(who) || u.role === who || u.name.toLowerCase().includes(who.toLowerCase()));
if (!user) throw new Error(`Usuário fictício não encontrado: ${who}`);
const principal = toPrincipal(user);
const conv = await minions.conversations.create(principal, question);
const { answer, trace } = await minions.orchestrator.ask({ principal, question, conversationId: conv.id });

console.log(`\n👤 ${user.name} (${user.role}) — ${question}\n`);
for (const t of trace) console.log(`  · [${t.type}${t.agent ? `:${t.agent}` : ''}] ${t.message}`);
console.log(`\n[${answer.status} | ${answer.mode} | ${answer.durationMs} ms]\n${answer.summary}\n`);
answer.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} — ${s.detail} [${s.citations.join(',')}]`));
answer.conflicts.forEach((c) => console.log(`  ⚠ ${c.description}`));
answer.sources.forEach((s) => console.log(`  📄 ${s.ref} ${s.title} v${s.version}${s.page ? ` p.${s.page}` : ''}${s.section ? ` §${s.section}` : ''}`));
answer.people.forEach((p) => console.log(`  🙋 ${p.name} — ${p.reason}${p.email ? ` <${p.email}>` : ''}`));
answer.proposals.forEach((p) => console.log(`  📁 ${p.code} ${p.name} (${p.status})`));
answer.suggestions.forEach((s) => console.log(`  💡 ${s}`));
await minions.close();
