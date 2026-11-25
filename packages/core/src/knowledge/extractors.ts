import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import { extractText, getDocumentProxy } from 'unpdf';
import type { SupportedExt } from './fileSecurity';
import { normalizeText } from './text';

export interface ExtractedSection {
  text: string;
  page: number | null;
  section: string | null;
}

export interface ExtractedContent {
  sections: ExtractedSection[];
  pageCount: number | null;
}

const MAX_TABLE_ROWS = 5000;

/** Extrai texto preservando página (PDF), seção (títulos) e aba (planilhas) para citações precisas. */
export async function extractContent(ext: SupportedExt, data: Buffer): Promise<ExtractedContent> {
  switch (ext) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'xlsx':
      return extractXlsx(data);
    case 'csv':
      return extractCsv(data.toString('utf8'));
    case 'md':
    case 'txt':
      return extractMarkdown(data.toString('utf8'));
  }
}

async function extractPdf(data: Buffer): Promise<ExtractedContent> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return {
    pageCount: totalPages,
    sections: pages.map((t, i) => ({ text: normalizeText(t), page: i + 1, section: null })).filter((s) => s.text.length > 0),
  };
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

async function extractDocx(data: Buffer): Promise<ExtractedContent> {
  const { value: html } = await mammoth.convertToHtml({ buffer: data });
  // Divide por títulos para manter a seção de origem de cada trecho.
  const parts = html.split(/(?=<h[1-6][^>]*>)/i);
  const sections: ExtractedSection[] = [];
  for (const part of parts) {
    const heading = /^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(part);
    const headingText = heading ? decodeEntities(heading[1]!.replace(/<[^>]+>/g, '')).trim() : null;
    const body = decodeEntities(
      part
        .replace(/^<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i, '')
        .replace(/<\/(p|li|tr|h[1-6])>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/t[dh]>/gi, ' | ')
        .replace(/<[^>]+>/g, ''),
    );
    const text = normalizeText(body);
    if (text) sections.push({ text, page: null, section: headingText });
  }
  return { sections, pageCount: null };
}

function rowsToText(header: string[], rows: unknown[][]): string {
  return rows
    .slice(0, MAX_TABLE_ROWS)
    .map((r) =>
      r
        .map((v, i) => {
          const val = v == null ? '' : String(v).trim();
          return val ? `${header[i] || `Coluna ${i + 1}`}: ${val}` : '';
        })
        .filter(Boolean)
        .join(' | '),
    )
    .filter(Boolean)
    .join('\n');
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return v.result ?? null;
    if ('formula' in v) return null;
    return null;
  }
  return v;
}

async function extractXlsx(data: Buffer): Promise<ExtractedContent> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sections: ExtractedSection[] = [];
  wb.eachSheet((sheet) => {
    const rows: unknown[][] = [];
    const notes: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cellValue(cell.value);
        const note = cell.note;
        if (note) {
          const noteText = typeof note === 'string' ? note : (note.texts ?? []).map((t) => t.text).join('');
          if (noteText.trim()) notes.push(`Nota em ${cell.address}: ${noteText.trim()}`);
        }
      });
      rows.push(values);
    });
    if (rows.length === 0) return;
    const header = (rows[0] ?? []).map((h) => (h == null ? '' : String(h).trim()));
    const body = rowsToText(header, rows.slice(1));
    const intro = `Planilha "${sheet.name}" — colunas: ${header.filter(Boolean).join(', ')}`;
    const text = normalizeText([intro, body, ...notes].filter(Boolean).join('\n'));
    if (text) sections.push({ text, page: null, section: `Aba: ${sheet.name}` });
  });
  return { sections, pageCount: null };
}

function extractCsv(raw: string): ExtractedContent {
  const parsed = Papa.parse<string[]>(raw.replace(/^﻿/, ''), { skipEmptyLines: true });
  const rows = parsed.data;
  if (rows.length === 0) return { sections: [], pageCount: null };
  const header = (rows[0] ?? []).map((h) => h.trim());
  const text = normalizeText(`Tabela — colunas: ${header.join(', ')}\n${rowsToText(header, rows.slice(1))}`);
  return { sections: text ? [{ text, page: null, section: null }] : [], pageCount: null };
}

function extractMarkdown(raw: string): ExtractedContent {
  const sections: ExtractedSection[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const text = normalizeText(buf.join('\n'));
    if (text) sections.push({ text, page: null, section: current });
    buf = [];
  };
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      current = h[2]!.trim();
    } else buf.push(line);
  }
  flush();
  return { sections, pageCount: null };
}
