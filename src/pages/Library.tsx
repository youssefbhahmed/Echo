import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Music2, Search, Trash2 } from 'lucide-react';
import type { Category } from '@shared/types.ts';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { dbToItem, useCollections, useLibrary } from '../hooks/data';
import { MediaCard } from '../components/MediaCard';
import { CategoryTabs } from '../components/Controls';
import { PageHeader } from '../components/Shell';
import { Listening } from '../components/Echo';
import { toast } from '../components/Toast';

type Tab = 'saved' | 'liked' | 'finished' | 'collections';

export default function LibraryPage() {
  const lib = useLibrary();
  const collections = useCollections();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('saved');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [openCollection, setOpenCollection] = useState<string | null>(null);
  const [shown, setShown] = useState(30);
  useEffect(() => setShown(30), [tab, category, q, openCollection]);
  const refreshed = useRef(false);
  const pickedTab = useRef(false);
  // Open on the first tab that has something in it (e.g. "Loved" right after a Spotify import).
  useEffect(() => {
    if (pickedTab.current || !lib.data) return;
    pickedTab.current = true;
    const rows = lib.data;
    if (!rows.some((r) => r.saved)) setTab(rows.some((r) => r.liked || (r.rating ?? 0) >= 4) ? 'liked' : rows.some((r) => r.status === 'consumed') ? 'finished' : 'saved');
  }, [lib.data]);

  // Keep displayed items fresh: YouTube's 30-day policy, and cover art for imported Spotify songs.
  const asked = useRef(new Set<string>());
  const refreshVisible = (visible: Array<{ item_id: string; content_items: { provider: string; artwork_url: string | null; stale: boolean; metadata: Record<string, unknown> } | null }>) => {
    const ids = visible
      .filter((r) => r.content_items && !asked.current.has(r.item_id))
      .filter((r) => (r.content_items!.provider === 'spotify' && !r.content_items!.artwork_url) || (r.content_items!.provider === 'youtube' && (r.content_items!.stale || Date.now() - new Date(String(r.content_items!.metadata?.fetchedAt ?? 0)).getTime() > 25 * 86400_000)))
      .map((r) => r.item_id)
      .slice(0, 40);
    if (!ids.length) return;
    ids.forEach((id) => asked.current.add(id));
    api.refresh(ids).then((r) => { if (r.refreshed) qc.invalidateQueries({ queryKey: ['library'] }); }).catch(() => undefined);
  };
  void refreshed;

  const rows = useMemo(() => {
    let list = (lib.data ?? []).filter((r) => r.content_items);
    if (openCollection) {
      const ids = new Set(collections.data?.find((c) => c.id === openCollection)?.collection_items.map((x) => x.item_id) ?? []);
      list = list.filter((r) => ids.has(r.item_id));
    } else if (tab === 'saved') list = list.filter((r) => r.saved);
    else if (tab === 'liked') list = list.filter((r) => r.liked || (r.rating ?? 0) >= 4);
    else if (tab === 'finished') list = list.filter((r) => r.status === 'consumed');
    if (category !== 'all') list = list.filter((r) => r.content_items!.category === category);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((r) => `${r.content_items!.title} ${r.content_items!.creators.join(' ')} ${r.note ?? ''}`.toLowerCase().includes(needle));
    return list;
  }, [lib.data, tab, category, q, openCollection, collections.data]);

  useEffect(() => {
    refreshVisible(rows.slice(0, shown));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, shown]);

  // Items saved to collections but not otherwise in the library still need display data.
  const collection = collections.data?.find((c) => c.id === openCollection);

  const deleteCollection = async (id: string) => {
    if (!confirm('Delete this collection? Items stay in your library.')) return;
    const { error } = await supabase.from('collections').delete().eq('id', id);
    if (error) return toast(error.message, 'error');
    setOpenCollection(null);
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const exportToSpotify = async () => {
    if (!collection) return;
    const ids = collection.collection_items.map((x) => x.item_id).filter((id) => id.startsWith('spotify:'));
    if (!ids.length) return toast('This collection has no Spotify tracks.');
    try {
      const r = await api.spotifyPlaylist(collection.name, ids);
      toast(`Created a Spotify playlist with ${r.added} items.`);
      window.open(r.playlistUrl, '_blank', 'noopener');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const tabs: Array<[Tab, string, number]> = [
    ['saved', 'Saved', (lib.data ?? []).filter((r) => r.saved).length],
    ['liked', 'Loved', (lib.data ?? []).filter((r) => r.liked || (r.rating ?? 0) >= 4).length],
    ['finished', 'Finished', (lib.data ?? []).filter((r) => r.status === 'consumed').length],
    ['collections', 'Collections', collections.data?.length ?? 0],
  ];

  return (
    <div>
      <PageHeader eyebrow="My Library" title={<>Everything you’ve <span className="text-mist italic">kept</span></>} />
      <div className="px-4 md:px-8">
        <div className="scrollbar-none -mx-4 mt-6 flex gap-5 overflow-x-auto border-b border-line px-4" role="tablist">
          {tabs.map(([t, label, n]) => (
            <button key={t} role="tab" aria-selected={tab === t && !openCollection} type="button" onClick={() => { setTab(t); setOpenCollection(null); }} className={`shrink-0 border-b-2 pb-3 text-[15px] transition ${tab === t && !openCollection ? 'border-ember text-bone' : 'border-transparent text-mist hover:text-bone'}`}>
              {label} <span className="text-xs text-dim">{n}</span>
            </button>
          ))}
        </div>

        {tab === 'collections' && !openCollection ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(collections.data ?? []).length === 0 && <p className="text-sm text-mist">Create collections from any card’s “…” menu → Add to collection.</p>}
            {(collections.data ?? []).map((c) => {
              const covers = c.collection_items.slice(0, 4).map((x) => (lib.data ?? []).find((r) => r.item_id === x.item_id)?.content_items?.artwork_url).filter(Boolean) as string[];
              return (
                <button key={c.id} type="button" onClick={() => setOpenCollection(c.id)} className="flex items-center gap-4 rounded-[var(--radius-card)] border border-line bg-ink-2/70 p-3 text-left hover:border-white/15">
                  <div className="grid h-20 w-20 shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-xl bg-ink-3">
                    {covers.map((src, i) => <img key={i} src={src} alt="" className="h-full w-full object-cover" loading="lazy" />)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-display text-lg">{c.name}</p>
                    <p className="text-xs text-dim">{c.collection_items.length} items</p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            {openCollection && collection && (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setOpenCollection(null)} className="inline-flex items-center gap-1 text-sm text-mist hover:text-bone"><ArrowLeft className="h-4 w-4" /> Collections</button>
                <h2 className="font-display text-2xl">{collection.name}</h2>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={exportToSpotify} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm text-tide"><Music2 className="h-4 w-4" /> Save to Spotify</button>
                  <button type="button" onClick={() => deleteCollection(collection.id)} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm text-dim hover:text-danger"><Trash2 className="h-4 w-4" /> Delete</button>
                </div>
              </div>
            )}
            <div className="mt-5 space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-dim" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library" aria-label="Search your library" className="w-full rounded-2xl border border-line bg-ink-2/80 py-3 pr-4 pl-10 placeholder:text-dim focus:border-ember/50 focus:outline-none md:max-w-md" />
              </div>
              <CategoryTabs value={category} onChange={setCategory} />
            </div>
            {lib.isLoading ? <Listening label="Opening your library…" /> : rows.length === 0 ? (
              <div className="mx-auto max-w-sm py-20 text-center">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ember/10"><Search className="h-6 w-6 text-ember" aria-hidden /></div>
                <p className="mt-4 font-display text-xl">{q ? 'No matches' : 'Nothing here yet'}</p>
                <p className="mt-1.5 text-sm text-mist">{q ? 'Try another word, or clear the search.' : 'Save, like or finish things from Discover and Echo AI, and they’ll appear here.'}</p>
              </div>
            ) : (
              <>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rows.slice(0, shown).map((r) => <MediaCard key={r.item_id} item={dbToItem(r.content_items!)} source="library" />)}
              </div>
              {rows.length > shown && (
                <div className="mt-6 flex justify-center">
                  <button type="button" onClick={() => setShown((n) => n + 30)} className="rounded-full border border-line px-5 py-2.5 text-sm text-mist hover:text-bone">
                    Show more ({rows.length - shown} left)
                  </button>
                </div>
              )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
