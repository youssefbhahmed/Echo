import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { AuthProvider } from './lib/auth';
import { PlayerProvider } from './lib/player';
import { Toaster } from './components/Toast';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true }, mutations: { retry: 0 } },
});

registerSW({ immediate: true });

// Retry reactions that could not be sent (offline, expired session) as soon as possible.
import('./hooks/data').then(({ flushFeedbackQueue }) => {
  const flush = () => flushFeedbackQueue().then((n) => { if (n) queryClient.invalidateQueries(); });
  setTimeout(flush, 3000);
  window.addEventListener('online', flush);
  window.addEventListener('focus', flush);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <AuthProvider>
          <PlayerProvider>
          <App />
          <Toaster />
          </PlayerProvider>
        </AuthProvider>
      </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
