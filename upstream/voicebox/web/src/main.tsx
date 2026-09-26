import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../app/src/App';
import '../../app/src/index.css';
import { PlatformProvider } from '../../app/src/platform/PlatformContext';
import { webPlatform } from './platform';
import { useServerStore } from '../../app/src/stores/serverStore';

// This local web build is served by its own backend, including fallback ports.
// Ignore a persisted URL belonging to another Voicebox installation.
useServerStore.setState({ serverUrl: window.location.origin, mode: 'local' });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PlatformProvider platform={webPlatform}>
        <App />
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
