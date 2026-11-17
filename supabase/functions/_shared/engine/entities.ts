// Named things in a request ("eminem", "books by Ursula K. Le Guin", "dune"): where each kind is looked
// up, which media answer it, and the cross-media items around it (their works, things like them, things
// about them). Music for an artist comes from the curator's entity lanes (curator.ts); everything else is
// here. Only the user's words and the AI interpreter's own output (names, related works) are looked up.
import type { Category, ContentItem, Entity, EntityKind, EntityTag, EntityWork, Intent, ProviderId, Recommendation } from '../types.ts';
import { PROVIDERS, providersFor } from '../providers/index.ts';
import { ProviderError, type HttpClient } from '../providers/http.ts';
import type { Env, Provider } from '../providers/types.ts';
import { openLibrary, openLibraryAuthorWorks } from '../providers/openlibrary.ts';
import { tmdbPersonWorks } from '../providers/tmdb.ts';
import { tvmazePersonShows } from '../providers/tvmaze.ts';
import { youtube } from '../providers/youtube.ts';
import { ENTITY_BY_LANE, ENTITY_LIKE_LANE, entityTagOf, isEntityExtra, isLaneVideo, laneTagOf } from './lanes.ts';

export { entityTagOf, isEntityExtra };
import { fold } from './text.ts';

/** The media a bare name is shown in: its own medium plus the media that tell its story. */
const ENTITY_MEDIA: Partial<Record<EntityKind, Category[]>> = {
  artist: ['music', 'screen', 'books', 'youtube'],
  author: ['books', 'screen', 'youtube'],
  book: ['books', 'screen', 'youtube'],
  director: ['screen', 'books', 'youtube'],
  actor: ['screen', 'books', 'youtube'],
  film: ['screen', 'books', 'youtube'],
  series: ['screen', 'books', 'youtube'],
  creator: ['youtube', 'podcasts'],
  podcast: ['podcasts', 'youtube'],
};

export function entityMedia(kind: EntityKind): Category[] | undefined {
  return ENTITY_MEDIA[kind];
}

export function primaryEntity(intent: Pick<Intent, 'entities'>): Entity | null {
  return intent.entities?.[0] ?? null;
}

/**
 * Where an entity is looked up, in order: an artist only in music (never as a book or a show), an author
 * in books, films/series/people in screen, a creator on YouTube, a podcast in podcasts. An unknown kind
 * is looked up in the request's other media, then screen, then books — never by a Spotify song search
 * (that would spend Spotify's rate-limited search on every unread name): in a music request, a name no
 * catalog knows as a work is answered as an artist by the curator, which checks every song's credit.
 */
export function entityRoute(e: Pick<Entity, 'kind'>, categories: Category[]): Category[] {
  switch (e.kind) {
    case 'artist':
      return ['music'];
    case 'author':
    case 'book':
      return ['books'];
    case 'film':
    case 'series':
    case 'director':
    case 'actor':
      return ['screen'];
    case 'creator':
      return ['youtube'];
    case 'podcast':
      return ['podcasts'];
    default:
      // A music-only request: the name is the curator's to answer (an artist), never a film or a book.
      if (categories.length && categories.every((c) => c === 'music')) return [];
      return [...new Set<Category>([...categories.filter((c) => c !== 'music'), 'screen', 'books'])];
  }
}

/**
 * An artist the music curator should answer: named as one, or a name of unknown kind in a music request
 * that no catalog knows as a work (a name resolved to a film, series, book or podcast takes that kind;
 * a song or album title is never an entity, see understand.ts).
 */
export function isArtistEntity(e: Pick<Entity, 'kind'>, categories: Category[]): boolean {
  return e.kind === 'artist' || (e.kind === 'other' && categories.includes('music'));
}

const has = (hay: string, needle: string) => needle.length >= 3 && hay.includes(needle);

