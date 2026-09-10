import { useEffect, useMemo, useState } from 'react';
import {
  deletePersonalProtocol,
  layoutSlotCount,
  restoreGlobalProtocol,
  savePersonalProtocol,
  SYSTEM_HANGING_PROTOCOLS,
} from '../services/hangingProtocols';
import {
  HANGING_MODALITIES,
  type HangingLayout,
  type HangingModality,
  type HangingProtocol,
  type HangingViewportRule,
} from '../types/hangingProtocol';

const LAYOUTS: HangingLayout[] = ['1x1', '1x2', '2x1', '2x2', 'mpr'];
const splitValues = (value: string): string[] => value.split(',').map(entry => entry.trim()).filter(Boolean);
const cloneProtocol = (protocol: HangingProtocol): HangingProtocol =>
  JSON.parse(JSON.stringify(protocol)) as HangingProtocol;

function blankRules(layout: HangingLayout, modality: HangingModality): HangingViewportRule[] {
  return Array.from({ length: layoutSlotCount(layout) }, (_, slot) => ({
    slot, label: `Viewport ${slot + 1}`, match: { modality },
  }));
}

interface Props {
  open: boolean;
  canEdit: boolean;
  personalProtocols: HangingProtocol[];
  onClose: () => void;
  onProtocolsChanged: (protocols: HangingProtocol[]) => void;
  onApply: (protocol: HangingProtocol) => void;
}

