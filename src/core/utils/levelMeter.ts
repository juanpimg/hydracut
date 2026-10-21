import { useEffect, useRef, type RefObject } from 'react';

/**
 * Medidor de nivel del master (pico + recorte).
 *
 * El motor (`AudioEngine`) enruta toda la mezcla activa por su entrada del
 * master, donde vive un `AnalyserNode` compartido (`getAnalyserNode`). Este
 * módulo lee ese analizador y pinta el nivel de forma IMPERATIVA: un
 * `requestAnimationFrame` escribe `transform`/`opacity` en los `ref` del
 * medidor. Nunca hay `setState` por fotograma (el transporte es sensible a
 * los 60 FPS: ver `07-perf-resources.md`).
 *
 * - `medirNivel` / `picoADecibelios` son puras y probadas byte a nivel.
 * - `useMedidorNivel` es el único bucle: asigna su búfer una vez (solo lo
 *   recrea si el `fftSize` del analizador cambiase, que no cambia).
 * - La preferencia de visibilidad es local (`localStorage` + memoria, como el
 *   volumen general): el medidor es opcional y no roba sitio al monitor.
 */

/** Muestra a partir de la cual se considera que la salida recorta (0 dBFS). */
export const UMBRAL_RECORTE = 0.99;

/** Cuánto aguanta encendido el testigo de recorte tras el pico (ms). */
export const RETENCION_RECORTE_MS = 1500;

/** Tamaño inicial del búfer de lectura (se ajusta al `fftSize` real). */
export const TAMANO_LECTURA_INICIAL = 2048;

/** Preferencia de visibilidad del medidor en `localStorage`. */
export const MEDIDOR_STORAGE_KEY = 'hydracut.meterVisible';

/** El medidor se muestra por defecto (se oculta con su interruptor). */
export const MEDIDOR_VISIBLE_POR_DEFECTO = true;

/** Pico [0, 1] y si alguna muestra llegó al fondo de escala. */
export interface MedicionNivel {
  pico: number;
  recorta: boolean;
}

/**
 * Mide el pico de un bloque de muestras en dominio temporal (`-1..1`).
 *
 * Pura: el bucle del medidor y los tests la llaman con el mismo array que
 * llena `getFloatTimeDomainData`. No asigna.
 */
export function medirNivel(muestras: Float32Array): MedicionNivel {
  let pico = 0;
  let recorta = false;
  for (let i = 0; i < muestras.length; i++) {
    const valor = muestras[i] < 0 ? -muestras[i] : muestras[i];
    if (valor > pico) pico = valor;
    if (valor >= UMBRAL_RECORTE) recorta = true;
  }
  return { pico, recorta };
}

/**
 * Expresa un pico lineal en dBFS (1 = 0 dB). El silencio es `-Infinity`,
 * como en cualquier mesa: el medidor lo pinta como cero.
 */
export function picoADecibelios(pico: number): number {
  if (!Number.isFinite(pico) || pico <= 0) return -Infinity;
  return 20 * Math.log10(pico > 1 ? 1 : pico);
}

/** Copia en memoria cuando `localStorage` falta o no se puede leer. */
let memoriaMedidor = MEDIDOR_VISIBLE_POR_DEFECTO;

/**
 * Lee la preferencia de visibilidad del medidor. Nunca lanza: sin
 * almacenamiento vale la copia en memoria.
 */
export function leerMedidorVisible(): boolean {
  try {
    if (typeof localStorage === 'undefined') return memoriaMedidor;
    const crudo = localStorage.getItem(MEDIDOR_STORAGE_KEY);
    if (crudo === null) return memoriaMedidor;
    memoriaMedidor = crudo === '1';
    return memoriaMedidor;
  } catch {
    return memoriaMedidor;
  }
}

/**
 * Guarda la preferencia de visibilidad del medidor y devuelve lo guardado.
 * Nunca lanza.
 */
export function escribirMedidorVisible(visible: boolean): boolean {
  const siguiente = visible === true;
  memoriaMedidor = siguiente;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MEDIDOR_STORAGE_KEY, siguiente ? '1' : '0');
    }
  } catch {
    // Modo privado: la memoria basta para la sesión.
  }
  return siguiente;
}

/**
 * Bucle del medidor: lee el analizador del master y escribe el nivel en el
 * DOM sin pasar por React.
 *
 * - `barraRef` es el relleno (origen a la izquierda, se escala en X con el
 *   pico 0..1).
 * - `recorteRef` es el testigo de recorte (se enciende con opacidad 1 y
 *   aguanta `RETENCION_RECORTE_MS` tras el último pico).
 * - `obtenerAnalizador` provee el `AnalyserNode` (el del motor en producción).
 *
 * Sin analizador (contexto cerrado, autoplay bloqueado) pinta silencio.
 */
export function useMedidorNivel(
  barraRef: RefObject<HTMLDivElement>,
  recorteRef: RefObject<HTMLDivElement>,
  obtenerAnalizador: () => AnalyserNode | null
): void {
  const proveedorRef = useRef(obtenerAnalizador);
  proveedorRef.current = obtenerAnalizador;

  useEffect(() => {
    let muestras = new Float32Array(TAMANO_LECTURA_INICIAL);
    let raf = 0;
    let recorteHasta = 0;
    const ahora = (): number =>
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const bucle = (): void => {
      raf = requestAnimationFrame(bucle);
      const barra = barraRef.current;
      const testigo = recorteRef.current;
      if (!barra && !testigo) return;
      const analizador = proveedorRef.current();
      if (!analizador) {
        if (barra) barra.style.transform = 'scaleX(0)';
        if (testigo) testigo.style.opacity = '0';
        return;
      }
      if (muestras.length !== analizador.fftSize) {
        muestras = new Float32Array(analizador.fftSize);
      }
      try {
        analizador.getFloatTimeDomainData(muestras);
      } catch {
        return;
      }
      const medido = medirNivel(muestras);
      if (barra) barra.style.transform = `scaleX(${medido.pico.toFixed(3)})`;
      if (testigo) {
        if (medido.recorta) recorteHasta = ahora() + RETENCION_RECORTE_MS;
        testigo.style.opacity = ahora() < recorteHasta ? '1' : '0';
      }
    };

    raf = requestAnimationFrame(bucle);
    return () => cancelAnimationFrame(raf);
  }, [barraRef, recorteRef]);
}
