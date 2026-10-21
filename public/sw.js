/**
 * HydraCut Studio — service worker sin conexión.
 *
 * Cáscara fina: las decisiones (qué se precarga, caché-primero por clase de
 * petición, limpieza de versiones viejas) viven y se prueban en
 * `src/core/utils/offline.ts`. Los nombres se mantienen iguales a propósito.
 *
 * - Precarga el shell (caché-primero): recargar sin red abre el editor.
 * - Los datos del usuario (IndexedDB + OPFS) no pasan por `fetch`: el worker
 *   nunca los guarda ni los borra. Solo se cachean GET del mismo origen.
 */

/* global self, caches, fetch */

// Réplica de `VERSION_CACHÉ` y `PREFIJO_CACHÉ` (ver `src/core/utils/offline.ts`).
var NOMBRE_CACHÉ = 'hydracut-shell-hydracut-v1';
var SHELL_BASE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(NOMBRE_CACHÉ)
      .then(function (caché) {
        return caché.addAll(SHELL_BASE);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (nombres) {
        var obsoletas = nombres.filter(function (nombre) {
          return (
            typeof nombre === 'string' &&
            nombre.indexOf('hydracut-shell-') === 0 &&
            nombre !== NOMBRE_CACHÉ
          );
        });
        return Promise.all(obsoletas.map(function (nombre) {
          return caches.delete(nombre);
        }));
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/** Solo los GET http(s) del mismo origen son cacheables (nunca blob:/data:). */
function esCacheable(petición) {
  if (!petición || petición.method !== 'GET') return false;
  var url = typeof petición.url === 'string' ? petición.url : '';
  if (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return false;
  if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0) return false;
  return url.indexOf(self.location.origin) === 0;
}

self.addEventListener('fetch', function (event) {
  var petición = event.request;
  // Las navegaciones van con caché-primero y caen a index.html sin red.
  if (petición.mode === 'navigate') {
    event.respondWith(
      caches.match(petición).then(function (enCaché) {
        if (enCaché) return enCaché;
        return fetch(petición)
          .then(function (respuesta) {
            var copia = respuesta.clone();
            caches.open(NOMBRE_CACHÉ).then(function (caché) {
              caché.put('/index.html', copia);
            });
            return respuesta;
          })
          .catch(function () {
            return caches.match('/index.html');
          });
      })
    );
    return;
  }
  // Recursos estáticos propios: caché-primero. Lo demás pasa a la red.
  if (!esCacheable(petición)) return;
  event.respondWith(
    caches.match(petición).then(function (enCaché) {
      if (enCaché) return enCaché;
      return fetch(petición).then(function (respuesta) {
        // Solo se guardan respuestas propias correctas (sin opacas de error).
        if (!respuesta || respuesta.status !== 200) return respuesta;
        var copia = respuesta.clone();
        caches.open(NOMBRE_CACHÉ).then(function (caché) {
          caché.put(petición, copia);
        });
        return respuesta;
      });
    })
  );
});