export default function HangingProtocolsPanel({
  open, canEdit, personalProtocols, onClose, onProtocolsChanged, onApply,
}: Props) {
  const [editing, setEditing] = useState<HangingProtocol | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allProtocols = useMemo(() => [...SYSTEM_HANGING_PROTOCOLS, ...personalProtocols], [personalProtocols]);

  useEffect(() => {
    if (!open) setEditing(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (open && event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  const startCreate = (base?: HangingProtocol) => {
    const modality = base?.modality || 'CT';
    const layout = base?.layout || '1x1';
    setError(null);
    setEditing({
      id: `new-${Date.now()}`, name: base ? `${base.name} personal` : 'Nuevo protocolo',
      modality, layout, isActive: true, source: 'user',
      viewportRules: base ? cloneProtocol(base).viewportRules : blankRules(layout, modality),
    });
  };

  const updateLayout = (layout: HangingLayout) => {
    if (!editing) return;
    setEditing({ ...editing, layout, viewportRules: blankRules(layout, editing.modality) });
  };

  const updateModality = (modality: HangingModality) => {
    if (!editing) return;
    const layout = editing.layout === 'mpr' && !['CT', 'MR'].includes(modality) ? '1x1' : editing.layout;
    setEditing({ ...editing, modality, layout, viewportRules: blankRules(layout, modality) });
  };

  const updateRule = (slot: number, patch: Partial<HangingViewportRule['match']>) => {
    if (!editing) return;
    setEditing({
      ...editing,
      viewportRules: editing.viewportRules.map(rule =>
        rule.slot === slot ? { ...rule, match: { ...rule.match, ...patch } } : rule),
    });
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await savePersonalProtocol(editing);
      const next = personalProtocols
        .filter(protocol => protocol.id !== saved.id)
        .map(protocol => saved.isActive && protocol.modality === saved.modality ? { ...protocol, isActive: false } : protocol);
      next.push(saved);
      onProtocolsChanged(next);
      setEditing(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar el protocolo.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (protocol: HangingProtocol) => {
    if (!window.confirm(`¿Eliminar “${protocol.name}”?`)) return;
    try {
      await deletePersonalProtocol(protocol.id);
      onProtocolsChanged(personalProtocols.filter(entry => entry.id !== protocol.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'No se pudo eliminar el protocolo.');
    }
  };

  const activate = async (protocol: HangingProtocol) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await savePersonalProtocol({ ...protocol, isActive: true });
      const next = personalProtocols.map(item => item.modality === saved.modality
        ? { ...item, isActive: item.id === saved.id }
        : item);
      onProtocolsChanged(next);
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : 'No se pudo activar el protocolo.');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (modality: HangingModality) => {
    try {
      await restoreGlobalProtocol(modality);
      onProtocolsChanged(personalProtocols.map(protocol =>
        protocol.modality === modality ? { ...protocol, isActive: false } : protocol));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'No se pudo restaurar el protocolo global.');
    }
  };

  return (
    <aside className={`hanging-protocols-drawer ${open ? 'open' : 'closed'}`} role="dialog" aria-modal="false" aria-hidden={!open} aria-label="Hanging protocols">
      <header className="hanging-drawer-header">
        <div><strong>Hanging protocols</strong><small>Presentación clínica por modalidad</small></div>
        <button type="button" onClick={onClose} aria-label="Cerrar">×</button>
      </header>
      {error && <div className="hanging-error" role="alert">{error}</div>}
      {!canEdit && <p className="hanging-readonly">Abra el estudio desde NextRIS para crear protocolos personales.</p>}

      {editing ? (
        <div className="hanging-editor">
          <label>Nombre<input value={editing.name} maxLength={80} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
          <div className="hanging-form-row">
            <label>Modalidad<select value={editing.modality} onChange={event => updateModality(event.target.value as HangingModality)}>{HANGING_MODALITIES.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Layout<select value={editing.layout} onChange={event => updateLayout(event.target.value as HangingLayout)}>{LAYOUTS.filter(value => value !== 'mpr' || ['CT', 'MR'].includes(editing.modality)).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
          </div>
          <label className="hanging-active-check"><input type="checkbox" checked={editing.isActive} onChange={event => setEditing({ ...editing, isActive: event.target.checked })} />Usar como protocolo predeterminado para {editing.modality}</label>
          <div className={`hanging-layout-preview layout-${editing.layout}`}>
            {editing.viewportRules.map(item => <span key={item.slot}>{item.slot + 1}</span>)}
          </div>
          {editing.viewportRules.map(viewportRule => (
            <fieldset key={viewportRule.slot} className="hanging-rule-card">
              <legend>Viewport {viewportRule.slot + 1}</legend>
              <label>Descripción incluye<input value={(viewportRule.match.descriptionIncludes || []).join(', ')} onChange={event => updateRule(viewportRule.slot, { descriptionIncludes: splitValues(event.target.value) })} /></label>
              <label>Descripción excluye<input value={(viewportRule.match.descriptionExcludes || []).join(', ')} onChange={event => updateRule(viewportRule.slot, { descriptionExcludes: splitValues(event.target.value) })} /></label>
              <div className="hanging-form-row">
                <label>Lateralidad<input placeholder="L, R" value={(viewportRule.match.laterality || []).join(', ')} onChange={event => updateRule(viewportRule.slot, { laterality: splitValues(event.target.value) })} /></label>
                <label>Proyección<input placeholder="AP, PA, MLO" value={(viewportRule.match.viewPosition || []).join(', ')} onChange={event => updateRule(viewportRule.slot, { viewPosition: splitValues(event.target.value) })} /></label>
              </div>
              <label>Parte corporal<input value={(viewportRule.match.bodyPart || []).join(', ')} onChange={event => updateRule(viewportRule.slot, { bodyPart: splitValues(event.target.value) })} /></label>
              <div className="hanging-form-row">
                <label>Serie desde<input type="number" value={viewportRule.match.seriesNumberMin ?? ''} onChange={event => updateRule(viewportRule.slot, { seriesNumberMin: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
                <label>Serie hasta<input type="number" value={viewportRule.match.seriesNumberMax ?? ''} onChange={event => updateRule(viewportRule.slot, { seriesNumberMax: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
              </div>
            </fieldset>
          ))}
          <div className="hanging-editor-actions">
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
            <button type="button" className="primary" disabled={saving || !editing.name.trim()} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar y aplicar'}</button>
          </div>
        </div>
      ) : (
        <div className="hanging-protocol-list">
          {canEdit && <button className="hanging-create-btn" type="button" onClick={() => startCreate()}>+ Crear protocolo</button>}
          {allProtocols.map(protocol => {
            const isEffective = protocol.source === 'user'
              ? protocol.isActive
              : !personalProtocols.some(item => item.modality === protocol.modality && item.isActive);
            return (
            <article key={protocol.id} className={`hanging-protocol-card ${isEffective ? 'active' : ''}`}>
              <div><strong>{protocol.name}</strong><small>{protocol.modality} · {protocol.layout.toUpperCase()} · {protocol.source === 'system' ? 'Global' : 'Personal'}</small></div>
              <div className="hanging-card-actions">
                <button type="button" onClick={() => onApply(protocol)}>Aplicar</button>
                {canEdit && protocol.source === 'system' && <button type="button" onClick={() => startCreate(protocol)}>Duplicar</button>}
                {canEdit && protocol.source === 'user' && <>{!protocol.isActive && <button type="button" disabled={saving} onClick={() => void activate(protocol)}>Activar</button>}<button type="button" onClick={() => setEditing(cloneProtocol(protocol))}>Editar</button><button type="button" onClick={() => void remove(protocol)}>Eliminar</button></>}
                {canEdit && protocol.source === 'system' && personalProtocols.some(item => item.modality === protocol.modality && item.isActive) && <button type="button" onClick={() => void restore(protocol.modality)}>Restaurar global</button>}
              </div>
            </article>
          )})}
        </div>
      )}
    </aside>
  );
}
