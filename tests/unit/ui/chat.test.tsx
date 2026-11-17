// @vitest-environment jsdom
// Echo AI answers: songs grouped by their lane (an artist's own songs, artists like them) with "Play all"
// and tiles that play inline, then the other picks as cards. A restored conversation renders the same
// lanes from the message payload. Synthetic items; network and player mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MotionGlobalConfig } from 'motion/react';
import type { AnalyzedItem, Recommendation } from '@shared/types.ts';
import { chatPayloadRecs } from '@shared/engine/chat.ts';

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string) {
      super(message);
    }
  }
  const tables: Record<string, unknown[]> = { chat_sessions: [], chat_messages: [], content_items: [] };
  const calls: Array<[string, string, unknown[]]> = [];
  // A chainable stand-in for supabase-js queries: every filter returns the chain, awaiting it gives the table's rows.
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'eq', 'in']) c[m] = (...args: unknown[]) => (calls.push([table, m, args]), c);
    c.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, fail);
    return c;
  };
  return { ApiError, tables, calls, supabase: { from: (t: string) => chain(t) }, api: { chat: vi.fn(), feedback: vi.fn() }, playQueue: vi.fn() };
});

vi.mock('../../../src/lib/api', () => ({ api: h.api, ApiError: h.ApiError }));
vi.mock('../../../src/lib/auth', () => ({ useAuth: () => ({ session: { access_token: 't' }, loading: false }) }));
vi.mock('../../../src/lib/supabase', () => ({ supabase: h.supabase, functionsUrl: '', supabaseConfigured: true }));
vi.mock('../../../src/lib/ollama', () => ({ localIntentHint: async () => undefined }));
vi.mock('../../../src/hooks/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/hooks/data')>()),
  useLibraryMap: () => new Map(),
}));
vi.mock('../../../src/lib/player', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/player')>()),
  usePlayQueue: () => ({ playQueue: h.playQueue, playItem: vi.fn(), togglePlay: vi.fn(), currentId: null, mode: 'preview', playing: false }),
}));

import Chat from '../../../src/pages/Chat';

MotionGlobalConfig.skipAnimations = true;
// jsdom has no layout: scrolling the newest message into view is a no-op here.
Element.prototype.scrollIntoView = () => undefined;

const ARTIST = 'Nova Lyric';
const BY = { id: 'entity-by', label: ARTIST };
const LIKE = { id: 'entity-like', label: `Artists like ${ARTIST}` };
let n = 0;
const song = (title: string, artist: string, lane: { id: string; label: string }, extra: Record<string, unknown> = {}): AnalyzedItem => {
  const id = `C${String(++n).padStart(21, '0')}`;
  return {
    id: `spotify:track:${id}`, category: 'music', kind: 'track', provider: 'spotify', externalId: id, title, creators: [artist], genres: [], tags: [], externalUrl: 'https://open.spotify.com/track/x',
    embed: { type: 'spotify', uri: `spotify:track:${id}`, kind: 'track' }, concepts: {}, metadata: { lane, ...extra },
  };
};
const book: AnalyzedItem = {
  id: 'openlibrary:book:OL1W', category: 'books', kind: 'book', provider: 'openlibrary', externalId: 'OL1W', title: 'My Lyric Life', creators: [ARTIST], genres: [], tags: [],
  externalUrl: 'https://openlibrary.org/works/OL1W', embed: null, concepts: {}, metadata: { entity: { name: ARTIST, role: 'about', note: 'his illustrated memoir' } },
};
const rec = (item: AnalyzedItem, text: string): Recommendation => ({
  item, score: { query: 0, deep: 0, surface: 0, novelty: 0, context: 0, quality: 0, collaborative: 0, semantic: 0, penalty: 0, total: 0.5 }, explanation: { text, reasons: [{ kind: 'reference', detail: text }], matchedConcepts: [] },
});
const answer = [
  rec(song('Signature One', ARTIST, BY, { inLibrary: false, entity: { name: ARTIST, role: 'by' } }), 'Nova Lyric — not in your library yet'),
  rec(song('Night Letter', ARTIST, BY, { inLibrary: false, entity: { name: ARTIST, role: 'by' } }), 'Nova Lyric — not in your library yet'),
  rec(song('Library Favourite', ARTIST, BY, { inLibrary: true, entity: { name: ARTIST, role: 'by' } }), 'Nova Lyric — in your library'),
  rec(song('Peer Song', 'Peer One', LIKE, { entity: { name: ARTIST, role: 'like', note: 'storytelling rap' } }), 'Like Nova Lyric: storytelling rap'),
  rec(song('Peer Hit', 'Peer Two', LIKE, { entity: { name: ARTIST, role: 'like' } }), 'Like Nova Lyric: same scene'),
  rec(book, 'My Lyric Life — his illustrated memoir'),
];

