import { useState, type FC, type FormEvent } from 'react';
import { login } from '../services/auth';

interface LoginPageProps { onAuthenticated: () => void; }

const LoginPage: FC<LoginPageProps> = ({ onAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      setPassword('');
      onAuthenticated();
    } catch (loginError) {
      const status = (loginError as Error & { status?: number }).status;
      setError(status === 401
        ? 'Usuario o contraseña incorrectos.'
        : 'No fue posible iniciar sesión con Keycloak. Inténtalo nuevamente.');
    } finally { setBusy(false); }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-brand-mark">N</span>
          <div><strong>Next Viewer</strong><small>Plataforma DICOM 3D</small></div>
        </div>
        <div className="login-heading">
          <h1 id="login-title">Iniciar sesión</h1>
          <p>Accede con tu cuenta de Keycloak para trabajar en la plataforma.</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>Usuario</span>
            <input autoComplete="username" autoFocus value={username}
              onChange={event => setUsername(event.target.value)} disabled={busy} required />
          </label>
          <label>
            <span>Contraseña</span>
            <input type="password" autoComplete="current-password" value={password}
              onChange={event => setPassword(event.target.value)} disabled={busy} required />
          </label>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? 'Autenticando…' : 'Ingresar'}
          </button>
        </form>
        <div className="login-keycloak-badge">Protegido por Keycloak</div>
      </section>
    </main>
  );
};

export default LoginPage;
