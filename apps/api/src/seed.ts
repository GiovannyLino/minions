/**
 * Carga de dados FICTÍCIOS para desenvolvimento e demonstração.
 * Empresa "Exemplo S.A." e todas as pessoas, propostas e documentos são inventados.
 * Uso: npm run seed            (não sobrescreve uma base existente)
 *      npm run seed -- --force (apaga a base local PGlite e recria)
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { assertDatabaseFree, createMinions, loadEnv, type Minions, type Principal } from '@minions/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = path.join(ROOT, 'seed', 'documents');

export const SEED_USERS = [
  { key: 'admin', name: 'Ana Ribeiro', email: 'ana.ribeiro@exemplo.test', role: 'admin', area: 'TI', groups: ['ti'] },
  { key: 'manager', name: 'Marcos Lima', email: 'marcos.lima@exemplo.test', role: 'manager', area: 'Comercial', groups: ['comercial'] },
  { key: 'engineer', name: 'Carla Souza', email: 'carla.souza@exemplo.test', role: 'collaborator', area: 'Engenharia', groups: ['engenharia'], clearance: 'restricted' },
  { key: 'collaborator', name: 'Diego Martins', email: 'diego.martins@exemplo.test', role: 'collaborator', area: 'Financeiro', groups: ['financeiro'] },
] as const;

const CATEGORIES = [
  ['Política', 'Políticas e normas corporativas'],
  ['Procedimento', 'Procedimentos operacionais passo a passo'],
  ['Manual', 'Manuais e guias de uso'],
  ['Modelo', 'Modelos, templates e planilhas'],
  ['Formulário', 'Formulários internos'],
  ['Sistema', 'Documentação de sistemas corporativos'],
  ['Proposta', 'Documentos de propostas e projetos'],
  ['Institucional', 'Glossário, comunicados e informações gerais'],
  ['Jurídico', 'Contratos e pareceres'],
  ['Tabela', 'Tabelas de referência'],
] as const;

const PEOPLE = [
  { key: 'marcos', name: 'Marcos Lima', email: 'marcos.lima@exemplo.test', jobTitle: 'Gerente Comercial', area: 'Comercial', expertise: ['propostas técnicas', 'precificação', 'modelo PT-03'], responsibilities: ['Aprovação de propostas comerciais', 'Manutenção do modelo PT-03 de proposta técnica'], user: 'manager' },
  { key: 'carla', name: 'Carla Souza', email: 'carla.souza@exemplo.test', jobTitle: 'Engenheira de Projetos', area: 'Engenharia', expertise: ['subestações', 'RDO', 'relatório diário de obra', 'revisão técnica de propostas'], responsibilities: ['Revisão técnica de propostas', 'Procedimento RDO'], user: 'engineer' },
  { key: 'paula', name: 'Paula Mendes', email: 'paula.mendes@exemplo.test', jobTitle: 'Analista de Suprimentos', area: 'Suprimentos', expertise: ['compras', 'cotação', 'portal de suprimentos'], responsibilities: ['Solicitações de compras (SC-01)', 'Cadastro de fornecedores'] },
  { key: 'rafael', name: 'Rafael Costa', email: 'rafael.costa@exemplo.test', jobTitle: 'Analista Financeiro', area: 'Financeiro', expertise: ['reembolso de despesas', 'centros de custo'], responsibilities: ['Política de reembolso de despesas', 'Tabela de centros de custo'] },
  { key: 'juliana', name: 'Juliana Alves', email: 'juliana.alves@exemplo.test', jobTitle: 'Coordenadora de Segurança da Informação', area: 'TI', expertise: ['segurança da informação', 'portal do colaborador', 'acessos'], responsibilities: ['Gestão de acessos', 'Portal do Colaborador'] },
  { key: 'bruno', name: 'Bruno Teixeira', email: 'bruno.teixeira@exemplo.test', jobTitle: 'Advogado', area: 'Jurídico', expertise: ['contratos', 'penalidades contratuais'], responsibilities: ['Contratos-quadro de clientes'], contactVisible: false },
] as const;

type DocSeed = { file: string; title: string; description: string; category: string; area: string; classification: 'public' | 'internal' | 'restricted' | 'confidential'; allowedGroups?: string[]; subjectKey?: string; proposal?: string };

const DOCUMENTS: DocSeed[] = [
  { file: 'glossario-corporativo.md', title: 'Glossário Corporativo', description: 'Definições de siglas e termos internos', category: 'Institucional', area: 'TI', classification: 'public' },
  { file: 'politica-reembolso-2024.md', title: 'Política de Reembolso de Despesas (2024)', description: 'Edição 2024 da política de reembolso', category: 'Política', area: 'Financeiro', classification: 'internal', subjectKey: 'politica-reembolso' },
  { file: 'politica-reembolso-2025.md', title: 'Política de Reembolso de Despesas (2025)', description: 'Edição 2025 da política de reembolso', category: 'Política', area: 'Financeiro', classification: 'internal', subjectKey: 'politica-reembolso' },
  { file: 'procedimento-sc01-compras.md', title: 'Procedimento SC-01 — Solicitação de Compras', description: 'Como abrir uma solicitação de compras', category: 'Procedimento', area: 'Suprimentos', classification: 'internal' },
  { file: 'procedimento-rdo.md', title: 'Procedimento RDO — Relatório Diário de Obra', description: 'Preenchimento do RDO', category: 'Procedimento', area: 'Engenharia', classification: 'internal' },
  { file: 'manual-propostas-tecnicas.md', title: 'Manual de Elaboração de Propostas Técnicas', description: 'Qual modelo usar e como preencher a PT-03', category: 'Manual', area: 'Comercial', classification: 'restricted', allowedGroups: ['comercial', 'engenharia'] },
  { file: 'modelo-pt-03.xlsx', title: 'Modelo PT-03 — Planilha de Proposta Técnica', description: 'Planilha oficial de proposta técnica', category: 'Modelo', area: 'Comercial', classification: 'restricted', allowedGroups: ['comercial', 'engenharia'] },
  { file: 'memorial-prp-2025-014.txt', title: 'Memorial Descritivo — PRP-2025-014', description: 'Escopo detalhado da proposta PRP-2025-014', category: 'Proposta', area: 'Comercial', classification: 'restricted', allowedGroups: ['comercial', 'engenharia'], proposal: 'PRP-2025-014' },
  { file: 'centros-de-custo.csv', title: 'Tabela de Centros de Custo', description: 'Códigos de centros de custo por área', category: 'Tabela', area: 'Financeiro', classification: 'internal' },
  { file: 'comunicado-teste-conteudo-suspeito.md', title: 'Comunicado — Manutenção do Portal do Colaborador', description: 'Documento de teste com prompt injection simulado', category: 'Institucional', area: 'TI', classification: 'internal' },
  { file: 'contrato-quadro-cliente-alfa.md', title: 'Contrato-quadro — Cliente Fictício Alfa', description: 'Contrato confidencial (teste de isolamento)', category: 'Jurídico', area: 'Jurídico', classification: 'confidential', allowedGroups: ['juridico'] },
];

async function buildPt03Template(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Minions (dados fictícios)';
  const geral = wb.addWorksheet('Dados Gerais');
  geral.addRow(['Campo', 'Valor', 'Obrigatório', 'Orientação']);
  const rows: [string, string, string][] = [
    ['Código da proposta', 'Sim', 'Formato PRP-AAAA-NNN, fornecido pela área Comercial'],
    ['Cliente', 'Sim', 'Razão social conforme cadastro de clientes'],
    ['Responsável comercial', 'Sim', 'Nome do gestor comercial da proposta'],
    ['Data limite de envio', 'Sim', 'Data acordada com o cliente (dd/mm/aaaa)'],
    ['Revisão técnica', 'Não', 'Obrigatória para propostas acima de R$ 1 milhão'],
  ];
  for (const [campo, obrig, orient] of rows) geral.addRow([campo, '', obrig, orient]);
  geral.getCell('A2').note = 'Use o código gerado pela área Comercial; não reutilize códigos de propostas anteriores.';
  const escopo = wb.addWorksheet('Escopo Técnico');
  escopo.addRow(['Item', 'Descrição da entrega', 'Unidade', 'Quantidade']);
  escopo.addRow(['1', 'Exemplo: fornecimento de transformador', 'un', '2']);
  const preco = wb.addWorksheet('Precificação');
  preco.addRow(['Item', 'Custo direto', 'BDI (%)', 'Preço final']);
  preco.getCell('A1').note = 'Aba preenchida exclusivamente pela área Comercial. Não altere as fórmulas.';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function seed(minions: Minions, opts: { log?: (msg: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  const users = new Map<string, Principal>();
  for (const u of SEED_USERS) {
    const created = await minions.users.upsert({ externalId: `dev:${u.key}`, email: u.email, name: u.name, role: u.role, area: u.area, groups: [...u.groups], ...('clearance' in u ? { clearance: u.clearance } : {}) });
    users.set(u.key, { id: created.id, email: created.email, name: created.name, role: created.role, area: created.area, groups: created.groups, clearance: created.clearance });
  }
  const admin = users.get('admin')!;
  log(`${users.size} usuários fictícios`);

  for (const [name, description] of CATEGORIES) {
    await minions.db.query('insert into categories (id, name, description) values ($1, $2, $3) on conflict (name) do nothing', [randomUUID(), name, description]);
  }

  const personIds = new Map<string, string>();
  for (const p of PEOPLE) {
    const person = await minions.people.create(admin, {
      name: p.name,
      email: p.email,
      jobTitle: p.jobTitle,
      area: p.area,
      expertise: [...p.expertise],
      responsibilities: [...p.responsibilities],
      contactVisible: !('contactVisible' in p) || p.contactVisible !== false,
      userId: 'user' in p ? users.get(p.user)!.id : null,
    });
    personIds.set(p.key, person.id);
  }
  log(`${personIds.size} pessoas`);

  const proposals = new Map<string, string>();
  const proposalSeeds = [
    {
      code: 'PRP-2025-014', name: 'Modernização da Subestação Norte', client: 'Cliente Fictício Alfa', status: 'in_review', area: 'Comercial', classification: 'restricted',
      description: 'Modernização de subestação com troca de transformadores e sistema de proteção.',
      scope: 'Substituição de dois transformadores de potência, modernização do sistema de proteção e controle e comissionamento da subestação. Obras civis e licenciamento ambiental excluídos.',
      ownerPersonId: personIds.get('marcos')!, memberPersonIds: [personIds.get('carla')!], dueDate: '2026-12-15',
      deliverables: ['Projeto executivo', 'Fornecimento e montagem dos transformadores', 'Relatório de comissionamento'],
    },
    {
      code: 'PRP-2025-021', name: 'Sistema de Monitoramento de Ativos', client: 'Cliente Fictício Beta', status: 'draft', area: 'Engenharia', classification: 'internal',
      description: 'Plataforma de monitoramento remoto de ativos elétricos.', scope: '', ownerPersonId: personIds.get('carla')!, memberPersonIds: [], dueDate: '2027-02-28',
      deliverables: ['Estudo de viabilidade'],
    },
    {
      code: 'PRP-2024-008', name: 'Consultoria de Eficiência Energética', client: 'Cliente Fictício Gama', status: 'won', area: 'Comercial', classification: 'confidential',
      description: 'Diagnóstico energético de três plantas industriais.', scope: 'Diagnóstico energético e plano de ação para três plantas.', ownerPersonId: personIds.get('marcos')!, memberPersonIds: [], dueDate: null,
      deliverables: ['Relatório de diagnóstico', 'Plano de ação'],
    },
  ];
  for (const ps of proposalSeeds) proposals.set(ps.code, (await minions.proposals.create(admin, ps)).id);
  log(`${proposals.size} propostas`);

  const pt03 = await buildPt03Template();
  for (const d of DOCUMENTS) {
    const data = d.file === 'modelo-pt-03.xlsx' ? pt03 : await readFile(path.join(DOCS, d.file));
    await minions.documents.upload(admin, {
      fileName: d.file,
      data,
      metadata: {
        title: d.title,
        description: d.description,
        category: d.category,
        area: d.area,
        classification: d.classification,
        allowedGroups: d.allowedGroups ?? [],
        subjectKey: d.subjectKey,
        proposalId: d.proposal ? proposals.get(d.proposal) : undefined,
      },
    });
  }
  const processed = await minions.documents.drainQueue();
  log(`${DOCUMENTS.length} documentos enviados, ${processed} processados`);
  return { users, personIds, proposals };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const env = loadEnv();
  // Produção só aceita a carga fictícia na demonstração (DEMO_ACCESS_CODE e ALLOW_REAL_DATA=false, validados no env).
  if (env.ALLOW_REAL_DATA || (env.NODE_ENV === 'production' && !env.DEMO_ACCESS_CODE)) {
    console.error('Seed bloqueado: este ambiente está marcado para dados reais/produção.');
    process.exit(1);
  }
  if (process.argv.includes('--force') && !env.DATABASE_URL) {
    try {
      await assertDatabaseFree(path.resolve(env.DATA_DIR, 'pglite'));
    } catch (err) {
      console.error(`
[minions] ${(err as Error).message}
`);
      process.exit(1);
    }
    await rm(path.resolve(env.DATA_DIR), { recursive: true, force: true });
  }
  const minions = await createMinions(env);
  const existing = await minions.db.one<{ n: number }>('select count(*)::int as n from users');
  if (existing && existing.n > 0) {
    console.log('Base já possui dados. Use `npm run seed -- --force` para recriar a base local.');
  } else {
    await seed(minions, { log: (m) => console.log(`• ${m}`) });
    console.log('Seed concluído (dados fictícios).');
    const backup = await minions.db.backup?.();
    if (backup) console.log(`• Backup inicial: ${path.basename(backup)}`);
  }
  await minions.close();
}
