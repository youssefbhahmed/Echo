import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Download, LogOut, Music2, Smartphone, Trash2 } from 'lucide-react';
import { CATEGORIES, type Category } from '@shared/types.ts';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { getLocalAi, setLocalAi, testLocalAi, type LocalAiSettings } from '../lib/ollama';
import { useProfile } from '../hooks/data';
import { CATEGORY_META } from '../lib/meta';
import { PageHeader } from '../components/Shell';
import { ExplorationSlider } from '../components/Controls';
import { toast } from '../components/Toast';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function Card({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-[var(--radius-card)] border border-line bg-ink-2/70 p-5">
      <h2 className="font-display text-xl">{title}</h2>
      <div className="mt-4 space-y-4 text-sm">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const { data } = useProfile();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [local, setLocal] = useState<LocalAiSettings>(getLocalAi());
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const spotifyServer = data?.server.providers.find((p) => p.id === 'spotify');
  const spotify = useQuery({ queryKey: ['spotify'], queryFn: api.spotifyStatus, retry: false, enabled: !!spotifyServer?.configured });

  useEffect(() => setName(data?.account.display_name ?? ''), [data?.account.display_name]);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', h);
    const p = new URLSearchParams(window.location.search).get('spotify');
    if (p) {
      toast(p === 'connected' ? 'Spotify connected.' : 'Spotify connection was cancelled.', p === 'connected' ? 'info' : 'error');
      window.history.replaceState({}, '', '/settings');
    }
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  const saveName = async () => {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from('profiles').update({ display_name: name.slice(0, 80) }).eq('id', u.user!.id);
    if (error) return toast(error.message, 'error');
    qc.invalidateQueries({ queryKey: ['profile'] });
    toast('Saved.');
  };

  const setCategories = async (cats: Category[]) => {
    const { data: u } = await supabase.auth.getUser();
    const settings = { ...(data?.account.settings ?? {}), categories: cats };
    const { error } = await supabase.from('profiles').update({ settings }).eq('id', u.user!.id);
    if (error) return toast(error.message, 'error');
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['feed'] });
  };

  const exportData = async () => {
    try {
      const json = await api.exportData();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `echo-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const deleteAccount = async () => {
    const typed = prompt('This permanently deletes your account, taste profile, library and history. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    try {
      await api.deleteAccount();
      await supabase.auth.signOut();
      qc.clear();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const clearChats = async () => {
    if (!confirm('Delete all Echo AI conversations?')) return;
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from('chat_sessions').delete().eq('user_id', u.user!.id);
    if (error) return toast(error.message, 'error');
    qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    toast('Conversations deleted.');
  };

  const clearHistory = async () => {
    if (!confirm('Clear your recommendation history (“recently discovered”)?')) return;
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from('recommendation_events').delete().eq('user_id', u.user!.id);
    if (error) return toast(error.message, 'error');
    qc.invalidateQueries({ queryKey: ['recent'] });
    toast('History cleared.');
  };

  const enabledCats = ((data?.account.settings?.categories as Category[] | undefined) ?? []).length ? (data!.account.settings!.categories as Category[]) : [...CATEGORIES];
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  return (
    <div>
      <PageHeader eyebrow="Settings" title={<>Make ECHO <span className="text-mist italic">yours</span></>} />
      <div className="mt-6 grid gap-4 px-4 md:px-8 lg:grid-cols-2">
        <Card title="Account">
          <p className="text-mist">Signed in as <span className="text-bone">{data?.account.email}</span></p>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Display name" aria-label="Display name" className="min-w-0 flex-1 rounded-xl border border-line bg-ink-3 px-3 py-2.5 focus:border-ember/50 focus:outline-none" />
            <button type="button" onClick={saveName} className="rounded-xl bg-bone px-4 font-semibold text-ink">Save</button>
          </div>
          <p className="text-xs text-dim">Your library, taste profile and conversations sync across every device you sign in on.</p>
          <button type="button" onClick={() => supabase.auth.signOut().then(() => qc.clear())} className="inline-flex items-center gap-2 text-mist hover:text-bone"><LogOut className="h-4 w-4" /> Sign out</button>
        </Card>

        <Card title="Recommendation preferences">
          <ExplorationSlider value={data?.model.exploration ?? 0.4} onChange={(v) => api.editProfile({ exploration: v }).then(() => qc.invalidateQueries({ queryKey: ['profile'] }))} />
          <div>
            <p className="mb-2 text-mist">Categories in your feed</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => {
                const on = enabledCats.includes(c);
                const m = CATEGORY_META[c];
                return (
                  <button key={c} type="button" aria-pressed={on} onClick={() => setCategories(on ? enabledCats.filter((x) => x !== c) : [...enabledCats, c])} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${on ? 'border-ember/50 bg-ember/10 text-bone' : 'border-line text-dim'}`}>
                    <m.icon className="h-4 w-4" style={{ color: m.color }} /> {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        <Card title="Connected platforms" id="platforms">
          <div className="flex items-start gap-3 rounded-2xl bg-ink-3/60 p-3">
            <Music2 className="mt-0.5 h-5 w-5 text-tide" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Spotify account</p>
              <p className="text-xs text-mist">Optional. Lets ECHO create playlists in your Spotify account from your collections. Playback inside ECHO works without connecting.</p>
              {!spotifyServer?.configured ? (
                <p className="mt-2 text-xs text-amber">Spotify isn’t configured on this server yet (see below).</p>
              ) : spotify.data?.connected ? (
                <button type="button" onClick={() => api.spotifyDisconnect().then(() => spotify.refetch())} className="mt-2 text-xs text-dim hover:text-danger">Connected ✓ · Disconnect</button>
              ) : (
                <button type="button" onClick={async () => { try { const r = await api.spotifyAuthorize(`${window.location.origin}/settings`); window.location.href = r.url; } catch (e) { toast((e as Error).message, 'error'); } }} className="mt-2 rounded-full bg-tide px-3.5 py-1.5 text-xs font-semibold text-ink">Connect Spotify</button>
              )}
            </div>
          </div>
          <div>
            <p className="mb-2 text-mist">Content sources on this server</p>
            <ul className="space-y-2">
              {(data?.server.providers ?? []).map((p) => (
                <li key={p.id} className="flex items-start gap-2.5">
                  {p.configured ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-tide" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />}
                  <div>
                    <p>{p.label} <span className="text-xs text-dim">· {p.categories.map((c) => CATEGORY_META[c].label).join(', ')}</span></p>
                    {!p.configured && p.setup && <p className="text-xs text-dim">{p.setup}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card title="AI providers">
          <div className="rounded-2xl bg-ink-3/60 p-3">
            <p className="font-medium">Server inference</p>
            <p className="text-xs text-mist">
              {data?.server.ai.enabled ? <>Enabled ({data.server.ai.model}). Used only to interpret your request; recommendations always come from real catalogs and ECHO’s ranking engine.</> : <>Off. ECHO’s built-in rules engine interprets requests, so no AI service is required. Admins can enable a free-tier OpenAI-compatible provider via <code>AI_BASE_URL</code>/<code>AI_MODEL</code>.</>}
            </p>
            <p className="mt-1 text-xs text-dim">Semantic embeddings (gte-small): {data?.server.embeddings ? 'on' : 'off'}</p>
          </div>
          <div className="rounded-2xl bg-ink-3/60 p-3">
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="font-medium">Local Ollama on this device</span>
                <span className="block text-xs text-mist">Optional. Interprets requests with a model on your computer. ECHO keeps working when it’s off.</span>
              </span>
              <input type="checkbox" checked={local.enabled} onChange={(e) => { const s = { ...local, enabled: e.target.checked }; setLocal(s); setLocalAi(s); }} className="h-5 w-5 accent-[var(--color-ember)]" />
            </label>
            {local.enabled && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input value={local.url} onChange={(e) => { const s = { ...local, url: e.target.value }; setLocal(s); setLocalAi(s); }} aria-label="Ollama URL" className="rounded-xl border border-line bg-ink-2 px-3 py-2" />
                <input value={local.model} onChange={(e) => { const s = { ...local, model: e.target.value }; setLocal(s); setLocalAi(s); }} aria-label="Ollama model" className="rounded-xl border border-line bg-ink-2 px-3 py-2" />
                <button type="button" onClick={async () => setLocalStatus(await testLocalAi(local))} className="rounded-xl border border-line px-3 py-2 text-left text-mist hover:text-bone sm:col-span-2">Test connection</button>
                {localStatus && <p className="text-xs text-mist sm:col-span-2">{localStatus}</p>}
                <p className="text-xs text-dim sm:col-span-2">Start Ollama with <code>OLLAMA_ORIGINS={window.location.origin}</code> so the browser may reach it.</p>
              </div>
            )}
          </div>
        </Card>

        <Card title="Privacy & data">
          <p className="text-mist">ECHO stores your taste profile, feedback, library, collections and conversations in your account. Every row is protected by database row-level security, so only you can read it. Provider API keys and Spotify tokens stay on the server and never reach your browser.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={exportData} className="inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-2 hover:border-white/20"><Download className="h-4 w-4" /> Export my data (JSON)</button>
            <button type="button" onClick={clearChats} className="rounded-full border border-line px-3.5 py-2 text-mist hover:text-bone">Delete conversations</button>
            <button type="button" onClick={clearHistory} className="rounded-full border border-line px-3.5 py-2 text-mist hover:text-bone">Clear history</button>
          </div>
          <button type="button" onClick={deleteAccount} className="inline-flex items-center gap-2 text-danger"><Trash2 className="h-4 w-4" /> Delete my account permanently</button>
        </Card>

        <Card title="Install ECHO">
          {standalone ? <p className="text-tide">Installed ✓ You’re using the app.</p> : installEvt ? (
            <button type="button" onClick={async () => { await installEvt.prompt(); setInstallEvt(null); }} className="inline-flex items-center gap-2 rounded-full bg-ember px-4 py-2 font-semibold text-ink"><Smartphone className="h-4 w-4" /> Install app</button>
          ) : isIos ? (
            <p className="text-mist">On iPhone/iPad: tap <b>Share</b> → <b>Add to Home Screen</b>.</p>
          ) : (
            <p className="text-mist">Use your browser’s install option (address bar icon or menu → “Install ECHO”). Works on Windows, macOS, Android and ChromeOS.</p>
          )}
        </Card>

        <Card title="About">
          <p className="text-mist">ECHO v0.1. Discover beyond the algorithm.</p>
          <p className="text-xs text-dim">Catalog data from YouTube, Spotify, TMDB, TVmaze and Open Library. This product uses the TMDB API but is not endorsed or certified by TMDB. TV data from TVmaze (CC BY-SA). Playback uses each platform’s official embedded player.</p>
        </Card>
      </div>
    </div>
  );
}
