// Named things in a request ("eminem", "books by Ursula K. Le Guin", "dune"): where each kind is looked
// up, which media answer it, and the cross-media items around it (their works, things like them, things
// about them). Music for an artist comes from the curator's entity lanes (curator.ts); everything else is
// here. Only the user's words and the AI interpreter's own output (names, related works) are looked up.
import type { Category, ContentItem, Entity, EntityKind, EntityTag, EntityWork, Intent, ProviderId, Recommendation } from '../types.ts';
import { PROVIDERS, providersFor } from '../providers/index.ts';
import type { HttpClient } from '../providers/http.ts';
import type { Env, Provider } from '../providers/types.ts';
import { openLibrary, openLibraryAuthorWorks } from '../providers/openlibrary.ts';
import { tmdbPersonWorks } from '../providers/tmdb.ts';
import { tvmazePersonShows } from '../providers/tvmaze.ts';
import { youtube } from '../providers/youtube.ts';
import { ENTITY_BY_LANE, ENTITY_LIKE_LANE, entityTagOf, isEntityExtra, laneTagOf } from './lanes.ts';

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
 * tries music first when the request is about music or names no medium, then screen, then books.
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
    default: {
      const musicFirst = !categories.length || categories.includes('music');
      return [...new Set<Category>([...(musicFirst ? (['music'] as Category[]) : []), ...categories.filter((c) => c !== 'music'), 'screen', 'books'])];
    }
  }
}

/** An artist the music curator should answer: named as one, or an unknown name in a music request. */
export function isArtistEntity(e: Pick<Entity, 'kind'>, categories: Category[]): boolean {
  return e.kind === 'artist' || (e.kind === 'other' && categories.includes('music'));
}

const has = (hay: string, needle: string) => needle.length >= 3 && hay.includes(needle);

/** The item names the entity in its title, credits, tags or description. */
export function mentions(item: Pick<ContentItem, 'title' | 'creators' | 'tags' | 'description'>, name: string): boolean {
  const n = fold(name);
  return has(fold(`${item.title} ${item.creators.join(' ')} ${item.tags.slice(0, 30).join(' ')} ${(item.description ?? '').slice(0, 800)}`), n);
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
  blocked?: Set<ProviderId>;
}

const WORK_KINDS_RESOLVED: EntityKind[] = ['film', 'series', 'book', 'podcast', 'other'];

/**
 * Look the entity up by kind. People (artists, authors, directors, actors, creators) are not looked up as
 * titles: the music curator answers artists, and their works come from entityExtras. Works (films, series,
 * books, podcasts) and unknown names go to their own media, and a match must plausibly be the thing named.
 */
export async function resolveEntity(e: Entity, categories: Category[], ctx: EntityContext, onError?: (p: Provider, err: unknown) => void): Promise<EntityResolution> {
  if (!WORK_KINDS_RESOLVED.includes(e.kind)) {
    const who = e.kind === 'artist' ? 'artist: music curator' : `${e.kind}: their works`;
    return { entity: e, item: null, provider: null, detail: `${e.name} → ${who}` };
  }
  for (const cat of entityRoute(e, categories)) {
    for (const p of providersFor(cat, ctx.env)) {
      if (!p.resolve || ctx.blocked?.has(p.id)) continue;
      // TVmaze only knows series: a film named on it would match a random show.
      if (e.kind === 'film' && p.id === 'tvmaze') continue;
      try {
        const item = await p.resolve(e.name, { http: ctx.http, env: ctx.env }, cat);
        // A song search crediting the name: it is an artist (answered by music lanes, not by that one song).
        if (item && cat === 'music') {
          if (credits(item, e.name)) return { entity: e, item: null, provider: p.id, detail: `${e.name} → artist (${p.id})`, kind: 'artist' };
          continue;
        }
        if (item && plausibleMatch(item, e.name)) return { entity: e, item, provider: p.id, detail: `${e.name} → ${item.title} (${p.id})` };
      } catch (err) {
        onError?.(p, err);
      }
    }
  }
  return { entity: e, item: null, provider: null, detail: `${e.name}: not found in the connected catalogs` };
}

// ───────────── cross-media items around an entity ─────────────

export interface ExtrasContext extends EntityContext {
  /** The media this request may show. */
  categories: Category[];
  /** The entity's own resolved item (film/book/show), from resolveEntity. */
  resolved?: ContentItem | null;
  /** Stored catalog items (YouTube out of quota, Spotify rate-limited). */
  stored?: (provider: ProviderId, categories: Category[]) => Promise<ContentItem[]>;
  /** Most items returned. */
  cap?: number;
  /** Most provider calls (YouTube search = 1, a TMDB lookup = 1–2). */
  maxCalls?: number;
}

export interface ExtrasResult {
  items: ContentItem[];
  calls: number;
  detail: string;
}

const KIND_WORD: Record<string, string> = { movie: 'film', series: 'series', book: 'book', video: 'video', episode: 'episode', podcast: 'podcast' };

