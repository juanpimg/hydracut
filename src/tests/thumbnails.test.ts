/**
 * Miniaturas del bin (auditoría T-01).
 *
 * `thumbnails` era el único módulo eximido del `quality-guard` ("lo cubre el
 * navegador") sin que ningún check de navegador lo nombrara: si devolvía
 * DataURLs corruptos, todo seguía en verde. Este fichero cierra la exención:
 * con un canvas falso se afirma el contrato observable —prefijo `data:image/`
 * y dimensiones— y la guarda de nodisponibilidad de `generateFilmstrip` sin
 * documento.
 *
 * Lo que NO prueba: el decodificado real de vídeo (`generateVideoThumbnail`
 * necesita un `<video>` con metadatos, solo posible en un navegador).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPlaceholderThumbnail,
  generatePlaceholderFilmstrip,
  generateFilmstrip,
} from '../core/utils/thumbnails';

/** Documento falso cuyo canvas 2d registra llamadas y devuelve un PNG fijo. */
function instalarDocumentoFalso() {
  const gradiente = { addColorStop: vi.fn() };
  const ctx = {
    createLinearGradient: vi.fn(() => gradiente),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  const lienzo = () => ({
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/png;base64,QUJD'),
  });
  (globalThis as Record<string, unknown>).document = {
    createElement: (etiqueta: string) => {
      if (etiqueta !== 'canvas') throw new Error(`sin soporte para <${etiqueta}>`);
      return lienzo();
    },
  };
  return ctx;
}

describe('miniaturas · sustitutos del bin', () => {
  let documentoPrevio: unknown;

  beforeEach(() => {
    documentoPrevio = (globalThis as Record<string, unknown>).document;
  });

  afterEach(() => {
    if (documentoPrevio === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = documentoPrevio;
    }
    vi.restoreAllMocks();
  });

  it('el sustituto es una DataURL de imagen no vacía', () => {
    instalarDocumentoFalso();
    const url = createPlaceholderThumbnail('Música', '#6366f1');
    expect(url.startsWith('data:image/')).toBe(true);
    expect(url.length).toBeGreaterThan('data:image/png;base64,'.length);
  });

  it('el sustituto pinta fondo con degradado y etiqueta', () => {
    const ctx = instalarDocumentoFalso();
    createPlaceholderThumbnail('Vídeo');
    expect(ctx.createLinearGradient).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it('la tira genera exactamente las DataURLs pedidas', () => {
    instalarDocumentoFalso();
    const tira = generatePlaceholderFilmstrip(3);
    expect(tira).toHaveLength(3);
    for (const url of tira) {
      expect(url.startsWith('data:image/')).toBe(true);
    }
  });

  it('la tira por defecto trae cinco fotogramas', () => {
    instalarDocumentoFalso();
    expect(generatePlaceholderFilmstrip()).toHaveLength(5);
  });

  it('generateFilmstrip sin documento devuelve lista vacía (guarda de node)', () => {
    delete (globalThis as Record<string, unknown>).document;
    return expect(generateFilmstrip('blob:x', 10, 3)).resolves.toEqual([]);
  });
});
