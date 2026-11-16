// The transparent ECHO recommendation pipeline:
//   1 intent → 2 retrieval → 3 enrichment → 4 semantic analysis → 5 personal ranking
//   → 6 diversity → 7 explanation   (8 feedback happens in profile.ts via the feedback endpoint)
// Pure orchestration: all I/O is injected so it runs in Deno, Node and tests alike.
import type { AnalyzedItem, Category, ContentItem, DiscoverRequest, DiscoverResponse, Intent, ProviderId, TasteProfile } from '../types.ts';
import { PROVIDERS, providersFor } from '../providers/index.ts';
import { ProviderError, type HttpClient } from '../providers/http.ts';
import type { Env, Provider } from '../providers/types.ts';
import { aiConfig, llmEnrichIntent, llmMusicPicks, mergeHint, sanitizeHint } from './ai.ts';
import { verifySpotifyPicks } from '../providers/spotify.ts';
import { musicBrief, topStyles } from '../importer.ts';
import { familyMix, mixBrief } from './music.ts';
import { hashKey } from '../providers/http.ts';
import { analyzeItem } from './analyze.ts';
import { conceptLabel, CONCEPT_BY_ID } from './concepts.ts';
import { parseIntent, refineIntent } from './intent.ts';
import { rankCandidates, type EvidenceItem, type ReferenceInfo } from './rank.ts';
import { feedConcepts, planRetrieval, targetCategories } from './retrieve.ts';
import { positivePart, topKeys } from './text.ts';

export interface PipelineDeps {
  env: Env;
  http: HttpClient;
  profile: TasteProfile;
  excludeIds?: Set<string>;
  evidence?: EvidenceItem[];
  previousIntent?: Intent | null;
  previousResults?: AnalyzedItem[];
  /** Providers temporarily blocked (e.g. quota exhausted today). */
  blockedProviders?: Set<ProviderId>;
  collaborative?: (ids: string[]) => Promise<Map<string, number>>;
  /** Optional text embedder (Supabase gte-small). */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Previously stored embeddings by item id. */
  storedEmbeddings?: (ids: string[]) => Promise<Map<string, number[]>>;
  useLlm?: boolean;
  seed?: number;
  now?: Date;
}

export interface PipelineResult extends DiscoverResponse {
  candidates: AnalyzedItem[];
  quotaErrors: ProviderId[];
}

const CATEGORY_NOUN: Record<Category, string> = { youtube: 'videos', music: 'music', screen: 'films & series', books: 'books', podcasts: 'podcasts' };

function timer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

function canEmbed(item: ContentItem): boolean {
  // Spotify Developer Policy: Spotify Content must not be ingested into ML/AI models.
  return item.provider !== 'spotify';
}

export function embeddingText(item: ContentItem): string {
  return [item.title, item.genres.join(', '), item.tags.slice(0, 12).join(', '), (item.description ?? '').slice(0, 400)].filter(Boolean).join('. ');
}