/** Default cap of non-music items around an entity: ~6 next to music lanes, a little more on their own. */
export function extrasCap(e: Entity, categories: Category[]): number {
  return isArtistEntity(e, categories) && e.want === 'all' && categories.includes('music') ? 6 : 8;
}

/**
 * Items around the entity in other media, bounded (≤ maxCalls provider calls, ≤ cap items), each tagged
 * metadata.entity = { name, role, note } and metadata.entityOrder (by → about → like):
 *   artist (all/about): the interpreter's related works (film/series → screen, book → books), one YouTube
 *     search "<name> interview|documentary|breakdown" (stored videos naming them when YouTube is
 *     out of quota), and an Open Library search for books by/about them;
 *   author: their works (by), books on their top work's subjects (like), works + interviews (about);
 *   film/series/book: the work itself (by), provider "similar" or same-subject books (like), related works
 *     + one YouTube search (about); director/actor: their known films/series (by), similar to the first (like);
 *   creator: their videos; podcast: the show itself (stored or looked up).
 */
export async function entityExtras(e: Entity, ctx: ExtrasContext): Promise<ExtrasResult> {
  const cats = ctx.categories;
  const may = (c: Category) => cats.includes(c);
  const by = e.want === 'by' || e.want === 'all';
  const like = e.want === 'like' || e.want === 'all';
  const about = e.want === 'about' || e.want === 'all';
  const budget = ctx.maxCalls ?? 4;
  let calls = 0;
  const spend = (n = 1) => (calls + n <= budget ? ((calls += n), true) : false);
  const pctx = { http: ctx.http, env: ctx.env };
  const blocked = (id: ProviderId) => !!ctx.blocked?.has(id);
  const ytOk = youtube.configured(ctx.env) && !blocked('youtube');
  const tmdb = PROVIDERS.tmdb;
  const tmdbOk = !!tmdb?.configured(ctx.env) && !blocked('tmdb');
  type Found = { item: ContentItem; role: EntityTag['role']; note?: string; rank: number };
  const found: Found[] = [];
  const notes: string[] = [];
  const tasks: Array<Promise<void>> = [];
  const run = (label: string, f: () => Promise<void>) =>
    tasks.push(f().catch((err) => {
      notes.push(`${label} failed (${String((err as Error)?.message ?? err).slice(0, 60)})`);
    }));
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

  // Related works the interpreter named (8 Mile, the memoir…), resolved in their own media.
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

  // Their own works (an author's also seed "like": books on the subjects of their best-known work).
  if (e.kind === 'author' && (by || like) && may('books') && spend()) {
    run('author works', async () => {
      const books = await openLibraryAuthorWorks(e.name, pctx, 12);
      if (by) add(books, 'by', 10, () => `by ${e.name}`, 4);
      const subj = (books[0]?.tags ?? []).filter((t) => t.length <= 30 && !/fiction$|^nyt|accessible|protected|lending|large type/i.test(t))[0];
      if (like && subj && spend()) {
        const similar = (await openLibrary.search({ query: `subject:"${subj}"`, category: 'books', limit: 15 }, pctx)).filter((b) => !credits(b, e.name));
        add(similar, 'like', 40, () => `like ${e.name}: ${subj.toLowerCase()}`, 3);
      }
    });
  }
  if (by && e.kind !== 'author') {
    if ((e.kind === 'director' || e.kind === 'actor') && may('screen')) {
      if (tmdbOk && spend()) {
        run('person works', async () => {
          const r = await tmdbPersonWorks(e.name, pctx);
          add(r.works, 'by', 10, () => (e.kind === 'director' ? `directed by ${e.name}` : `with ${e.name}`), 4);
          const first = r.works[0];
          if (like && first && tmdb?.similar && spend()) add(await tmdb.similar(first, pctx), 'like', 40, () => `like ${first.title}`, 3);
        });
      } else if (!blocked('tvmaze') && spend(2)) {
        run('person shows', async () => add(await tvmazePersonShows(e.name, pctx, e.kind === 'director' ? 'crew' : 'cast'), 'by', 10, () => (e.kind === 'director' ? `made by ${e.name}` : `with ${e.name}`), 4));
      }
    } else if (e.kind === 'creator' && may('youtube')) {
      if (ytOk && spend()) {
        run('creator videos', async () => {
          const vids = await youtube.search({ query: e.name, category: 'youtube', limit: 15 }, pctx);
          add(vids.filter((v) => credits(v, e.name)), 'by', 10, () => `from ${e.name}`, 4);
        });
      } else if (ctx.stored) {
        run('stored creator videos', async () => add((await ctx.stored!('youtube', ['youtube'])).filter((v) => credits(v, e.name)), 'by', 10, () => `from ${e.name}`, 4));
      }
    } else if (ctx.resolved && may(ctx.resolved.category)) {
      // A film, series, book or show: the work itself.
      const r = ctx.resolved;
      add([r], 'by', 10, () => (r.creators[0] ? `the ${kindWord(r)} itself, by ${r.creators[0]}` : `the ${kindWord(r)} itself`), 1);
    } else if (e.kind === 'podcast' && may('podcasts') && ctx.stored) {
      run('stored podcast', async () => {
        const shows = [...(await ctx.stored!('spotify', ['podcasts'])), ...(await ctx.stored!('youtube', ['podcasts']))];
        add(shows.filter((s) => plausibleMatch(s, e.name)), 'by', 10, () => 'the show itself', 2);
      });
    }
  }

  // Things like it (works only: an artist's "like" is the curator's lane, an author's comes with their works).
  if (like && ctx.resolved && !person) {
    const r = ctx.resolved;
    const p = PROVIDERS[r.provider];
    if (p?.similar && !blocked(p.id) && may(r.category) && spend()) {
      run('similar', async () => add(await p.similar!(r, pctx), 'like', 40, () => `like ${r.title}`, 5));
    } else if (r.category === 'books' && may('books')) {
      const subj = r.tags.filter((t) => t.length <= 30 && !/fiction$|^nyt|accessible|protected|lending|large type/i.test(t))[0];
      if (subj && spend()) {
        run('same-subject books', async () => {
          const books = (await openLibrary.search({ query: `subject:"${subj}"`, category: 'books', limit: 15 }, pctx)).filter((b) => b.id !== r.id && !r.creators.some((c) => credits(b, c)));
          add(books, 'like', 40, () => `like ${r.title}: ${subj.toLowerCase()}`, 4);
        });
      }
    }
  }

  // Things about it: one YouTube search (stored videos naming it when YouTube is out of quota), and books.
  if (about) {
    if (may('youtube') && e.kind !== 'creator') {
      // YouTube search's OR operator is "|".
      const q = person ? `${e.name} interview|documentary|breakdown` : `${subject} explained|analysis|review`;
      if (ytOk && spend()) {
        run('videos about', async () => {
          const vids = await youtube.search({ query: q, category: 'youtube', limit: 15 }, pctx);
          add(vids.filter((v) => mentions(v, e.name)), 'about', 50, (v) => `a video about ${e.name}${v.creators[0] ? ` from ${v.creators[0]}` : ''}`, 2);
        });
      } else if (ctx.stored) {
        run('stored videos about', async () => {
          const vids = await ctx.stored!('youtube', ['youtube']);
          add(vids.filter((v) => mentions(v, e.name)), 'about', 50, (v) => `a video about ${e.name}${v.creators[0] ? ` from ${v.creators[0]}` : ''}`, 2);
        });
      }
    }
    if (may('books') && person && e.kind !== 'author' && spend()) {
      run('books about', async () => {
        const books = (await openLibrary.search({ query: e.name, category: 'books', limit: 15 }, pctx)).filter((b) => mentions(b, e.name));
        add(books, 'about', 30, (b) => (credits(b, e.name) ? `written by ${e.name}` : `a book about ${e.name}`), 2);
      });
    }
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
 * Am and 2 more."
 */
export function entityReply(e: Entity, recs: Array<Pick<Recommendation, 'item'>>): string {
  const lane = (id: string) => recs.filter((r) => r.item.category === 'music' && laneTagOf(r.item)?.id === id);
  const bySongs = lane(ENTITY_BY_LANE);
  const likeSongs = lane(ENTITY_LIKE_LANE);
  const extras = recs.filter((r) => isEntityExtra(r.item));
  const role = (r: EntityTag['role']) => extras.filter((x) => entityTagOf(x.item)?.role === r);
  const parts: string[] = [];
  if (bySongs.length) {
    const fresh = bySongs.filter((r) => r.item.metadata?.inLibrary !== true).length;
    const saved = fresh === bySongs.length ? 'none of them in your library yet' : fresh === 0 ? 'all already in your library' : `${fresh} you haven't saved`;
    parts.push(`${plural(bySongs.length, `song by ${e.name}`, `songs by ${e.name}`)} (${saved})`);
  }
  if (likeSongs.length) parts.push(`${plural(new Set(likeSongs.map((r) => fold(r.item.creators[0] ?? r.item.id))).size, 'artist')} in the same lane`);
  const byItems = role('by');
  if (byItems.length) parts.push(e.kind === 'film' || e.kind === 'series' || e.kind === 'book' || e.kind === 'podcast' ? `the ${KIND_WORD[byItems[0].item.kind] ?? 'work'} itself` : `${plural(byItems.length, 'work')} by ${e.name}`);
  const likeItems = role('like');
  if (likeItems.length) parts.push(`${plural(likeItems.length, 'pick')} like it`);
  const aboutItems = role('about');
  if (aboutItems.length) parts.push(`${plural(aboutItems.length, 'thing')} about ${e.name}: ${titlesList(aboutItems.map((r) => r.item.title))}`);
  if (!parts.length) return `I couldn't find ${e.name} in the connected catalogs right now.`;
  const last = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Here's ${e.name}: ${last}.`;
}
