// Global music queue: one tap plays, the rest of the shelf follows automatically.
// Two modes:
//  • SPOTIFY — the user's Spotify Premium account is connected with playback permission: full songs play in their
//    Spotify app (Spotify Connect, remote-controlled through the `spotify` function) and ECHO shows its own bar.
//  • PREVIEW — Spotify's official embedded player inside ECHO (previews unless signed in to Spotify in the browser).
// Music lanes also hold YouTube live sessions / music videos: ECHO plays those itself (the mini player's
// YouTube player) in queue order. In Spotify mode Spotify is paused first and only ever gets the run of
// songs up to the next video; when a video ends, the next song starts with the songs that follow it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnalyzedItem } from '@shared/types.ts';
import { api, ApiError, type SpotifyPlayerState } from './api';
import { useFeedback, useSpotifyStatus } from '../hooks/data';
import { canPlayFrom, classifyPlayerError, isVideoItem, ListenTracker, livePosition, nextPollDelay, openInSpotifyAppUrl, openInSpotifyUrl, POLL_MS, queueWindow, remoteRunEnded, sameQueue, spotifyUri } from './playback';
import { connectSpotify, consumeSpotifyReturn } from './spotify';

/** Songs and episodes on Spotify, and the YouTube sessions / music videos inside music lanes. */
export function isQueueable(item: AnalyzedItem): boolean {
  if (item.embed?.type === 'youtube') return item.category === 'music';
  return item.embed?.type === 'spotify' && (item.kind === 'track' || item.kind === 'episode');
}

export type PlayerMode = 'preview' | 'spotify';

export type PlayerNotice =
  | { kind: 'no_device'; url: string; appUrl: string }
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
  /** Preview mode: the embed reports playback (feeds skip detection; `durationMs` is 30 s for a preview). */
  previewProgress: (item: AnalyzedItem, playing: boolean, positionMs: number, durationMs?: number) => void;
  /** The mini player's YouTube player reports playback of a queued video (first play → 'play' feedback). */
  videoProgress: (item: AnalyzedItem, playing: boolean, positionMs: number, durationMs?: number) => void;
  /** A queued video ended (YT.PlayerState.ENDED): the next item plays (never a skip). */
  videoEnded: (item: AnalyzedItem) => void;
}

const Ctx = createContext<PlayerApi | null>(null);

/** The slow-changing part (what's current, which mode, how to start a queue) for shelves and cards. */
interface QueueApi {
  currentId: string | null;
  mode: PlayerMode;
  /** Spotify mode: the user's Spotify app is playing (changes on play/pause only, not with progress). */
  playing: boolean;
  playQueue: PlayerApi['playQueue'];
  /** Play one song: the current one keeps playing (or resumes), one already in the queue is jumped to, anything else plays on its own. */
  playItem: (item: AnalyzedItem) => void;
  /** Spotify mode: pause or resume the current song. */
  togglePlay: PlayerApi['togglePlay'];
}
const QueueCtx = createContext<QueueApi | null>(null);

/** A play the user asked for (kept for the no-device retry). */
interface PlayCtx {
  queue: AnalyzedItem[];
  index: number;
  auto?: boolean;
}

