import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import JSZip from 'jszip';
import { FileRejectedError } from '../errors';

export const SUPPORTED_TYPES = {
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'zip', requiredEntry: 'word/document.xml' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'zip', requiredEntry: 'xl/workbook.xml' },
  csv: { mime: 'text/csv', kind: 'text' },
  txt: { mime: 'text/plain', kind: 'text' },
  md: { mime: 'text/markdown', kind: 'text' },
} as const;
export type SupportedExt = keyof typeof SUPPORTED_TYPES;

export interface ValidatedFile {
  fileName: string;
  ext: SupportedExt;
  mime: string;
  sha256: string;
  size: number;
  /** Sinais não bloqueantes (ex.: links externos, não escaneado) exibidos ao admin. */
  flags: string[];
}

const ZIP_MAX_ENTRIES = 5000;
const ZIP_MAX_UNCOMPRESSED = 250 * 1024 * 1024;
const ZIP_MAX_RATIO = 120;

export function sanitizeFileName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/')).normalize('NFC');
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  if (!clean || clean === '.' || clean === '..') throw new FileRejectedError('Nome de arquivo inválido');
  return clean.slice(-180);
}

/**
 * Validação de segurança do arquivo: extensão permitida, tamanho, assinatura (magic bytes) coerente com a
 * extensão, inspeção de ZIP (zip bomb, macros, path traversal) e PDF (JavaScript/ações automáticas).
 */
export async function validateFile(originalName: string, data: Buffer, maxBytes: number): Promise<ValidatedFile> {
  const fileName = sanitizeFileName(originalName);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!(ext in SUPPORTED_TYPES)) {
    throw new FileRejectedError(`Formato não suportado: .${ext || '?'}. Aceitos: ${Object.keys(SUPPORTED_TYPES).join(', ')}`);
  }
  const type = SUPPORTED_TYPES[ext as SupportedExt];
  if (data.length === 0) throw new FileRejectedError('Arquivo vazio');
  if (data.length > maxBytes) throw new FileRejectedError(`Arquivo excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB`);

  const flags: string[] = [];
  if (type.kind === 'pdf') inspectPdf(data, flags);
  else if (type.kind === 'zip') await inspectOfficeZip(data, 'requiredEntry' in type ? type.requiredEntry : '', flags);
  else inspectText(data);

  return {
    fileName,
    ext: ext as SupportedExt,
    mime: type.mime,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    flags: [...new Set(flags)],
  };
}

function inspectPdf(data: Buffer, flags: string[]) {
  if (data.subarray(0, 1024).indexOf('%PDF-') === -1) throw new FileRejectedError('Conteúdo não corresponde a um PDF');
  const raw = data.toString('latin1');
  if (/\/JavaScript\b|\/JS\s*[(<]/.test(raw)) throw new FileRejectedError('PDF contém JavaScript embutido');
  if (/\/Launch\b/.test(raw)) throw new FileRejectedError('PDF contém ações de execução (/Launch)');
  if (/\/Encrypt\b/.test(raw)) throw new FileRejectedError('PDF protegido por senha não pode ser indexado');
  if (/\/EmbeddedFile\b/.test(raw)) flags.push('pdf_embedded_files');
  if (/\/OpenAction\b|\/AA\b/.test(raw)) flags.push('pdf_auto_actions');
}

async function inspectOfficeZip(data: Buffer, requiredEntry: string, flags: string[]) {
  if (data.readUInt32LE(0) !== 0x04034b50) throw new FileRejectedError('Conteúdo não corresponde a um arquivo Office (ZIP)');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: false });
  } catch {
    throw new FileRejectedError('Arquivo Office corrompido');
  }
  const entries = Object.values(zip.files);
  if (entries.length > ZIP_MAX_ENTRIES) throw new FileRejectedError('Arquivo com número excessivo de entradas');
  let total = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('..') || name.startsWith('/')) throw new FileRejectedError('Arquivo contém caminhos inválidos');
    if (/vbaProject\.bin$|\.bin$/i.test(name) && /vba/i.test(name)) throw new FileRejectedError('Arquivos com macros não são aceitos');
    if (/activeX/i.test(name)) throw new FileRejectedError('Arquivos com controles ActiveX não são aceitos');
    if (/oleObject|embeddings\//i.test(name)) flags.push('office_embedded_objects');
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > ZIP_MAX_UNCOMPRESSED || (total > 10 * 1024 * 1024 && total / data.length > ZIP_MAX_RATIO)) {
    throw new FileRejectedError('Taxa de compressão suspeita (possível zip bomb)');
  }
  if (requiredEntry && !zip.file(requiredEntry)) throw new FileRejectedError('Estrutura do arquivo Office inválida');
  const rels = entries.filter((e) => e.name.endsWith('.rels'));
  for (const rel of rels) {
    const xml = await rel.async('string');
    if (/TargetMode="External"/i.test(xml)) {
      flags.push('office_external_links');
      break;
    }
  }
}

function inspectText(data: Buffer) {
  if (data.includes(0)) throw new FileRejectedError('Arquivo de texto contém bytes binários');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new FileRejectedError('Arquivo de texto precisa estar em UTF-8');
  }
}

// ───────────────────────── Antivírus ─────────────────────────

export interface ScanResult {
  engine: string;
  clean: boolean;
  signature?: string;
}

export interface MalwareScanner {
  scan(data: Buffer): Promise<ScanResult>;
}

/** Sem antivírus (apenas desenvolvimento). O documento recebe a flag `not_scanned`. */
export class NoopScanner implements MalwareScanner {
  async scan(): Promise<ScanResult> {
    return { engine: 'none', clean: true };
  }
}

/** ClamAV via protocolo INSTREAM do clamd. */
export class ClamAvScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('Timeout do antivírus')));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const part = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (d) => chunks.push(typeof d === 'string' ? Buffer.from(d) : d));
      socket.on('error', reject);
      socket.on('close', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/OK$/.test(reply)) resolve({ engine: 'clamav', clean: true });
        else if (/FOUND$/.test(reply)) resolve({ engine: 'clamav', clean: false, signature: reply.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
        else reject(new Error(`Resposta inesperada do antivírus`));
      });
    });
  }
}
