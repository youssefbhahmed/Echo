import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ArrowUp, Compass, History, Landmark, Mic2, Music2, Orbit, Plus, Sunrise } from 'lucide-react';
import type { Recommendation } from '@shared/types.ts';
import type { ChatPayloadRec } from '@shared/engine/chat.ts';
import { api } from '../lib/api';
import { idChunks, restoreRecs } from '../lib/chat';
import { supabase } from '../lib/supabase';
import { localIntentHint } from '../lib/ollama';
import { DB_ITEM_COLUMNS, dbToItem, type DbItem } from '../hooks/data';
import { ChatAnswer } from '../components/ChatAnswer';
import { DetailSheet } from '../components/DetailSheet';
import { EchoMark, Listening } from '../components/Echo';
import { PageHeader } from '../components/Shell';
import { toast } from '../components/Toast';

interface Msg { role: 'user' | 'assistant'; content: string; recs?: Recommendation[]; clarify?: { text: string; options: string[] } | null; summary?: string }


const REFINEMENTS = ['More like the first one', 'More adventurous', 'Only books', 'Only music', 'Shorter', 'Less dark'];

const STARTERS: Array<{ icon: typeof Compass; text: string }> = [
  { icon: Orbit, text: 'Something with the same existential feeling as Interstellar, but it doesn’t have to be science fiction.' },
  { icon: Music2, text: 'I’m feeling nostalgic. Music that starts melancholic and gradually becomes uplifting.' },
  { icon: Landmark, text: 'I want to understand the origins of civilization through serious documentaries.' },
  { icon: Compass, text: 'Recommend something completely outside my usual preferences that you think I would love.' },
  { icon: Mic2, text: 'Des podcasts YouTube sur la géopolitique, en français.' },
  { icon: Sunrise, text: 'Find music that feels like watching the sunrise after a difficult night.' },
];

