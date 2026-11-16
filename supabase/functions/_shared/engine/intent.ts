// Pipeline step 1 — interpret a natural-language request into structured signals.
// Deterministic rules + the concept lexicon. An optional LLM can enrich the
// result (see ai.ts) but this parser alone is enough to drive the pipeline.
import { CATEGORIES, type Category, type ConceptVector, type Entity, type Intent, type PreferenceStatement, type ProviderId } from '../types.ts';
import { CONCEPT_BY_ID, CONCEPTS, MOOD_IDS } from './concepts.ts';
import { conceptHits, contentTokens, normalize, projectText, round, tokenize, topKeys } from './text.ts';

const CATEGORY_WORDS: Array<[RegExp, Category[]]> = [
  [/\b(youtubers?|video essays?|videos?|vid(e|é)os?|clips?|vlogs?|channels?|cha(i|î)nes?|lectures?|talks?|ted|conf(e|é)rences?)\b/, ['youtube']],
  [/\b(music|musique|songs?|chansons?|sons|tracks?|titres|morceaux|albums?|artists?|artistes?|bands?|groupes?|playlists?|tunes|beats|singers?|chanteu(r|se)s?|mix(tape)?)\b/, ['music']],
  [/\b(films?|movies?|cin(e|é)ma|series|s(e|é)ries?|tv|t(e|é)l(e|é)|shows?|sitcoms?|miniseries|anime|netflix|directors?|r(e|é)alisateurs?)\b/, ['screen']],
  [/\b(books?|livres?|novels?|romans?|read(ing)?|lire|lecture|authors?|auteurs?|literature|litt(e|é)rature|memoirs?|m(e|é)moires|(?<!video )essays?|essais|po(e|é)sie|poetry|poems?|non-?fiction|biograph(y|ies)|graphic novels?)\b/, ['books']],
  [/\b(podcasts?|episodes?|audio shows?|interviews?)\b/, ['podcasts']],
  [/\b(documentar(y|ies)|documentaires?|docuseries|docs)\b/, ['screen', 'youtube']],
];

const LANGS: Record<string, string> = {
  english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', japanese: 'ja', korean: 'ko',
  chinese: 'zh', mandarin: 'zh', arabic: 'ar', russian: 'ru', hindi: 'hi', turkish: 'tr', dutch: 'nl', swedish: 'sv', polish: 'pl', persian: 'fa',
};

/** Common provider genre words users type directly. */
export const GENRE_WORDS = [
  'jazz', 'blues', 'classical', 'ambient', 'rock', 'pop', 'hip hop', 'hip-hop', 'rap', 'metal', 'punk', 'folk', 'soul', 'r&b', 'electronic', 'techno',
  'house', 'indie', 'country', 'reggae', 'lo-fi', 'lofi', 'post-rock', 'shoegaze', 'synthwave', 'soundtrack', 'opera', 'gospel', 'funk', 'disco',
  'drama', 'comedy', 'thriller', 'horror', 'western', 'animation', 'anime', 'romance', 'fantasy', 'science fiction', 'sci-fi', 'documentary', 'mystery', 'crime',
  'biography', 'memoir', 'poetry', 'history', 'philosophy', 'science', 'economics', 'psychology', 'true crime', 'noir', 'musical', 'war',
];

const FILLER = new Set(
  ('feels feel watching listening reading sounds looks seems after before understand learn learning explore discover through serious same feeling feelings gives give vibe vibes mood moods completely totally usual usually preferences preference think would love loved enjoy outside comfort zone surprise new different something someone somewhere either kinda bit lot little good great best amazing nice ones one watch listen read tonight today right now currently starts start starting gradually becomes become ending ends end turns turning while also doesnt dont isnt have has has to be necessarily needn need deep complex light easy short long quick').split(' '),
);

const SENTIMENT = new Set(['bad', 'good', 'great', 'awful', 'terrible', 'boring', 'cool', 'nice', 'okay', 'ok', 'hate', 'love', 'liked', 'want', 'wanted', 'need', 'needed', 'them', 'those', 'these', 'stuff', 'anymore', 'please', 'thanks', 'thank', 'dont', 'theyre', 'its', 'im', 'ive']);
const NEG_STOP = new Set(['for', 'in', 'on', 'from', 'please', 'but', 'and', 'or', 'just', 'like', 'because', 'that', 'this', 'when', 'with', 'about', 'anymore', 'thanks', 'today', 'tonight', 'videos', 'video', 'songs', 'music', 'films', 'movies', 'books', 'podcasts', 'series']);
const CATEGORY_TOKEN = /^(videos?|songs?|music|films?|movies?|books?|podcasts?|series|shows?|tv|documentar(y|ies)|albums?|tracks?|novels?|episodes?|playlists?)$/;

