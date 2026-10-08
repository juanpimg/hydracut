import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useProjectStore } from './store/useProjectStore';
import { useUIStore } from './store/useUIStore';

import { masterClock } from './core/engine/MasterClock';
import { mediaSourcePool } from './core/engine/MediaSourcePool';
import { compositor } from './core/engine/Compositor';

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__projectStore = useProjectStore;
  (window as unknown as Record<string, unknown>).__uiStore = useUIStore;
  (window as unknown as Record<string, unknown>).__masterClock = masterClock;
  (window as unknown as Record<string, unknown>).__mediaSourcePool = mediaSourcePool;
  (window as unknown as Record<string, unknown>).__compositor = compositor;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
