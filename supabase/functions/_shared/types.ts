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

export type ProviderId = 'youtube' | 'spotify' | 'itunes' | 'tmdb' | 'tvmaze' | 'openlibrary' | 'podcastindex';

export type Embed =
  | { type: 'youtube'; videoId: string }
  | { type: 'spotify'; uri: string; kind: 'track' | 'album' | 'artist' | 'playlist' | 'show' | 'episode' }
  | { type: 'applepodcast'; collectionId: string; episodeId?: string }
  | { type: 'audio'; previewUrl: string; label?: string };

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
  /** Which parser produced this intent. */
  source: 'rules' | 'rules+llm' | 'rules+client-llm';
}

export interface PreferenceStatement {
  polarity: 1 | -1;
  subject: string;
  /** Concepts the subject maps onto (may be empty if it is a creator/title). */
  concepts: string[];
}

export type FeedbackType = 'like' | 'dislike' | 'save' | 'unsave' | 'skip' | 'rate' | 'consumed' | 'open' | 'play';

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
  };
  exploration: number;
  interactionCount: number;
  updatedAt: string | null;
  embedding?: number[] | null;
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