async function resolveReferences(intent: Intent, deps: PipelineDeps, statuses: Map<ProviderId, DiscoverResponse['providers'][number]>) {
  const refs: ReferenceInfo[] = [];
  const refItems: AnalyzedItem[] = [];
  const similar: AnalyzedItem[] = [];
  const similarMap = new Map<string, string>();
  const order: Category[] = intent.categories.length && !intent.categories.includes('screen') ? [...intent.categories, 'screen', 'books'] : ['screen', 'books', 'music', 'podcasts'];
  for (const title of intent.references) {
    let resolved: ContentItem | null = null;
    let via: Provider | null = null;
    for (const cat of [...new Set(order)]) {
      for (const p of providersFor(cat, deps.env)) {
        if (!p.resolve || deps.blockedProviders?.has(p.id)) continue;
        try {
          resolved = await p.resolve(title, { http: deps.http, env: deps.env }, cat);
          if (resolved) {
            via = p;
            break;
          }
        } catch (e) {
          if (e instanceof ProviderError) statuses.set(p.id, { id: p.id, status: e.kind === 'quota' ? 'quota' : 'error', message: e.message.slice(0, 160) });
        }
      }
      if (resolved) break;
    }
    if (!resolved || !via) continue;
    const a = analyzeItem(resolved);
    refItems.push(a);
    refs.push({ title: a.title, concepts: a.concepts, provider: via.id });
    if (via.similar) {
      try {
        for (const s of await via.similar(resolved, { http: deps.http, env: deps.env })) {
          const sa = analyzeItem(s);
          similar.push(sa);
          similarMap.set(sa.id, a.title);
        }
      } catch {
        /* similar is best-effort */
      }
    }
  }
  // Ordinal references to earlier results ("more like the second one")
  for (const idx of intent.ordinalRefs) {
    const list = deps.previousResults ?? [];
    const item = idx === -1 ? list[list.length - 1] : list[idx];
    if (!item) continue;
    refItems.push(item);
    refs.push({ title: item.title, concepts: item.concepts, provider: item.provider });
    const p = PROVIDERS[item.provider];
    if (p?.similar) {
      try {
        for (const s of await p.similar(item, { http: deps.http, env: deps.env })) {
          const sa = analyzeItem(s);
          similar.push(sa);
          similarMap.set(sa.id, item.title);
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return { refs, refItems, similar, similarMap };
}

export function describeIntent(intent: Intent): string {
  const parts: string[] = [];
  const top = topKeys(positivePart(intent.target), 4, 0.2).filter((k) => CONCEPT_BY_ID[k]);
  if (top.length) parts.push(top.map((k) => conceptLabel(k).toLowerCase()).join(' · '));
  if (intent.references.length) parts.push(`in the spirit of ${intent.references.join(', ')}`);
  if (intent.relaxed.length) parts.push(`not necessarily ${[...new Set(intent.relaxed.map((r) => (CONCEPT_BY_ID[r] ? conceptLabel(r).toLowerCase() : r === 'sci-fi' ? 'science fiction' : r)))].join(', ')}`);
  if (intent.excludes.length) parts.push(`avoiding ${intent.excludes.map((r) => (CONCEPT_BY_ID[r] ? conceptLabel(r).toLowerCase() : r)).join(', ')}`);
  if (intent.trajectory) parts.push(`moving from ${conceptLabel(intent.trajectory.from).toLowerCase()} to ${conceptLabel(intent.trajectory.to).toLowerCase()}`);
  if (intent.complexity === 'deep') parts.push('in-depth');
  if (intent.duration) parts.push(`${intent.duration} format`);
  return parts.join('; ');
}

export async function runPipeline(req: DiscoverRequest, deps: PipelineDeps): Promise<PipelineResult> {
  const pipeline: DiscoverResponse['pipeline'] = [];
  const statuses = new Map<ProviderId, DiscoverResponse['providers'][number]>();
  const query = (req.query ?? '').trim();
  const hasQuery = query.length > 0;

  // ── Step 1: intent ──
  let t = timer();
  let intent = parseIntent(query, { moods: req.moods, categories: req.categories, exploration: undefined });
  if (deps.previousIntent && hasQuery) intent = refineIntent(deps.previousIntent, intent);
  if (req.intentHint) intent = mergeHint(intent, sanitizeHint(req.intentHint, query), 'rules+client-llm');
  const ai = aiConfig(deps.env);
  if (ai && deps.useLlm !== false && hasQuery && query.split(/\s+/).length >= 4) {
    try {
      intent = await llmEnrichIntent(intent, ai, deps.http);
    } catch (e) {
      pipeline.push({ step: 'intent-llm', ms: 0, detail: `LLM unavailable, rules only (${(e as Error).message.slice(0, 80)})` });
    }
  }
  const exploration = Math.max(0, Math.min(1, intent.exploration ?? req.exploration ?? deps.profile.exploration ?? 0.4));
  pipeline.push({ step: 'intent', ms: t(), detail: `${intent.intent} via ${intent.source}${describeIntent(intent) ? `: ${describeIntent(intent)}` : ''}` });

  let clarifyingQuestion: DiscoverResponse['clarifyingQuestion'] = null;
  const effectiveHasQuery = hasQuery && !intent.vague;
  if (hasQuery && intent.vague) {
    clarifyingQuestion = {
      text: 'Tell me a bit more. What are you in the mood for, or what did you last love?',
      options: ['Something calm and beautiful', 'A mind-expanding documentary', 'Music for focus', 'Surprise me, outside my comfort zone'],
    };
  }

  // ── Step 2a: references ──
  t = timer();
  const { refs, refItems, similar, similarMap } = intent.references.length || intent.ordinalRefs.length ? await resolveReferences(intent, deps, statuses) : { refs: [], refItems: [], similar: [], similarMap: new Map<string, string>() };
  const extraConcepts: string[] = [];
  for (const r of refs) {
    for (const k of topKeys(r.concepts, 4, 0.3)) {
      if (intent.relaxed.includes(k) || !CONCEPT_BY_ID[k] || CONCEPT_BY_ID[k].group === 'quality') continue;
      intent.target[k] = Math.max(intent.target[k] ?? 0, 0.7 * r.concepts[k]);
      extraConcepts.push(k);
    }
  }
  if (intent.references.length || intent.ordinalRefs.length) pipeline.push({ step: 'references', ms: t(), detail: refs.length ? `resolved ${refs.map((r) => `${r.title} (${r.provider})`).join(', ')}` : 'could not resolve references' });

  // ── Step 2b: retrieval ──
  t = timer();
  const categories = targetCategories(intent, deps.profile, req.categories);
  for (const cat of categories) {
    if (!providersFor(cat, deps.env).length) {
      const p = cat === 'youtube' ? PROVIDERS.youtube! : PROVIDERS.spotify!;
      statuses.set(p.id, { id: p.id, status: 'unconfigured', message: p.setup });
    }
  }
  // A follow-up with nothing new to search for ("they're bad") explores fresh themes instead of repeating searches.
  const nothingToSearch = effectiveHasQuery && !intent.keywords.length && !topKeys(positivePart(intent.target), 1, 0.15).length && !intent.references.length && !intent.genres.length;
  const plan = planRetrieval(intent, deps.profile, categories, { env: deps.env, exploration, hasQuery: effectiveHasQuery && !nothingToSearch, seed: deps.seed, mix: req.mix }, extraConcepts).filter((q) => !deps.blockedProviders?.has(q.provider.id));
  for (const id of deps.blockedProviders ?? []) statuses.set(id, { id, status: 'quota', message: 'Daily quota reached; using cached results until it resets.' });
  const callsBefore = deps.http.calls;
  // Music discovery: Spotify's dev-mode search can't find music by mood or genre (it returns stock
  // "sleep/ambient" filler), so the optional LLM proposes real artists/recordings for the user's
  // taste words and every pick is verified on Spotify. Runs in parallel with provider searches.
  const musicPicks = (async (): Promise<{ items: ContentItem[]; detail: string } | null> => {
    if (!categories.includes('music') || !ai || deps.useLlm === false || !PROVIDERS.spotify?.configured(deps.env) || deps.blockedProviders?.has('spotify')) return null;
    const concepts = (effectiveHasQuery ? topKeys(positivePart(intent.target), 5, 0.15) : feedConcepts(deps.profile, exploration, intent.moods, deps.seed ?? 0)).filter((c) => CONCEPT_BY_ID[c]);
    // Music is briefed with moods (and the few themes that translate to sound), not e.g. "politics".
    const SOUND_THEMES = new Set(['cosmic', 'nature', 'spiritual', 'love', 'loss', 'solitude', 'time-memory', 'identity', 'travel']);
    const musicConcepts = effectiveHasQuery ? concepts : concepts.filter((c) => CONCEPT_BY_ID[c].group === 'mood' || SOUND_THEMES.has(c));
    const words = musicConcepts.map((c) => conceptLabel(c).toLowerCase()).join(', ');
    const desc = effectiveHasQuery
      ? `${intent.rawText}${words ? ` (themes: ${words})` : ''}${deps.profile.music ? `. Listener background: ${musicBrief(deps.profile.music, { styles: false })}` : ''}${intent.trajectory ? `; arc from ${intent.trajectory.from} to ${intent.trajectory.to}` : ''}; ${exploration >= 0.6 ? 'favour lesser-known, distinctive artists over chart hits' : exploration <= 0.3 ? 'well-loved classics are welcome' : 'mix beloved classics with lesser-known gems; avoid obvious chart hits'}`
      : (() => {
          // Style words learned from the user's library (generic genre terms, never track/artist names).
          const styles = topStyles(deps.profile, 8);
          // Live style mix (reflects every like, dislike and removal), plus stable background from the import.
          const mix = mixBrief(familyMix(deps.profile));
          const bg = deps.profile.music ? musicBrief(deps.profile.music, { styles: false }) : '';
          const base = mix ? `a listener with this ${mix}${bg ? `; background: ${bg}` : ''}` : styles.length ? `a listener whose favourite styles are ${styles.join(', ')}` : 'a listener';
          const reach = exploration >= 0.6
            ? 'suggest artists from neighbouring styles and scenes they probably do not know yet'
            : exploration <= 0.3
              ? 'suggest strong artists squarely within these styles that they may not have heard'
              : 'mostly within these styles, plus a few adjacent discoveries';
          return `music for ${base}${words ? `; moods/themes they respond to: ${words}` : ''}; ${reach}. Prefer artists outside the obvious mainstream.`;
        })();
    const avoid = [...deps.profile.explicit.dislikes, ...intent.excludes.filter((x) => !CONCEPT_BY_ID[x])];
    const picks = await llmMusicPicks(desc, ai, deps.http, { avoid, count: 16, cacheKey: `ai:music:${await hashKey(`${desc}|${avoid.join(',')}`)}:${(deps.seed ?? 0) % 4}` });
    const verified = await verifySpotifyPicks(picks, { http: deps.http, env: deps.env });
    const styleOf = new Map(picks.map((pk) => [pk.artist.toLowerCase(), pk.style]));
    const items = verified.map((i, idx) => ({ ...i, genres: i.genres.length ? i.genres : [styleOf.get((i.creators[0] ?? '').toLowerCase()) ?? ''].filter(Boolean), popularity: 0.75, metadata: { ...(i.metadata ?? {}), aiPick: true, aiOrder: idx, aiFor: words, retrievedBy: `ai:${i.creators[0] ?? i.id}`, retrievedFor: concepts.slice(0, 3) } }));
    return { items, detail: `${verified.length}/${picks.length} AI music picks verified on Spotify` };
  })().catch((e) => ({ items: [] as ContentItem[], detail: `AI music picks skipped (${(e as Error).message.slice(0, 60)})` }));
  const settled = await Promise.allSettled(plan.map((q) => q.provider.search(q.params, { http: deps.http, env: deps.env })));
  const raw: ContentItem[] = [];
  const quotaErrors: ProviderId[] = [];
  settled.forEach((s, i) => {
    const pid = plan[i].provider.id;
    if (s.status === 'fulfilled') {
      raw.push(...s.value);
      if (!statuses.has(pid)) statuses.set(pid, { id: pid, status: 'ok' });
    } else {
      const e = s.reason as ProviderError;
      const kind = e instanceof ProviderError ? e.kind : 'error';
      if (kind === 'quota') quotaErrors.push(pid);
      statuses.set(pid, { id: pid, status: kind === 'quota' ? 'quota' : 'error', message: String(e?.message ?? e).slice(0, 200) });
    }
  });
  const mp = await musicPicks;
  if (mp) {
    // Enough verified curator picks → drop Spotify mood-word search results for music (mostly filler);
    // otherwise they remain as the fallback.
    if (mp.items.length >= 3) {
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i].category === 'music' && raw[i].provider === 'spotify') raw.splice(i, 1);
    }
    raw.push(...mp.items);
    pipeline.push({ step: 'music-ai', ms: 0, detail: mp.detail });
  }
  pipeline.push({ step: 'retrieval', ms: t(), detail: `${plan.length} queries → ${raw.length} items (${deps.http.calls - callsBefore} network calls, rest cached)` });

  // ── Steps 3–4: enrichment + semantic analysis ──
  t = timer();
  const byId = new Map<string, AnalyzedItem>();
  for (const it of [...similar, ...raw.map(analyzeItem)]) {
    const prev = byId.get(it.id);
    if (!prev) byId.set(it.id, it);
    else {
      // Merge retrieval evidence from several queries.
      const merged = { ...prev.concepts };
      for (const [k, v] of Object.entries(it.concepts)) merged[k] = Math.max(merged[k] ?? 0, v);
      byId.set(it.id, { ...prev, concepts: merged });
    }
  }
  let candidates = [...byId.values()];
  pipeline.push({ step: 'analysis', ms: t(), detail: `${candidates.length} unique candidates projected into the concept space` });

  // Optional semantic embeddings (never for Spotify items)
  let queryEmbedding: number[] | null = null;
  if (deps.embed) {
    t = timer();
    try {
      const stored = deps.storedEmbeddings ? await deps.storedEmbeddings(candidates.map((c) => c.id)) : new Map<string, number[]>();
      const need = candidates.filter((c) => canEmbed(c) && !stored.has(c.id)).slice(0, 24);
      const texts = [...(effectiveHasQuery ? [query] : []), ...need.map(embeddingText)];
      const vecs = texts.length ? await deps.embed(texts) : [];
      if (effectiveHasQuery) queryEmbedding = vecs.shift() ?? null;
      need.forEach((c, i) => stored.set(c.id, vecs[i]));
      candidates = candidates.map((c) => (canEmbed(c) && stored.get(c.id) ? { ...c, embedding: stored.get(c.id) } : c));
      pipeline.push({ step: 'embeddings', ms: t(), detail: `gte-small: ${need.length} new item vectors${queryEmbedding ? ' + query' : ''}` });
    } catch (e) {
      pipeline.push({ step: 'embeddings', ms: t(), detail: `skipped (${(e as Error).message.slice(0, 60)})` });
    }
  }

  // Collaborative signal (only when enough community data exists — decided by the injected function)
  let collaborative: Map<string, number> | undefined;
  if (deps.collaborative) {
    try {
      collaborative = await deps.collaborative(candidates.map((c) => c.id));
    } catch {
      collaborative = undefined;
    }
  }

  // ── Steps 5–7: ranking, diversity, explanation ──
  t = timer();
  const limit = Math.max(1, Math.min(req.limit ?? 12, 30));
  const recommendations = rankCandidates(candidates, intent, deps.profile, {
    exploration,
    hasQuery: effectiveHasQuery,
    excludeIds: deps.excludeIds,
    referenceIds: new Set(refItems.map((r) => r.id)),
    referenceSimilar: similarMap,
    references: refs,
    collaborative,
    evidence: deps.evidence,
    queryEmbedding,
    limit,
    mix: req.mix,
    now: deps.now,
  });
  pipeline.push({ step: 'ranking', ms: t(), detail: `exploration ${Math.round(exploration * 100)}% · ${recommendations.length} picks after diversity` });

  // Reply (deterministic, grounded in what was actually retrieved)
  let reply: string | undefined;
  if (hasQuery) {
    const cats = [...new Set(recommendations.map((r) => r.item.category))].map((c) => CATEGORY_NOUN[c]);
    const desc = describeIntent(intent);
    if (!recommendations.length) {
      const unconfigured = [...statuses.values()].filter((s) => s.status === 'unconfigured' || s.status === 'error' || s.status === 'quota');
      reply = `I couldn't find real catalog matches for that${unconfigured.length ? ` (${unconfigured.map((u) => `${u.id}: ${u.status}`).join(', ')})` : ''}. Try rephrasing or widening the categories.`;
    } else {
      reply = `${desc ? `I read this as ${desc}. ` : ''}Here ${recommendations.length === 1 ? 'is 1 pick' : `are ${recommendations.length} picks`} across ${cats.join(', ')}${intent.trajectory ? `, ordered to travel from ${conceptLabel(intent.trajectory.from).toLowerCase()} to ${conceptLabel(intent.trajectory.to).toLowerCase()}` : ''}.`;
      if (intent.references.length && !refs.length) reply += ` I couldn't find “${intent.references.join(', ')}” in the connected catalogs, so I matched on the qualities you described instead.`;
      if (intent.statements.length) reply += ` Noted for your taste profile: ${intent.statements.map((s) => `${s.polarity > 0 ? 'you like' : "you don't like"} ${s.subject}`).join('; ')}.`;
    }
  }

  return {
    intent: { ...intent, exploration },
    recommendations,
    reply,
    clarifyingQuestion,
    providers: [...statuses.values()],
    pipeline,
    candidates,
    quotaErrors,
  };
}
