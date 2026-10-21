/**
 * Pulido UI (5 items): bienvenida de primer arranque, fundido con pista
 * bloqueada, etiqueta de exportar agnóstica, duplicar proyecto y tamaño
 * real del export.
 *
 * Cada suite falla sin su cambio (nuevo módulo, rama nueva en el Inspector,
 * etiquetas, testid o formateadores nuevos). Sin jsdom: la lógica pura se
 * prueba directamente y el cableado de los componentes se prueba sobre su
 * fuente (patrón ya usado en `clipboard-export-range.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  WELCOME_SEEN_KEY,
  hasSeenWelcome,
  markWelcomeSeen,
  resetWelcomeSeen,
  shouldShowWelcome,
  type FlagStorage,
} from '../core/utils/appFlags';
import { describeCrossfadeForClip } from '../core/utils/crossfade';
import {
  formatBytes,
  formatBitrate,
} from '../components/export/ExportModal';
import {
  createNewProject,
  saveProject,
  getProjectById,
  listProjects,
  duplicateProject,
} from '../core/storage/projectStorage';
import type { Clip, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks herméticos (mismo patrón que el resto de suites)               */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, unknown>();
  return {
    memory,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: unknown) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
  };
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => h.getSpy(key),
  set: (key: string, value: unknown) => h.setSpy(key, value),
  del: (key: string) => h.delSpy(key),
  keys: async () => Array.from(h.memory.keys()),
  clear: async () => {
    h.memory.clear();
  },
}));

vi.mock('../core/storage/opfsStorage', () => ({
  saveMediaToOPFS: async (mediaId: string, file: File) => `${mediaId}_${file.name}`,
  getMediaFromOPFS: async (_path: string): Promise<File | null> => null,
  deleteMediaFilesFromOPFS: async (_paths: string[]) => undefined,
  deleteMediaFromOPFS: async () => undefined,
  isOPFSSupported: async () => false,
}));

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/** Almacenamiento en memoria para la API testeable de `appFlags`. */
function memoryFlagStorage(initial?: Record<string, string>): FlagStorage & { size: number } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    get size() {
      return data.size;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1 — La bienvenida solo se muestra al visitante primerizo             */
/* ------------------------------------------------------------------ */

describe('1 · appFlags: bandera persistente de la bienvenida', () => {
  it('nadie la ha visto al principio; marcarla y resetearla funciona', () => {
    const storage = memoryFlagStorage();
    expect(hasSeenWelcome(storage)).toBe(false);
    expect(shouldShowWelcome(storage)).toBe(true);
    markWelcomeSeen(storage);
    expect(hasSeenWelcome(storage)).toBe(true);
    expect(shouldShowWelcome(storage)).toBe(false);
    resetWelcomeSeen(storage);
    expect(hasSeenWelcome(storage)).toBe(false);
  });

  it('la clave de la bandera es estable y no vacía', () => {
    expect(typeof WELCOME_SEEN_KEY).toBe('string');
    expect(WELCOME_SEEN_KEY.length).toBeGreaterThan(0);
  });

  it('sin almacenamiento disponible no lanza y muestra (valor seguro)', () => {
    expect(hasSeenWelcome(null)).toBe(false);
    expect(shouldShowWelcome(null)).toBe(true);
    expect(() => markWelcomeSeen(null)).not.toThrow();
    expect(() => resetWelcomeSeen(null)).not.toThrow();
  });

  it('un almacenamiento roto (modo privado) nunca rompe la app', () => {
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error('denegado');
      },
      setItem: () => {
        throw new Error('denegado');
      },
      removeItem: () => {
        throw new Error('denegado');
      },
    };
    expect(hasSeenWelcome(broken)).toBe(false);
    expect(shouldShowWelcome(broken)).toBe(true);
    expect(() => markWelcomeSeen(broken)).not.toThrow();
    expect(() => resetWelcomeSeen(broken)).not.toThrow();
  });
});

