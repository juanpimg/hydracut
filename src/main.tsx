import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useProjectStore } from './store/useProjectStore';
import { useUIStore } from './store/useUIStore';

if (typeof window !== 'undefined') {
  (window as unknown as { __projectStore: typeof useProjectStore; __uiStore: typeof useUIStore }).__projectStore = useProjectStore;
  (window as unknown as { __projectStore: typeof useProjectStore; __uiStore: typeof useUIStore }).__uiStore = useUIStore;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
