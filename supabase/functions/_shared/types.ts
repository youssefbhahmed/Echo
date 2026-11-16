// Shared domain types for ECHO. Pure TypeScript: imported by Supabase Edge
// Functions (Deno) and by the React frontend (Vite). No runtime dependencies.

/** Top-level discovery categories shown in the UI. Add new ones here (e.g. 'places'). */
export const CATEGORIES = ['youtube', 'music', 'screen', 'books', 'podcasts'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ContentKind =
  | 'video'
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'movie'
  | 'series'
  | 'book'
  | 'podcast'
  | 'episode';

export type ProviderId = 'youtube' | 'spotify' | 'tmdb' | 'tvmaze' | 'openlibrary' | 'podcastindex';

export type Embed =
  | { type: 'youtube'; videoId: string }
  | { type: 'spotify'; uri: string; kind: 'track' | 'album' | 'artist' | 'playlist' | 'show' | 'episode' };

/** Normalized catalog item. Every provider adapter maps into this shape. */
export interface ContentItem {
  /** Stable id: `${provider}:${kind}:${externalId}` */
  id: string;
  category: Category;
  kind: ContentKind;
  provider: ProviderId;
  externalId: string;
  title: string;
  creators: string[];
  description?: string;
  genres: string[];
  /** Free-form subject/keyword tags from the provider (e.g. Open Library subjects, TMDB keywords). */
  tags: string[];
  artworkUrl?: string;
  durationSec?: number;
  language?: string;
  releaseDate?: string;
  externalUrl: string;
  embed?: Embed | null;
  /** When playback inside ECHO is impossible, explains why (shown to the user). */
  playbackNote?: string;
  /** Provider rating normalised to 0..1, when available. */
  rating?: number;
  /** Provider popularity normalised to 0..1, when available. */
  popularity?: number;
  metadata?: Record<string, unknown>;
}

/** Sparse vector keyed by concept id. */
export type ConceptVector = Record<string, number>;

/** Item enriched by the semantic analysis stage. */
export interface AnalyzedItem extends ContentItem {
  concepts: ConceptVector;
  /** Embedding (gte-small, 384d) when computed. */
  embedding?: number[] | null;
}

export type Energy = 'low' | 'medium' | 'high';
export type Complexity = 'light' | 'medium' | 'deep';
export type DurationPref = 'short' | 'medium' | 'long';

export interface Intent {
  /** discover = open-ended, similar = "like X", learn = understand a topic, mood = emotional target, explore = outside comfort zone */
  intent: 'discover' | 'similar' | 'learn' | 'mood' | 'explore';
  rawText: string;
  categories: Category[];
  moods: string[];
  themes: string[];
  /** Explicit genre words the user asked for (provider-level genres, e.g. "jazz", "documentary"). */
  genres: string[];
  /** Genres/themes the user explicitly does NOT want. */
  excludes: string[];
  /** Genres the user said are optional ("doesn't have to be sci-fi"). They are not required and not boosted. */
  relaxed: string[];
  energy?: Energy;
  complexity?: Complexity;
  /** 0 = familiar, 1 = adventurous; undefined = use the user's slider. */
  exploration?: number;
  trajectory?: { from: string; to: string };
  duration?: DurationPref;
  language?: string;
  /** Titles/creators the user referenced ("like Interstellar"). */
  references: string[];
  /** Ordinal references to previous results ("more like the second one"), 0-based. */
  ordinalRefs: number[];
  /** Free keywords used for provider search. */
  keywords: string[];
  /** Combined target concept vector derived from the request. */
  target: ConceptVector;
  /** True when the request is too vague to act on precisely. */
  vague: boolean;
  /** Preference statements detected ("I love Tarkovsky"). */
  statements: PreferenceStatement[];
  /** Catalog search phrase per category, from the AI interpreter. */
  searchQueries?: Partial<Record<Category, string>>;
  /** Source filter: only use these providers (e.g. "youtube podcasts"). */
  providers?: ProviderId[];
  /** Named people or works the request is about ("eminem", "books by Ursula K. Le Guin"), first = primary. */
  entities?: Entity[];
  /** Which parser produced this intent. */
  source: 'rules' | 'rules+llm' | 'rules+client-llm';
}

export const ENTITY_KINDS = ['artist', 'author', 'director', 'actor', 'creator', 'film', 'series', 'book', 'podcast', 'other'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** by = their own works, like = similar things, about = things about them, all = a bare name (by + like + about). */
export const ENTITY_WANTS = ['by', 'like', 'about', 'all'] as const;
export type EntityWant = (typeof ENTITY_WANTS)[number];
export const WORK_KINDS = ['film', 'series', 'book', 'podcast', 'video'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** A well-known work related to an entity, in another medium (from the AI interpreter; resolved against catalogs). */
export interface EntityWork {
  title: string;
  kind: WorkKind;
  /** Release / publication year, when known (checked against the catalog match). */
  year?: number;
  /** Author / director, when known (checked against the catalog match). */
  by?: string;
  /** How it relates, a few words ("the film based on his life"). */
  note?: string;
}

/** A named person or work the user asked about. */
export interface Entity {
  /** As the user wrote or meant it, properly capitalised ("Eminem"). */
  name: string;
  kind: EntityKind;
  want: EntityWant;
  /** Up to 4 related works in other media. */
  works?: EntityWork[];
  /** 'rules' = a short query the rules parser could not read otherwise (kind 'other'). */
  source?: 'llm' | 'rules';
}

/** Per-item entity tag (item.metadata.entity) on results answering an entity request. */
export interface EntityTag {
  name: string;
  role: 'by' | 'like' | 'about';
  /** Short reason in plain words ("the film based on his life", "storytelling rap with rapid-fire flow"). */
  note?: string;
}

export interface PreferenceStatement {
  polarity: 1 | -1;
  subject: string;
  /** Concepts the subject maps onto (may be empty if it is a creator/title). */
  concepts: string[];
}

export type FeedbackType = 'like' | 'unlike' | 'dislike' | 'save' | 'unsave' | 'skip' | 'rate' | 'consumed' | 'open' | 'play';

export interface TasteProfile {
  /** Long-term concept affinities, roughly -3..3. */
  concepts: ConceptVector;
  /** Long-term affinities per concept per category (powers cross-media insight). */
  conceptsByCategory: Partial<Record<Category, ConceptVector>>;
  genres: Record<string, number>;
  creators: Record<string, number>;
  categories: Partial<Record<Category, number>>;
  /** Short-term context (mood / session). Decays quickly. */
  shortTerm: { concepts: ConceptVector; updatedAt: string | null };
  /** User-declared statements and edits; always respected. */
  explicit: {
    likes: string[];
    dislikes: string[];
    statements: string[];
    pinnedConcepts: string[];
    blockedConcepts: string[];
    /** Music style families the user never wants (see engine/music.ts). */
    blockedFamilies?: string[];
  };
  exploration: number;
  interactionCount: number;
  updatedAt: string | null;
  embedding?: number[] | null;
  /** Summary of an imported music library (styles, recent shift, eras, moods, languages). */
  music?: MusicDna | null;
  /** 2 = music and non-music taste kept apart (see separateMusicTaste). */
  domainsVersion?: number;
  /** Learned per-lane bias from feedback on lane picks (lane id → -1..1); scales how often a lane is chosen. */
  laneFeedback?: Record<string, number>;
}

export interface MusicDna {
  tracks: number;
  distinctArtists: number;
  styles: string[];
  recentStyles: string[];
  decades: string[];
  languages: string[];
  mood: { valence: number; energy: number; danceability: number; topQuadrant: string };
  importedAt: string;
  /** Taste lanes of the library (see engine/lanes.ts), owner policy applied, shares sum to 1. */
  lanes?: MusicLane[];
  /** Rules the music curator and resolver always apply. */
  policy?: MusicPolicy;
}

/** A coherent listening lane of the user's library ("Afro & melodic house"). Generic words only: no track/artist names. */
export interface MusicLane {
  id: string;
  /** Human shelf title, e.g. "Hip-hop & R&B". */
  label: string;
  /** Share of the music picks this lane should get (0..1). */
  share: number;
  /** Generic descriptors (sub-genres, mood, tempo/energy, era) used to brief the curator. */
  descriptors: string[];
  /** Release-year window of the lane (regional lanes never start before policy.regionalMinYear). */
  era: { from: number; to: number };
  /** Medians of the lane's audio features (0..1). */
  energy: number;
  danceability: number;
  valence: number;
  /** Spotify popularity quartiles (0..100) of the user's songs in this lane. */
  popularity: { p25: number; p50: number; p75: number };
  /** French / Arabic / Maghreb lanes: capped share, modern releases only. */
  regional: boolean;
  /** Top sub-genre tags of the lane (generic labels). */
  genres: string[];
  /** Where the lane came from: the imported library (measured), learned genre weights, or a default open lane. */
  source?: 'library' | 'genres' | 'default';
}

export interface MusicPolicy {
  /** Combined share of all regional lanes. */
  regionalShare: number;
  /** Regional lanes only take releases from this year on. */
  regionalMinYear: number;
  /** 'library' = songs known in their scene at the popularity of the user's own library; never obscure or experimental. */
  familiarity: 'library';
}

/** Lane tag carried by every music recommendation the engine produces (item.metadata.lane). */
export interface LaneTag {
  id: string;
  label: string;
}

export interface ScoreBreakdown {
  query: number;
  deep: number;
  surface: number;
  novelty: number;
  context: number;
  quality: number;
  collaborative: number;
  semantic: number;
  penalty: number;
  total: number;
}

export interface Explanation {
  text: string;
  /** Machine-readable reasons used to build the text (for transparency UI). */
  reasons: Array<{ kind: 'query' | 'profile' | 'creator' | 'novelty' | 'reference' | 'quality' | 'collaborative' | 'context' | 'trajectory'; detail: string }>;
  /** Concepts detected in the item and how they were found. */
  matchedConcepts: string[];
}

export interface Recommendation {
  item: AnalyzedItem;
  score: ScoreBreakdown;
  explanation: Explanation;
  /** Position within an emotional trajectory, when sequenced. */
  trajectoryStep?: number;
}

export interface DiscoverRequest {
  query?: string;
  categories?: Category[];
  moods?: string[];
  exploration?: number;
  limit?: number;
  sessionId?: string;
  /** Limit used instead of `limit` when the request names an entity (chat: 20 instead of 12). */
  entityLimit?: number;
  /** Feed mix: relative weight per category (0.5 less, 1 normal, 2 more). */
  mix?: Partial<Record<Category, number>>;
  /** Intent produced by an optional client-side LLM (e.g. local Ollama). Validated server-side. */
  intentHint?: Partial<Intent>;
}

export interface DiscoverResponse {
  intent: Intent;
  recommendations: Recommendation[];
  reply?: string;
  clarifyingQuestion?: { text: string; options: string[] } | null;
  providers: Array<{ id: ProviderId; status: 'ok' | 'unconfigured' | 'error' | 'quota' | 'cached'; message?: string }>;
  pipeline: Array<{ step: string; ms: number; detail?: string }>;
  sessionId?: string;
}
