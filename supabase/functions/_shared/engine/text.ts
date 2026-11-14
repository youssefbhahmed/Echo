// Text utilities + projection of free text into the concept space.
import { CONCEPTS } from './concepts.ts';
import type { ConceptVector } from '../types.ts';

const STOPWORDS = new Set(
  ('a an the and or but if of to in on at by for with about against between into through during before after above below from up down out over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very can will just should now i me my myself we our you your he him his she her it its they them their what which who whom this that these those am is are was were be been being have has had having do does did doing would could ought im youre ive id lets something anything thing things want need like feel feeling make makes give gives really also maybe please recommend recommendation recommendations find show me some kind sort type stuff get got').split(/\s+/),
);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9\s'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .map((t) => t.replace(/^['\-]+|['\-]+$/g, ''))
    .filter(Boolean);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface CompiledTerm {
  conceptId: string;
  weight: number;
  kind: 'prefix' | 'exact' | 'phrase';
  value: string;
  re?: RegExp;
}

let compiled: CompiledTerm[] | null = null;

function compile(): CompiledTerm[] {
  if (compiled) return compiled;
  const out: CompiledTerm[] = [];
  for (const c of CONCEPTS) {
    for (const raw of c.terms) {
      let term = raw;
      let weight = 1;
      const m = /^(.*):([0-9.]+)$/.exec(term);
      if (m) {
        term = m[1];
        weight = Number(m[2]);
      }
      if (term.startsWith('=')) {
        out.push({ conceptId: c.id, weight, kind: 'exact', value: normalize(term.slice(1)) });
      } else if (/[\s\-]/.test(term)) {
        const v = normalize(term);
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out.push({ conceptId: c.id, weight, kind: 'phrase', value: v, re: new RegExp(`(^|\\s)${escaped}(\\s|$)`) });
      } else {
        const v = normalize(term);
        out.push({ conceptId: c.id, weight, kind: v.length >= 5 ? 'prefix' : 'exact', value: v });
      }
    }
  }
  compiled = out;
  return out;
}

/** Count raw concept hits in a text. */
export function conceptHits(text: string): Record<string, number> {
  const norm = normalize(text);
  if (!norm) return {};
  const tokens = norm.split(' ');
  const tokenSet = new Set(tokens);
  const hits: Record<string, number> = {};
  for (const t of compile()) {
    let n = 0;
    if (t.kind === 'exact') {
      if (tokenSet.has(t.value)) n = tokens.filter((x) => x === t.value).length;
    } else if (t.kind === 'prefix') {
      for (const tok of tokens) if (tok.startsWith(t.value)) n++;
    } else if (t.re && t.re.test(norm)) {
      n = 1;
    }
    if (n > 0) hits[t.conceptId] = (hits[t.conceptId] ?? 0) + n * t.weight;
  }
  return hits;
}

export interface TextField {
  text: string | undefined | null;
  weight: number;
}

/**
 * Project weighted text fields into the concept space.
 * Saturating: repeated mentions add confidence with diminishing returns (0..1 per concept).
 */
export function projectText(fields: TextField[]): ConceptVector {
  const acc: Record<string, number> = {};
  for (const f of fields) {
    if (!f.text) continue;
    const hits = conceptHits(f.text);
    for (const [k, v] of Object.entries(hits)) acc[k] = (acc[k] ?? 0) + v * f.weight;
  }
  const out: ConceptVector = {};
  for (const [k, v] of Object.entries(acc)) {
    const s = 1 - Math.exp(-0.75 * v);
    if (s >= 0.05) out[k] = round(s);
  }
  return out;
}

// ───────────── vector math on sparse vectors ─────────────

export function round(x: number, d = 4): number {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

export function dot(a: ConceptVector, b: ConceptVector): number {
  let s = 0;
  const [small, big] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const k in small) if (k in big) s += small[k] * big[k];
  return s;
}

export function norm(a: ConceptVector): number {
  let s = 0;
  for (const k in a) s += a[k] * a[k];
  return Math.sqrt(s);
}

export function cosine(a: ConceptVector, b: ConceptVector): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export function addScaled(target: ConceptVector, src: ConceptVector, scale: number): ConceptVector {
  for (const k in src) target[k] = (target[k] ?? 0) + src[k] * scale;
  return target;
}

export function positivePart(a: ConceptVector): ConceptVector {
  const out: ConceptVector = {};
  for (const k in a) if (a[k] > 0) out[k] = a[k];
  return out;
}

export function negativePart(a: ConceptVector): ConceptVector {
  const out: ConceptVector = {};
  for (const k in a) if (a[k] < 0) out[k] = -a[k];
  return out;
}

export function topKeys(a: Record<string, number>, n: number, min = 0): string[] {
  return Object.entries(a)
    .filter(([, v]) => v > min)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k]) => k);
}

export function denseCosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return d / Math.sqrt(na * nb);
}

export function normKey(s: string): string {
  return normalize(s).replace(/\s+/g, ' ').trim();
}