beforeEach(() => {
  h.api.chat.mockResolvedValue({ intent: {}, recommendations: answer, reply: "Here's Nova Lyric: 3 songs by Nova Lyric (2 you haven't saved), 2 artists in the same lane and 1 thing about Nova Lyric: My Lyric Life.", providers: [], pipeline: [{ step: 'intent', ms: 1, detail: 'discover' }], sessionId: '11111111-1111-4111-8111-111111111111' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.tables.chat_sessions = [];
  h.tables.chat_messages = [];
  h.tables.content_items = [];
  h.calls.length = 0;
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Chat />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function expectLanes() {
  const headings = screen.getAllByRole('heading', { level: 3 }).map((x) => x.textContent);
  // Lanes in order, then the other picks (the book card's own heading).
  expect(headings.slice(0, 3)).toEqual([ARTIST, `Artists like ${ARTIST}`, 'My Lyric Life']);
  const by = screen.getByRole('region', { name: ARTIST });
  expect(within(by).getByText('3 songs · 2 not in your library yet')).toBeInTheDocument();
  expect(within(by).getAllByText('In your library')).toHaveLength(1);
  expect(within(by).getByRole('button', { name: /^Library Favourite, Nova Lyric\. Play$/ })).toHaveTextContent('In your library');
  const like = screen.getByRole('region', { name: `Artists like ${ARTIST}` });
  expect(within(like).queryByText('In your library')).toBeNull();
  return { by, like };
}

describe('Echo AI answer lanes', () => {
  it('groups songs by lane with Play all and inline-playing tiles, then the other picks', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Message Echo'), { target: { value: 'nova lyric' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    await screen.findByText(/Here's Nova Lyric/);
    const { by, like } = expectLanes();

    // "Play all" plays the lane from its first song.
    await act(async () => {
      fireEvent.click(within(by).getByRole('button', { name: `Play all: ${ARTIST}` }));
    });
    expect(h.playQueue).toHaveBeenLastCalledWith(answer.slice(0, 3).map((r) => r.item), 0);
    // A tile plays the lane from that song.
    await act(async () => {
      fireEvent.click(within(like).getByRole('button', { name: /^Peer Hit, Peer Two\. Play$/ }));
    });
    expect(h.playQueue).toHaveBeenLastCalledWith(answer.slice(3, 5).map((r) => r.item), 1);
    // The book is a card with its explanation.
    expect(screen.getByText('My Lyric Life — his illustrated memoir')).toBeInTheDocument();
  });

  it('a restored conversation shows the same lanes from the stored payload (not the shared catalog row)', async () => {
    const sid = '22222222-2222-4222-8222-222222222222';
    h.tables.chat_sessions = [{ id: sid, title: 'nova lyric', updated_at: '2026-11-16T10:00:00Z' }];
    h.tables.chat_messages = [
      { role: 'user', content: 'nova lyric', payload: null },
      { role: 'assistant', content: "Here's Nova Lyric.", payload: { recommendations: chatPayloadRecs(answer), intent: { summary: 'discover' } } },
    ];
    // Catalog rows: shared, so no per-answer lane / library / entity fields (one even carries another answer's lane).
    h.tables.content_items = answer.map((r, i) => ({
      id: r.item.id, category: r.item.category, kind: r.item.kind, provider: r.item.provider, external_id: r.item.externalId, title: r.item.title, creators: r.item.creators, description: null, genres: [], tags: [],
      artwork_url: null, duration_sec: null, language: null, release_date: null, external_url: r.item.externalUrl, embed: r.item.embed, playback_note: null, rating: null, popularity: null,
      metadata: i === 0 ? { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' } } : {}, concepts: {}, stale: false,
    }));
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /History/ }));
    });
    const session = await screen.findByRole('button', { name: /nova lyric/ });
    await act(async () => {
      fireEvent.click(session);
    });
    await screen.findByText("Here's Nova Lyric.");
    expectLanes();
    expect(screen.queryByText('Hip-hop & R&B')).toBeNull();
  });

  it('a long conversation loads its picks in groups (each URL stays short), without the embedding column', async () => {
    const sid = '33333333-3333-4333-8333-333333333333';
    const many = Array.from({ length: 230 }, (_, i) => rec(song(`Song ${i}`, `Artist ${i}`, BY), 'x'));
    h.tables.chat_sessions = [{ id: sid, title: 'long talk', updated_at: '2026-11-16T10:00:00Z' }];
    h.tables.chat_messages = [{ role: 'assistant', content: 'Many picks.', payload: { recommendations: chatPayloadRecs(many) } }];
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /History/ }));
    });
    const session = await screen.findByRole('button', { name: /long talk/ });
    await act(async () => {
      fireEvent.click(session);
    });
    await screen.findByText('Many picks.');
    const items = h.calls.filter(([t]) => t === 'content_items');
    const ins = items.filter(([, m]) => m === 'in').map(([, , a]) => a[1] as string[]);
    expect(ins.map((x) => x.length)).toEqual([100, 100, 30]);
    const selects = items.filter(([, m]) => m === 'select').map(([, , a]) => String(a[0]));
    expect(selects.every((cols) => cols !== '*' && !cols.includes('embedding') && cols.includes('metadata'))).toBe(true);
  });
});
