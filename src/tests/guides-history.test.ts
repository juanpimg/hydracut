/**
 * W-G · Áreas seguras + historial visible.
 *
 * TDD: este fichero se escribió ANTES que la implementación.
 * - La geometría de las guías es matemática pura (`safeAreas.ts`): se prueba
 *   de forma exhaustiva (16:9, 9:16, 1:1; encaje exacto y con letterbox).
 * - Las etiquetas del historial son puras (`HistoryPanel.tsx`, sin tocar el
 *   store): se prueban contra instantáneas sintéticas.
 */
import { describe, it, expect } from 'vitest';

import {
  ACTION_SAFE_SCALE,
  CENTER_SAFE_SCALE,
  TITLE_SAFE_SCALE,
  computeSafeAreaLayout,
  toPercentStyle,
} from '../core/utils/safeAreas';
import {
  buildHistoryEntries,
  describeHistoryChange,
  planHistoryJump,
  type HistorySnapshot,
} from '../components/layout/HistoryPanel';
import type { Clip, MediaItem, Track } from '../types/project';
import type { SafeAreaBox } from '../core/utils/safeAreas';

/** Igualdad de cajas con tolerancia (el inset 5 % no es exacto en binario). */
function assertCaja(real: SafeAreaBox, esperada: SafeAreaBox): void {
  expect(real.x).toBeCloseTo(esperada.x, 9);
  expect(real.y).toBeCloseTo(esperada.y, 9);
  expect(real.width).toBeCloseTo(esperada.width, 9);
  expect(real.height).toBeCloseTo(esperada.height, 9);
}

/* ------------------------------------------------------------------ */
/* Áreas seguras                                                       */
/* ------------------------------------------------------------------ */

describe('áreas seguras · constantes del estándar de emisión', () => {
  it('acción 90 % y título 80 %', () => {
    expect(ACTION_SAFE_SCALE).toBeCloseTo(0.9, 12);
    expect(TITLE_SAFE_SCALE).toBeCloseTo(0.8, 12);
    expect(CENTER_SAFE_SCALE).toBeCloseTo(0.5, 12);
  });
});

describe('áreas seguras · encaje exacto (sin letterbox)', () => {
  it('16:9 a pantalla completa: el contenido ocupa todo el contenedor', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 960,
      containerHeight: 540,
      projectWidth: 1920,
      projectHeight: 1080,
    });
    expect(r.content).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    // Acción = inset del 5 % por lado; título = inset del 10 % por lado.
    assertCaja(r.action, { x: 48, y: 27, width: 864, height: 486 });
    assertCaja(r.title, { x: 96, y: 54, width: 768, height: 432 });
  });

  it('9:16 a pantalla completa', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 540,
      containerHeight: 960,
      projectWidth: 1080,
      projectHeight: 1920,
    });
    expect(r.content).toEqual({ x: 0, y: 0, width: 540, height: 960 });
    assertCaja(r.action, { x: 27, y: 48, width: 486, height: 864 });
    assertCaja(r.title, { x: 54, y: 96, width: 432, height: 768 });
  });

  it('1:1 a pantalla completa', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 600,
      containerHeight: 600,
      projectWidth: 1080,
      projectHeight: 1080,
    });
    expect(r.content).toEqual({ x: 0, y: 0, width: 600, height: 600 });
    assertCaja(r.action, { x: 30, y: 30, width: 540, height: 540 });
    assertCaja(r.title, { x: 60, y: 60, width: 480, height: 480 });
  });

  it('las tres guías conservan la proporción del proyecto', () => {
    for (const [pw, ph] of [[1920, 1080], [1080, 1920], [1080, 1080]] as const) {
      const r = computeSafeAreaLayout({
        containerWidth: 800,
        containerHeight: 600,
        projectWidth: pw,
        projectHeight: ph,
      });
      const aspecto = pw / ph;
      for (const caja of [r.content, r.action, r.title, r.center]) {
        expect(caja.width / caja.height).toBeCloseTo(aspecto, 9);
      }
    }
  });
});

