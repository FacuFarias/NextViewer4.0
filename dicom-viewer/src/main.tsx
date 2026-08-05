import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

async function bootstrap() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/dicom-cache-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    } catch (error) {
      console.warn('[DICOM cache] Service Worker unavailable', error);
    }
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
