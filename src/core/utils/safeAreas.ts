/**
 * W-G · Guías de áreas seguras del visor.
 *
 * Matemática pura (sin React ni DOM) para que se pueda probar en Node:
 * dado el marco del visor (la caja CSS que contiene al lienzo) y la
 * resolución del proyecto, calcula dónde cae el contenido real (encaje
 * `contain`: el proyecto se inscribe sin deformarse, con bandas cuando la
 * caja no tiene su misma proporción) y, DENTRO de ese contenido, los
 * rectángulos de emisión:
 *
 * - acción 90 % (inset del 5 % por lado),
 * - título 80 % (inset del 10 % por lado),
 * - centro 50 % (inset del 25 % por lado, guía opcional de composición).
 *
 * La corrección importante: las guías siguen la PROPORCIÓN DEL PROYECTO
 * dentro del letterbox, no la caja del lienzo. Una implementación ingenua
 * (insets directos sobre la caja) desplaza las guías a las bandas negras en
 * cuanto la caja y el proyecto difieren (p. ej. proyecto 9:16 en una caja
 * apaisada tras un redimensionado).
 *
 * El overlay es solo DOM sobre el lienzo: no toca el canvas, su nitidez ni
 * la exportación (el exportador pinta desde el `Compositor`, nunca desde el
 * DOM del visor).
 */

/** Fracción del contenido que ocupa el área de acción (90 %). */
export const ACTION_SAFE_SCALE = 0.9;

/** Fracción del contenido que ocupa el área de título (80 %). */
export const TITLE_SAFE_SCALE = 0.8;

/** Fracción del contenido que ocupa el área central (50 %). */
export const CENTER_SAFE_SCALE = 0.5;

/** Clave de `localStorage` del interruptor de las guías (persiste apagado/encendido). */
export const SAFE_AREAS_STORAGE_KEY = 'hydracut.guiasSeguras';

/** Caja en píxeles dentro del marco del visor. */
export interface SafeAreaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeAreaInput {
  /** Ancho CSS del marco que contiene al lienzo (px). */
  containerWidth: number;
  /** Alto CSS del marco que contiene al lienzo (px). */
  containerHeight: number;
  /** Ancho de la resolución del proyecto (px). */
  projectWidth: number;
  /** Alto de la resolución del proyecto (px). */
  projectHeight: number;
}

export interface SafeAreaLayout {
  /** Contenido real del proyecto dentro del marco (encaje `contain`). */
  content: SafeAreaBox;
  /** Área de acción (90 % del contenido). */
  action: SafeAreaBox;
  /** Área de título (80 % del contenido). */
  title: SafeAreaBox;
  /** Área central (50 % del contenido). */
  center: SafeAreaBox;
}

const VACIA: SafeAreaBox = { x: 0, y: 0, width: 0, height: 0 };

function esFinitoPositivo(valor: number): boolean {
  return Number.isFinite(valor) && valor > 0;
}

/**
 * Inscribe un rectángulo con la proporción `aspect` dentro de `w × h`
 * (encaje `contain`): el mayor rectángulo sin deformar, centrado.
 */
export function computeContainRect(
  containerWidth: number,
  containerHeight: number,
  aspect: number
): SafeAreaBox {
  if (!esFinitoPositivo(containerWidth) || !esFinitoPositivo(containerHeight) || !esFinitoPositivo(aspect)) {
    return { ...VACIA };
  }
  const width = Math.min(containerWidth, containerHeight * aspect);
  const height = Math.min(containerHeight, containerWidth / aspect);
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Encoge una caja por cada lado en `fraction` de su tamaño
 * (`0.05` → queda el 90 % centrado). Nunca devuelve tamaños negativos.
 */
export function insetBox(box: SafeAreaBox, fraction: number): SafeAreaBox {
  if (!Number.isFinite(fraction) || fraction <= 0) return { ...box };
  const dx = box.width * fraction;
  const dy = box.height * fraction;
  return {
    x: box.x + dx,
    y: box.y + dy,
    width: Math.max(0, box.width - 2 * dx),
    height: Math.max(0, box.height - 2 * dy),
  };
}

/**
 * Calcula el contenido y las tres guías para el marco y el proyecto dados.
 * Con dimensiones degeneradas devuelve cajas vacías (nunca NaN).
 */
export function computeSafeAreaLayout(input: SafeAreaInput): SafeAreaLayout {
  const { containerWidth, containerHeight, projectWidth, projectHeight } = input;
  if (
    !esFinitoPositivo(containerWidth) ||
    !esFinitoPositivo(containerHeight) ||
    !esFinitoPositivo(projectWidth) ||
    !esFinitoPositivo(projectHeight)
  ) {
    return {
      content: { ...VACIA },
      action: { ...VACIA },
      title: { ...VACIA },
      center: { ...VACIA },
    };
  }
  const content = computeContainRect(containerWidth, containerHeight, projectWidth / projectHeight);
  return {
    content,
    action: insetBox(content, (1 - ACTION_SAFE_SCALE) / 2),
    title: insetBox(content, (1 - TITLE_SAFE_SCALE) / 2),
    center: insetBox(content, (1 - CENTER_SAFE_SCALE) / 2),
  };
}

/**
 * Convierte una caja en píxeles a estilo CSS en % del contenedor, para que el
 * overlay sea fluido ante redimensionados sin volver a medir el DOM.
 */
export function toPercentStyle(
  box: SafeAreaBox,
  containerWidth: number,
  containerHeight: number
): { left: string; top: string; width: string; height: string } {
  if (!esFinitoPositivo(containerWidth) || !esFinitoPositivo(containerHeight)) {
    return { left: '0%', top: '0%', width: '0%', height: '0%' };
  }
  const pct = (valor: number): string => `${(valor * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
  return {
    left: pct(box.x / containerWidth),
    top: pct(box.y / containerHeight),
    width: pct(box.width / containerWidth),
    height: pct(box.height / containerHeight),
  };
}

/**
 * Lee el interruptor de las guías (apagado por defecto; el modo privado o un
 * valor corrupto también apagan sin lanzar nunca).
 */
export function readSafeAreasVisible(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(SAFE_AREAS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persiste el interruptor de las guías (nunca lanza). */
export function writeSafeAreasVisible(visible: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (visible) window.localStorage.setItem(SAFE_AREAS_STORAGE_KEY, '1');
    else window.localStorage.removeItem(SAFE_AREAS_STORAGE_KEY);
  } catch {
    /* modo privado: el ajuste vive solo en memoria */
  }
}