describe('áreas seguras · letterbox (el contenido sigue al proyecto, no a la caja)', () => {
  it('proyecto 16:9 en caja vertical: bandas arriba y abajo, guías dentro', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 400,
      containerHeight: 800,
      projectWidth: 1920,
      projectHeight: 1080,
    });
    // Contenido 400x225 centrado verticalmente.
    expect(r.content.width).toBeCloseTo(400, 9);
    expect(r.content.height).toBeCloseTo(225, 9);
    expect(r.content.x).toBeCloseTo(0, 9);
    expect(r.content.y).toBeCloseTo((800 - 225) / 2, 9);
    // Las guías viven DENTRO del contenido, nunca en las bandas.
    expect(r.action.y).toBeGreaterThanOrEqual(r.content.y);
    expect(r.action.y + r.action.height).toBeLessThanOrEqual(r.content.y + r.content.height + 1e-9);
    expect(r.title.x).toBeGreaterThanOrEqual(r.content.x);
    expect(r.title.x + r.title.width).toBeLessThanOrEqual(r.content.x + r.content.width + 1e-9);
  });

  it('proyecto 9:16 en caja apaisada: bandas a los lados, guías dentro', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 800,
      containerHeight: 400,
      projectWidth: 1080,
      projectHeight: 1920,
    });
    expect(r.content.width).toBeCloseTo(225, 9);
    expect(r.content.height).toBeCloseTo(400, 9);
    expect(r.content.x).toBeCloseTo((800 - 225) / 2, 9);
    expect(r.content.y).toBeCloseTo(0, 9);
    expect(r.action.x).toBeGreaterThanOrEqual(r.content.x);
    expect(r.title.y).toBeGreaterThanOrEqual(r.content.y);
    expect(r.title.y + r.title.height).toBeLessThanOrEqual(r.content.y + r.content.height + 1e-9);
  });

  it('proyecto 1:1 en caja 16:9: contenido centrado y guías inscritas', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 960,
      containerHeight: 540,
      projectWidth: 1080,
      projectHeight: 1080,
    });
    expect(r.content.width).toBeCloseTo(540, 9);
    expect(r.content.height).toBeCloseTo(540, 9);
    expect(r.content.x).toBeCloseTo(210, 9);
    expect(r.content.y).toBeCloseTo(0, 9);
    expect(r.title.width).toBeCloseTo(540 * 0.8, 9);
  });
});

