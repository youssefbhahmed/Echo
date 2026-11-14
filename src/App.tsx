import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { supabaseConfigured } from './lib/supabase';
import { useProfile } from './hooks/data';
import { Shell } from './components/Shell';
import { Listening } from './components/Echo';
import AuthPage from './pages/Auth';
import Discover from './pages/Discover';

const Chat = lazy(() => import('./pages/Chat'));
const Taste = lazy(() => import('./pages/Taste'));
const LibraryPage = lazy(() => import('./pages/Library'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Onboarding = lazy(() => import('./pages/Onboarding'));

function Gate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const profile = useProfile();
  const loc = useLocation();
  if (loading) return <Listening label="Waking up…" />;
  if (!session) return <Navigate to="/auth" replace state={{ from: loc.pathname }} />;
  if (profile.isLoading) return <Listening label="Remembering you…" />;
  if (profile.isError)
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <p className="font-display text-2xl">ECHO can’t reach its server right now.</p>
        <p className="mt-2 text-sm text-mist">{(profile.error as Error).message}</p>
        <button type="button" onClick={() => profile.refetch()} className="mt-5 rounded-full bg-ember px-5 py-2.5 font-semibold text-ink">Try again</button>
      </div>
    );
  if (profile.data && !profile.data.account.onboarded_at && loc.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg px-6 py-20">
      <h1 className="font-display text-3xl">ECHO isn’t configured yet</h1>
      <p className="mt-3 text-mist">Set <code className="text-bone">VITE_SUPABASE_URL</code> and <code className="text-bone">VITE_SUPABASE_PUBLISHABLE_KEY</code> in <code className="text-bone">.env.local</code> (see README → Setup), then restart the dev server.</p>
    </div>
  );
}

export default function App() {
  if (!supabaseConfigured) return <NotConfigured />;
  return (
    <Suspense fallback={<Listening label="Loading…" />}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/welcome" element={<Gate><Onboarding /></Gate>} />
        <Route element={<Gate><Shell /></Gate>}>
          <Route index element={<Discover />} />
          <Route path="echo" element={<Chat />} />
          <Route path="taste" element={<Taste />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
