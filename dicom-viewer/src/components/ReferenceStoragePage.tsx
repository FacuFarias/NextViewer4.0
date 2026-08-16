import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCurrentUser, logout } from '../services/auth';
import { referenceStorageService } from '../services/referenceStorage';
import type { ReferenceStudy } from '../types/referenceStorage';

// Keep the page bounded; filtering and pagination are performed by the API/DB.
const PAGE_SIZE = 20;

const bytes = (value: number): string => {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
};

const importLabel = (study: ReferenceStudy): string => {
  const job = study.latestImport;
  if (!job) return study.pacsPresent ? 'En dcm4chee' : 'No importado';
  if (job.status === 'queued') return 'En cola';
  if (job.status === 'importing') return `Importando ${job.progress.toFixed(0)}%`;
  if (job.status === 'completed') return 'En dcm4chee';
  if (job.status === 'failed') return 'Error';
  return 'Cancelado';
};

export default function ReferenceStoragePage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ReferenceStudy[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [seg, setSeg] = useState<'all' | 'with' | 'without'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pulling, setPulling] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchSize, setBatchSize] = useState<5 | 10 | 20>(5);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await referenceStorageService.list({ search, seg, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setItems(result.items); setTotal(result.total); setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar el catálogo');
    } finally { if (!quiet) setLoading(false); }
  }, [page, search, seg]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!items.some(item => ['queued', 'importing'].includes(item.latestImport?.status || ''))) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const stats = useMemo(() => ({
    withSeg: items.filter(item => item.hasSeg).length,
    inPacs: items.filter(item => item.pacsPresent).length,
  }), [items]);

  const selectableItems = useMemo(() => items.filter(item =>
    item.scanStatus === 'ready' && !['queued', 'importing'].includes(item.latestImport?.status || '')
  ), [items]);
  const selectedOnPage = selectableItems.filter(item => selectedIds.has(item.id));
  const allVisibleSelected = selectableItems.length > 0 && selectedOnPage.length === selectableItems.length;

  const toggleSelected = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (allVisibleSelected) selectableItems.forEach(item => next.delete(item.id));
      else selectableItems.forEach(item => next.add(item.id));
      return next;
    });
  };

  const pull = async (study: ReferenceStudy) => {
    setPulling(current => new Set(current).add(study.id));
    try { await referenceStorageService.pull(study.id); await load(true); }
    catch (pullError) { setError(pullError instanceof Error ? pullError.message : 'No se pudo iniciar el pull'); }
    finally { setPulling(current => { const next = new Set(current); next.delete(study.id); return next; }); }
  };

  const pullBatch = async () => {
    const ids = [...selectedIds].slice(0, batchSize);
    if (!ids.length) return;
    setPulling(current => new Set([...current, ...ids]));
    try {
      await referenceStorageService.pullBatch(ids);
      setSelectedIds(current => {
        const next = new Set(current);
        ids.forEach(id => next.delete(id));
        return next;
      });
      await load(true);
    } catch (pullError) {
      setError(pullError instanceof Error ? pullError.message : 'No se pudo iniciar el pull del lote');
    } finally {
      setPulling(current => {
        const next = new Set(current);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }
  };

  return (
    <div className="reference-page">
      <header className="viewer-header">
        <div className="header-left">
          <button className="back-to-studies" onClick={() => navigate('/')}>← Estudios PACS</button>
          <h1>Reference Storage</h1><span className="server-badge">S3</span>
        </div>
        <div className="header-right">
          <span className="session-user-badge">{getCurrentUser()}</span>
          <button className="logout-btn" onClick={() => void logout()}>Cerrar sesión</button>
        </div>
      </header>

      <main className="reference-content">
        <div className="reference-title-row">
          <div><h2>Estudios anonimizados</h2><p>{total.toLocaleString()} accessions catalogados en S3</p></div>
          <div className="reference-stats"><span>SEG en página: {stats.withSeg}</span><span>En PACS: {stats.inPacs}</span></div>
        </div>
        <form className="reference-filters" onSubmit={event => { event.preventDefault(); setPage(0); setSearch(searchInput.trim()); }}>
          <input value={searchInput} onChange={event => setSearchInput(event.target.value)}
            placeholder="Buscar accession, Study UID, paciente anonimizado…" />
          <button type="submit">Buscar</button>
          <select value={seg} onChange={event => { setPage(0); setSeg(event.target.value as typeof seg); }}>
            <option value="all">Todos los SEG</option><option value="with">Con SEG</option><option value="without">Sin SEG</option>
          </select>
          <button type="button" onClick={() => void load()}>Actualizar</button>
        </form>
        <div className="reference-batch-toolbar">
          <label className="reference-select-all"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /> Seleccionar visibles</label>
          <span>{selectedIds.size} seleccionados</span>
          <label>Pull de <select value={batchSize} onChange={event => setBatchSize(Number(event.target.value) as typeof batchSize)}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select> estudios</label>
          <button className="reference-batch-pull" disabled={!selectedIds.size || pulling.size > 0} onClick={() => void pullBatch()}>
            {pulling.size ? `Encolando ${pulling.size}…` : `Pull lote (${Math.min(selectedIds.size, batchSize)})`}
          </button>
          {selectedIds.size > batchSize && <small>Los restantes quedan seleccionados para el siguiente lote.</small>}
        </div>
        {error && <div className="reference-error">{error}</div>}
        <div className="reference-table-wrap">
          <table className="reference-table">
            <thead><tr><th className="reference-select-cell"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} aria-label="Seleccionar estudios visibles" /></th><th>Accession</th><th>Study Instance UID</th><th>Fuente</th><th>SEG</th><th>Mediciones</th><th>dcm4chee</th><th /></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} className="reference-empty">Cargando catálogo…</td></tr> : items.length === 0 ?
                <tr><td colSpan={8} className="reference-empty">No se encontraron estudios.</td></tr> : items.map(study => (
                <Fragment key={study.id}>
                  <tr>
                    <td className="reference-select-cell"><input type="checkbox" checked={selectedIds.has(study.id)} disabled={study.scanStatus !== 'ready' || ['queued', 'importing'].includes(study.latestImport?.status || '')} onChange={() => toggleSelected(study.id)} aria-label={`Seleccionar ${study.accessionNumber}`} /></td>
                    <td><strong>{study.accessionNumber}</strong><small>{study.patientId || 'Sin Patient ID'} · {study.modality || 'N/A'}</small></td>
                    <td className="reference-uid">{study.studyInstanceUID || <span className="reference-bad">No disponible</span>}</td>
                    <td>{study.objectCount.toLocaleString()} DICOM<small>{bytes(study.totalSizeBytes)}</small></td>
                    <td><span className={`reference-pill ${study.hasSeg ? 'ok' : ''}`}>{study.hasSeg ? `${study.segmentationCount} SEG` : 'Sin SEG'}</span><small>{study.segmentationOrigins.join(', ')}</small></td>
                    <td>{study.measurements.reduce((sum, item) => sum + item.count, 0)}<small>{study.measurements.slice(0, 2).map(item => item.labelName).join(', ') || 'Sin mediciones'}</small></td>
                    <td><span className={`reference-pill import-${study.latestImport?.status || 'none'}`}>{importLabel(study)}</span>
                      {study.latestImport?.errorMessage && <small className="reference-bad">{study.latestImport.errorMessage}</small>}</td>
                    <td className="reference-actions">
                      <button onClick={() => setExpanded(expanded === study.id ? null : study.id)} title="Ver detalle">⌄</button>
                      <button className="reference-pull" disabled={study.scanStatus !== 'ready' || pulling.has(study.id) || ['queued','importing'].includes(study.latestImport?.status || '')}
                        onClick={() => void pull(study)}>{pulling.has(study.id) ? 'Encolando…' : study.pacsPresent ? 'Pull otra vez' : 'Pull a PACS'}</button>
                    </td>
                  </tr>
                  {expanded === study.id && <tr key={`${study.id}-detail`} className="reference-detail-row"><td colSpan={8}>
                    <div className="reference-detail-grid">
                      <div><h4>S3</h4><code>s3://{study.sourceBucket}/{study.sourcePrefix}</code><p>Último escaneo: {study.lastScannedAt ? new Date(study.lastScannedAt).toLocaleString() : '—'}</p></div>
                      <div><h4>DICOM SEG</h4>{study.segmentations.length ? study.segmentations.map(item => <p key={item.id}>{item.name} · {item.origin} · v{item.version}{item.segmentSummary.length ? ` · ${item.segmentSummary.map(segment => segment.label).join(', ')}` : ''}</p>) : <p>Sin objetos SEG registrados.</p>}</div>
                      <div><h4>Mediciones / anotaciones</h4>{study.measurements.length ? study.measurements.map(item => <p key={`${item.labelCode}-${item.toolName}`}>{item.labelName} · {item.toolName} · {item.count}</p>) : <p>Sin mediciones registradas.</p>}</div>
                    </div>
                  </td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="reference-pagination"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>← Anterior</button><span>Página {page + 1} de {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Siguiente →</button></div>
      </main>
    </div>
  );
}
