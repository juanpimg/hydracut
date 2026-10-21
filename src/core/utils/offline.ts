/**
 * Lógica sin conexión (PWA) de HydraCut Studio.
 *
 * Todo lo que hay aquí es puro: sin `caches`, sin `navigator`, sin DOM. Así
 * se prueba con vitest en Node y el `public/sw.js` queda como una cáscara
 * fina que replica estas decisiones (los nombres se mantienen iguales a
 * propósito para que la réplica sea evidente).
 *
 * Reglas que fija este módulo:
 * - Solo el shell de la app (`/`, `index.html`, manifiesto, iconos y los
 *   recursos de la compilación) entra en la caché, con caché-primero.
 * - Los datos del usuario viven en IndexedDB + OPFS y ni siquiera pasan por
 *   `fetch`: el worker nunca los guarda ni los borra.
 * - Al activar una versión nueva se borran las cachés viejas del shell.
 */

/** Versión del shell sin conexión. Cambiarla invalida la caché anterior. */
export const VERSION_CACHÉ = 'hydracut-v1';

/** Prefijo de las cachés que posee este worker (solo el shell). */
export const PREFIJO_CACHÉ = 'hydracut-shell-';

/** Nombre de la caché del shell para una versión dada. */
export function nombreCaché(versión: string = VERSION_CACHÉ): string {
  return `${PREFIJO_CACHÉ}${versión}`;
}

/** Entradas del shell que siempre se precargan, haya o no recursos compilados. */
export const SHELL_BASE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'] as const;

export interface ManifiestoPrecarga {
  /** Caché donde se guardan las entradas. */
  caché: string;
  /** URLs precargadas (sin duplicados ni vacías). */
  urls: string[];
}

/**
 * Calcula el manifiesto de precarga a partir de los recursos emitidos por la
 * compilación (p. ej. `/assets/index-*.js`). Pura: la misma entrada da
 * siempre la misma salida.
 */
export function construirManifiestoPrecarga(opciones: {
  versión?: string;
  recursos?: string[];
}): ManifiestoPrecarga {
  const versión = opciones.versión ?? VERSION_CACHÉ;
  const recursos = Array.isArray(opciones.recursos) ? opciones.recursos : [];
  const vistas = new Set<string>();
  const urls: string[] = [];
  for (const candidata of [...SHELL_BASE, ...recursos]) {
    if (typeof candidata !== 'string') continue;
    const url = candidata.trim();
    if (url.length === 0 || vistas.has(url)) continue;
    vistas.add(url);
    urls.push(url);
  }
  return { caché: nombreCaché(versión), urls };
}

/** Clases de petición según lo que el worker puede hacer con ellas. */
export type ClasePetición = 'navegación' | 'estático' | 'no-cacheable';

/** Estrategia de respuesta por clase de petición. */
export type EstrategiaCaché = 'caché-primero' | 'solo-red';

/**
 * Clasifica una petición (pura: trabaja con cadenas, no con `Request`).
 *
 * - `navegación`: documento del mismo origen (recarga sin red incluida).
 * - `estático`: recurso GET del mismo origen (el shell compilado).
 * - `no-cacheable`: todo lo demás (otro origen, `blob:`, `data:`, no GET).
 *   Los medios del usuario (blob:, IndexedDB, OPFS) caen siempre aquí.
 */
export function clasificarPetición(
  urlPetición: string,
  urlÁmbito: string,
  método: string
): ClasePetición {
  if (typeof urlPetición !== 'string' || urlPetición.length === 0) return 'no-cacheable';
  // El tercer argumento describe la petición: `navigate` (documento) o el
  // método HTTP (`get`, `post`, …). Solo los GET propios son cacheables.
  const esNavegación = método === 'navigate';
  if (!esNavegación && método !== 'get' && método !== 'GET') return 'no-cacheable';
  if (urlPetición.startsWith('blob:') || urlPetición.startsWith('data:')) return 'no-cacheable';
  let petición: URL;
  let ámbito: URL;
  try {
    petición = new URL(urlPetición, urlÁmbito);
    ámbito = new URL(urlÁmbito);
  } catch {
    return 'no-cacheable';
  }
  if (petición.protocol !== 'http:' && petición.protocol !== 'https:') return 'no-cacheable';
  if (petición.origin !== ámbito.origin) return 'no-cacheable';
  if (esNavegación) return 'navegación';
  return 'estático';
}

/** Estrategia de respuesta para cada clase de petición. */
export function estrategiaPara(clase: ClasePetición): EstrategiaCaché {
  return clase === 'no-cacheable' ? 'solo-red' : 'caché-primero';
}

/**
 * Cachés que debe borrar el worker al activarse: las del shell con un nombre
 * distinto al actual. Las cachés ajenas (otras librerías) no se tocan.
 */
export function cachésObsoletas(existentes: string[], actual: string): string[] {
  if (!Array.isArray(existentes)) return [];
  return existentes.filter(
    (nombre) => typeof nombre === 'string' && nombre.startsWith(PREFIJO_CACHÉ) && nombre !== actual
  );
}

/**
 * Texto del distintivo de conexión. Informa sin bloquear: la app funciona
 * igual sin red (todo es local), así que con red no hay nada que mostrar.
 */
export function textoEstadoConexión(enLínea: boolean): string {
  if (enLínea) return '';
  return 'Sin conexión · todo sigue en este navegador';
}

/**
 * Puerta de registro del worker: solo la compilación de producción con
 * `serviceWorker` disponible lo registra. El servidor de desarrollo y la
 * suite de navegador (que corre contra el dev server) quedan fuera.
 */
export function debeRegistrarServiceWorker(opciones: {
  esProducción: boolean;
  hayServiceWorker: boolean;
}): boolean {
  return opciones.esProducción === true && opciones.hayServiceWorker === true;
}
