import { Fragment, type ReactNode } from 'react';

/**
 * Renderizador mínimo e seguro (sem HTML): parágrafos, **negrito** e citações [S1].
 * O texto vem de documentos e do modelo — nunca é interpretado como HTML.
 */
export function RichText({ text, onCite, className }: { text: string; onCite?: (ref: string) => void; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i} className="mb-3 last:mb-0">
          {inline(p, onCite)}
        </p>
      ))}
    </div>
  );
}

export function inline(text: string, onCite?: (ref: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[(S\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{withBreaks(text.slice(last, m.index))}</Fragment>);
    if (m[1]) out.push(<strong key={k++} className="font-semibold text-fg">{m[1]}</strong>);
    else if (m[2]) {
      const ref = m[2];
      out.push(
        <button key={k++} type="button" className="cite" onClick={() => onCite?.(ref)} aria-label={`Ver fonte ${ref}`}>
          {ref.slice(1)}
        </button>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{withBreaks(text.slice(last))}</Fragment>);
  return out;
}

function withBreaks(s: string): ReactNode[] {
  return s.split('\n').flatMap((line, i) => (i === 0 ? [line] : [<br key={`br${i}`} />, line]));
}