/** Words of any script, lowercased, accents removed: "Jay-Z live" → ["jay", "z", "live"], "MØ" → ["mø"]. */
function wordsOf(s: string): string[] {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** The name's words appear together, as whole words ("Nas" is not in "NASA" or "dynasty"). */
function namedIn(text: string, nameWords: string[]): boolean {
  if (!nameWords.length) return false;
  const words = wordsOf(text);
  for (let i = 0; i + nameWords.length <= words.length; i++) if (nameWords.every((w, j) => words[i + j] === w)) return true;
  return false;
}

/**
 * The item names the entity, as whole words: in its title, credits or tags, or (a name of two words or
 * more) its description. A one-word name ("Future", "Common") is a common word in prose, so the
 * description doesn't count for it; a two-letter name ("U2", "MØ") counts like any other.
 */
export function mentions(item: Pick<ContentItem, 'title' | 'creators' | 'tags' | 'description'>, name: string): boolean {
  const n = wordsOf(name);
  if (!n.length || n.join('').length < 2) return false;
  if ([item.title, ...item.creators, ...item.tags.slice(0, 30)].some((t) => namedIn(t, n))) return true;
  return n.length >= 2 && namedIn((item.description ?? '').slice(0, 800), n);
}

/** The item credits the entity (author, channel, artist). */
export function credits(item: Pick<ContentItem, 'creators'>, name: string): boolean {
  const n = fold(name);
  return item.creators.some((c) => {
    const f = fold(c);
    return f === n || (n.length >= 4 && f.includes(n));
  });
}

/** A catalog lookup for a named work/person plausibly found it (a show search returns *something* for any word). */
export function plausibleMatch(item: Pick<ContentItem, 'title' | 'creators'>, name: string): boolean {
  const n = fold(name);
  const t = fold(item.title);
  if (!n || !t) return false;
  return t === n || has(t, n) || (t.length >= 4 && n.includes(t) && t.length / n.length >= 0.5) || credits(item, name);
}

/** A catalog match for one of the interpreter's related works: same title, and year/author when both sides know them. */
export function workMatches(item: Pick<ContentItem, 'title' | 'creators' | 'releaseDate' | 'kind'>, w: EntityWork): boolean {
  const t = fold(item.title);
  const wt = fold(w.title);
  if (!t || !wt) return false;
  const titleOk = t === wt || (Math.min(t.length, wt.length) >= 5 && (t.startsWith(wt) || wt.startsWith(t)));
  if (!titleOk) return false;
  const y = Number(String(item.releaseDate ?? '').slice(0, 4));
  if (w.year && y > 1800 && Math.abs(y - w.year) > 1) return false;
  if (w.by && item.creators.length && !credits(item, w.by)) return false;
  if (w.kind === 'film' && item.kind === 'series') return false;
  return true;
}

// ───────────── resolution ─────────────

export interface EntityResolution {
  entity: Entity;
  /** The entity's own catalog item (a film, a book, a show), when its kind is a work. */
  item: ContentItem | null;
  provider: ProviderId | null;
  /** How it was handled, for the pipeline trace ("artist: music curator", "film via tmdb"). */
  detail: string;
  /** The kind the lookup revealed for a name of unknown kind (a song search crediting it → 'artist'). */
  kind?: EntityKind;
}

export interface EntityContext {
  env: Env;
  http: HttpClient;
  /** Providers not to call (blocked, or out of quota earlier in this request: callers add to it). */
  blocked?: Set<ProviderId>;
}

const WORK_KINDS_RESOLVED: EntityKind[] = ['film', 'series', 'book', 'podcast', 'other'];

/** The kind of entity a catalog work is ("movie" → film, "episode" → podcast). */
const KIND_OF_WORK: Partial<Record<ContentItem['kind'], EntityKind>> = { movie: 'film', series: 'series', book: 'book', podcast: 'podcast', episode: 'podcast' };

/** Same title, a leading article aside ("The Dune" = "Dune"): a name that IS this work, not one about it. */
export function sameTitle(title: string, name: string): boolean {
  const bare = (x: string) => fold(x.replace(/^\s*(the|a|an|le|la|les|el)\s+/i, ''));
  return !!bare(name) && bare(title) === bare(name);
}

/**
 * Look the entity up by kind. People (artists, authors, directors, actors, creators) are not looked up as
 * titles: the music curator answers artists, and their works come from entityExtras. Works (films,
 * series, books, podcasts) go to their own media, and a match must plausibly be the thing named. A name
 * of unknown kind is a work only when a catalog has a work of exactly that title ("dune" → the film
 * Dune): it then takes that work's kind. Anything else ("The Nova Lyric Story" for "nova lyric") is about
 * the name at most, so the name stays a name (a person: things about them come from entityExtras).
 */
export async function resolveEntity(e: Entity, categories: Category[], ctx: EntityContext, onError?: (p: Provider, err: unknown) => void): Promise<EntityResolution> {
  if (!WORK_KINDS_RESOLVED.includes(e.kind)) {
    const who = e.kind === 'artist' ? 'artist: music curator' : `${e.kind}: their works`;
    return { entity: e, item: null, provider: null, detail: `${e.name} → ${who}` };
  }
  const unknown = e.kind === 'other';
  for (const cat of entityRoute(e, categories)) {
    for (const p of providersFor(cat, ctx.env)) {
      if (!p.resolve || ctx.blocked?.has(p.id)) continue;
      // TVmaze only knows series: a film named on it would match a random show.
      if (e.kind === 'film' && p.id === 'tvmaze') continue;
      try {
        const item = await p.resolve(e.name, { http: ctx.http, env: ctx.env }, cat);
        if (!item) continue;
        if (unknown) {
          const kind = KIND_OF_WORK[item.kind];
          if (kind && sameTitle(item.title, e.name)) return { entity: e, item, provider: p.id, detail: `${e.name} → ${item.title} (${p.id}, a ${kind})`, kind };
          continue;
        }
        if (plausibleMatch(item, e.name)) return { entity: e, item, provider: p.id, detail: `${e.name} → ${item.title} (${p.id})` };
      } catch (err) {
        onError?.(p, err);
      }
    }
  }
  return { entity: e, item: null, provider: null, detail: unknown ? `${e.name}: no work of that title in the connected catalogs (a name)` : `${e.name}: not found in the connected catalogs` };
}

// ───────────── cross-media items around an entity ─────────────

export interface ExtrasContext extends EntityContext {
  /** The media this request may show. */
  categories: Category[];
  /** The entity's own resolved item (film/book/show), from resolveEntity. */
  resolved?: ContentItem | null;
  /** Stored catalog items (YouTube out of quota, Spotify rate-limited). */
  stored?: (provider: ProviderId, categories: Category[]) => Promise<ContentItem[]>;
  /**
   * Stored catalog items that name `name` (title or credits), looked up by name: preferred over `stored`,
   * whose newest-first window can miss an older video about them.
   */
  storedNamed?: (provider: ProviderId, categories: Category[], name: string) => Promise<ContentItem[]>;
  /** A provider answered "out of quota" (recorded as a block by the caller, and not called again in this request). */
  onQuota?: (provider: ProviderId, retryAfterSec?: number) => void;
  /** Most items returned. */
  cap?: number;
  /** Most of the entity's own works ('by'); default 4 next to other kinds of items (see extrasCap). */
  byMax?: number;
  /** Most provider calls (YouTube search = 1, a TMDB lookup = 1–2). Default 5. */
  maxCalls?: number;
}

export interface ExtrasResult {
  items: ContentItem[];
  calls: number;
  detail: string;
}

const KIND_WORD: Record<string, string> = { movie: 'film', series: 'series', book: 'book', video: 'video', episode: 'episode', podcast: 'podcast' };

/** People whose own works answer "<their works>" (an author's books, a director's films, a creator's videos). */
const MAKERS: EntityKind[] = ['author', 'director', 'actor', 'creator'];

/**
 * Cap of non-music items around an entity: ~6 next to music lanes, 8 on their own. A request for a
 * maker's own works ("books by X") is answered by those works: up to the request limit, less a few.
 */
export function extrasCap(e: Entity, categories: Category[], limit = 20): number {
  if (e.want === 'by' && MAKERS.includes(e.kind)) return Math.max(8, limit - 4);
  return isArtistEntity(e, categories) && e.want === 'all' && categories.includes('music') ? 6 : 8;
}

const isQuota = (err: unknown): err is ProviderError => err instanceof ProviderError && err.kind === 'quota';

/**
 * Items around the entity in other media, bounded (≤ maxCalls provider calls, ≤ cap items), each tagged
 * metadata.entity = { name, role, note } and metadata.entityOrder (by → about → like):
 *   artist (all/about): one YouTube search "<name> interview|documentary|breakdown" (stored videos naming
 *     them when YouTube is out of quota), an Open Library search for books by/about them, and the
 *     interpreter's related works (film/series → screen, book → books);
 *   author: their works (by), books on their top work's subjects (like), interviews + related works (about);
 *   film/series/book: the work itself (by), provider "similar" or same-subject books (like), one YouTube
 *     search + related works (about); director/actor: their known films/series (by), similar to the first (like);
 *   creator: their videos; podcast: the show itself (stored or looked up).
 * The budget goes to the entity's own works first, then things like it and the about-search, and only then
 * to the interpreter's related works (a TMDB lookup costs 2): a famous author's film adaptations never
 * crowd out their books. A YouTube search out of quota falls back to stored videos in the same request.
 */
export async function entityExtras(e: Entity, ctx: ExtrasContext): Promise<ExtrasResult> {
  const cats = ctx.categories;
  const may = (c: Category) => cats.includes(c);
  const by = e.want === 'by' || e.want === 'all';
  const like = e.want === 'like' || e.want === 'all';
  const about = e.want === 'about' || e.want === 'all';
  const byMax = Math.max(1, ctx.byMax ?? 4);
  const budget = ctx.maxCalls ?? 5;
  let calls = 0;
  // Calls are reserved when a task is registered (in priority order), not when it runs.
  const spend = (n = 1) => (calls + n <= budget ? ((calls += n), true) : false);
  const pctx = { http: ctx.http, env: ctx.env };
  const blocked = (id: ProviderId) => !!ctx.blocked?.has(id);
  const ytOk = youtube.configured(ctx.env) && !blocked('youtube');
  const tmdb = PROVIDERS.tmdb;
  const tmdbOk = !!tmdb?.configured(ctx.env) && !blocked('tmdb');
  const hasStored = !!(ctx.storedNamed || ctx.stored);
  const storedFor = (provider: ProviderId, c: Category[]) =>
    ctx.storedNamed ? ctx.storedNamed(provider, c, e.name) : ctx.stored ? ctx.stored(provider, c) : Promise.resolve([] as ContentItem[]);
  type Found = { item: ContentItem; role: EntityTag['role']; note?: string; rank: number };
  const found: Found[] = [];
  const notes: string[] = [];
  const tasks: Array<Promise<void>> = [];
  const quota = (err: ProviderError) => {
    ctx.blocked?.add(err.provider as ProviderId);
    ctx.onQuota?.(err.provider as ProviderId, err.retryAfterSec);
  };
  const run = (label: string, f: () => Promise<void>) =>
    tasks.push(f().catch((err) => {
      if (isQuota(err)) quota(err);
      notes.push(`${label} failed (${String((err as Error)?.message ?? err).slice(0, 60)})`);
    }));
  /** A live search, or (out of quota) the stored items instead, in the same request. */
  const liveOrStored = async (search: () => Promise<ContentItem[]>, provider: ProviderId, c: Category[]) => {
    try {
      return await search();
    } catch (err) {
      if (!isQuota(err) || !hasStored) throw err;
      quota(err);
      notes.push(`${provider} out of quota: stored items used`);
      return storedFor(provider, c);
    }
  };
  const add = (items: ContentItem[], role: EntityTag['role'], rank: number, note: (i: ContentItem) => string | undefined, max: number) => {
    let n = 0;
    for (const item of items) {
      if (n >= max) break;
      found.push({ item, role, note: note(item), rank: rank + n / 100 });
      n++;
    }
  };
  const kindWord = (i: ContentItem) => KIND_WORD[i.kind] ?? 'pick';
  const person = ['artist', 'author', 'director', 'actor', 'creator'].includes(e.kind) || (e.kind === 'other' && !ctx.resolved);
  const subject = ctx.resolved?.title ?? e.name;
  const SUBJECT_NOISE = /fiction$|^nyt|accessible|protected|lending|large type/i;

  // 1. Their own works (an author's also seed "like": books on the subjects of their best-known work).
  if (e.kind === 'author' && (by || like) && may('books') && spend()) {
    const likeOk = like && spend();
    run('author works', async () => {
      const books = await openLibraryAuthorWorks(e.name, pctx, Math.min(30, Math.max(12, byMax + 2)));
      if (by) add(books, 'by', 10, () => `by ${e.name}`, byMax);
      const subj = (books[0]?.tags ?? []).filter((t) => t.length <= 30 && !SUBJECT_NOISE.test(t))[0];
      if (likeOk && subj) {
        const similar = (await openLibrary.search({ query: `subject:"${subj}"`, category: 'books', limit: 15 }, pctx)).filter((b) => !credits(b, e.name));
        add(similar, 'like', 40, () => `like ${e.name}: ${subj.toLowerCase()}`, 3);
      }
    });
  }
  if (by && e.kind !== 'author') {
    if ((e.kind === 'director' || e.kind === 'actor') && may('screen')) {
      if (tmdbOk && spend()) {
        const likeOk = like && !!tmdb?.similar && spend();
        run('person works', async () => {
          const r = await tmdbPersonWorks(e.name, pctx);
          add(r.works, 'by', 10, () => (e.kind === 'director' ? `directed by ${e.name}` : `with ${e.name}`), byMax);
          const first = r.works[0];
          if (likeOk && first) add(await tmdb!.similar!(first, pctx), 'like', 40, () => `like ${first.title}`, 3);
        });
      } else if (!blocked('tvmaze') && spend(2)) {
        run('person shows', async () => add(await tvmazePersonShows(e.name, pctx, e.kind === 'director' ? 'crew' : 'cast'), 'by', 10, () => (e.kind === 'director' ? `made by ${e.name}` : `with ${e.name}`), byMax));
      }
    } else if (e.kind === 'creator' && may('youtube')) {
      if (ytOk && spend()) {
        run('creator videos', async () => {
          const vids = await liveOrStored(() => youtube.search({ query: e.name, category: 'youtube', limit: 15 }, pctx), 'youtube', ['youtube']);
          add(vids.filter((v) => credits(v, e.name)), 'by', 10, () => `from ${e.name}`, byMax);
        });
      } else if (hasStored) {
        run('stored creator videos', async () => add((await storedFor('youtube', ['youtube'])).filter((v) => credits(v, e.name)), 'by', 10, () => `from ${e.name}`, byMax));
      }
    } else if (ctx.resolved && may(ctx.resolved.category)) {
      // A film, series, book or show: the work itself.
      const r = ctx.resolved;
      add([r], 'by', 10, () => (r.creators[0] ? `the ${kindWord(r)} itself, by ${r.creators[0]}` : `the ${kindWord(r)} itself`), 1);
    } else if (e.kind === 'podcast' && may('podcasts') && hasStored) {
      run('stored podcast', async () => {
        const [spotifyShows, youtubeShows] = await Promise.all([storedFor('spotify', ['podcasts']), storedFor('youtube', ['podcasts'])]);
        add([...spotifyShows, ...youtubeShows].filter((x) => plausibleMatch(x, e.name)), 'by', 10, () => 'the show itself', 2);
      });
    }
  }

  // 2. Things like it (works only: an artist's "like" is the curator's lane, an author's comes with their works).
  if (like && ctx.resolved && !person) {
    const r = ctx.resolved;
    const p = PROVIDERS[r.provider];
    if (p?.similar && !blocked(p.id) && may(r.category) && spend()) {
      run('similar', async () => add(await p.similar!(r, pctx), 'like', 40, () => `like ${r.title}`, 5));
    } else if (r.category === 'books' && may('books')) {
      const subj = r.tags.filter((t) => t.length <= 30 && !SUBJECT_NOISE.test(t))[0];
      if (subj && spend()) {
        run('same-subject books', async () => {
          const books = (await openLibrary.search({ query: `subject:"${subj}"`, category: 'books', limit: 15 }, pctx)).filter((b) => b.id !== r.id && !r.creators.some((c) => credits(b, c)));
          add(books, 'like', 40, () => `like ${r.title}: ${subj.toLowerCase()}`, 4);
        });
      }
    }
  }

  // 3. Things about it: one YouTube search (stored videos naming it when YouTube is out of quota), and books.
  if (about) {
    if (may('youtube') && e.kind !== 'creator') {
      // YouTube search's OR operator is "|".
      const q = person ? `${e.name} interview|documentary|breakdown` : `${subject} explained|analysis|review`;
      const note = (v: ContentItem) => `a video about ${e.name}${v.creators[0] ? ` from ${v.creators[0]}` : ''}`;
      if (ytOk && spend()) {
        run('videos about', async () => {
          const vids = await liveOrStored(() => youtube.search({ query: q, category: 'youtube', limit: 15 }, pctx), 'youtube', ['youtube']);
          add(vids.filter((v) => mentions(v, e.name)), 'about', 50, note, 2);
        });
      } else if (hasStored) {
        run('stored videos about', async () => add((await storedFor('youtube', ['youtube'])).filter((v) => mentions(v, e.name)), 'about', 50, note, 2));
      }
    }
    if (may('books') && person && e.kind !== 'author' && spend()) {
      run('books about', async () => {
        const books = (await openLibrary.search({ query: e.name, category: 'books', limit: 15 }, pctx)).filter((b) => mentions(b, e.name));
        add(books, 'about', 30, (b) => (credits(b, e.name) ? `written by ${e.name}` : `a book about ${e.name}`), 2);
      });
    }
  }

  // 4. Related works the interpreter named (8 Mile, the memoir…), resolved in their own media with what is left.
  const works = about ? (e.works ?? []).filter((w) => (w.kind === 'film' || w.kind === 'series' ? may('screen') : w.kind === 'book' ? may('books') : false)) : [];
  for (const [wi, w] of works.slice(0, 2).entries()) {
    const cat: Category = w.kind === 'book' ? 'books' : 'screen';
    const p = cat === 'books' ? openLibrary : tmdbOk ? tmdb! : w.kind === 'series' ? PROVIDERS.tvmaze : undefined;
    if (!p?.resolve || blocked(p.id) || !spend(p.id === 'tmdb' ? 2 : 1)) continue;
    run(`work ${w.title}`, async () => {
      const item = await p.resolve!(w.title, pctx, cat);
      if (item && workMatches(item, w)) add([item], 'about', 20 + wi, () => w.note ?? `a ${w.kind} tied to ${e.name}`, 1);
    });
  }

  await Promise.all(tasks);
  const cap = ctx.cap ?? 6;
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const items: ContentItem[] = [];
  for (const f of found.sort((a, b) => a.rank - b.rank)) {
    const t = `${f.item.category}|${fold(f.item.title)}`;
    if (seenIds.has(f.item.id) || seenTitles.has(t)) continue;
    seenIds.add(f.item.id);
    seenTitles.add(t);
    const tag: EntityTag = { name: e.name, role: f.role, ...(f.note ? { note: f.note } : {}) };
    items.push({ ...f.item, metadata: { ...(f.item.metadata ?? {}), entity: tag, entityOrder: items.length, retrievedBy: `entity:${e.name}` } });
    if (items.length >= cap) break;
  }
  const roles = (['by', 'about', 'like'] as const).map((r) => [r, items.filter((i) => entityTagOf(i)?.role === r).length] as const).filter(([, n]) => n > 0);
  const detail = `${e.name} (${e.kind}, ${e.want}): ${items.length} items${roles.length ? ` (${roles.map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}, ${calls} provider calls${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return { items, calls, detail };
}

// ───────────── reply ─────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function titlesList(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? '';
  const shown = titles.slice(0, 3);
  const more = titles.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Chat reply for an entity request, grounded in what is actually shown, e.g. "Here's Eminem: 7 of their
 * songs (3 you haven't saved), 8 artists in the same lane, and 4 things about Eminem: 8 Mile, The Way I
 * Am and 2 more." The other picks shown with them are counted ("…, plus 4 other picks"). Null when
 * nothing shown answers the entity itself: the caller describes the other picks instead.
 */
export function entityReply(e: Entity, recs: Array<Pick<Recommendation, 'item'>>): string | null {
  const laneItems = (id: string) => recs.filter((r) => r.item.category === 'music' && laneTagOf(r.item)?.id === id);
  const lane = (id: string) => laneItems(id).filter((r) => !isLaneVideo(r.item));
  const bySongs = lane(ENTITY_BY_LANE);
  const byVideos = laneItems(ENTITY_BY_LANE).filter((r) => isLaneVideo(r.item));
  const likeSongs = lane(ENTITY_LIKE_LANE);
  const extras = recs.filter((r) => isEntityExtra(r.item));
  const role = (r: EntityTag['role']) => extras.filter((x) => entityTagOf(x.item)?.role === r);
  const parts: string[] = [];
  if (bySongs.length) {
    const fresh = bySongs.filter((r) => r.item.metadata?.inLibrary !== true).length;
    const saved = fresh === bySongs.length ? 'none of them in your library yet' : fresh === 0 ? 'all already in your library' : `${fresh} you haven't saved`;
    parts.push(`${plural(bySongs.length, `song by ${e.name}`, `songs by ${e.name}`)} (${saved})`);
  }
  if (byVideos.length) parts.push(byVideos.every((r) => r.item.metadata?.videoKind !== 'video') ? plural(byVideos.length, 'live session') : plural(byVideos.length, 'video'));
  if (likeSongs.length) parts.push(`${plural(new Set(likeSongs.map((r) => fold(r.item.creators[0] ?? r.item.id))).size, 'artist')} in the same lane`);
  const byItems = role('by');
  if (byItems.length) parts.push(e.kind === 'film' || e.kind === 'series' || e.kind === 'book' || e.kind === 'podcast' ? `the ${KIND_WORD[byItems[0].item.kind] ?? 'work'} itself` : `${plural(byItems.length, 'work')} by ${e.name}`);
  const likeItems = role('like');
  if (likeItems.length) parts.push(`${plural(likeItems.length, 'pick')} like it`);
  const aboutItems = role('about');
  if (aboutItems.length) parts.push(`${plural(aboutItems.length, 'thing')} about ${e.name}: ${titlesList(aboutItems.map((r) => r.item.title))}`);
  if (!parts.length) return null;
  const last = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const others = recs.length - bySongs.length - byVideos.length - likeSongs.length - extras.length;
  return `Here's ${e.name}: ${last}${others > 0 ? `, plus ${plural(others, 'other pick')}` : ''}.`;
}