describe('1 · el store arranca según la bandera y la persiste al cerrar', () => {
  const KEY = WELCOME_SEEN_KEY;
  const previousLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;

  function installLocalStorage(initial?: Record<string, string>): FlagStorage {
    const storage = memoryFlagStorage(initial);
    (globalThis as unknown as { localStorage?: unknown }).localStorage = storage;
    return storage;
  }

  function restoreLocalStorage(): void {
    if (previousLocalStorage === undefined) {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as unknown as { localStorage?: unknown }).localStorage = previousLocalStorage;
    }
  }

  it('el estado inicial ya no es siempre `true`: respeta la bandera', async () => {
    // Visitante primerizo → se muestra.
    installLocalStorage();
    try {
      vi.resetModules();
      const fresh = await import('../store/useUIStore');
      expect(fresh.useUIStore.getState().isWelcomeOpen).toBe(true);
    } finally {
      restoreLocalStorage();
    }
    // Visitante que vuelve → entra directo al editor.
    installLocalStorage({ [KEY]: '1' });
    try {
      vi.resetModules();
      const returning = await import('../store/useUIStore');
      expect(returning.useUIStore.getState().isWelcomeOpen).toBe(false);
    } finally {
      restoreLocalStorage();
    }
  });

  it('cerrar la bienvenida persiste la bandera (no vuelve a salir al recargar)', async () => {
    const storage = installLocalStorage() as FlagStorage & { size: number };
    try {
      vi.resetModules();
      const { useUIStore } = await import('../store/useUIStore');
      expect(useUIStore.getState().isWelcomeOpen).toBe(true);
      useUIStore.getState().setWelcomeOpen(false);
      expect(useUIStore.getState().isWelcomeOpen).toBe(false);
      expect(storage.getItem(KEY)).toBe('1');
      // Y reabrirla a propósito (Guía de inicio) sigue funcionando.
      useUIStore.getState().setWelcomeOpen(true);
      expect(useUIStore.getState().isWelcomeOpen).toBe(true);
    } finally {
      restoreLocalStorage();
    }
  });

  it('el cableado existe en la fuente (store + modal + guía en ambos headers)', () => {
    const uiStore = sourceOf('../store/useUIStore.ts');
    expect(uiStore).toContain('hasSeenWelcome');
    expect(uiStore).toContain('markWelcomeSeen');
    expect(uiStore).not.toContain('isWelcomeOpen: true');

    const welcome = sourceOf('../components/modals/WelcomeModal.tsx');
    expect(welcome).toContain('markWelcomeSeen');

    for (const path of [
      '../components/layout/Header.tsx',
      '../components/mobile/MobileHeader.tsx',
    ]) {
      const header = sourceOf(path);
      expect(header).toContain('Guía de inicio');
      expect(header).toContain('setWelcomeOpen(true)');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2 — "Crear fundido" visible y deshabilitado con pista bloqueada      */
/* ------------------------------------------------------------------ */

function lockedTrackFixture(): { clips: Clip[]; tracks: Track[] } {
  const track: Track = {
    id: 'track_video_1',
    name: 'Video V1',
    type: 'video',
    isMuted: false,
    isLocked: true,
    isVisible: true,
  };
  const base = {
    trackId: track.id,
    mediaId: 'm1',
    type: 'video' as const,
    duration: 2,
    sourceStart: 0,
    sourceDuration: 5,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
  };
  const clips: Clip[] = [
    { ...base, id: 'clip_a', name: 'Clip A', start: 0 },
    { ...base, id: 'clip_b', name: 'Clip B', start: 2 },
  ];
  return { clips, tracks: [track] };
}

describe('2 · fundido de cruce con la pista bloqueada', () => {
  it('la lógica pura informa pista bloqueada con motivo en español', () => {
    const { clips, tracks } = lockedTrackFixture();
    const info = describeCrossfadeForClip(clips, tracks, 'clip_a', 30);
    expect(info.clipFound).toBe(true);
    expect(info.trackLocked).toBe(true);
    expect(info.canCreate).toBe(false);
    expect(info.createReason).not.toBeNull();
    expect(info.createReason ?? '').toMatch(/bloqueada/);
  });

  it('sin bloqueo el mismo par sí puede fundirse (el bloqueo es la causa)', () => {
    const { clips, tracks } = lockedTrackFixture();
    const unlocked = [{ ...tracks[0], isLocked: false }];
    const info = describeCrossfadeForClip(clips, unlocked, 'clip_a', 30);
    expect(info.trackLocked).toBe(false);
    expect(info.neighbour).not.toBeNull();
    expect(info.canCreate).toBe(true);
    expect(info.createReason).toBeNull();
  });

  it('el Inspector mantiene el botón visible y deshabilitado con el motivo', () => {
    const inspector = sourceOf('../components/inspector/ClipInspector.tsx');
    const lockedBranch = inspector.indexOf('crossfadeInfo.trackLocked');
    // Sin la rama, el botón desaparece y solo queda `crossfade-no-neighbour`.
    expect(lockedBranch).toBeGreaterThan(-1);
    const neighbourEnd = inspector.indexOf('crossfade-no-neighbour');
    expect(neighbourEnd).toBeGreaterThan(lockedBranch);
    const block = inspector.slice(lockedBranch, neighbourEnd);
    expect(block).toContain('crossfade-create');
    expect(block).toContain('disabled');
    expect(block).toContain('crossfade-disabled-reason');
    expect(block).toMatch(/bloqueada/);
  });
});

/* ------------------------------------------------------------------ */
/* 3 — Etiqueta de exportar agnóstica al formato                        */
/* ------------------------------------------------------------------ */

describe('3 · el header no promete solo MP4', () => {
  it('el header de escritorio muestra "Exportar vídeo" sin MP4 visible', () => {
    const header = sourceOf('../components/layout/Header.tsx');
    expect(header).not.toContain('>MP4<');
    expect(header).toContain('Exportar vídeo');
    // El nombre accesible nombra la acción (docs/copy.md U6).
    expect(header).toContain('aria-label="Exportar vídeo"');
  });

  it('el header móvil es agnóstico (ni visible ni accesible dice MP4)', () => {
    const mobile = sourceOf('../components/mobile/MobileHeader.tsx');
    expect(mobile).not.toContain('MP4');
    expect(mobile).toContain('Exportar');
  });
});

/* ------------------------------------------------------------------ */
/* 4 — Duplicar proyecto (misma media por referencia)                   */
/* ------------------------------------------------------------------ */

describe('4 · duplicar proyecto', () => {
  beforeEach(() => {
    h.memory.clear();
  });

  it('la galería ofrece "Duplicar" por proyecto y refresca al duplicar', () => {
    const modal = sourceOf('../components/modals/ProjectsModal.tsx');
    expect(modal).toContain('Duplicar proyecto');
    expect(modal).toContain('duplicateProject');
    expect(modal).toContain('project-duplicate-button-');
    // Tras duplicar, la galería se refresca.
    const dupCall = modal.indexOf('await duplicateProject(id)');
    expect(dupCall).toBeGreaterThan(-1);
    expect(modal.slice(dupCall, dupCall + 300)).toContain('refreshList');
  });

  it('el duplicado tiene id nuevo, nombre "(Copia)" y media INDEPENDIENTE (D02)', async () => {
    const original = await createNewProject('Viaje a Roma');
    original.clips.push({
      id: 'clip_orig_1',
      trackId: original.tracks[1].id,
      mediaId: 'media_roma',
      name: 'Toma Coliseo',
      type: 'video',
      start: 2,
      duration: 8,
      sourceStart: 0,
      sourceDuration: 8,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
      audioEffects: { pan: -0.5 },
    });
    original.mediaPool.push({
      id: 'media_roma',
      name: 'coliseo.mp4',
      type: 'video',
      url: 'blob:fake',
      duration: 8,
      width: 1920,
      height: 1080,
      fps: 30,
      thumbnailUrl: '',
      size: 1024,
      createdAt: Date.now(),
      opfsPath: 'media_roma_coliseo.mp4',
    });
    await saveProject(original);

    const duplicate = await duplicateProject(original.id);

    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.name).toBe('Viaje a Roma (Copia)');
    expect(duplicate.tracks.length).toBe(original.tracks.length);
    expect(duplicate.clips.length).toBe(1);
    expect(duplicate.clips[0].id).not.toBe('clip_orig_1');
    expect(duplicate.clips[0].audioEffects).toEqual({ pan: -0.5 });
    // D02: el clon es independiente del original: ids de media nuevos y bytes
    // propios (nunca la misma ruta OPFS: borrar el original corrompería al
    // clon). En este mock los bytes no se pueden leer, así que el clon queda
    // como ausente (honesto) en vez de apuntar al archivo del original.
    expect(duplicate.mediaPool.length).toBe(1);
    expect(duplicate.mediaPool[0].id).not.toBe('media_roma');
    expect(duplicate.mediaPool[0].opfsPath).not.toBe('media_roma_coliseo.mp4');
    expect(duplicate.clips[0].mediaId).toBe(duplicate.mediaPool[0].id);
    expect(duplicate.mediaPool[0].status).toBe('missing');

    // Aparece en la galería y se puede abrir.
    const gallery = await listProjects();
    expect(gallery.some((p) => p.id === duplicate.id)).toBe(true);
    const openable = await getProjectById(duplicate.id);
    expect(openable).not.toBeNull();
    expect(openable?.clips.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5 — Tamaño real y bitrate efectivo tras exportar                     */
/* ------------------------------------------------------------------ */

describe('5 · formateadores puros del resultado del export', () => {
  it('formatBytes usa coma decimal y las unidades correctas', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-40)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1,0 KB');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(1048576)).toBe('1,0 MB');
    expect(formatBytes(5_000_000)).toBe('4,8 MB');
  });

  it('formatBitrate calcula bytes × 8 / duración (del blob real)', () => {
    // 1000 bytes en 10 s → 800 bps.
    expect(formatBitrate(1000, 10)).toBe('800 bps');
    // 8000 bytes en 10 s → 6,4 kbps.
    expect(formatBitrate(8000, 10)).toBe('6,4 kbps');
    // 8 MB en 10 s → 6,40 Mbps.
    expect(formatBitrate(8_000_000, 10)).toBe('6,40 Mbps');
    // Casos inválidos: nunca un número absurdo.
    expect(formatBitrate(0, 10)).toBe('no disponible');
    expect(formatBitrate(1000, 0)).toBe('no disponible');
    expect(formatBitrate(Number.NaN, 10)).toBe('no disponible');
  });

  it('el modal muestra el tamaño real del blob y el bitrate efectivo', () => {
    const modal = sourceOf('../components/export/ExportModal.tsx');
    expect(modal).toContain('export-result-size');
    expect(modal).toContain('export-result-bitrate');
    expect(modal).toContain('Tamaño del archivo');
    expect(modal).toContain('Bitrate efectivo');
    // Viene del blob producido, no de una estimación del ajuste.
    expect(modal).toContain('bytes: blob.size');
    expect(modal).toContain('formatBytes(');
    expect(modal).toContain('formatBitrate(');
  });
});
/**
 * U7a · Pulido final F1–F5 + F7 (remate del rediseño U0–U6).
 *
 * Se añade a `ui-polish.test.ts` sin tocar las secciones anteriores: cada
 * test falla sin su cambio (primitiva sin `testid`, secciones desmontadas,
 * fila recortada con ellipsis, etiqueta flotante duplicada, rellenos de
 * acento sólidos o `setActiveTab` muerto). Sin jsdom: cableado sobre la
 * fuente, como el resto del fichero.
 */

describe('U7a · F1 — el Slider reenvía `testid` y el Inspector lo usa', () => {
  it('la primitiva acepta `testid`/`ariaLabel`/`title` y los reenvía al deslizador', () => {
    const slider = sourceOf('../components/ui/Slider.tsx');
    expect(slider).toContain('testid?: string');
    expect(slider).toContain('ariaLabel?: string');
    expect(slider).toContain('data-testid={testid}');
    expect(slider).toContain('aria-label={nombreAccesible}');
  });

  it('el campo numérico expone `${testid}-numero` (mismo valor, sin colisión)', () => {
    const slider = sourceOf('../components/ui/Slider.tsx');
    expect(slider).toContain('testid}-numero');
  });

  it('el Inspector usa la primitiva con los `data-testid` exactos de la suite', () => {
    const inspector = sourceOf('../components/inspector/ClipInspector.tsx');
    for (const id of [
      'testid="clip-volume"',
      'testid="clip-scale"',
      'testid="clip-opacity"',
      'testid="clip-audio-pan"',
      'testid={`clip-audio-eq-${slider.key}`}',
      'testid={`clip-color-${slider.key}`}',
    ]) {
      expect(inspector).toContain(id);
    }
    // Seis usos de <Slider cubren los 13 deslizadores (2 + 6 + 1 + 1 + 3).
    expect(inspector.match(/<Slider/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it('los nativos con `testid` escrito a mano desaparecen (diseño único)', () => {
    const inspector = sourceOf('../components/inspector/ClipInspector.tsx');
    expect(inspector).not.toContain('clip-color-${slider.key}-${clip.id}');
    expect(inspector).not.toContain('audio-pan-${clip.id}');
    expect(inspector).not.toContain('audio-eq-${slider.key}-${clip.id}');
  });

  it('las etiquetas que afirma la suite se conservan', () => {
    const inspector = sourceOf('../components/inspector/ClipInspector.tsx');
    // Literales con dos puntos (los que la suite lee por `closest('div')`).
    for (const etiqueta of [
      'Paneo:',
      'Volumen:',
      'Escala:',
      'Opacidad:',
      'Ducking: bajar cuando entra la voz',
      'Paneo estéreo del clip',
      'Brillo del clip',
      'Contraste del clip',
      'Saturación del clip',
      'Temperatura del clip',
      'Blanco y negro del clip',
      'Sepia del clip',
    ]) {
      expect(inspector).toContain(etiqueta);
    }
    // EQ y color componen «Etiqueta:» como `${slider.label}:`; la suite lee
    // «Graves:»/«Medios:»/«Agudos:» del DOM resultante.
    expect(inspector).toContain('label={`${slider.label}:`}');
    for (const banda of ["'Graves'", "'Medios'", "'Agudos'"]) {
      expect(inspector).toContain(banda);
    }
  });
});

describe('U7a · F2 — secciones montadas pero colapsadas (máx. 5 abiertas)', () => {
  it('Section monta el contenido colapsado con `hidden` (no lo desmonta)', () => {
    const section = sourceOf('../components/ui/Section.tsx');
    expect(section).toContain('hidden={!abierta}');
    expect(section).not.toContain('{abierta &&');
  });

  it('el Inspector arranca con 5 expandidas: Keyframes y Fundidos cerrados', () => {
    const inspector = sourceOf('../components/inspector/ClipInspector.tsx');
    const cerradas = Array.from(
      inspector.matchAll(/<Section titulo="([^"]+)" abiertaPorDefecto=\{false\}/g)
    ).map((m) => m[1]);
    // Exactamente las dos avanzadas/contextuales; el resto (incluidos
    // Audio y Fundido de cruce, cuyos avisos exige visibles la suite)
    // arranca abierto: 7 − 2 = 5 en un clip de vídeo.
    expect(cerradas.sort()).toEqual(['Fundidos', 'Keyframes de animación']);
    expect(inspector).not.toMatch(/<Section titulo="Audio" abiertaPorDefecto/);
    expect(inspector).not.toMatch(/<Section titulo="Fundido de cruce" abiertaPorDefecto/);
  });
});

describe('U7a · F3 — acciones del clip dentro del clip (28 px)', () => {
  it('la fila vive dentro (`inset-x-1`) y recorta lo que no quepa', () => {
    const clip = sourceOf('../components/timeline/ClipItem.tsx');
    expect(clip).toContain('inset-x-1 bottom-0.5');
    expect(clip).toContain('max-w-full');
    expect(clip).toContain('overflow-hidden');
    // La caja flotante centrada que se derramaba ya no existe.
    expect(clip).not.toContain('-translate-x-1/2');
  });

  it('botones de 28 px con etiquetas exactas y `aria-label`s', () => {
    const clip = sourceOf('../components/timeline/ClipItem.tsx');
    expect(clip).toContain('data-testid="clip-clipboard-actions"');
    expect(clip).toContain('data-testid="clip-copy-button"');
    expect(clip).toContain('data-testid="clip-paste-button"');
    expect(clip).toContain('data-testid="clip-duplicate-button"');
    for (const palabra of ['Copiar', 'Pegar', 'Duplicar']) {
      expect(clip).toMatch(new RegExp(`>\\s*${palabra}\\s*<`));
    }
    // Primitivas de 28 px (sm), no botones ad-hoc de 26 px.
    expect(clip).not.toContain('min-h-[26px]');
  });

  it('la fila se revela al seleccionar, al hover o por teclado', () => {
    const clip = sourceOf('../components/timeline/ClipItem.tsx');
    expect(clip).toContain('group-hover:flex');
    expect(clip).toContain('group-focus-within:flex');
  });
});

describe('U7a · F4 — la tarjeta no recorta la duración con ellipsis', () => {
  it('la duración vive en la miniatura (insignia) y el nombre usa 2 líneas', () => {
    const tarjeta = sourceOf('../components/media/MediaItemCard.tsx');
    expect(tarjeta).toContain('line-clamp-2');
    expect(tarjeta).toContain('absolute right-0.5 bottom-0.5');
    expect(tarjeta).toContain('formatDuration(item.duration)');
  });

  it('ninguna fila de metadatos usa `truncate`/ellipsis', () => {
    const tarjeta = sourceOf('../components/media/MediaItemCard.tsx');
    // El nombre usa clamp de 2 líneas (nunca recorte de 1 línea).
    expect(tarjeta).toContain('line-clamp-2');
    const iNombre = tarjeta.indexOf('line-clamp-2');
    expect(tarjeta.slice(tarjeta.lastIndexOf('<p', iNombre), iNombre)).not.toContain(
      'truncate'
    );
    // La única línea con `truncate` es la alerta compacta de rechazo (M8:
    // una línea + tooltip, con su testid y su role).
    expect(tarjeta.split('truncate').length - 1).toBe(1);
    expect(tarjeta).toContain('whitespace-nowrap');
    expect(tarjeta).toContain('media-size-');
  });

  it('los `aria-label` que lee la suite se conservan', () => {
    const tarjeta = sourceOf('../components/media/MediaItemCard.tsx');
    expect(tarjeta).toContain(': añadir a la línea de tiempo');
    expect(tarjeta).not.toContain('pulsa para añadir');
    expect(tarjeta).toContain('a la papelera');
  });
});

describe('U7a · F5 — diálogo de exportar sin duplicados ni acento sólido', () => {
  it('sin etiqueta flotante que duplique el preajuste activo', () => {
    const modal = sourceOf('../components/export/ExportModal.tsx');
    expect(modal).not.toContain('activePreset.label');
    expect(modal).not.toContain('Personalizado');
    // El estado activo sigue viviendo en el propio botón.
    expect(modal).toContain('export-preset-${preset.id}');
    expect(modal).toContain('aria-pressed={isActive}');
  });

  it('la espec del preajuste es legible (dos líneas, sin `truncate`)', () => {
    const modal = sourceOf('../components/export/ExportModal.tsx');
    const bloque = modal.slice(
      modal.indexOf('data-testid="export-presets"'),
      modal.indexOf('data-testid="export-presets"') + 2000
    );
    expect(bloque).toContain('{preset.hint}');
    expect(bloque).not.toContain('truncate');
  });

  it('los seleccionados usan `accent-soft`; el único sólido es Exportar', () => {
    const modal = sourceOf('../components/export/ExportModal.tsx');
    expect(modal).toContain('bg-accent-soft');
    expect(modal).not.toContain('bg-accent-fill');
    expect(modal).toContain('variant="primary"');
  });
});

describe('U7a · F7 — ClipItem sin `setActiveTab` muerto', () => {
  it('no queda ninguna llamada ni el import sin uso', () => {
    const clip = sourceOf('../components/timeline/ClipItem.tsx');
    expect(clip).not.toContain('setActiveTab');
    expect(clip).toContain('const { activeTool } = useUIStore();');
    // La selección sigue intacta.
    expect(clip).toContain('selectClip(clip.id');
  });
});
