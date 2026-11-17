// @vitest-environment jsdom
// Discover on a single-category tab: a small page shows every pick (no hero swallowing it), a short music
// page offers "Get more", an empty page says so, and a failed request offers Retry. Network mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MotionGlobalConfig } from 'motion/react';
import type { AnalyzedItem, Category, Recommendation } from '@shared/types.ts';

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: { discover: vi.fn(), editProfile: vi.fn(), profile: vi.fn() },
    playQueue: vi.fn(),
  };
});

vi.mock('../../../src/lib/api', () => ({ api: h.api, ApiError: h.ApiError }));
vi.mock('../../../src/lib/auth', () => ({ useAuth: () => ({ session: { access_token: 't' }, loading: false }) }));
vi.mock('../../../src/lib/supabase', () => ({ supabase: {}, functionsUrl: '', supabaseConfigured: true }));
vi.mock('../../../src/hooks/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/hooks/data')>()),
  useProfile: () => ({ data: { account: { display_name: 'Tester', settings: {} }, model: { exploration: 0.4 } } }),
  useRecent: () => ({ data: [] }),
  useLibraryMap: () => new Map(),
}));
vi.mock('../../../src/lib/player', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/player')>()),
  usePlayQueue: () => ({ playQueue: h.playQueue, currentId: null }),
}));

import Discover from '../../../src/pages/Discover';

MotionGlobalConfig.skipAnimations = true;

