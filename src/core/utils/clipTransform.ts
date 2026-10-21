/**
 * Rotación / volteo / recorte (encuadre) de un clip — ÚNICA fuente de verdad.
 *
 * Quién usa este módulo (para que no diverjan, como ya pasó con la velocidad
 * F4, el crossfade F5, los fundidos de audio y los filtros F9):
 * - el preview y el export (`Compositor.drawMediaToCanvas`, evaluado por
 *   frame a través del MISMO `Compositor` en ambos caminos),
 * - el exportador (`resolveExportClipTransform`, el ancla literal de la
 *   paridad preview ≡ export),
 * - el Inspector (los controles de «Transformación» escriben estos campos).
 *
 * ## Modelo
 *
 * - `rotation`: grados en sentido horario, SOLO ángulos rectos
 *   (`0 | 90 | 180 | 270`). Una rotación libre es otra feature y queda fuera.
 * - `flipH` / `flipV`: espejo horizontal / vertical (booleanos).
 * - `crop`: fracciones de la fuente (0..1) ELIMINADAS por cada lado
 *   (`{ top, right, bottom, left }`). El recorte muestra solo esa región de
 *   la fuente, ESTIRADA a la caja del clip (eso es un encuadre: la caja no
 *   cambia, cambia qué píxeles la llenan).
 *
 * ## Orden: primero voltear, después rotar
 *
 * El volteo se aplica en el ESPACIO DE LA FUENTE y la rotación después, en
 * sentido horario. Así `flipH` siempre espeja la izquierda y la derecha de
 * la imagen original, sin importar el ángulo. El orden contrario haría que
 * `flipH` espejase ejes distintos con 90°/270° (con 90° espejaría
 * arriba/abajo en pantalla) y el control mentiría según la rotación.
 * En el lienzo eso es `translate(centro); rotate(θ); scale(fx, fy)`:
 * la escala (volteo) multiplica primero al punto y la rotación después.
 *
 * ## La caja no crece
 *
 * El clip se dibuja rotado sobre su centro DENTRO de su caja: con 90°/270°
 * la fuente se ajusta (`contain`) con los ejes cambiados, así que la caja
 * rotada sigue cabiendo en el lienzo. El recorte no cambia la caja: solo
 * cambia la región de origen que se estira en ella.
 *
 * ## Camino caliente
 *
 * La geometría se resuelve UNA vez por cambio de valores y se cachea por
 * clip en el `Compositor` (el mismo patrón que los filtros y los keyframes):
 * `resolveClipVisualTransform` asigna (camino frío), `resolveClipVisualInto`
 * escribe en un `out` reutilizable (cero asignaciones por frame). El contador
 * `getClipTransformBuildCount` es la prueba de que el hot path no
 * reconstruye: debe quedarse plano con los fotogramas.
 */

import type { Clip, ClipCrop, ClipRotation } from '../../types/project';

/* ------------------------------------------------------------------ */
/* Presets de encuadre                                                 */
/* ------------------------------------------------------------------ */

/** Los cinco presets de encuadre del producto. */
export type CropPresetId = 'original' | '16:9' | '9:16' | '1:1' | '4:5';

/** El orden en que se muestran en el inspector. */
export const CROP_PRESET_ORDER: readonly CropPresetId[] = [
  'original',
  '16:9',
  '9:16',
  '1:1',
  '4:5',
];

/** Etiquetas en español de los presets. */
export const CROP_PRESET_LABELS: Record<CropPresetId, string> = {
  original: 'Original',
  '16:9': '16:9',
  '9:16': '9:16',
  '1:1': '1:1',
  '4:5': '4:5',
};

/** Aspecto (ancho/alto) que encuadra cada preset (salvo «Original»). */
export const CROP_PRESET_ASPECTS: Record<Exclude<CropPresetId, 'original'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

/** Las cuatro rotaciones admitidas. */
export const CLIP_ROTATIONS: readonly ClipRotation[] = [0, 90, 180, 270];

/* ------------------------------------------------------------------ */
/* Saneamiento                                                         */
/* ------------------------------------------------------------------ */

