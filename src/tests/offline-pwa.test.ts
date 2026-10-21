import { describe, it, expect } from 'vitest';
import {
  VERSION_CACHÉ,
  nombreCaché,
  construirManifiestoPrecarga,
  clasificarPetición,
  estrategiaPara,
  cachésObsoletas,
  textoEstadoConexión,
  debeRegistrarServiceWorker,
} from '../core/utils/offline';

/**
 * PWA / sin conexión: la lógica de la caché debe ser pura y probada sin
 * navegador (sin `caches`, sin `navigator`). El `sw.js` de `public/` es una
 * cáscara fina que replica estas decisiones; la verdad vive aquí.
 */
describe('lógica sin conexión (PWA)', () => {
  it('la versión de la caché tiene nombre y el nombre incluye la versión', () => {
    expect(typeof VERSION_CACHÉ).toBe('string');
    expect(VERSION_CACHÉ.length).toBeGreaterThan(0);
    expect(nombreCaché(VERSION_CACHÉ)).toContain(VERSION_CACHÉ);
  });

  it('el manifiesto incluye el shell (/, index.html, manifiesto, iconos) más los recursos de la compilación', () => {
    const manifiesto = construirManifiestoPrecarga({
      versión: VERSION_CACHÉ,
      recursos: ['/assets/index-abc123.js', '/assets/index-def456.css'],
    });
    expect(manifiesto.caché).toBe(nombreCaché(VERSION_CACHÉ));
    for (const entrada of ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']) {
      expect(manifiesto.urls).toContain(entrada);
    }
    expect(manifiesto.urls).toContain('/assets/index-abc123.js');
    expect(manifiesto.urls).toContain('/assets/index-def456.css');
  });

  it('el manifiesto no duplica ni deja entradas vacías', () => {
    const manifiesto = construirManifiestoPrecarga({
      versión: VERSION_CACHÉ,
      recursos: ['/index.html', ' ', '', '/assets/a.js', '/assets/a.js'],
    });
    const únicas = new Set(manifiesto.urls);
    expect(únicas.size).toBe(manifiesto.urls.length);
    expect(manifiesto.urls.every((u) => u.length > 0)).toBe(true);
  });

  it('la navegación y los recursos propios van con caché primero; lo demás solo va por red', () => {
    expect(clasificarPetición('https://app.local/', 'https://app.local/', 'navigate')).toBe(
      'navegación'
    );
    expect(clasificarPetición('https://app.local/assets/a.js', 'https://app.local/', 'get')).toBe(
      'estático'
    );
    expect(estrategiaPara('navegación')).toBe('caché-primero');
    expect(estrategiaPara('estático')).toBe('caché-primero');
  });

  it('los datos del usuario nunca entran en la caché (otro origen, blob:, data:, no GET)', () => {
    // IndexedDB y OPFS ni siquiera pasan por `fetch`, pero el worker tampoco
    // debe guardar nada que no sea el shell propio.
    expect(clasificarPetición('blob:https://app.local/uuid', 'https://app.local/', 'get')).toBe(
      'no-cacheable'
    );
    expect(clasificarPetición('data:image/png;base64,xx', 'https://app.local/', 'get')).toBe(
      'no-cacheable'
    );
    expect(clasificarPetición('https://cdn.local/lib.js', 'https://app.local/', 'get')).toBe(
      'no-cacheable'
    );
    expect(clasificarPetición('https://app.local/api/x', 'https://app.local/', 'post')).toBe(
      'no-cacheable'
    );
    expect(estrategiaPara('no-cacheable')).toBe('solo-red');
  });

  it('al activar se borran las cachés viejas y se conserva la actual', () => {
    const actual = nombreCaché(VERSION_CACHÉ);
    const viejas = cachésObsoletas([actual, 'hydracut-shell-vieja', 'otra-caché'], actual);
    expect(viejas).toContain('hydracut-shell-vieja');
    expect(viejas).not.toContain(actual);
    // Las cachés que no son del shell (otra-caché) no las toca este worker.
    expect(viejas).not.toContain('otra-caché');
  });

  it('el distintivo sin conexión informa sin bloquear (texto en español, vacío con red)', () => {
    expect(textoEstadoConexión(true)).toBe('');
    const sinRed = textoEstadoConexión(false);
    expect(sinRed.length).toBeGreaterThan(0);
    expect(sinRed).toMatch(/sin conexión/i);
  });

  it('el worker solo se registra en la compilación de producción con service worker disponible', () => {
    expect(
      debeRegistrarServiceWorker({ esProducción: true, hayServiceWorker: true })
    ).toBe(true);
    // El servidor de desarrollo y la suite de navegador nunca lo registran.
    expect(
      debeRegistrarServiceWorker({ esProducción: false, hayServiceWorker: true })
    ).toBe(false);
    expect(
      debeRegistrarServiceWorker({ esProducción: true, hayServiceWorker: false })
    ).toBe(false);
  });
});
