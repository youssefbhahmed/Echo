import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { motion } from 'motion/react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { EchoMark } from '../components/Echo';

export default function AuthPage() {
  const { session } = useAuth();
  const loc = useLocation();
  const [mode, setMode] = useState<'signin' | 'signup' | 'magic'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  if (session) return <Navigate to={(loc.state as { from?: string } | null)?.from ?? '/'} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'magic') {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        setMsg({ tone: 'ok', text: 'Check your inbox for a sign-in link.' });
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) setMsg({ tone: 'ok', text: 'Almost there. Confirm your email, then sign in.' });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setMsg({ tone: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grain relative grid min-h-dvh place-items-center overflow-hidden px-5 py-10">
      <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        {[360, 560, 760, 960].map((s, i) => (
          <div key={s} className="absolute rounded-full border border-ember/10" style={{ width: s, height: s, left: -s / 2, top: -s / 2, opacity: 1 - i * 0.2 }} />
        ))}
      </div>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="relative w-full max-w-sm">
        <EchoMark size={56} />
        <h1 className="mt-6 font-display text-5xl font-medium tracking-tight">ECHO</h1>
        <p className="mt-2 font-display text-xl text-mist italic">Discover beyond the algorithm.</p>
        <p className="mt-4 text-sm leading-relaxed text-mist">A personal curator for videos, music, films, books and podcasts that learns <em>why</em> you love what you love.</p>

        <form onSubmit={submit} className="mt-8 space-y-3">
          <label className="block">
            <span className="sr-only">Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-2xl border border-line bg-ink-2/80 px-4 py-3.5 placeholder:text-dim focus:border-ember/60 focus:outline-none" />
          </label>
          {mode !== 'magic' && (
            <label className="block">
              <span className="sr-only">Password</span>
              <input type="password" required minLength={8} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" className="w-full rounded-2xl border border-line bg-ink-2/80 px-4 py-3.5 placeholder:text-dim focus:border-ember/60 focus:outline-none" />
            </label>
          )}
          <button disabled={busy} className="w-full rounded-2xl bg-ember py-3.5 font-semibold text-ink transition hover:bg-[#ff9a70] active:scale-[0.99] disabled:opacity-60">
            {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : mode === 'magic' ? 'Email me a link' : 'Sign in'}
          </button>
          {msg && <p role="alert" className={`text-sm ${msg.tone === 'err' ? 'text-danger' : 'text-tide'}`}>{msg.text}</p>}
        </form>
        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm text-mist">
          {mode !== 'signup' && <button type="button" onClick={() => setMode('signup')} className="hover:text-bone">New here? <span className="text-ember">Create an account</span></button>}
          {mode !== 'signin' && <button type="button" onClick={() => setMode('signin')} className="hover:text-bone">Sign in with password</button>}
          {mode !== 'magic' && <button type="button" onClick={() => setMode('magic')} className="hover:text-bone">Use a magic link</button>}
        </div>
      </motion.div>
    </div>
  );
}