/**
 * Solo 0/90/180/270 son válidos; cualquier otra cosa (ángulo libre,
 * negativo, NaN, texto) es «sin rotar». Una rotación libre es otra feature.
 */
export function sanitizeRotation(value: unknown): ClipRotation {
  return value === 0 || value === 90 || value === 180 || value === 270
    ? value
    : 0;
}

/** El volteo es booleano estricto: solo `true` es voltear. */
export function sanitizeFlip(value: unknown): boolean {
  return value === true;
}

/** Acota un borde del recorte a [0, 1]; lo no finito es 0 (nada quitado). */
export function clampCropEdge(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Normaliza un recorte para guardarlo (camino frío: el Inspector al editar).
 *
 * - Cada borde se acota a [0, 1].
 * - Si un eje suma >= 1 (no quedaría nada visible), el eje se reescala en
 *   proporción (el centro manda: 0,8/0,8 → 0,5/0,5 menos un épsilon).
 * - Un recorte neutral (nada quitado) es `undefined`: el clip no lleva clave
 *   (la forma común no cambia, como los filtros y los efectos de audio).
 */
export function normalizeCrop(raw: unknown): ClipCrop | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Partial<ClipCrop>;
  let top = clampCropEdge(source.top);
  let right = clampCropEdge(source.right);
  let bottom = clampCropEdge(source.bottom);
  let left = clampCropEdge(source.left);
  const vertical = top + bottom;
  if (vertical >= 1) {
    const scale = vertical > 0 ? (1 - 1e-6) / vertical : 0;
    top *= scale;
    bottom *= scale;
  }
  const horizontal = left + right;
  if (horizontal >= 1) {
    const scale = horizontal > 0 ? (1 - 1e-6) / horizontal : 0;
    left *= scale;
    right *= scale;
  }
  if (top <= 0 && right <= 0 && bottom <= 0 && left <= 0) return undefined;
  return { top, right, bottom, left };
}

/** `true` cuando el recorte no quita nada (ausente, nulo o todo a cero). */
export function isNeutralCrop(crop?: ClipCrop | null): boolean {
  if (!crop || typeof crop !== 'object') return true;
  return (
    !(crop.top > 0) && !(crop.right > 0) && !(crop.bottom > 0) && !(crop.left > 0)
  );
}

/** `true` cuando el clip no rota, no voltea y no recorta. */
export function isNeutralVisualTransform(
  clip: Pick<Clip, 'rotation' | 'flipH' | 'flipV' | 'crop'>
): boolean {
  return (
    sanitizeRotation(clip.rotation) === 0 &&
    !sanitizeFlip(clip.flipH) &&
    !sanitizeFlip(clip.flipV) &&
    isNeutralCrop(clip.crop)
  );
}

/* ------------------------------------------------------------------ */
/* Rectángulo de origen del recorte (fracciones → píxeles de fuente)   */
/* ------------------------------------------------------------------ */

/** Región de la fuente que se dibuja, en píxeles de la fuente. */
export interface CropSourceRect {
  /** Origen X (lo quitado por la izquierda, en px). */
  sx: number;
  /** Origen Y (lo quitado por arriba, en px). */
  sy: number;
  /** Anchura visible (en px). */
  sw: number;
  /** Altura visible (en px). */
  sh: number;
}

/**
 * Región visible de una fuente de `sourceWidth × sourceHeight`.
 *
 * `left`/`right` son lo ELIMINADO por cada lado: `sx = left·W`,
 * `sw = W·(1−left−right)` (análogo en vertical). Sin recorte, la fuente
 * completa. Camino caliente: escribe en `out`, no asigna.
 */
