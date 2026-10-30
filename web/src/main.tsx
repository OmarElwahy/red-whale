import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // Live updates arrive over the WebSocket (Phase 5); don't refetch the whole graph on every focus.
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