describe('áreas seguras · área central y casos degenerados', () => {
  it('el área central es el 50 % del contenido, centrada', () => {
    const r = computeSafeAreaLayout({
      containerWidth: 960,
      containerHeight: 540,
      projectWidth: 1920,
      projectHeight: 1080,
    });
    assertCaja(r.center, { x: 240, y: 135, width: 480, height: 270 });
  });

  it('dimensiones degeneradas devuelven cajas vacías (sin NaN)', () => {
    for (const entrada of [
      { containerWidth: 0, containerHeight: 540, projectWidth: 1920, projectHeight: 1080 },
      { containerWidth: 960, containerHeight: -1, projectWidth: 1920, projectHeight: 1080 },
      { containerWidth: 960, containerHeight: 540, projectWidth: 0, projectHeight: 0 },
      { containerWidth: NaN, containerHeight: 540, projectWidth: 1920, projectHeight: 1080 },
    ]) {
      const r = computeSafeAreaLayout(entrada);
      for (const caja of [r.content, r.action, r.title, r.center]) {
        expect(Number.isFinite(caja.x)).toBe(true);
        expect(Number.isFinite(caja.width)).toBe(true);
        expect(caja.width).toBeGreaterThanOrEqual(0);
        expect(caja.height).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('toPercentStyle convierte una caja a % del contenedor (para el overlay)', () => {
    const estilo = toPercentStyle({ x: 48, y: 27, width: 864, height: 486 }, 960, 540);
    expect(estilo.left).toBe('5%');
    expect(estilo.top).toBe('5%');
    expect(estilo.width).toBe('90%');
    expect(estilo.height).toBe('90%');
  });
});

/* ------------------------------------------------------------------ */
/* Historial visible                                                   */
/* ------------------------------------------------------------------ */

function pista(id = 'v1'): Track {
  return { id, name: 'Vídeo V1 (principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true };
}

function clip(parcial: Partial<Clip> & { id: string }): Clip {
  return {
    trackId: 'v1',
    mediaId: 'm1',
    name: 'Clip',
    type: 'video',
    start: 0,
    duration: 4,
    sourceStart: 0,
    sourceDuration: 10,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...parcial,
  };
}

function medio(id = 'm1'): MediaItem {
  return {
    id,
    name: 'medio.mp4',
    type: 'video',
    url: 'blob:x',
    duration: 11,
    width: 640,
    height: 360,
    fps: 25,
    thumbnailUrl: '',
    size: 777,
    createdAt: 0,
  };
}

function estado(parcial: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return { tracks: [pista()], clips: [], mediaPool: [medio()], trash: [], selectedClipIds: [], ...parcial };
}

describe('historial · etiquetas humanas (no nombres internos)', () => {
  it('añadir un clip', () => {
    const antes = estado();
    const despues = estado({ clips: [clip({ id: 'c1' })] });
    expect(describeHistoryChange(antes, despues)).toBe('Añadir clip');
  });

  it('borrar un clip', () => {
    const antes = estado({ clips: [clip({ id: 'c1' })] });
    expect(describeHistoryChange(antes, estado())).toBe('Borrar clip');
  });

  it('cambiar el volumen', () => {
    const antes = estado({ clips: [clip({ id: 'c1', volume: 1 })] });
    const despues = estado({ clips: [clip({ id: 'c1', volume: 0.5 })] });
    expect(describeHistoryChange(antes, despues)).toBe('Cambiar volumen');
  });

  it('mover un clip', () => {
    const antes = estado({ clips: [clip({ id: 'c1', start: 0 })] });
    const despues = estado({ clips: [clip({ id: 'c1', start: 6 })] });
    expect(describeHistoryChange(antes, despues)).toBe('Mover clip');
  });

  it('dividir un clip', () => {
    const antes = estado({ clips: [clip({ id: 'c1', start: 0, duration: 8 })] });
    const despues = estado({
      clips: [clip({ id: 'c2', start: 0, duration: 3 }), clip({ id: 'c3', start: 3, duration: 5 })],
    });
    expect(describeHistoryChange(antes, despues)).toBe('Dividir clip');
  });

  it('añadir una pista e importar un medio', () => {
    const antes = estado();
    const conPista = estado({
      tracks: [pista('v1'), { ...pista('a1'), name: 'Audio A1', type: 'audio' }],
    });
    expect(describeHistoryChange(antes, conPista)).toBe('Añadir pista');
    const conMedio = estado({ mediaPool: [medio('m1'), medio('m2')] });
    expect(describeHistoryChange(antes, conMedio)).toBe('Importar medio');
  });

  it('sin cambios y estado inicial', () => {
    const base = estado();
    expect(describeHistoryChange(base, estado())).toBe('Sin cambios');
    expect(describeHistoryChange(null, base)).toBe('Estado inicial');
  });
});

describe('historial · saltos (plan puro sobre la API existente)', () => {
  it('calcula deshaceres y rehaceres con tope', () => {
    expect(planHistoryJump(5, 2, 0)).toEqual({ undos: 3, redos: 0 });
    expect(planHistoryJump(2, 5, 3)).toEqual({ undos: 0, redos: 3 });
    expect(planHistoryJump(3, 3, 1)).toEqual({ undos: 0, redos: 0 });
    // El objetivo no puede salirse de [0, pasado + futuro].
    expect(planHistoryJump(2, 99, 1)).toEqual({ undos: 0, redos: 1 });
    expect(planHistoryJump(2, -4, 1)).toEqual({ undos: 2, redos: 0 });
  });

  it('construye la lista pasado → actual → futuro con el actual marcado', () => {
    const s0 = estado();
    const s1 = estado({ clips: [clip({ id: 'c1' })] });
    const s2 = estado({ clips: [clip({ id: 'c1', volume: 0.5 })] });
    const entradas = buildHistoryEntries([s0, s1], s2, []);
    expect(entradas.map((e) => e.tipo)).toEqual(['pasado', 'pasado', 'actual']);
    expect(entradas[0].etiqueta).toBe('Estado inicial');
    expect(entradas[1].etiqueta).toBe('Añadir clip');
    expect(entradas[2].etiqueta).toBe('Cambiar volumen');
    // Saltar a cada índice restaura ese punto (pasado.length objetivo).
    expect(entradas.map((e) => e.indice)).toEqual([0, 1, 2]);
  });

  it('incluye los estados futuros (para rehacer) tras el actual', () => {
    const s0 = estado();
    const actual = estado({ clips: [clip({ id: 'c1' })] });
    const futuro = estado({ clips: [clip({ id: 'c1' }), clip({ id: 'c2' })] });
    const entradas = buildHistoryEntries([s0], actual, [futuro]);
    expect(entradas.map((e) => e.tipo)).toEqual(['pasado', 'actual', 'futuro']);
    expect(entradas[2].etiqueta).toBe('Añadir clip');
    expect(entradas[2].indice).toBe(2);
  });
});
