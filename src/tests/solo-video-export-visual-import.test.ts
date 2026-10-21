/**
 * Cabos sueltos de la ola (W-K): el export de vídeo ignora el solo y la
 * importación pierde la rotación / el volteo / el recorte.
 *
 * - El WAV aplica `applySoloToTracks` antes de `renderOfflineAudio`; el vídeo
 *   debe aplicar la MISMA regla (preview ≡ export): una pista en solo es la
 *   única audible en el fichero exportado.
 * - `sanitizeImportedProject` reconstruye cada clip campo a campo: la
 *   transformación visual debe viajar con él, saneada por el helper puro
 *   `sanitizeImportedClipVisual` (mismo patrón que `sanitizeMarkers`).
 *
 * Pruebas puras (sin IndexedDB): llaman a `sanitizeImportedProject` y al
 * helper directamente, y comprueban el cableado del exportador por fuente,
 * como hacen las suites de paridad.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizeImportedClipVisual,
  sanitizeImportedCrop,
  sanitizeImportedProject,
} from '../core/storage/projectStorage';

const aqui = dirname(fileURLToPath(import.meta.url));
function fuente(relativa: string): string {
  return readFileSync(join(aqui, relativa), 'utf8');
}

/** Candidato mínimo de proyecto para la importación. */
function candidatoBase() {
  return {
    id: 'proj_x',
    name: 'X',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [
      { id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
    ],
    mediaPool: [],
    duration: 30,
    createdAt: 1,
    updatedAt: 1,
  };
}

/* ------------------------------------------------------------------ */
/* 1. El export de vídeo honra el solo                                 */
/* ------------------------------------------------------------------ */

describe('solo · el export de vídeo aplica la misma regla que el WAV', () => {
  it('webcodecsExporter importa applySoloToTracks (no duplica la regla)', () => {
    const codigo = fuente('../core/export/webcodecsExporter.ts');
    expect(codigo).toContain('applySoloToTracks');
    expect(codigo).toMatch(/from '\.\.\/engine\/AudioEngine'/);
  });

  it('ambos caminos de audio del exportador mezclan con el solo aplicado', () => {
    const codigo = fuente('../core/export/webcodecsExporter.ts');
    // Dos llamadas a `renderOfflineAudio` (WebCodecs y respaldo MediaRecorder):
    // cada una recibe las pistas con el solo ya aplicado.
    const llamadas = codigo.match(/renderOfflineAudio\(/g) ?? [];
    // Definición + 2 llamadas reales.
    expect(llamadas.length).toBeGreaterThanOrEqual(3);
    const aplicaciones = codigo.match(/applySoloToTracks\(tracks\)/g) ?? [];
    expect(aplicaciones.length).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Saneador puro de la transformación visual importada              */
/* ------------------------------------------------------------------ */

describe('sanitizeImportedClipVisual · rotación, volteo y recorte puros', () => {
  it('sin nada devuelve el objeto vacío (acarreo opcional: sin clave nueva)', () => {
    expect(sanitizeImportedClipVisual(undefined)).toEqual({});
    expect(sanitizeImportedClipVisual(null)).toEqual({});
    expect(sanitizeImportedClipVisual({})).toEqual({});
  });

  it('la rotación válida viaja (0/90/180/270)', () => {
    for (const angulo of [0, 90, 180, 270] as const) {
      expect(sanitizeImportedClipVisual({ rotation: angulo }).rotation).toBe(angulo);
    }
  });

  it('la rotación inválida es 0 (no se pierde el clip ni se rompe el dibujado)', () => {
    for (const mala of [45, -90, 360, 91, Number.NaN, '90', null, {}, []]) {
      expect(sanitizeImportedClipVisual({ rotation: mala }).rotation).toBe(0);
    }
  });

  it('el volteo es booleano estricto: lo no booleano se descarta', () => {
    expect(sanitizeImportedClipVisual({ flipH: true }).flipH).toBe(true);
    expect(sanitizeImportedClipVisual({ flipV: false }).flipV).toBe(false);
    expect('flipH' in sanitizeImportedClipVisual({ flipH: 'sí' })).toBe(false);
    expect('flipV' in sanitizeImportedClipVisual({ flipV: 1 })).toBe(false);
    expect('flipH' in sanitizeImportedClipVisual({ flipH: null })).toBe(false);
  });

  it('el recorte válido viaja intacto', () => {
    const recorte = { top: 0.1, right: 0.2, bottom: 0.15, left: 0.05 };
    expect(sanitizeImportedClipVisual({ crop: recorte }).crop).toEqual(recorte);
  });

  it('el recorte neutro (todo a cero) no añade clave', () => {
    expect(
      'crop' in
        sanitizeImportedClipVisual({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })
    ).toBe(false);
  });

  it('el recorte inválido se DESCARTA, no se recorta a algo que no dibuja nada', () => {
    const malos = [
      undefined,
      null,
      'recorte',
      42,
      // Lados no numéricos o fuera de [0,1).
      { top: '0.1', right: 0, bottom: 0, left: 0 },
      { top: Number.NaN, right: 0, bottom: 0, left: 0 },
      { top: Number.POSITIVE_INFINITY, right: 0, bottom: 0, left: 0 },
      { top: -0.1, right: 0, bottom: 0, left: 0 },
      { top: 1, right: 0, bottom: 0, left: 0 },
      { top: 0, right: 0, bottom: 0, left: 1.5 },
      { top: 0, right: 0, bottom: 0 },
      // Ejes que no dejan nada visible (suma >= 1).
      { top: 0.6, right: 0, bottom: 0.4, left: 0 },
      { top: 0.5, right: 0, bottom: 0.5, left: 0 },
      { top: 0, right: 0.7, bottom: 0, left: 0.3 },
      { top: 0, right: 0.9, bottom: 0, left: 0.9 },
    ];
    for (const malo of malos) {
      expect('crop' in sanitizeImportedClipVisual({ crop: malo })).toBe(false);
    }
  });

  it('sanitizeImportedCrop valida los cuatro bordes y las sumas por eje', () => {
    expect(
      sanitizeImportedCrop({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 })
    ).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    expect(sanitizeImportedCrop({ top: 0, right: 0, bottom: 0, left: 0 })).toBeUndefined();
    expect(sanitizeImportedCrop({ top: 0.5, right: 0, bottom: 0.5, left: 0 })).toBeUndefined();
    expect(sanitizeImportedCrop({ top: 0, right: 0.5, bottom: 0, left: 0.5 })).toBeUndefined();
    expect(sanitizeImportedCrop(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 3. La importación conserva la transformación (línea + papelera)     */
/* ------------------------------------------------------------------ */

describe('sanitizeImportedProject · la importación conserva el encuadre', () => {
  it('rotación, volteos y recorte viajan con el clip', () => {
    const resultado = sanitizeImportedProject(
      {
        ...candidatoBase(),
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            mediaId: 'm1',
            name: 'Clip',
            type: 'video',
            start: 0,
            duration: 2,
            sourceStart: 0,
            sourceDuration: 2,
            volume: 1,
            opacity: 1,
            scale: 1,
            positionX: 0,
            positionY: 0,
            muted: false,
            rotation: 90,
            flipH: true,
            flipV: false,
            crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
          },
        ],
      } as never,
      { projectId: 'proj_x', fallbackName: 'X' }
    );
    const clip = resultado.project.clips.find((c) => c.id === 'c1');
    expect(clip?.rotation).toBe(90);
    expect(clip?.flipH).toBe(true);
    expect(clip?.flipV).toBe(false);
    expect(clip?.crop).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
  });

  it('lo inválido se sanea sin descartar el clip', () => {
    const resultado = sanitizeImportedProject(
      {
        ...candidatoBase(),
        clips: [
          {
            id: 'c1',
            trackId: 't1',
            mediaId: 'm1',
            name: 'Clip',
            type: 'video',
            start: 0,
            duration: 2,
            sourceStart: 0,
            sourceDuration: 2,
            volume: 1,
            opacity: 1,
            scale: 1,
            positionX: 0,
            positionY: 0,
            muted: false,
            rotation: 45,
            flipH: 'sí',
            crop: { top: 0.8, right: 0, bottom: 0.8, left: 0 },
          },
        ],
      } as never,
      { projectId: 'proj_x', fallbackName: 'X' }
    );
    const clip = resultado.project.clips.find((c) => c.id === 'c1');
    expect(clip).toBeDefined();
    expect(resultado.droppedClips).toBe(0);
    expect(clip?.rotation).toBe(0);
    expect('flipH' in (clip as object)).toBe(false);
    expect('crop' in (clip as object)).toBe(false);
  });

  it('la papelera conserva el encuadre con el mismo saneador', () => {
    const resultado = sanitizeImportedProject(
      {
        ...candidatoBase(),
        clips: [],
        mediaPool: [
          {
            id: 'm1',
            name: 'Medio',
            type: 'video',
            url: '',
            duration: 2,
            width: 640,
            height: 360,
            fps: 30,
            thumbnailUrl: '',
            size: 10,
            createdAt: 1,
          },
        ],
        trash: [
          {
            media: {
              id: 'm1',
              name: 'Medio',
              type: 'video',
              url: '',
              duration: 2,
              width: 640,
              height: 360,
              fps: 30,
              thumbnailUrl: '',
              size: 10,
              createdAt: 1,
            },
            clips: [
              {
                id: 'ct1',
                trackId: 't1',
                mediaId: 'm1',
                name: 'Clip papelera',
                type: 'video',
                start: 0,
                duration: 2,
                sourceStart: 0,
                sourceDuration: 2,
                volume: 1,
                opacity: 1,
                scale: 1,
                positionX: 0,
                positionY: 0,
                muted: false,
                rotation: 270,
                flipV: true,
                crop: { top: 0.2, right: 0.05, bottom: 0.1, left: 0.05 },
              },
            ],
            deletedAt: 2,
          },
        ],
      } as never,
      { projectId: 'proj_x', fallbackName: 'X' }
    );
    const papelera = resultado.project.trash?.[0]?.clips?.[0];
    expect(papelera?.rotation).toBe(270);
    expect(papelera?.flipV).toBe(true);
    expect(papelera?.crop).toEqual({ top: 0.2, right: 0.05, bottom: 0.1, left: 0.05 });
  });
});
