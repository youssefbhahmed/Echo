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
const everything = feed([item(100, 'books'), item(101, 'youtube'), item(102), item(103)]);

let musicResponses: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  musicResponses = [];
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

    // "Get more" asks for a fresh page without the songs on screen.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Get more/ }));
    });
    const last = h.api.discover.mock.calls.at(-1)![0] as { categories: Category[]; seed: number; exclude: string[] };
    expect(last).toMatchObject({ categories: ['music'], seed: 1 });
    expect(last.exclude).toEqual(expect.arrayContaining([item(1).id, item(2).id, item(3).id]));
    // A full page: the top song is the hero again, the rest in the lane, no note.
    await screen.findByText(/Today’s echo/);
    expect(songTiles()).toHaveLength(8);
    expect(screen.queryByText('That’s all ECHO could verify right now.')).toBeNull();
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

  it('only the tab\'s own category is shown, never the previous tab\'s other items', async () => {
    musicResponses.push(async () => feed([item(1), item(2)]));
    await openMusicTab();
    await screen.findByText('That’s all ECHO could verify right now.');
    expect(screen.queryByText('Pick 100')).toBeNull();
    expect(screen.queryByText('Pick 101')).toBeNull();
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
