import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { announce } from '../layout/liveRegion';

/** Tono del aviso. Regla: semántico real, nunca decorativo. */
export type ToastTone = 'info' | 'error' | 'success';

export interface ToastData {
  /** Identificador único del aviso. */
  id: number;
  /** Titular corto (en español): qué pasó y qué hacer. */
  titulo: string;
  /** Detalle opcional (en español). */
  detalle?: string;
  /** Tono. Por defecto `info`. */
  tono?: ToastTone;
}

const TONO_CLASSES: Record<ToastTone, string> = {
  info: 'border-border text-text-1',
  error: 'border-danger/60 text-text-1',
  success: 'border-success/60 text-text-1',
};

const TONO_ICONO: Record<ToastTone, typeof Info> = {
  info: Info,
  error: AlertCircle,
  success: CheckCircle2,
};

const TONO_ICONO_CLASE: Record<ToastTone, string> = {
  info: 'text-accent',
  error: 'text-danger',
  success: 'text-success',
};

/** Milisegundos antes del auto-descarte (~5 s según DESIGN.md). */
export const TOAST_AUTO_DISMISS_MS = 5000;

export interface ToastProps {
  /** Datos del aviso. */
  toast: ToastData;
  /** Cierre (manual o automático). */
  onDismiss: (id: number) => void;
}

/**
 * Un aviso: aparece en la esquina (nunca encima del contenido), se descarta
 * solo a los ~5 s y usa los tokens semánticos. El temporizador se reinicia
 * si cambia el contenido.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const tono: ToastTone = toast.tono ?? 'info';
  const Icono = TONO_ICONO[tono];

  useEffect(() => {
    const temporizador = window.setTimeout(() => onDismiss(toast.id), TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(temporizador);
  }, [toast.id, toast.titulo, toast.detalle, onDismiss]);

  return (
    <div
      role="status"
      className={`pointer-events-auto flex w-72 items-start gap-2 rounded-lg border bg-overlay px-3 py-2 shadow-overlay ${TONO_CLASSES[tono]}`}
    >
      <Icono aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${TONO_ICONO_CLASE[tono]}`} />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-medium">{toast.titulo}</p>
        {toast.detalle && <p className="mt-0.5 text-body-sm text-text-2">{toast.detalle}</p>}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Cerrar aviso"
        className="shrink-0 cursor-pointer rounded px-1 text-text-3 transition hover:text-text-1"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export interface ToastHostProps {
  /** Avisos visibles. */
  toasts: Array<ToastData>;
  /** Cierre de un aviso. */
  onDismiss: (id: number) => void;
}

/**
 * Contenedor fijo en la esquina inferior derecha: fuera del contenido,
 * apilado hacia arriba. Expone una sola región `aria-live` cortés.
 */
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      data-testid="toast-host"
      className="pointer-events-none fixed right-4 bottom-4 z-[300] flex flex-col-reverse items-end gap-2"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

let siguienteId = 1;

/**
 * Cola de avisos para las olas U1–U7: `push` publica (y anuncia por la
 * región viva para lectores de pantalla), `dismiss` cierra.
 * Sustituye a los banners fijos que tapaban el contenido.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Array<ToastData>>([]);
  const ids = useRef(new Set<number>());

  const dismiss = useCallback((id: number) => {
    ids.current.delete(id);
    setToasts((anteriores) => anteriores.filter((aviso) => aviso.id !== id));
  }, []);

  const push = useCallback(
    (aviso: Omit<ToastData, 'id'>) => {
      const id = siguienteId++;
      ids.current.add(id);
      announce(aviso.detalle ? `${aviso.titulo}. ${aviso.detalle}` : aviso.titulo);
      setToasts((anteriores) => [...anteriores.slice(-3), { ...aviso, id }]);
      return id;
    },
    []
  );

  return { toasts, push, dismiss };
}