/** Ask Spotify how things went this long after a tap. */
const CONFIRM_MS = 1500;
/** Spotify mode, before a video: stop the run's last song this long before its end (so no autoplay song slips in). */
const BOUNDARY_LEAD_MS = 400;

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
  // Full songs stop: a missing permission, no Premium, or a fresh status saying the link is gone.
  const blocked = reconnectNeeded || premiumMissing || (!!status.data && !status.canPlay);
  // No Spotify polling while a video plays (Spotify is paused; the video's end starts the next songs).
  const polling = queueMode === 'spotify' && queue.length > 0 && spotifyReady && !isVideoItem(queue[index]);
  const since = status.data?.since ?? null;

  // Latest values for async callbacks.
  const live = useRef({ queue, index, remote, queueMode, spotifyReady, statusLoading, blocked, polling, since, mutate: feedback.mutate });
  live.current = { queue, index, remote, queueMode, spotifyReady, statusLoading, blocked, polling, since, mutate: feedback.mutate };
  /** After a command, polls that still show the old state are ignored for a few seconds. */
  const expect = useRef<{ uri?: string; isPlaying?: boolean; until: number } | null>(null);
  /** What Spotify was doing before the taps not yet confirmed: shown again when a tap fails (undefined = nothing pending). */
  const before = useRef<RemoteState | null | undefined>(undefined);
  const backoffUntil = useRef(0);
  const pending = useRef<{ queue: AnalyzedItem[]; index: number; retried: boolean } | null>(null);
  const windowRef = useRef<{ begin: number; end: number } | null>(null);
  const previewPos = useRef<{ id: string; ms: number; durationMs?: number } | null>(null);
  const inflight = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollDue = useRef(0);
  const idlePolls = useRef(0);
  const pollRef = useRef<() => Promise<void>>(async () => undefined);
  /** A background check answered "reconnect" once: confirm before ending full songs. */
  const reconnectStrikes = useRef(0);
  /** Spotify mode: the run of songs Spotify was given ends before a video (its last URI, all its URIs, the video's index). */
  const runEnd = useRef<{ lastUri: string; uris: Set<string>; video: number; sawLast: boolean } | null>(null);
  const boundaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The link's `since` when full songs were blocked for a reconnect: a newer one means the link was renewed. */
  const reconnectSince = useRef<string | null>(null);

  const record = useCallback((item: AnalyzedItem, type: 'play' | 'skip') => live.current.mutate({ item, type, source: 'feed', silent: true }), []);

  /** The user moved on from what is playing: a quick move is a skip (once per song). */
  const noteLeave = useCallback(() => {
    const playing = tracker.playing;
    if (!playing) return;
    const { remote: r, queueMode: m } = live.current;
    const now = Date.now();
    let progress: number | undefined;
    let duration: number | undefined;
    if (m === 'spotify' && !isVideoItem(playing)) {
      if (r?.track && r.track.uri === spotifyUri(playing)) {
        progress = livePosition(r, now);
        duration = r.durationMs;
      }
    } else if (previewPos.current?.id === playing.id) {
      progress = previewPos.current.ms;
      duration = previewPos.current.durationMs;
    }
    const skipped = tracker.left(now, progress, duration);
    if (skipped) record(skipped, 'skip');
  }, [record, tracker]);

  /** Plan the next player-state poll in `ms` (a sooner one already planned wins). */
  const schedulePoll = useCallback((ms: number) => {
    const now = Date.now();
    if (pollTimer.current !== undefined && pollDue.current >= now && pollDue.current <= now + ms) return;
    clearTimeout(pollTimer.current);
    pollDue.current = now + ms;
    pollTimer.current = setTimeout(() => {
      pollTimer.current = undefined;
      void pollRef.current();
    }, ms);
  }, []);
  const stopPolling = useCallback(() => {
    clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  }, []);

  /** Spotify playback became impossible (permission or Premium): keep the music going with previews. */
  const toPreview = useCallback(() => {
    expect.current = null;
    before.current = undefined;
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

  /** A tap failed, so Spotify kept doing what it did before: show that again (`stopped`: nothing can be playing). */
  const undoOptimistic = useCallback((stopped: boolean) => {
    expect.current = null;
    const prev = before.current;
    before.current = undefined;
    const now = Date.now();
    setRemote((r) => {
      const base = prev === undefined ? r && { ...r, isPlaying: false } : prev;
      return base && { ...base, isPlaying: base.isPlaying && !stopped, progressMs: livePosition(base, now), at: now };
    });
  }, []);

  /** Full songs need the user to reconnect Spotify (until a fresh status shows a renewed link). */
  const blockForReconnect = useCallback(() => {
    reconnectStrikes.current = 0;
    reconnectSince.current = live.current.since;
    setReconnectNeeded(true);
    void qc.invalidateQueries({ queryKey: ['spotify'] });
  }, [qc]);

  /**
   * A Spotify request failed. `ctx`: a play the user asked for (kept for the no-device retry). `command`: any tap — its
   * optimistic state is undone and the user is told what happened. Background polls pass neither.
   */
  const fail = useCallback((e: unknown, ctx?: PlayCtx, command = !!ctx) => {
    const err = e instanceof ApiError ? e : null;
    const kind = classifyPlayerError(err?.code, err?.status);
    if (command) undoOptimistic(kind === 'no_device');
    switch (kind) {
      case 'no_device':
        if (!command) {
          expect.current = null;
          setRemote((r) => (r ? { ...r, isPlaying: false, at: Date.now() } : r));
        }
        if (ctx) {
          // Remember it: when the user comes back from the Spotify app, play again (once).
          pending.current = { queue: ctx.queue, index: ctx.index, retried: !!ctx.auto };
          setNotice({ kind: 'no_device', url: openInSpotifyUrl(ctx.queue[ctx.index]), appUrl: openInSpotifyAppUrl(ctx.queue[ctx.index]) });
        }
        return;
      case 'premium_required':
        setPremiumMissing(true);
        toPreview();
        setNotice({ kind: 'premium_required' });
        return;
      case 'not_connected':
        // The link may be gone (disconnected elsewhere): re-read it. Full songs end only if the fresh status says so.
        void qc.invalidateQueries({ queryKey: ['spotify'] });
        if (ctx) {
          toPreview();
          setNotice(null);
        }
        return;
      case 'reconnect':
        blockForReconnect();
        // A play the user just asked for continues as a preview; other failures only show the banner.
        if (ctx) {
          toPreview();
          setNotice(null);
        }
        return;
      case 'rate_limited':
        backoffUntil.current = Date.now() + (err?.retryAfter ?? 10) * 1000;
        if (command) setNotice({ kind: 'error', message: 'Spotify is busy right now. Try again in a moment.' });
        return;
      case 'restricted':
        if (command) {
          setNotice({ kind: 'error', message: ctx ? 'Spotify can’t play on that device right now.' : 'Spotify can’t control that device right now.' });
          schedulePoll(500);
        }
        return;
      default:
        if (command) setNotice({ kind: 'error', message: err?.message ?? (ctx ? 'Spotify could not start playing.' : 'Spotify did not respond. Try again.') });
    }
  }, [blockForReconnect, qc, schedulePoll, toPreview, undoOptimistic]);

  /**
   * Play the queued video at `i`: Spotify pauses first (whatever it plays: the song before, or its autoplay),
   * then the mini player's YouTube player takes over. `auto`: the song before played to its end (not a skip).
   */
  const enterVideo = useCallback((i: number, auto = false, seen?: SpotifyPlayerState) => {
    clearTimeout(boundaryTimer.current);
    runEnd.current = null;
    windowRef.current = null;
    if (auto) tracker.stop();
    const r = seen ? { ...seen, at: Date.now() } : live.current.remote;
    if (r?.isPlaying) {
      const now = Date.now();
      expect.current = null;
      before.current = undefined;
      setRemote({ ...r, isPlaying: false, progressMs: livePosition(r, now), at: now });
      api.spotifyControl('pause').catch(() => undefined);
    }
    setIndex(i);
  }, [tracker]);

  /** The boundary timer fired: the run's last song is (still) ending → on to the video. */
  const boundaryRef = useRef<() => void>(() => undefined);
  boundaryRef.current = () => {
    const run = runEnd.current;
    const r = live.current.remote;
    if (!run || !r || isVideoItem(live.current.queue[live.current.index])) return;
    if (r.isPlaying && r.track?.uri === run.lastUri && r.durationMs > 0 && livePosition(r, Date.now()) >= r.durationMs - 1500) enterVideo(run.video, true);
  };

  /** Take a player-state sample, unless Spotify hasn't caught up with the last tap yet. */
  const applyState = useCallback((s: SpotifyPlayerState) => {
    if (!live.current.queue.length) return;
    const now = Date.now();
    const exp = expect.current;
    if (exp && now < exp.until && ((exp.uri !== undefined && s.track?.uri !== exp.uri) || (exp.isPlaying !== undefined && s.isPlaying !== exp.isPlaying))) {
      // Keep the optimistic state.
      if (s.device) setRemote((r) => (r ? { ...r, device: s.device } : r));
      return;
    }
    expect.current = null;
    before.current = undefined;
    setRemote({ ...s, at: now });
    const q = live.current.queue;
    // A video plays: Spotify's state never moves the queue.
    if (isVideoItem(q[live.current.index])) return;
    const run = runEnd.current;
    if (run) {
      if (s.isPlaying && s.track?.uri === run.lastUri) {
        run.sawLast = true;
        clearTimeout(boundaryTimer.current);
        if (s.durationMs > 0) boundaryTimer.current = setTimeout(() => boundaryRef.current(), Math.max(0, s.durationMs - s.progressMs - BOUNDARY_LEAD_MS));
      } else if (remoteRunEnded(s, run)) {
        // Spotify finished the songs before the video (stopped, or moved on to its own autoplay).
        return enterVideo(run.video, true, s);
      }
    }
    const i = s.track ? q.findIndex((x) => spotifyUri(x) === s.track!.uri) : -1;
    if (i < 0) return;
    if (i !== live.current.index) setIndex(i);
    if (s.isPlaying && tracker.started(q[i], now - s.progressMs)) record(q[i], 'play');
  }, [enterVideo, record, tracker]);

  const poll = useCallback(async () => {
    stopPolling();
    // Hidden: the visibility handler polls on return. Waiting for the user to open Spotify: nothing to see yet.
    if (!live.current.polling || document.visibilityState === 'hidden' || pending.current) return;
    const wait = backoffUntil.current - Date.now();
    if (wait > 0) return schedulePoll(wait + 250);
    if (inflight.current) return;
    inflight.current = true;
    let seen: SpotifyPlayerState | null = null;
    let confirm = false;
    try {
      seen = await api.spotifyPlayerState();
      reconnectStrikes.current = 0;
      applyState(seen);
    } catch (e) {
      // One failed background check (e.g. two token refreshes racing) is not enough to end full songs: check once more.
      if (e instanceof ApiError && classifyPlayerError(e.code, e.status) === 'reconnect' && reconnectStrikes.current === 0) {
        reconnectStrikes.current = 1;
        confirm = true;
      } else fail(e);
    } finally {
      inflight.current = false;
    }
    if (!live.current.polling) return;
    const exp = expect.current;
    const waiting = !!exp && Date.now() < exp.until;
    const s = seen ?? live.current.remote;
    idlePolls.current = waiting || s?.isPlaying ? 0 : idlePolls.current + 1;
    const delay = confirm ? CONFIRM_MS : nextPollDelay(s, idlePolls.current, waiting);
    if (delay !== null) schedulePoll(delay);
  }, [applyState, fail, schedulePoll, stopPolling]);
  pollRef.current = poll;

  /** Show the requested song as playing right away; the next polls confirm it. */
  const showOptimistic = useCallback((item: AnalyzedItem) => {
    const uri = spotifyUri(item);
    const now = Date.now();
    if (before.current === undefined) before.current = live.current.remote;
    expect.current = uri ? { uri, isPlaying: true, until: now + 8000 } : null;
    setRemote((r) => ({
      isPlaying: true,
      progressMs: 0,
      durationMs: (item.durationSec ?? 0) * 1000,
      shuffle: r?.shuffle,
      device: r?.device ?? null,
      track: uri ? { uri, id: uri.split(':')[2], name: item.title, artists: item.creators, artworkUrl: item.artworkUrl ?? null } : null,
      at: now,
    }));
  }, []);

  /** Hand the queue to the user's Spotify app, starting at `i` (up to the next video; a video plays in ECHO). */
  const startRemote = useCallback(async (q: AnalyzedItem[], i: number, auto = false) => {
    clearTimeout(boundaryTimer.current);
    if (isVideoItem(q[i])) return enterVideo(i);
    const win = queueWindow(q, i);
    if (!win) {
      setNotice({ kind: 'error', message: 'This song can’t be played on Spotify.' });
      return;
    }
    const start = q.findIndex((x) => spotifyUri(x) === win.uris[win.offset]);
    windowRef.current = { begin: win.begin, end: win.end };
    runEnd.current = win.video !== null ? { lastUri: win.uris[win.uris.length - 1], uris: new Set(win.uris), video: win.video, sawLast: false } : null;
    if (start !== live.current.index) setIndex(start);
    // Known to be off already: the function can skip turning shuffle off.
    const shuffleOff = live.current.remote?.shuffle === false;
    showOptimistic(q[start]);
    setBusy(true);
    try {
      const r = await api.spotifyPlay({ uris: win.uris, offset: win.offset, ...(shuffleOff ? { shuffle: false } : {}) });
      pending.current = null;
      setNotice((n) => (n?.kind === 'premium_required' ? n : null));
      // The function also turned shuffle off, so the lane plays in ECHO's order.
      setRemote((s) => (s ? { ...s, shuffle: false, device: r.device ?? s.device } : s));
      schedulePoll(CONFIRM_MS);
    } catch (e) {
      fail(e, { queue: q, index: start, auto });
    } finally {
      setBusy(false);
    }
  }, [enterVideo, fail, schedulePoll, showOptimistic]);

  const next = useCallback(() => {
    const { queue: q, index: i, queueMode: m, remote: r } = live.current;
    if (i + 1 >= q.length) return;
    noteLeave();
    const t = i + 1;
    setIndex(t);
    if (m !== 'spotify' || blockedSpotify()) return;
    const win = windowRef.current;
    // Spotify's own "next" only while it plays ECHO's queue in order (with shuffle on it would pick a random song),
    // and never into a video (Spotify's run stops before it).
    const inSync = !isVideoItem(q[t]) && !!r?.track && r.track.uri === spotifyUri(q[i]) && !r.shuffle && !expect.current && !!win && t <= win.end;
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

  /** The current item ended by itself: the next one plays (a song in Spotify mode starts with the songs after it). */
  const advance = useCallback(() => {
    tracker.stop();
    const { queue: q, index: i, queueMode: m } = live.current;
    const t = i + 1;
    if (t >= q.length) return;
    if (m === 'spotify' && !isVideoItem(q[t]) && !blockedSpotify()) return void startRemote(q, t);
    setIndex(t);
  }, [blockedSpotify, startRemote, tracker]);

  const videoEnded = useCallback((item: AnalyzedItem) => {
    const { queue: q, index: i } = live.current;
    if (q[i]?.id === item.id) advance();
  }, [advance]);

  const togglePlay = useCallback(() => {
    const { queue: q, index: i, remote: r, queueMode: m } = live.current;
    const item = q[i];
    if (!item || m !== 'spotify' || blockedSpotify()) return;
    const now = Date.now();
    if (r?.isPlaying) {
      if (before.current === undefined) before.current = r;
      expect.current = { isPlaying: false, until: now + 6000 };
      setRemote({ ...r, isPlaying: false, progressMs: livePosition(r, now), at: now });
      api.spotifyControl('pause').then(() => schedulePoll(CONFIRM_MS)).catch((e) => fail(e, undefined, true));
      return;
    }
    if (r?.track && r.track.uri === spotifyUri(item)) {
      if (before.current === undefined) before.current = r;
      expect.current = { uri: r.track.uri, isPlaying: true, until: now + 6000 };
      setRemote({ ...r, isPlaying: true, at: now });
      api.spotifyControl('resume')
        .then(() => schedulePoll(CONFIRM_MS))
        .catch((e) => (e instanceof ApiError && e.code === 'no_device' ? void startRemote(q, i) : fail(e, { queue: q, index: i })));
      return;
    }
    void startRemote(q, i);
  }, [blockedSpotify, fail, schedulePoll, startRemote]);

  const playQueue = useCallback((items: AnalyzedItem[], start = 0) => {
    const q = items.filter(isQueueable);
    if (!q.length) return;
    const first = items[start] && isQueueable(items[start]) ? q.findIndex((x) => x.id === items[start].id) : 0;
    const i = Math.max(0, first);
    const cur = live.current;
    // The video on screen tapped again: it keeps playing.
    if (i === cur.index && isVideoItem(q[i]) && sameQueue(q, cur.queue)) return;
    // The queue Spotify is already playing (a shelf or a song tapped again): carry on instead of restarting the song.
    if (cur.queueMode === 'spotify' && cur.spotifyReady && sameQueue(q, cur.queue)) {
      if (i !== cur.index) return jump(i);
      const r = cur.remote;
      if (r?.track && r.track.uri === spotifyUri(q[i])) {
        if (!r.isPlaying) togglePlay();
        return;
      }
    }
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
        before.current = undefined;
        setRemote(null);
      }
    };
    // Right after start-up the Spotify link may still be loading: wait for it rather than guess.
    if (cur.statusLoading) {
      qc.fetchQuery({ queryKey: ['spotify'], queryFn: api.spotifyStatus, staleTime: 60_000 })
        .then((s) => begin(canPlayFrom(s) && !live.current.blocked ? 'spotify' : 'preview'))
        .catch(() => begin('preview'));
      return;
    }
    begin(cur.spotifyReady ? 'spotify' : 'preview');
  }, [jump, noteLeave, qc, startRemote, togglePlay, tracker]);

  const playItem = useCallback((item: AnalyzedItem) => {
    const q = live.current.queue;
    const at = q.findIndex((x) => x.id === item.id);
    if (at >= 0) playQueue(q, at);
    else playQueue([item], 0);
  }, [playQueue]);

  const close = useCallback(() => {
    const { queueMode: m, remote: r } = live.current;
    if (m === 'spotify' && r?.isPlaying) api.spotifyControl('pause').catch(() => undefined);
    clearTimeout(boundaryTimer.current);
    runEnd.current = null;
    tracker.stop();
    pending.current = null;
    expect.current = null;
    before.current = undefined;
    windowRef.current = null;
    previewPos.current = null;
    idlePolls.current = 0;
    stopPolling();
    setQueue([]);
    setIndex(0);
    setRemote(null);
    setNotice(null);
  }, [stopPolling, tracker]);

  const retry = useCallback(() => {
    const p = pending.current ?? { queue: live.current.queue, index: live.current.index };
    if (p.queue.length) void startRemote(p.queue, p.index);
  }, [startRemote]);

  const dismissNotice = useCallback(() => {
    pending.current = null;
    setNotice(null);
  }, []);

  const connect = useCallback(() => void connectSpotify(), []);

  const previewProgress = useCallback((item: AnalyzedItem, playing: boolean, positionMs: number, durationMs?: number) => {
    previewPos.current = { id: item.id, ms: positionMs, durationMs };
    if (playing && positionMs > 0) tracker.started(item, Date.now() - positionMs);
  }, [tracker]);

  const videoProgress = useCallback((item: AnalyzedItem, playing: boolean, positionMs: number, durationMs?: number) => {
    previewPos.current = { id: item.id, ms: positionMs, durationMs };
    // The first time it plays: one 'play' (a quick Next later counts as a skip, like a song).
    if (playing && tracker.started(item, Date.now() - positionMs)) record(item, 'play');
  }, [record, tracker]);

  // Keep the bar in sync with the Spotify app (cadence: nextPollDelay), never while hidden; on return, check again or
  // retry a pending play.
  useEffect(() => {
    if (!polling) return;
    if (!pending.current) schedulePoll(POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return stopPolling();
      idlePolls.current = 0;
      const p = pending.current;
      if (p && !p.retried) {
        p.retried = true;
        void startRemote(p.queue, p.index, true);
      } else void pollRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [polling, schedulePoll, startRemote, stopPolling]);

  useEffect(() => () => {
    stopPolling();
    clearTimeout(boundaryTimer.current);
  }, [stopPolling]);

  // Back from Spotify's consent screen (?spotify=connected|denied): confirm once and refresh the link status.
  useEffect(() => {
    if (consumeSpotifyReturn() !== null) {
      setReconnectNeeded(false);
      void qc.invalidateQueries({ queryKey: ['spotify'] });
    }
  }, [qc]);

  // A fresh status showing a renewed link (tokens stored since full songs were blocked, e.g. by a parallel refresh or
  // a reconnect in another tab) lifts the reconnect block. An unchanged link keeps it.
  useEffect(() => {
    if (reconnectNeeded && status.canPlay && status.data && (status.data.since ?? null) !== reconnectSince.current) setReconnectNeeded(false);
  }, [reconnectNeeded, status.canPlay, status.data]);

  const mode: PlayerMode = queue.length ? queueMode : spotifyReady ? 'spotify' : 'preview';
  const spotify = useMemo(
    () => ({ configured: status.configured, known: !!status.data, connected: status.connected, canPlay: status.canPlay, needsReconnect: status.connected && (!status.canPlay || reconnectNeeded) }),
    [status.configured, status.data, status.connected, status.canPlay, reconnectNeeded],
  );
  const value = useMemo<PlayerApi>(
    () => ({ queue, index, current: queue[index] ?? null, mode, spotify, remote, busy, notice, playQueue, next, prev, jump, advance, togglePlay, close, retry, dismissNotice, connect, previewProgress, videoProgress, videoEnded }),
    [queue, index, mode, spotify, remote, busy, notice, playQueue, next, prev, jump, advance, togglePlay, close, retry, dismissNotice, connect, previewProgress, videoProgress, videoEnded],
  );
  const currentId = queue[index]?.id ?? null;
  const playing = queueMode === 'spotify' && !!remote?.isPlaying;
  const lite = useMemo<QueueApi>(() => ({ currentId, mode, playing, playQueue, playItem, togglePlay }), [currentId, mode, playing, playQueue, playItem, togglePlay]);
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
