import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { sharedBridge } from './core/faultlineEngine';
import './styles.css';

// Auto-configure Firebase AI Logic Hybrid SDK (@firebase/ai 3.1.0) when env vars are supplied at build time
const env = import.meta.env as Record<string, string | undefined>;
if (env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID) {
  sharedBridge.configure(
    {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    },
    env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || undefined,
  );
}

// Register offline-first PWA Service Worker in production / preview builds
if (!import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const isExtension = window.location.protocol === 'chrome-extension:';
    if (!isExtension) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal in restricted iframe sandboxes
      });
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