export function resolveCropSourceInto(
  sourceWidth: number,
  sourceHeight: number,
  crop: ClipCrop | undefined | null,
  out: CropSourceRect
): CropSourceRect {
  const safeW = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1;
  const safeH = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1;
  if (isNeutralCrop(crop)) {
    out.sx = 0;
    out.sy = 0;
    out.sw = safeW;
    out.sh = safeH;
    return out;
  }
  const c = crop as ClipCrop;
  const left = clampCropEdge(c.left);
  const right = clampCropEdge(c.right);
  const top = clampCropEdge(c.top);
  const bottom = clampCropEdge(c.bottom);
  out.sx = left * safeW;
  out.sy = top * safeH;
  out.sw = Math.max(1e-6, safeW * (1 - left - right));
  out.sh = Math.max(1e-6, safeH * (1 - top - bottom));
  return out;
}

/** Versión asignante de `resolveCropSourceInto` (camino frío: tests, UI). */
export function resolveCropSource(
  sourceWidth: number,
  sourceHeight: number,
  crop?: ClipCrop | null
): CropSourceRect {
  return resolveCropSourceInto(sourceWidth, sourceHeight, crop, {
    sx: 0,
    sy: 0,
    sw: 1,
    sh: 1,
  });
}

/**
 * Aspecto (ancho/alto) visible tras el recorte: lo que el usuario encuadra.
 * Sin recorte, el aspecto de la fuente. Nunca NaN/Infinito.
 */
export function cropResultAspect(
  sourceWidth: number,
  sourceHeight: number,
  crop?: ClipCrop | null
): number {
  const rect = resolveCropSource(sourceWidth, sourceHeight, crop);
  const aspect = rect.sw / rect.sh;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    const fallback = sourceWidth / sourceHeight;
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  }
  return aspect;
}

/* ------------------------------------------------------------------ */
/* Presets de encuadre (centrados, desde el aspecto de la fuente)      */
/* ------------------------------------------------------------------ */

/**
 * Recorte centrado que encuadra `preset` a partir de una fuente de
 * `sourceWidth × sourceHeight`.
 *
 * Solo se recorta UN eje (el que sobra): si la fuente es más ancha que el
 * objetivo se quitan los lados (`left == right`); si es más alta, arriba y
 * abajo (`top == bottom`). Si la fuente ya tiene el aspecto (o no hay
 * fuente útil), `undefined` (nada que recortar).
 */
export function cropPresetForSource(
  sourceWidth: number,
  sourceHeight: number,
  preset: CropPresetId
): ClipCrop | undefined {
  if (preset === 'original') return undefined;
  const safeW = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 0;
  const safeH = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 0;
  if (safeW <= 0 || safeH <= 0) return undefined;
  const target = CROP_PRESET_ASPECTS[preset];
  const source = safeW / safeH;
  // Ya encuadra (1 % de tolerancia): nada que recortar.
  if (Math.abs(source - target) / target < 0.01) return undefined;
  if (source > target) {
    // Sobra anchura: quitar lados. Visible W' = target·H.
    const keep = (target * safeH) / safeW;
    const cut = Math.min(0.999999, Math.max(0, (1 - keep) / 2));
    if (cut <= 0) return undefined;
    return { top: 0, right: cut, bottom: 0, left: cut };
  }
  // Sobra altura: quitar arriba/abajo. Visible H' = W/target.
  const keep = safeW / target / safeH;
  const cut = Math.min(0.999999, Math.max(0, (1 - keep) / 2));
  if (cut <= 0) return undefined;
  return { top: cut, right: 0, bottom: cut, left: 0 };
}

/**
 * El preset que describen los valores del clip sobre su fuente (`null` =
 * combinación manual). Compara el aspecto resultante con un 1 % de
 * tolerancia (la misma que `cropPresetForSource`).
 */
export function matchCropPreset(
  sourceWidth: number,
  sourceHeight: number,
  crop?: ClipCrop | null
): CropPresetId | null {
  if (isNeutralCrop(crop)) return 'original';
  const aspect = cropResultAspect(sourceWidth, sourceHeight, crop);
  for (const preset of CROP_PRESET_ORDER) {
    if (preset === 'original') continue;
    const target = CROP_PRESET_ASPECTS[preset];
    if (Math.abs(aspect - target) / target < 0.01) return preset;
  }
  return null;
}

/**
 * Describe el aspecto resultante en español: `16:9` cuando coincide con un
 * preset conocido, `1,78:1` (coma decimal, norma de copy) en otro caso.
 */