export default function Chat() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSent = useRef(false);
  const [open, setOpenState] = useState<{ rec: Recommendation; play: boolean } | null>(null);
  const openRec = (rec: Recommendation) => setOpenState({ rec, play: false });
  const watchRec = (rec: Recommendation) => setOpenState({ rec, play: true });

  const sessions = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('chat_sessions').select('id, title, updated_at').order('updated_at', { ascending: false }).limit(30);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const intentHint = await localIntentHint(message);
      const res = await api.chat({ message, sessionId, intentHint });
      setSessionId(res.sessionId);
      setMessages((m) => [...m, { role: 'assistant', content: res.reply ?? '', recs: res.recommendations, clarify: res.clarifyingQuestion, summary: res.pipeline[0]?.detail }]);
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
    } catch (e) {
      toast((e as Error).message, 'error');
      setMessages((m) => [...m, { role: 'assistant', content: `I couldn’t complete that: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  // Deep link from the Discover search box
  useEffect(() => {
    const q = params.get('q');
    if (q && !autoSent.current) {
      autoSent.current = true;
      setParams({}, { replace: true });
      send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSession = async (id: string) => {
    setShowHistory(false);
    const { data, error } = await supabase.from('chat_messages').select('role, content, payload').eq('session_id', id).order('created_at');
    if (error) return toast(error.message, 'error');
    const ids = [...new Set((data ?? []).flatMap((m) => ((m.payload as { recommendations?: ChatPayloadRec[] })?.recommendations ?? []).map((r) => r.itemId)))];
    // The picks of every answer, in groups (a long conversation's ids don't fit one URL), without embeddings.
    const parts = await Promise.all(idChunks(ids).map((c) => supabase.from('content_items').select(DB_ITEM_COLUMNS).in('id', c)));
    if (parts.some((p) => p.error)) toast('Some picks of this conversation could not be loaded.', 'error');
    const items = parts.flatMap((p) => (p.data ?? []) as unknown as DbItem[]);
    const byId = new Map(items.map((i) => [i.id, dbToItem(i)]));
    setSessionId(id);
    setMessages(
      (data ?? []).map((m) => {
        const p = (m.payload ?? {}) as { recommendations?: ChatPayloadRec[]; clarifyingQuestion?: Msg['clarify']; intent?: { summary?: string } };
        return {
          role: m.role as Msg['role'],
          content: m.content,
          summary: p.intent?.summary,
          clarify: p.clarifyingQuestion,
          recs: restoreRecs(p.recommendations, byId),
        };
      }),
    );
  };

  const last = messages[messages.length - 1];
  const showRefine = !!(last && last.role === 'assistant' && last.recs?.length);

  const newChat = () => {
    setSessionId(undefined);
    setMessages([]);
    setShowHistory(false);
  };

  return (
    <div className="flex min-h-[calc(100dvh-5rem)] flex-col md:min-h-dvh">
      <PageHeader eyebrow="Echo AI" title={<>Tell me what you’re <span className="text-mist italic">looking for</span></>}>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-sm text-mist hover:text-bone"><History className="h-4 w-4" /> History</button>
          <button type="button" onClick={newChat} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-sm text-mist hover:text-bone"><Plus className="h-4 w-4" /> New</button>
        </div>
      </PageHeader>

      {showHistory && (
        <div className="mx-4 mt-4 max-h-72 overflow-y-auto rounded-2xl border border-line bg-ink-2 p-2 md:mx-8 md:max-w-lg">
          {(sessions.data ?? []).length === 0 && <p className="p-3 text-sm text-mist">No conversations yet.</p>}
          {(sessions.data ?? []).map((s) => (
            <button key={s.id} type="button" onClick={() => openSession(s.id)} className={`block w-full truncate rounded-xl px-3 py-2.5 text-left text-sm hover:bg-ink-3 ${s.id === sessionId ? 'text-ember' : ''}`}>
              {s.title ?? 'Conversation'} <span className="text-xs text-dim">· {new Date(s.updated_at).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-6 px-4 pt-6 pb-10 md:px-8">
        {messages.length === 0 && (
          <div className="max-w-4xl">
            <p className="max-w-xl text-[15px] leading-relaxed text-mist">Speak naturally, in any language: a feeling, a reference, a curiosity. ECHO reads the intent behind it, searches real catalogs and explains every pick.</p>
            <p className="mt-6 text-xs font-semibold tracking-[0.18em] text-dim uppercase">Try asking</p>
            <div className="mt-3 grid gap-2.5 md:grid-cols-2">
              {STARTERS.map(({ icon: Icon, text }) => (
                <button key={text} type="button" onClick={() => send(text)} className="group flex items-start gap-3 rounded-2xl border border-line bg-ink-2/70 p-4 text-left transition-colors duration-150 hover:border-ember/40 hover:bg-ink-2">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ember/10 text-ember transition-colors group-hover:bg-ember/20"><Icon className="h-[18px] w-[18px]" aria-hidden /></span>
                  <span className="font-display text-[15px] leading-snug text-bone/90">{text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="ml-auto max-w-[85%] rounded-3xl rounded-br-lg bg-ink-4 px-4 py-3 md:max-w-xl">
              {m.content}
            </motion.div>
          ) : (
            <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-5xl">
              <div className="flex gap-3">
                <EchoMark size={28} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-display text-[17px] leading-relaxed">{m.content}</p>
                  {m.summary && <p className="mt-1 text-xs text-dim">Interpreted · {m.summary}</p>}
                  {m.clarify && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {m.clarify.options.map((o) => (
                        <button key={o} type="button" onClick={() => send(o)} className="rounded-full border border-ember/40 px-3.5 py-1.5 text-sm text-ember hover:bg-ember/10">{o}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {m.recs && m.recs.length > 0 && <ChatAnswer recs={m.recs} answerKey={String(i)} onOpen={openRec} onWatch={watchRec} />}
            </motion.div>
          ),
        )}
        {busy && <Listening label="Interpreting, searching, ranking…" />}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="echo-composer-offset md:echo-composer-offset-wide sticky z-30 px-4 pb-3 md:px-8 md:pb-6"
      >
        {showRefine && !busy && (
          <div className="scrollbar-none -mx-4 mb-2 flex gap-2 overflow-x-auto px-4 text-sm md:mx-0 md:px-0" aria-label="Refine suggestions">
            {REFINEMENTS.map((r) => (
              <button key={r} type="button" onClick={() => send(r)} className="shrink-0 rounded-full border border-line bg-ink-2/95 px-3 py-1.5 text-mist backdrop-blur-xl hover:border-white/20 hover:text-bone">{r}</button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-3xl border border-line bg-ink-2/95 p-2 pl-4 shadow-2xl backdrop-blur-xl focus-within:border-ember/50 md:max-w-3xl">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            maxLength={1000}
            placeholder={sessionId ? 'Refine: “less dark”, “only podcasts”…' : 'What are you in the mood for?'}
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-2.5 placeholder:text-dim focus:outline-none"
            aria-label="Message Echo"
          />
          <button disabled={busy || !input.trim()} className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-ember text-ink disabled:opacity-40" aria-label="Send"><ArrowUp className="h-5 w-5" /></button>
        </div>
      </form>
      <DetailSheet rec={open?.rec ?? null} autoPlay={open?.play} source="chat" onClose={() => setOpenState(null)} />
    </div>
  );
}
