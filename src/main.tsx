import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useProjectStore } from './store/useProjectStore';
import { useUIStore } from './store/useUIStore';

import { masterClock } from './core/engine/MasterClock';
import { mediaSourcePool } from './core/engine/MediaSourcePool';
import { compositor } from './core/engine/Compositor';
import {
  debeRegistrarServiceWorker,
  textoEstadoConexión,
} from './core/utils/offline';

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__projectStore = useProjectStore;
  (window as unknown as Record<string, unknown>).__uiStore = useUIStore;
  (window as unknown as Record<string, unknown>).__masterClock = masterClock;
  (window as unknown as Record<string, unknown>).__mediaSourcePool = mediaSourcePool;
  (window as unknown as Record<string, unknown>).__compositor = compositor;

  // PWA: el worker solo se registra en la compilación de producción, nunca en
  // el servidor de desarrollo (la suite de navegador corre contra el dev
  // server y queda intacta). Sin worker la app funciona igual que antes.
  const entorno = (import.meta as unknown as { env?: { PROD?: boolean } }).env;
  const conServiceWorker =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  if (debeRegistrarServiceWorker({ esProducción: entorno?.PROD === true, hayServiceWorker: conServiceWorker })) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        // Sin shell sin conexión, pero la app sigue funcionando en línea.
      });
    });
  }

  // Distintivo discreto de conexión: informa sin bloquear. La app es 100 %
  // local, así que sin red todo sigue funcionando; el distintivo solo dice
  // que no hay red y desaparece al volver.
  if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
    const distintivo = document.createElement('div');
    distintivo.id = 'hydra-estado-conexión';
    distintivo.setAttribute('role', 'status');
    distintivo.setAttribute('aria-live', 'polite');
    distintivo.style.cssText =
      'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);' +
      'z-index:60;padding:4px 12px;border-radius:9999px;font-size:12px;' +
      'background:rgba(13,17,23,.85);color:#94a3b8;border:1px solid #26303d;' +
      'pointer-events:none;display:none;';
    const actualizar = () => {
      const texto = textoEstadoConexión(navigator.onLine);
      distintivo.textContent = texto;
      distintivo.style.display = texto ? 'block' : 'none';
    };
    window.addEventListener('online', actualizar);
    window.addEventListener('offline', actualizar);
    actualizar();
    document.body.appendChild(distintivo);
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