export function formatCropAspect(aspect: number): string {
  if (!Number.isFinite(aspect) || aspect <= 0) return '—';
  for (const preset of CROP_PRESET_ORDER) {
    if (preset === 'original') continue;
    const target = CROP_PRESET_ASPECTS[preset];
    if (Math.abs(aspect - target) / target < 0.005) return CROP_PRESET_LABELS[preset];
  }
  return `${aspect.toFixed(2).replace('.', ',')}:1`;
}

/* ------------------------------------------------------------------ */
/* Caja de destino (ajuste + rotación, dentro de sus límites)          */
/* ------------------------------------------------------------------ */

/** `true` cuando la rotación intercambia los ejes (90°/270°). */
export function swapsAxes(rotation: ClipRotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** Caja de destino del clip en el lienzo (px lógicos del proyecto). */
export interface FittedSize {
  /** Anchura de la caja (ya con la escala). */
  w: number;
  /** Altura de la caja (ya con la escala). */
  h: number;
}

/**
 * Ajuste (`contain`) de la fuente al lienzo, por la escala, con la rotación.
 *
 * Con 90°/270° la fuente se ajusta con los ejes cambiados (una fuente 16:9
 * rotada se comporta como 9:16): la caja rotada sigue cabiendo en el lienzo
 * (la caja no crece). Camino caliente: escribe en `out`, no asigna.
 */
export function resolveFittedSizeInto(
  canvasWidth: number,
  canvasHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  rotation: ClipRotation,
  out: FittedSize
): FittedSize {
  const safeCanvasW =
    Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 1;
  const safeCanvasH =
    Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 1;
  const safeSourceW =
    Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1;
  const safeSourceH =
    Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const effW = swapsAxes(rotation) ? safeSourceH : safeSourceW;
  const effH = swapsAxes(rotation) ? safeSourceW : safeSourceH;
  const srcAspect = effW / effH;
  const canvasAspect = safeCanvasW / safeCanvasH;
  let w: number;
  let h: number;
  if (srcAspect > canvasAspect) {
    w = safeCanvasW;
    h = safeCanvasW / srcAspect;
  } else {
    h = safeCanvasH;
    w = safeCanvasH * srcAspect;
  }
  out.w = Math.max(1e-6, w * safeScale);
  out.h = Math.max(1e-6, h * safeScale);
  return out;
}

/** Versión asignante de `resolveFittedSizeInto` (camino frío). */
export function resolveFittedSize(
  canvasWidth: number,
  canvasHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  rotation: ClipRotation
): FittedSize {
  return resolveFittedSizeInto(
    canvasWidth,
    canvasHeight,
    sourceWidth,
    sourceHeight,
    scale,
    rotation,
    { w: 1, h: 1 }
  );
}

/* ------------------------------------------------------------------ */
/* Transformación de lienzo (volteo primero, rotación después)         */
/* ------------------------------------------------------------------ */

/** Lo que el compositor aplica alrededor del `drawImage` del clip. */
export interface CanvasVisualTransform {
  /** Rotación horaria en radianes (para `ctx.rotate`). */
  rotateRadians: number;
  /** Escala X (para `ctx.scale`): -1 con `flipH`, 1 sin él. */
  scaleX: number;
  /** Escala Y (para `ctx.scale`): -1 con `flipV`, 1 sin él. */
  scaleY: number;
}

/**
 * De los valores del clip a los del lienzo. Pura y sin asignar de más:
 * el volteo viaja como escala para que el orden sea voltear→rotar
 * (ver la cabecera del módulo).
 */
export function resolveCanvasTransform(
  rotation: ClipRotation,
  flipH: boolean,
  flipV: boolean
): CanvasVisualTransform {
  return {
    rotateRadians: (sanitizeRotation(rotation) * Math.PI) / 180,
    scaleX: flipH ? -1 : 1,
    scaleY: flipV ? -1 : 1,
  };
}

/**
 * Aplica volteo→rotación a un punto (solo para documentar y probar el
 * orden: el compositor no transforma puntos, transforma el lienzo).
 * La rotación es horaria (eje Y hacia abajo, como el lienzo).
 */
export function applyPointTransform(
  x: number,
  y: number,
  rotation: ClipRotation,
  flipH: boolean,
  flipV: boolean
): { x: number; y: number } {
  const fx = flipH ? -x : x;
  const fy = flipV ? -y : y;
  const angle = (sanitizeRotation(rotation) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: fx * cos - fy * sin, y: fx * sin + fy * cos };
}

/* ------------------------------------------------------------------ */
/* Resolución por clip (lo que el Compositor cachea)                   */
/* ------------------------------------------------------------------ */

/** La geometría de un clip, resuelta y lista para dibujar. */
export interface ResolvedClipVisual {
  /** Rotación saneada (0 = sin rotar). */
  rotation: ClipRotation;
  /** Volteo horizontal saneado. */
  flipH: boolean;
  /** Volteo vertical saneado. */
  flipV: boolean;
  /** Fracción eliminada por la izquierda (0..1). */
  cropLeft: number;
  /** Fracción eliminada por la derecha (0..1). */
  cropRight: number;
  /** Fracción eliminada por arriba (0..1). */
  cropTop: number;
  /** Fracción eliminada por abajo (0..1). */
  cropBottom: number;
  /** `true` cuando no hay nada que transformar (atajo del camino caliente). */
  neutral: boolean;
}

/**
 * Resuelve la geometría de un clip (camino frío: asigna; el `Compositor`
 * cachea el resultado por clip y el camino caliente usa el cacheado).
 */
export function resolveClipVisualTransform(
  clip: Pick<Clip, 'rotation' | 'flipH' | 'flipV' | 'crop'>
): ResolvedClipVisual {
  countClipTransformBuild();
  const rotation = sanitizeRotation(clip.rotation);
  const flipH = sanitizeFlip(clip.flipH);
  const flipV = sanitizeFlip(clip.flipV);
  const crop = clip.crop;
  const neutral =
    rotation === 0 && !flipH && !flipV && isNeutralCrop(crop);
  return {
    rotation,
    flipH,
    flipV,
    cropLeft: neutral ? 0 : clampCropEdge(crop?.left),
    cropRight: neutral ? 0 : clampCropEdge(crop?.right),
    cropTop: neutral ? 0 : clampCropEdge(crop?.top),
    cropBottom: neutral ? 0 : clampCropEdge(crop?.bottom),
    neutral,
  };
}

/**
 * Versión sin asignar de `resolveClipVisualTransform` (camino caliente:
 * el `Compositor` la llama solo cuando el caché no vale).
 */
export function resolveClipVisualInto(
  clip: Pick<Clip, 'rotation' | 'flipH' | 'flipV' | 'crop'>,
  out: ResolvedClipVisual
): ResolvedClipVisual {
  const resolved = resolveClipVisualTransform(clip);
  out.rotation = resolved.rotation;
  out.flipH = resolved.flipH;
  out.flipV = resolved.flipV;
  out.cropLeft = resolved.cropLeft;
  out.cropRight = resolved.cropRight;
  out.cropTop = resolved.cropTop;
  out.cropBottom = resolved.cropBottom;
  out.neutral = resolved.neutral;
  return out;
}

/* ------------------------------------------------------------------ */
/* Instrumentación (tests)                                             */
/* ------------------------------------------------------------------ */

let buildCount = 0;

/**
 * Cuántas veces se resolvió DE VERDAD la geometría de un clip.
 *
 * El compositor cachea el resultado por clip, así que este contador NO debe
 * crecer con los fotogramas: es la prueba de que el camino caliente no
 * reconstruye (ni reasigna) la geometría en cada frame.
 */
export function getClipTransformBuildCount(): number {
  return buildCount;
}

/** Reinicia el contador de instrumentación. */
export function resetClipTransformBuildCount(): void {
  buildCount = 0;
}

/** Interna: cuenta una resolución real de geometría. */
export function countClipTransformBuild(): void {
  buildCount++;
}
