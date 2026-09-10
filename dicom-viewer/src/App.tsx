import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import DicomViewer from './components/DicomViewer';
import { ensureAuthenticated, handleSigninCallback, setShareAccess } from './services/auth';
import { dicomWebService } from './services/dicomWeb';
import { parseViewerRequest } from './services/viewerRequest';
import { getRuntimeConfig } from './services/runtimeConfig';
import {
  exchangeHandoffCode,
  parseHandoffCode,
  parseTokenHandoff,
  storeTokenHandoff,
} from './services/tokenHandoff';
import './App.css';

function StatusPage({ title, message }: { title: string; message: string }) {
  return (
    <main className="clinical-status-page" role="alert">
      <section className="clinical-status-card">
        <h1>{title}</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

function ViewerRoute() {
  const { studyInstanceUID: pathStudyInstanceUID } = useParams();
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const parsed = useMemo(
    () => parseViewerRequest(location.search, pathStudyInstanceUID),
    [location.search, pathStudyInstanceUID]
  );

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      if (!parsed.request) return;
      try {
        const isShare = parsed.request.source === 'share';
        setShareAccess(isShare);
        dicomWebService.configureForViewerRequest(parsed.request);

        if (!isShare) {
          const authenticated = await ensureAuthenticated(
            `${location.pathname}${location.search}`,
            parsed.request.studyInstanceUID
          );
          if (!authenticated) return;
        }
        if (!cancelled) setReady(true);
      } catch (error) {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : 'No se pudo iniciar la sesión clínica.');
        }
      }
    };
    void prepare();
    return () => { cancelled = true; };
  }, [location.pathname, location.search, parsed.request]);

  if (parsed.error) return <StatusPage title="Enlace no válido" message={parsed.error} />;
  if (authError) return <StatusPage title="Acceso no autorizado" message={authError} />;
  if (!parsed.request || !ready) {
    return <StatusPage title="NextViewer 5.0 Clinical" message="Validando acceso al estudio…" />;
  }

  return (
    <DicomViewer
      studyInstanceUID={parsed.request.studyInstanceUID}
      shareAccess={parsed.request.source === 'share'}
    />
  );
}

function TokenHandoffRoute() {
  const [initialSearch] = useState(() => window.location.search);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const config = getRuntimeConfig();
    const codeRequest = parseHandoffCode(initialSearch);
    if (codeRequest) {
      window.history.replaceState(window.history.state, '', '/set-token.html');
      exchangeHandoffCode(codeRequest.code, codeRequest.studyInstanceUID)
        .then(session => {
          if (cancelled) return;
          storeTokenHandoff(session);
          window.location.replace(`/viewer?StudyInstanceUIDs=${encodeURIComponent(session.studyInstanceUID)}`);
        })
        .catch(exchangeError => {
          if (!cancelled) setError(exchangeError instanceof Error ? exchangeError.message : 'No se pudo validar la sesión de NextRIS.');
        });
      return () => { cancelled = true; };
    }
    const result = parseTokenHandoff(
      initialSearch,
      config.keycloakAuthority,
      config.tokenHandoffClientIds
    );
    if (!result.session) {
      window.history.replaceState(window.history.state, '', '/set-token.html');
      setError(result.error || 'No se pudo validar la sesión de NextRIS.');
      return;
    }
    storeTokenHandoff(result.session);
    const params = new URLSearchParams({ StudyInstanceUIDs: result.session.studyInstanceUID });
    if (result.shareToken) params.set('share_token', result.shareToken);
    window.location.replace(`/viewer?${params.toString()}`);
    return () => { cancelled = true; };
  }, [initialSearch]);

  return (
    <StatusPage
      title={error ? 'Acceso no autorizado' : 'NextViewer 5.0 Clinical'}
      message={error || 'Validando la sesión recibida desde NextRIS…'}
    />
  );
}

function OidcCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    handleSigninCallback()
      .then(returnUrl => {
        if (!cancelled) navigate(returnUrl, { replace: true });
      })
      .catch(callbackError => {
        if (!cancelled) {
          setError(callbackError instanceof Error ? callbackError.message : 'Falló el retorno de Keycloak.');
        }
      });
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <StatusPage
      title={error ? 'No se pudo iniciar sesión' : 'Iniciando sesión'}
      message={error || 'Completando autenticación segura…'}
    />
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/viewer" element={<ViewerRoute />} />
        <Route path="/viewer/:studyInstanceUID" element={<ViewerRoute />} />
        <Route path="/callback" element={<OidcCallback />} />
        <Route path="/set-token.html" element={<TokenHandoffRoute />} />
        <Route
          path="*"
          element={
            <StatusPage
              title="Acceso no habilitado"
              message="Abra las imágenes desde un enlace autorizado de NextRIS."
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
