// Global music queue: one tap plays, the rest of the shelf follows automatically.
// Two modes:
//  • SPOTIFY — the user's Spotify Premium account is connected with playback permission: full songs play in their
//    Spotify app (Spotify Connect, remote-controlled through the `spotify` function) and ECHO shows its own bar.
//  • PREVIEW — Spotify's official embedded player inside ECHO (previews unless signed in to Spotify in the browser).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnalyzedItem } from '@shared/types.ts';
import { api, ApiError, type SpotifyPlayerState } from './api';
import { useFeedback, useSpotifyStatus } from '../hooks/data';
import { canPlayFrom, classifyPlayerError, ListenTracker, livePosition, openInSpotifyUrl, queueWindow, spotifyUri } from './playback';
import { connectSpotify, consumeSpotifyReturn } from './spotify';

export function isQueueable(item: AnalyzedItem): boolean {
  return item.embed?.type === 'spotify' && (item.kind === 'track' || item.kind === 'episode');
}

export type PlayerMode = 'preview' | 'spotify';

export type PlayerNotice =
  | { kind: 'no_device'; url: string }
  | { kind: 'premium_required' }
  | { kind: 'error'; message: string };

/** Spotify's playback state plus when it was sampled (positions advance locally between polls). */
export interface RemoteState extends SpotifyPlayerState {
  at: number;
}

interface PlayerApi {
  queue: AnalyzedItem[];
  index: number;
  current: AnalyzedItem | null;
  mode: PlayerMode;
  /** known = the account link status has loaded. */
  spotify: { configured: boolean; known: boolean; connected: boolean; canPlay: boolean; needsReconnect: boolean };
  /** Spotify mode only: what the user's Spotify app is doing. */
  remote: RemoteState | null;
  /** A play request is on its way to Spotify. */
  busy: boolean;
  notice: PlayerNotice | null;
  playQueue: (items: AnalyzedItem[], start?: number) => void;
  /** User taps Next (a quick Next counts as a skip). */
  next: () => void;
  prev: () => void;
  /** User picks a song in the queue. */
  jump: (i: number) => void;
  /** Automatic advance at the end of a preview (never a skip). */
  advance: () => void;
  togglePlay: () => void;
  close: () => void;
  /** Try the pending Spotify play again. */
  retry: () => void;
  dismissNotice: () => void;
  connect: () => void;
  /** Preview mode: the embed reports playback (feeds skip detection). */
  previewProgress: (item: AnalyzedItem, playing: boolean, positionMs: number) => void;
}

const Ctx = createContext<PlayerApi | null>(null);

/** The slow-changing part (what's current, which mode, how to start a queue) for shelves and cards. */
interface QueueApi {
  currentId: string | null;
  mode: PlayerMode;
  playQueue: PlayerApi['playQueue'];
}
const QueueCtx = createContext<QueueApi | null>(null);