// Synthetic items with 22-character ids.
const item = (n: number, category: Category = 'music'): AnalyzedItem => {
  const id = `D${String(n).padStart(21, '0')}`;
  const music = category === 'music';
  return {
    id: music ? `spotify:track:${id}` : `test:${category}:${n}`, category, kind: music ? 'track' : category === 'youtube' ? 'video' : 'book', provider: music ? 'spotify' : 'openlibrary',
    externalId: id, title: `Pick ${n}`, creators: [`Maker ${n}`], genres: [], tags: [], externalUrl: 'https://example.org',
    embed: music ? { type: 'spotify', uri: `spotify:track:${id}`, kind: 'track' } : null, concepts: {},
    metadata: music ? { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' } } : {},
  };
};
const rec = (i: AnalyzedItem): Recommendation => ({
  item: i, score: { total: 0.5 } as Recommendation['score'], explanation: { text: 'Because.', reasons: [{ kind: 'profile', detail: 'Because.' }], matchedConcepts: [] },
});
const feed = (items: AnalyzedItem[]) => ({ intent: {}, recommendations: items.map(rec), providers: [], pipeline: [] });
let everything = feed([item(100, 'books'), item(101, 'youtube'), item(102), item(103)]);

let musicResponses: Array<() => Promise<unknown>> = [];

/** A response the test settles itself (the Music request stays in flight until then). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  musicResponses = [];
  everything = feed([item(100, 'books'), item(101, 'youtube'), item(102), item(103)]);
  h.api.discover.mockImplementation(async (body: { categories?: Category[] }) => {
    if (body.categories?.length === 1 && body.categories[0] === 'music') return (musicResponses.shift() ?? (async () => feed([])))();
    return everything;
  });
  h.api.editProfile.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMusicTab() {
  mount();
  await screen.findByText('Today’s echo', { exact: false });
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /Music/ }));
  });
}

const songTiles = () => screen.queryAllByRole('button', { name: /^Pick \d+, Maker \d+\. Play$/ });

describe('Discover, single-category tab', () => {
  it('a small music page shows every song in its lane (no hero), with a calm note and "Get more"', async () => {
    musicResponses.push(async () => feed([item(1), item(2), item(3)]));
    musicResponses.push(async () => feed([item(4), item(5), item(6), item(7), item(8), item(9), item(10), item(11), item(12)]));
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(songTiles()).toHaveLength(3);
    expect(screen.queryByText(/Today’s echo/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Hip-hop & R&B' })).toBeInTheDocument();
    expect(screen.getByText('Play all')).toBeInTheDocument();
    expect(screen.queryByText('Nothing new here right now.')).toBeNull();

    // "Get more" asks for a new page without the songs on screen, and adds it to them.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Get more/ }));
    });
    const last = h.api.discover.mock.calls.at(-1)![0] as { categories: Category[]; seed: number; exclude: string[] };
    expect(last).toMatchObject({ categories: ['music'], seed: 1 });
    expect(last.exclude).toEqual(expect.arrayContaining([item(1).id, item(2).id, item(3).id]));
    await screen.findByText('Pick 12');
    // The 3 songs stay first, the 9 new ones follow (still one lane, no hero taking the first song), no note.
    expect(songTiles().map((t) => t.getAttribute('aria-label')?.split(',')[0])).toEqual(['Pick 1', 'Pick 2', 'Pick 3', 'Pick 4', 'Pick 5', 'Pick 6', 'Pick 7', 'Pick 8', 'Pick 9', 'Pick 10', 'Pick 11', 'Pick 12']);
    expect(screen.queryByText(/Today’s echo/)).toBeNull();
    expect(screen.queryByText('That’s all ECHO could verify right now.')).toBeNull();
  });

  it('"Get more" never makes the page emptier: an empty new page keeps the songs on screen', async () => {
    musicResponses.push(async () => feed([item(1), item(2), item(3), item(4), item(5)]));
    const next = deferred<unknown>();
    musicResponses.push(() => next.promise);
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Get more/ }));
    });
    // While the new page loads, the songs stay (dimmed) and the note says what is happening.
    expect(songTiles()).toHaveLength(5);
    expect(screen.getByText('Looking for more songs…')).toBeInTheDocument();
    await act(async () => {
      next.resolve(feed([]));
    });
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(songTiles()).toHaveLength(5);
    expect(screen.queryByText('Nothing new here right now.')).toBeNull();
  });

  it('"New picks" replaces the page (and forgets songs kept by "Get more")', async () => {
    musicResponses.push(async () => feed([item(1), item(2)]));
    musicResponses.push(async () => feed([item(3)]));
    musicResponses.push(async () => feed([item(4), item(5)]));
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Get more/ }));
    });
    await screen.findByText('Pick 3');
    expect(songTiles()).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /New picks/ }));
    });
    await screen.findByText('Pick 5');
    expect(songTiles().map((t) => t.getAttribute('aria-label')?.split(',')[0])).toEqual(['Pick 4', 'Pick 5']);
    const last = h.api.discover.mock.calls.at(-1)![0] as { exclude: string[] };
    expect(last.exclude).toEqual(expect.arrayContaining([item(1).id, item(2).id, item(3).id]));
  });

  it('a single song is a tile, not a hero over an empty page', async () => {
    musicResponses.push(async () => feed([item(1)]));
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(songTiles()).toHaveLength(1);
    // A plain page header (category + count) instead of the hero; the lane says the same count.
    expect(screen.getByRole('heading', { level: 1, name: 'Music' })).toBeInTheDocument();
    expect(screen.getAllByText('1 song')).toHaveLength(2);
  });

  it('while the Music page loads, the Everything feed never stands in for it', async () => {
    // A big Everything feed led by a book (it would be the hero) with two songs in it.
    everything = feed([item(100, 'books'), item(101, 'youtube'), item(102), item(103), item(104, 'books'), item(105, 'youtube'), item(106, 'books')]);
    const music = deferred<unknown>();
    musicResponses.push(() => music.promise);
    await openMusicTab();
    expect(h.api.discover.mock.calls.at(-1)![0]).toMatchObject({ categories: ['music'] });
    // Loading: the skeleton, not the Everything songs passed off as the finished Music page.
    expect(screen.getByText('Finding your picks…')).toBeInTheDocument();
    for (const n of [100, 101, 102, 103, 104]) expect(screen.queryByText(`Pick ${n}`)).toBeNull();
    expect(screen.queryByText('That’s all ECHO could verify right now.')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Music' })).toBeNull();
    expect(screen.queryByText('2 songs')).toBeNull();
    // The Music page arrives: only its songs (a stray non-music item in it is never shown on this tab).
    await act(async () => {
      music.resolve(feed([item(1), item(2), item(50, 'books')]));
    });
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(songTiles().map((t) => t.getAttribute('aria-label')?.split(',')[0])).toEqual(['Pick 1', 'Pick 2']);
    expect(screen.queryByText('Pick 50')).toBeNull();
    expect(screen.getAllByText('2 songs')).toHaveLength(2);
  });

  it('a song shown again on a short page says so', async () => {
    const again = { ...item(7), metadata: { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' }, fallbackTier: 3 } };
    musicResponses.push(async () => feed([item(1), again]));
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(screen.getAllByText('Shown again')).toHaveLength(1);
  });

  it('an empty music page says so', async () => {
    musicResponses.push(async () => feed([]));
    await openMusicTab();
    await screen.findByText('Nothing new here right now.');
    expect(songTiles()).toHaveLength(0);
    expect(screen.queryByText('That’s all ECHO could verify right now.')).toBeNull();
    expect(screen.getByRole('button', { name: /New picks/ })).toBeInTheDocument();
  });

  it('a failed request shows a short message with Retry instead of a blank page', async () => {
    musicResponses.push(async () => {
      throw new h.ApiError(500, 'Something went wrong on our side.');
    });
    musicResponses.push(async () => feed([item(1), item(2)]));
    await openMusicTab();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ECHO couldn’t load your picks.');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    });
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(songTiles()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
