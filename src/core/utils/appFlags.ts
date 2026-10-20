/**
 * Banderas persistidas de la app (pulido UI).
 *
 * La bienvenida solo se muestra al visitante primerizo: una vez vista se
 * guarda la bandera en `localStorage`. Todo el acceso es defensivo — si el
 * almacenamiento no está disponible (modo privado, SSR, tests en Node) las
 * funciones NO lanzan: `hasSeenWelcome` devuelve `false` (el valor seguro es
 * mostrar la bienvenida) y `mark/resetWelcomeSeen` son no-ops.
 *
 * La API acepta un almacenamiento inyectable para que sea 100 % testeable
 * sin DOM: `hasSeenWelcome(mock)`, `markWelcomeSeen(mock)`,
 * `resetWelcomeSeen(mock)`. Sin argumento se usa `globalThis.localStorage`.
 */

/** Clave de `localStorage` que recuerda que ya se vio la bienvenida. */
export const WELCOME_SEEN_KEY = 'hydracut.hasSeenWelcome';

/** Superficie mínima de almacenamiento que necesita este módulo. */
export type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function globalFlagStorage(): FlagStorage | null {
  try {
    const candidate = (globalThis as unknown as { localStorage?: FlagStorage }).localStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}

function resolveFlagStorage(explicit?: FlagStorage | null): FlagStorage | null {
  if (explicit !== undefined) return explicit;
  return globalFlagStorage();
}

/**
 * `true` cuando el usuario ya vio (y cerró) la bienvenida.
 * Nunca lanza: sin almacenamiento devuelve `false` (mostrar es el valor seguro).
 */
export function hasSeenWelcome(storage?: FlagStorage | null): boolean {
  try {
    const store = resolveFlagStorage(storage);
    if (!store) return false;
    return store.getItem(WELCOME_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Recuerda que el usuario ya vio la bienvenida. Nunca lanza. */
export function markWelcomeSeen(storage?: FlagStorage | null): void {
  try {
    resolveFlagStorage(storage)?.setItem(WELCOME_SEEN_KEY, '1');
  } catch {
    /* almacenamiento no disponible (modo privado): no es un error fatal */
  }
}

/** Olvida la bandera (para tests y para "ver la guía de nuevo"). Nunca lanza. */
export function resetWelcomeSeen(storage?: FlagStorage | null): void {
  try {
    resolveFlagStorage(storage)?.removeItem(WELCOME_SEEN_KEY);
  } catch {
    /* idem */
  }
}

/** `true` cuando hay que mostrar la bienvenida al arrancar. */
export function shouldShowWelcome(storage?: FlagStorage | null): boolean {
  return !hasSeenWelcome(storage);
}