const POLL_MS = 4000;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useSpotifyStatus();
  const feedback = useFeedback();
  const [queue, setQueue] = useState<AnalyzedItem[]>([]);
  const [index, setIndex] = useState(0);
  const [queueMode, setQueueMode] = useState<PlayerMode>('preview');
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PlayerNotice | null>(null);
  const [reconnectNeeded, setReconnectNeeded] = useState(false);
  const [premiumMissing, setPremiumMissing] = useState(false);
  const [tracker] = useState(() => new ListenTracker<AnalyzedItem>());

  const spotifyReady = status.canPlay && !reconnectNeeded && !premiumMissing;
  const statusLoading = status.configured && !status.data && status.isFetching;

  // Latest values for async callbacks.
  const blocked = reconnectNeeded || premiumMissing;
  const live = useRef({ queue, index, remote, queueMode, spotifyReady, statusLoading, blocked, mutate: feedback.mutate });
  live.current = { queue, index, remote, queueMode, spotifyReady, statusLoading, blocked, mutate: feedback.mutate };
  /** After a command, polls that still show the old state are ignored for a few seconds. */
  const expect = useRef<{ uri?: string; isPlaying?: boolean; until: number } | null>(null);
  const backoffUntil = useRef(0);
  const pending = useRef<{ queue: AnalyzedItem[]; index: number; retried: boolean } | null>(null);
  const windowRef = useRef<{ begin: number; end: number } | null>(null);
  const previewPos = useRef<{ id: string; ms: number } | null>(null);
  const inflight = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollRef = useRef<() => Promise<void>>(async () => undefined);

  const record = useCallback((item: AnalyzedItem, type: 'play' | 'skip') => live.current.mutate({ item, type, source: 'feed', silent: true }), []);

  /** The user moved on from what is playing: a quick move is a skip (once per song). */
  const noteLeave = useCallback(() => {
    const playing = tracker.playing;
    if (!playing) return;
    const { remote: r, queueMode: m } = live.current;
    const now = Date.now();
    const progress = m === 'spotify'
      ? (r?.track && r.track.uri === spotifyUri(playing) ? livePosition(r, now) : undefined)
      : (previewPos.current?.id === playing.id ? previewPos.current.ms : undefined);
    const skipped = tracker.left(now, progress);
    if (skipped) record(skipped, 'skip');
  }, [record, tracker]);

  const schedulePoll = useCallback((ms: number) => {
    clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => void pollRef.current(), ms);
  }, []);

  /** Spotify playback became impossible (permission or Premium): keep the music going with previews. */
  const toPreview = useCallback(() => {
    expect.current = null;
    pending.current = null;
    setQueueMode('preview');
    setRemote(null);
  }, []);
  /** In Spotify mode but blocked: switch to previews and let the caller stop. */
  const blockedSpotify = useCallback(() => {
    if (live.current.queueMode !== 'spotify' || !live.current.blocked) return false;
    toPreview();
    return true;
  }, [toPreview]);

  const fail = useCallback((e: unknown, ctx?: { queue: AnalyzedItem[]; index: number; auto?: boolean }) => {
    const err = e instanceof ApiError ? e : null;
    switch (classifyPlayerError(err?.code, err?.status)) {
      case 'no_device':
        expect.current = null;
        setRemote((r) => (r ? { ...r, isPlaying: false, at: Date.now() } : r));
        if (ctx) {
          // Remember it: when the user comes back from the Spotify app, play again (once).
          pending.current = { queue: ctx.queue, index: ctx.index, retried: !!ctx.auto };
          setNotice({ kind: 'no_device', url: openInSpotifyUrl(ctx.queue[ctx.index]) });
        }
        return;
      case 'premium_required':
        setPremiumMissing(true);
        toPreview();
        setNotice({ kind: 'premium_required' });
        return;
      case 'reconnect':
      case 'not_connected':
        setReconnectNeeded(true);
        void qc.invalidateQueries({ queryKey: ['spotify'] });
        // A play the user just asked for continues as a preview; background checks only show the banner.
        if (ctx) {
          toPreview();
          setNotice(null);
        }
        return;
      case 'rate_limited':
        backoffUntil.current = Date.now() + (err?.retryAfter ?? 10) * 1000;
        if (ctx) setNotice({ kind: 'error', message: 'Spotify is busy right now. Try again in a moment.' });
        return;
      case 'restricted':
        expect.current = null;
        schedulePoll(500);
        return;
      default:
        if (ctx) setNotice({ kind: 'error', message: err?.message ?? 'Spotify could not start playing.' });
    }
  }, [qc, schedulePoll, toPreview]);

  const poll = useCallback(async () => {
    if (inflight.current || Date.now() < backoffUntil.current) return;
    inflight.current = true;
    try {
      const s = await api.spotifyPlayerState();
      if (!live.current.queue.length) return;
      const now = Date.now();
      const exp = expect.current;
      if (exp && now < exp.until && ((exp.uri !== undefined && s.track?.uri !== exp.uri) || (exp.isPlaying !== undefined && s.isPlaying !== exp.isPlaying))) {
        // Spotify hasn't caught up with the last tap yet: keep the optimistic state.
        if (s.device) setRemote((r) => (r ? { ...r, device: s.device } : r));
        return;
      }
      expect.current = null;
      setRemote({ ...s, at: now });
      const q = live.current.queue;
      const i = s.track ? q.findIndex((x) => spotifyUri(x) === s.track!.uri) : -1;
      if (i < 0) return;
      if (i !== live.current.index) setIndex(i);
      if (s.isPlaying && tracker.started(q[i], now - s.progressMs)) record(q[i], 'play');
    } catch (e) {
      fail(e);
    } finally {
      inflight.current = false;
    }
  }, [fail, record, tracker]);
  pollRef.current = poll;

  /** Show the requested song as playing right away; the next polls confirm it. */
  const showOptimistic = useCallback((item: AnalyzedItem) => {
    const uri = spotifyUri(item);
    const now = Date.now();
    expect.current = uri ? { uri, isPlaying: true, until: now + 8000 } : null;
    setRemote((r) => ({
      isPlaying: true,
      progressMs: 0,
      durationMs: (item.durationSec ?? 0) * 1000,
      device: r?.device ?? null,
      track: uri ? { uri, id: uri.split(':')[2], name: item.title, artists: item.creators, artworkUrl: item.artworkUrl ?? null } : null,
      at: now,
    }));
  }, []);

  /** Hand the queue to the user's Spotify app, starting at `i`. */
  const startRemote = useCallback(async (q: AnalyzedItem[], i: number, auto = false) => {
    const win = queueWindow(q, i);
    if (!win) {
      setNotice({ kind: 'error', message: 'This song can’t be played on Spotify.' });
      return;
    }
    const start = q.findIndex((x) => spotifyUri(x) === win.uris[win.offset]);
    windowRef.current = { begin: win.begin, end: win.end };
    if (start !== live.current.index) setIndex(start);
    showOptimistic(q[start]);
    setBusy(true);
    try {
      const r = await api.spotifyPlay({ uris: win.uris, offset: win.offset });
      pending.current = null;
      setNotice((n) => (n?.kind === 'premium_required' ? n : null));
      if (r.device) setRemote((s) => (s ? { ...s, device: r.device } : s));
      schedulePoll(1500);
    } catch (e) {
      fail(e, { queue: q, index: start, auto });
    } finally {
      setBusy(false);
    }
  }, [fail, schedulePoll, showOptimistic]);

  const playQueue = useCallback((items: AnalyzedItem[], start = 0) => {
    const q = items.filter(isQueueable);
    if (!q.length) return;
    const first = items[start] && isQueueable(items[start]) ? q.findIndex((x) => x.id === items[start].id) : 0;
    const i = Math.max(0, first);
    if (tracker.playing && tracker.playing.id !== q[i].id) noteLeave();
    const begin = (mode: PlayerMode) => {
      pending.current = null;
      setQueue(q);
      setIndex(i);
      setQueueMode(mode);
      setNotice((n) => (mode === 'preview' && n?.kind === 'premium_required' ? n : null));
      if (mode === 'spotify') void startRemote(q, i);
      else {
        expect.current = null;
        setRemote(null);
      }
    };
    // Right after start-up the Spotify link may still be loading: wait for it rather than guess.
    if (live.current.statusLoading) {
      qc.fetchQuery({ queryKey: ['spotify'], queryFn: api.spotifyStatus, staleTime: 60_000 })
        .then((s) => begin(canPlayFrom(s) && !live.current.blocked ? 'spotify' : 'preview'))
        .catch(() => begin('preview'));
      return;
    }
    begin(live.current.spotifyReady ? 'spotify' : 'preview');
  }, [noteLeave, qc, startRemote, tracker]);

  const next = useCallback(() => {
    const { queue: q, index: i, queueMode: m, remote: r } = live.current;
    if (i + 1 >= q.length) return;
    noteLeave();
    const t = i + 1;
    setIndex(t);
    if (m !== 'spotify' || blockedSpotify()) return;
    const win = windowRef.current;
    const inSync = !!r?.track && r.track.uri === spotifyUri(q[i]) && !expect.current && !!win && t <= win.end;
    if (!inSync) return void startRemote(q, t);
    showOptimistic(q[t]);
    api.spotifyControl('next')
      .then(() => schedulePoll(1200))
      .catch((e) => (e instanceof ApiError && e.code === 'no_device' ? void startRemote(q, t) : fail(e, { queue: q, index: t })));
  }, [blockedSpotify, fail, noteLeave, schedulePoll, showOptimistic, startRemote]);

  const prev = useCallback(() => {
    const { queue: q, index: i, queueMode: m } = live.current;
    if (i <= 0) return;
    tracker.stop();
    setIndex(i - 1);
    if (m === 'spotify' && !blockedSpotify()) void startRemote(q, i - 1);
  }, [blockedSpotify, startRemote, tracker]);

  const jump = useCallback((t: number) => {
    const { queue: q, index: i, queueMode: m } = live.current;
    if (t === i || t < 0 || t >= q.length) return;
    noteLeave();
    setIndex(t);
    if (m === 'spotify' && !blockedSpotify()) void startRemote(q, t);
  }, [blockedSpotify, noteLeave, startRemote]);

  const advance = useCallback(() => {
    tracker.stop();
    setIndex((i) => (i + 1 < live.current.queue.length ? i + 1 : i));
  }, [tracker]);

  const togglePlay = useCallback(() => {
    const { queue: q, index: i, remote: r } = live.current;
    const item = q[i];
    if (!item || blockedSpotify()) return;
    const now = Date.now();
    if (r?.isPlaying) {
      expect.current = { isPlaying: false, until: now + 6000 };
      setRemote({ ...r, isPlaying: false, progressMs: livePosition(r, now), at: now });
      api.spotifyControl('pause').then(() => schedulePoll(1500)).catch((e) => fail(e));
      return;
    }
    if (r?.track && r.track.uri === spotifyUri(item)) {
      expect.current = { uri: r.track.uri, isPlaying: true, until: now + 6000 };
      setRemote({ ...r, isPlaying: true, at: now });
      api.spotifyControl('resume')
        .then(() => schedulePoll(1500))
        .catch((e) => (e instanceof ApiError && e.code === 'no_device' ? void startRemote(q, i) : fail(e)));
      return;
    }
    void startRemote(q, i);
  }, [blockedSpotify, fail, schedulePoll, startRemote]);

  const close = useCallback(() => {
    const { queueMode: m, remote: r } = live.current;
    if (m === 'spotify' && r?.isPlaying) api.spotifyControl('pause').catch(() => undefined);
    tracker.stop();
    pending.current = null;
    expect.current = null;
    windowRef.current = null;
    previewPos.current = null;
    clearTimeout(pollTimer.current);
    setQueue([]);
    setIndex(0);
    setRemote(null);
    setNotice(null);
  }, [tracker]);

  const retry = useCallback(() => {
    const p = pending.current ?? { queue: live.current.queue, index: live.current.index };
    if (p.queue.length) void startRemote(p.queue, p.index);
  }, [startRemote]);

  const dismissNotice = useCallback(() => {
    pending.current = null;
    setNotice(null);
  }, []);

  const connect = useCallback(() => void connectSpotify(), []);

  const previewProgress = useCallback((item: AnalyzedItem, playing: boolean, positionMs: number) => {
    previewPos.current = { id: item.id, ms: positionMs };
    if (playing && positionMs > 0) tracker.started(item, Date.now() - positionMs);
  }, [tracker]);

  // Keep the bar in sync with the Spotify app: poll while visible, and check (or retry a pending play) on return.
  const polling = queueMode === 'spotify' && queue.length > 0 && !reconnectNeeded;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void pollRef.current();
    }, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const p = pending.current;
      if (p && !p.retried) {
        p.retried = true;
        void startRemote(p.queue, p.index, true);
      } else void pollRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [polling, startRemote]);

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  // Back from Spotify's consent screen (?spotify=connected|denied): confirm once and refresh the link status.
  useEffect(() => {
    if (consumeSpotifyReturn() !== null) {
      setReconnectNeeded(false);
      void qc.invalidateQueries({ queryKey: ['spotify'] });
    }
  }, [qc]);

  const mode: PlayerMode = queue.length ? queueMode : spotifyReady ? 'spotify' : 'preview';
  const spotify = useMemo(
    () => ({ configured: status.configured, known: !!status.data, connected: status.connected, canPlay: status.canPlay, needsReconnect: status.connected && (!status.canPlay || reconnectNeeded) }),
    [status.configured, status.data, status.connected, status.canPlay, reconnectNeeded],
  );
  const value = useMemo<PlayerApi>(
    () => ({ queue, index, current: queue[index] ?? null, mode, spotify, remote, busy, notice, playQueue, next, prev, jump, advance, togglePlay, close, retry, dismissNotice, connect, previewProgress }),
    [queue, index, mode, spotify, remote, busy, notice, playQueue, next, prev, jump, advance, togglePlay, close, retry, dismissNotice, connect, previewProgress],
  );
  const currentId = queue[index]?.id ?? null;
  const lite = useMemo<QueueApi>(() => ({ currentId, mode, playQueue }), [currentId, mode, playQueue]);
  return (
    <QueueCtx.Provider value={lite}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </QueueCtx.Provider>
  );
}

/** Everything about the player (re-renders on every playback update: use it in the player itself). */
export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer outside PlayerProvider');
  return v;
}

/** Start queues and know what's current, without re-rendering on playback progress. */
export function usePlayQueue(): QueueApi {
  const v = useContext(QueueCtx);
  if (!v) throw new Error('usePlayQueue outside PlayerProvider');
  return v;
}