// Small talk and refinement words: never read as a name.
const CHATTER = new Set(
  ('hmm hm hmmm hi hello hey yo sup thanks thank ok okay yes yeah yep no nope lol help test testing what why how who where when idk nothing anything something everything more less again please sure cool nice wow great good bad shorter longer only just another other others next back stop same different random surprise whatever play listen watch read show give tell find recommend suggest new old best top music songs videos films movies books podcasts series stuff things').split(' '),
);

/**
 * Rules fallback (AI unavailable): a short message (1–4 words) the rules can't read as a concept, genre,
 * mood, medium or anything else is probably a name ("eminem", "kendrick lamar"): a candidate entity of
 * unknown kind, everything about it.
 */
export function candidateEntity(original: string): Entity | null {
  const name = original.trim().replace(/^[\s"'“”«»]+|[\s"'“”«».!?,;:]+$/g, '').replace(/\s+/g, ' ');
  const words = name.split(' ').filter(Boolean);
  if (!words.length || words.length > 4 || name.length < 3 || name.length > 60) return null;
  if (/[?]/.test(original) || !/\p{L}/u.test(name)) return null;
  const tokens = tokenize(name);
  if (!tokens.length || tokens.every((t) => CHATTER.has(t) || FILLER.has(t) || SENTIMENT.has(t))) return null;
  if (CHATTER.has(tokens[0])) return null;
  return { name, kind: 'other', want: 'all', source: 'rules' };
}

const DESCRIPTIVE_VERBS = /(feel|feels|feeling|felt|sound|sounds|sounding|look|looks|seem|seems|taste|tastes)\s*$/;

function extractReferences(original: string): { refs: string[]; spans: string[] } {
  const refs: string[] = [];
  const spans: string[] = [];
  // Quoted titles are always references.
  for (const m of original.matchAll(/["“”«»]([^"“”«»]{2,80})["“”«»]/g)) {
    refs.push(m[1].trim());
    spans.push(m[0]);
  }
  const re = /\b(like|as|similar to|reminds me of|in the vein of|fans? of|inspired by|the spirit of)\s+([^,.;!?]+)/gi;
  for (const m of original.matchAll(re)) {
    const before = original.slice(0, m.index ?? 0).toLowerCase();
    const trigger = m[1].toLowerCase();
    if (trigger === 'like' && (/\b(i|we|you|they|i'd|we'd|would|'d|really|also|do|don't|didn't)\s*$/.test(before) || DESCRIPTIVE_VERBS.test(before))) continue;
    if (trigger === 'as' && !/\bsame\b[^.]*$|\bas\s+good\b/.test(before) && !/\b(much|well|such)\s*$/.test(before)) {
      // plain "as" is only a reference in "same ... as X"
      if (!/same/.test(before)) continue;
    }
    let candidate = m[2].split(/\s+(but|and then|though|although|except|without|that|which|who|while|because|so|with|only|or something)\b/i)[0].trim();
    candidate = candidate.replace(/^(the movie|the film|the book|the show|the series|the album|the song|the band|the artist|the podcast)\s+/i, '');
    candidate = candidate.split(/\s+/).slice(0, 7).join(' ');
    if (!candidate) continue;
    // Only treat as a title/creator if it looks like a proper noun (any capitalised word, not sentence-initial pronoun).
    const words = candidate.split(/\s+/);
    const looksProper = words.some((w) => /^[A-Z0-9]/.test(w)) && !/^(I|A|The|This|That|Something|Anything|Watching|Listening)$/.test(words[0] + (words.length === 1 ? '' : 'x'));
    if (!looksProper) continue;
    if (/ing$/i.test(words[0])) continue; // "like watching the sunrise" → descriptive
    refs.push(candidate);
    spans.push(m[0]);
  }
  return { refs: [...new Set(refs)].slice(0, 3), spans };
}

/** Map a phrase onto concept ids and genre words. */
export function phraseToConcepts(phrase: string): { concepts: string[]; genres: string[] } {
  const hits = conceptHits(phrase);
  let concepts = Object.keys(hits);
  // "science fiction" is a genre, not a statement about science.
  if (concepts.includes('sci-fi')) concepts = concepts.filter((c) => c !== 'science');
  const norm = normalize(phrase);
  let genres = GENRE_WORDS.filter((g) => new RegExp(`(^|\\s)${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(norm));
  return { concepts, genres: genres.includes('science fiction') ? genres.filter((g) => g !== 'science') : genres };
}

const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, sixth: 5, last: -1 };

function extractOrdinals(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|last)\s+(one|pick|item|result|recommendation|suggestion|song|track|film|movie|book|video|podcast|album)\b/g)) out.push(ORDINALS[m[1]]);
  for (const m of text.matchAll(/(?:#|number\s+|no\.\s*)(\d{1,2})\b/g)) out.push(Number(m[1]) - 1);
  return [...new Set(out)];
}

function extractStatements(original: string): PreferenceStatement[] {
  const out: PreferenceStatement[] = [];
  const pos = /\bi\s+(?:really\s+|absolutely\s+|truly\s+)?(?:love|adore|enjoy|like|am into|'m into|am obsessed with|'m obsessed with|am a (?:big |huge )?fan of|'m a (?:big |huge )?fan of)\s+([^,.;!?]+)/gi;
  const neg = /\bi\s+(?:really\s+)?(?:hate|dislike|can't stand|cannot stand|don't like|do not like|am not into|'m not into|am tired of|'m tired of)\s+([^,.;!?]+)/gi;
  for (const [re, polarity] of [[pos, 1], [neg, -1]] as const) {
    for (const m of original.matchAll(re)) {
      const subject = m[1].split(/\s+(but|and i|so|because|when)\b/i)[0].trim().split(/\s+/).slice(0, 6).join(' ');
      if (!subject || /^(to|it|that|this|when|how|something|anything|the idea)\b/i.test(subject)) continue;
      out.push({ polarity, subject, concepts: phraseToConcepts(subject).concepts });
    }
  }
  return out;
}

export interface ParseOptions {
  moods?: string[];
  categories?: Category[];
  exploration?: number;
}

export function parseIntent(rawText: string, opts: ParseOptions = {}): Intent {
  const original = (rawText ?? '').slice(0, 1000);
  const text = normalize(original);

  // Platforms are SOURCE filters when another kind of media is named ("youtube podcasts" = podcasts
  // from YouTube); on their own they mean their default category ("youtube" = videos, "spotify" = music).
  const PLATFORMS: Array<[RegExp, ProviderId, Category]> = [
    [/\b(on |from )?youtube\b/, 'youtube', 'youtube'],
    [/\b(on |from )?spotify\b/, 'spotify', 'music'],
  ];
  const platformText = PLATFORMS.reduce((t, [re]) => t.replace(new RegExp(re.source, 'g'), ' '), text);
  let categories: Category[] = [];
  for (const [re, cats] of CATEGORY_WORDS) if (re.test(platformText)) categories.push(...cats);
  const providers: ProviderId[] = [];
  for (const [re, id, cat] of PLATFORMS) {
    if (!re.test(text)) continue;
    if (categories.length) providers.push(id);
    else categories.push(cat);
  }
  if (!categories.length && /\b(listen|listening|hear)\b/.test(text)) categories.push('music', 'podcasts');
  if (!categories.length && /\bwatch(ing)?\b/.test(text) && !/\blike watching\b/.test(text)) categories.push('screen', 'youtube');
  const typedCategories = categories.length;
  if (opts.categories?.length) categories = [...categories, ...opts.categories];
  categories = [...new Set(categories)].filter((c) => (CATEGORIES as readonly string[]).includes(c));

  // References & statements (from original casing)
  const { refs, spans } = extractReferences(original);
  const statements = extractStatements(original);

  // Negations / relaxations
  const excludes: string[] = [];
  const relaxed: string[] = [];
  const negSpans: string[] = [];
  for (const m of text.matchAll(/\b(?:doesn't|doesnt|does not|don't|dont|do not|needn't|neednt|need not)\s+(?:have|need)\s+to\s+be\s+([a-z0-9\- ]{2,40}?)(?=$|\s(?:but|and|or|just|as long)\b|[,.;])/g)) {
    const p = phraseToConcepts(m[1]);
    relaxed.push(...p.concepts, ...p.genres);
    negSpans.push(m[0]);
  }
  for (const m of text.matchAll(/\bnot\s+necessarily\s+([a-z0-9\- ]{2,40}?)(?=$|\s(?:but|and|or)\b|[,.;])/g)) {
    const p = phraseToConcepts(m[1]);
    relaxed.push(...p.concepts, ...p.genres);
    negSpans.push(m[0]);
  }
  // "no motivational speeches for the videos" → exclude the 1–4 words after the negator,
  // stopping at function words; non-concept words become free-text exclusions.
  for (const m of text.matchAll(/\b(?:no|not|without|nothing|avoid|except|anything but|never|zero|less|no more|stop)\s+(?:too\s+|very\s+|any\s+|more\s+)?((?:[a-z0-9'\-]+\s?){1,4})/g)) {
    if (negSpans.some((s) => s.includes(m[0].trim()))) continue;
    const words = m[1].trim().split(/\s+/);
    const stop = words.findIndex((w) => NEG_STOP.has(w));
    const phrase = (stop === -1 ? words : words.slice(0, stop)).join(' ');
    if (!phrase || /^(necessarily|sure|really|that|this|the|same|have|need|be|so|bad|good|like|a|an|longer|one|it|them)$/.test(phrase.split(' ')[0])) continue;
    const p = phraseToConcepts(phrase);
    const terms = contentTokens(phrase).filter((t) => !FILLER.has(t) && !CATEGORY_TOKEN.test(t) && t.length > 2);
    if (!p.concepts.length && !p.genres.length && !terms.length) continue;
    excludes.push(...p.concepts, ...p.genres, ...(p.concepts.length || p.genres.length ? [] : terms));
    negSpans.push(m[0].trim().split(/\s+/).slice(0, 1 + (stop === -1 ? words.length : stop) + (m[0].includes(' too ') || m[0].includes(' very ') || m[0].includes(' any ') || m[0].includes(' more ') ? 1 : 0)).join(' '));
  }

  // Text used for concept projection excludes negated spans.
  let positiveText = text;
  for (const s of negSpans) positiveText = positiveText.replace(s, ' ');
  for (const s of spans) positiveText = positiveText.replace(normalize(s), ' ');
  const refText = refs.join(' ');

  const target: ConceptVector = projectText([
    { text: positiveText, weight: 1.6 },
    { text: refText, weight: 0.5 },
  ]);
  for (const ex of excludes) if (CONCEPT_BY_ID[ex]) target[ex] = -0.8;
  for (const r of relaxed) if (CONCEPT_BY_ID[r] && target[r] !== undefined) delete target[r];
  for (const m of opts.moods ?? []) if (CONCEPT_BY_ID[m]) target[m] = Math.max(target[m] ?? 0, 0.85);
  // Statements are about long-term taste, not this request's target.
  for (const st of statements) for (const c of st.concepts) if (target[c] !== undefined && !opts.moods?.includes(c)) target[c] = round(target[c] * 0.5);

  const moods = MOOD_IDS.filter((m) => (target[m] ?? 0) > 0).sort((a, b) => target[b] - target[a]);
  const themes = CONCEPTS.filter((c) => c.group !== 'mood' && (target[c.id] ?? 0) > 0).map((c) => c.id).sort((a, b) => target[b] - target[a]);

  // Genres explicitly typed
  const genres = GENRE_WORDS.filter((g) => {
    const re = new RegExp(`(^|\\s)${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    return re.test(positiveText);
  }).filter((g) => !relaxed.includes(g) && !excludes.includes(g));

  // Emotional trajectory: "starts melancholic ... becomes uplifting", "from sad to hopeful"
  let trajectory: Intent['trajectory'];
  const trajRe = /\b(?:starts?|starting|begins?|beginning|opens?|from)\b(.{0,60}?)\b(?:becomes?|becoming|turns?|turning|ends?|ending|into|to|then|gradually|builds? to|resolves? (?:in|into))\b(.{0,60})/;
  const tm = trajRe.exec(text);
  if (tm) {
    const fromHits = topKeys(projectText([{ text: tm[1], weight: 1 }]), 3).filter((k) => MOOD_IDS.includes(k));
    const toHits = topKeys(projectText([{ text: tm[2], weight: 1 }]), 3).filter((k) => MOOD_IDS.includes(k));
    if (fromHits[0] && toHits[0] && fromHits[0] !== toHits[0]) trajectory = { from: fromHits[0], to: toHits[0] };
  }
  if (!trajectory) {
    const after = /\bafter\s+(?:a\s+)?(.{0,40}?)(?:$|,|\.)/.exec(text);
    // "sunrise after a difficult night" → from melancholic towards uplifting
    if (after && /night|storm|loss|breakup|hard|difficult|dark/.test(after[1]) && (target.uplifting ?? 0) > 0) {
      trajectory = { from: 'melancholic', to: 'uplifting' };
    }
  }
  if (trajectory) {
    target[trajectory.from] = Math.max(target[trajectory.from] ?? 0, 0.7);
    target[trajectory.to] = Math.max(target[trajectory.to] ?? 0, 0.8);
  }

  // Energy & complexity
  let energy: Intent['energy'];
  if (/\b(energetic|upbeat|hype|workout|party|dance|pump|high energy|fast)\b/.test(text)) energy = 'high';
  else if (/\b(calm|chill|sleep|relax|relaxing|wind down|quiet|slow|gentle|soft|background)\b/.test(text)) energy = 'low';
  let complexity: Intent['complexity'];
  if (/\b(serious|in-depth|in depth|deep dive|rigorous|academic|complex|challenging|scholarly|thorough|dense|understand)\b/.test(text)) complexity = 'deep';
  else if (/\b(light|easy|casual|fun|simple|beginner|mindless|popcorn)\b/.test(text) && !/\blight after\b/.test(text)) complexity = 'light';
  if (complexity === 'deep') target.cerebral = Math.max(target.cerebral ?? 0, 0.6);
  if (complexity === 'light') target.accessible = Math.max(target.accessible ?? 0, 0.6);

  // Exploration
  let exploration = opts.exploration;
  if (/\b(outside (?:of )?my (?:usual|comfort|normal)|out of my comfort zone|completely different|something different|surprise me|never (?:heard|seen|tried)|new to me|unexpected|adventurous|off the beaten|hidden gems?|obscure|underrated|break my bubble|beyond my)\b/.test(text)) exploration = 0.9;
  else if (/\b(more of the same|similar to what i like|familiar|comfort (?:watch|listen|read)|safe pick|my usual)\b/.test(text)) exploration = 0.15;

  // Duration
  let duration: Intent['duration'];
  const minutes = /\b(?:under|less than|max(?:imum)?|within|<)\s*(\d{1,3})\s*(?:min|mins|minutes)\b/.exec(text);
  if (minutes) duration = Number(minutes[1]) <= 20 ? 'short' : 'medium';
  else if (/\b(short|quick|brief|bite-sized|few minutes)\b/.test(text)) duration = 'short';
  else if (/\b(long|long-form|longform|epic|marathon|binge|deep dive|lengthy)\b/.test(text)) duration = 'long';

  // Language
  let language: string | undefined;
  const lm = /\b(?:in|from)\s+(english|french|spanish|german|italian|portuguese|japanese|korean|chinese|mandarin|arabic|russian|hindi|turkish|dutch|swedish|polish|persian)\b|\b(english|french|spanish|german|italian|portuguese|japanese|korean|chinese|mandarin|arabic|russian|hindi|turkish|dutch|swedish|polish|persian)[- ]language\b/.exec(text);
  if (lm) language = LANGS[lm[1] ?? lm[2]];

  // Keywords for provider search (content words, minus filler/categories/negated)
  const negWords = new Set(negSpans.flatMap((s) => s.split(' ')));
  const excludedWords = new Set(excludes.flatMap((e) => e.split(' ')));
  const keywords = contentTokens(positiveText)
    // Contractions and bare sentiment words ("don't", "they're", "bad") are never search terms.
    .filter((t) => !FILLER.has(t) && !negWords.has(t) && !excludedWords.has(t) && !t.includes("'") && !SENTIMENT.has(t) && !CATEGORY_TOKEN.test(t) && !/^(youtube|spotify|netflix|apple|deezer)$/.test(t))
    .slice(0, 8);

  const ordinalRefs = extractOrdinals(text);

  // Intent type
  let kind: Intent['intent'] = 'discover';
  if ((exploration ?? 0) >= 0.8) kind = 'explore';
  else if (refs.length || ordinalRefs.length) kind = 'similar';
  else if (/\b(understand|learn|explain|teach|origins? of|how (?:does|did|do)|why (?:does|did|do)|history of|introduction to)\b/.test(text)) kind = 'learn';
  else if (moods.length && (/\b(feel|feeling|mood|vibe|i'm|im|sad|happy|nostalgic)\b/.test(text) || trajectory)) kind = 'mood';

  // Nothing else read: a short message is probably a name (see candidateEntity).
  const unread =
    typedCategories === 0 &&
    providers.length === 0 &&
    Object.keys(target).length === 0 &&
    refs.length === 0 &&
    ordinalRefs.length === 0 &&
    genres.length === 0 &&
    exploration === undefined &&
    statements.length === 0 &&
    !trajectory &&
    !language &&
    !excludes.length &&
    !relaxed.length;
  const entity = unread ? candidateEntity(original) : null;

  const vague = original.trim().length > 0 && unread && keywords.length < 2 && !entity;

  for (const k of Object.keys(target)) target[k] = round(target[k]);

  return {
    intent: kind,
    rawText: original,
    categories,
    moods,
    themes,
    genres,
    excludes: [...new Set(excludes)],
    relaxed: [...new Set(relaxed)],
    energy,
    complexity,
    exploration,
    trajectory,
    duration,
    language,
    references: refs,
    ordinalRefs,
    keywords,
    target,
    vague,
    statements,
    providers: providers.length ? providers : undefined,
    ...(entity ? { entities: [entity] } : {}),
    source: 'rules',
  };
}

/** Merge a follow-up message into the previous intent (conversational refinement). */
export function refineIntent(prev: Intent, next: Intent): Intent {
  const text = normalize(next.rawText);
  const isFreshRequest =
    next.references.length > 0 ||
    !!next.entities?.length ||
    (next.keywords.length >= 3 && !/^(more|less|only|just|shorter|longer|but|and|now|what about|how about|instead)\b/.test(text));
  if (isFreshRequest) return next;

  const target: ConceptVector = { ...prev.target };
  for (const [k, v] of Object.entries(next.target)) target[k] = round((target[k] ?? 0) * 0.5 + v);
  // "less dark" / "more upbeat"
  for (const m of text.matchAll(/\bless\s+([a-z\-]+)/g)) for (const c of phraseToConcepts(m[1]).concepts) target[c] = -0.7;
  for (const m of text.matchAll(/\bmore\s+([a-z\-]+)/g)) for (const c of phraseToConcepts(m[1]).concepts) target[c] = Math.max(target[c] ?? 0, 0.9);

  const onlyCats = /\b(only|just)\b/.test(text) && next.categories.length ? next.categories : null;
  let exploration = next.exploration ?? prev.exploration;
  if (/\bmore (adventurous|different|surprising|unexpected)\b/.test(text)) exploration = Math.min(1, (prev.exploration ?? 0.5) + 0.3);
  if (/\b(more familiar|safer|less (adventurous|weird|experimental))\b/.test(text)) exploration = Math.max(0, (prev.exploration ?? 0.5) - 0.3);
  let duration = next.duration ?? prev.duration;
  if (/\bshorter\b/.test(text)) duration = 'short';
  if (/\blonger\b/.test(text)) duration = 'long';

  return {
    ...prev,
    rawText: `${prev.rawText} → ${next.rawText}`,
    categories: onlyCats ?? (next.categories.length ? next.categories : prev.categories),
    providers: next.providers ?? (next.categories.length ? undefined : prev.providers),
    moods: [...new Set([...next.moods, ...prev.moods])].filter((m) => (target[m] ?? 0) > 0),
    themes: [...new Set([...next.themes, ...prev.themes])].filter((m) => (target[m] ?? 0) > 0),
    genres: [...new Set([...next.genres, ...prev.genres])].filter((g) => !next.excludes.includes(g)),
    excludes: [...new Set([...prev.excludes, ...next.excludes])],
    relaxed: [...new Set([...prev.relaxed, ...next.relaxed])],
    energy: next.energy ?? prev.energy,
    complexity: next.complexity ?? prev.complexity,
    exploration,
    trajectory: next.trajectory ?? prev.trajectory,
    duration,
    language: next.language ?? prev.language,
    references: prev.references,
    ordinalRefs: next.ordinalRefs,
    keywords: (() => {
      const banned = new Set([...prev.excludes, ...next.excludes].flatMap((e) => e.split(' ')));
      const merged = next.keywords.length ? [...new Set([...prev.keywords.slice(0, 4), ...next.keywords])] : prev.keywords;
      return merged.filter((k) => !banned.has(k)).slice(0, 8);
    })(),
    target,
    vague: false,
    statements: next.statements,
    intent: next.ordinalRefs.length ? 'similar' : prev.intent,
  };
}
