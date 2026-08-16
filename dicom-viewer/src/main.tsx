import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LoginPage from './components/LoginPage.tsx'
import { initializeAuthentication, subscribeToAuthRequired } from './services/auth.ts'

function AuthenticatedRoot() {
  const [status, setStatus] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  useEffect(() => {
    let active = true;
    void initializeAuthentication().then(authenticated => {
      if (active) setStatus(authenticated ? 'authenticated' : 'anonymous');
    });
    const unsubscribe = subscribeToAuthRequired(() => setStatus('anonymous'));
    return () => { active = false; unsubscribe(); };
  }, []);

  if (status === 'checking') {
    return <div className="auth-loading"><div className="loading-spinner" /><span>Verificando sesión…</span></div>;
  }
  if (status === 'anonymous') {
    return <LoginPage onAuthenticated={() => setStatus('authenticated')} />;
  }
  return <App />;
}

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
      <AuthenticatedRoot />
    </StrictMode>,
  );
}

void bootstrap();
