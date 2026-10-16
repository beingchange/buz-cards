import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// Offline app shell (PWA) needs a secure context: HTTPS, or http://localhost on the computer itself.
// On a plain-HTTP Wi-Fi address the app still works fully online; it just is not installable/offline.
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => undefined);
}
