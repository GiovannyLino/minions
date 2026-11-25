import type { DocumentStatus } from '@minions/core/contracts';
import { Badge } from '../ui';

const MAP: Record<DocumentStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  pending: { label: 'Na fila', tone: 'neutral' },
  processing: { label: 'Indexando', tone: 'accent' },
  ready: { label: 'Indexado', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
  archived: { label: 'Arquivado', tone: 'neutral' },
};

export function DocStatusBadge({ status }: { status: DocumentStatus }) {
  const s = MAP[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export const FLAG_LABEL: Record<string, string> = {
  not_scanned: 'Não verificado por antivírus',
  suspicious_content: 'Conteúdo suspeito (possível prompt injection)',
  office_external_links: 'Contém links externos',
  office_embedded_objects: 'Contém objetos incorporados',
  pdf_embedded_files: 'PDF com arquivos anexos',
  pdf_auto_actions: 'PDF com ações automáticas',
};
