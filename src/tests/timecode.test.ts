import { describe, it, expect } from 'vitest';
import {
  formatExportRange,
  formatExportTimecode,
} from '../components/export/ExportModal';
import { formatTimecode } from '../core/utils/time';

/**
 * Regression tests: the export range markers and the playhead used to be
 * formatted with `Math.floor(seconds)` (`HH:MM:SS`), so a 0,9 s → 1,1 s
 * range displayed «00:00:00 → 00:00:01 (0.2 s)»: times contradicting the
 * duration shown next to them. They must be frame-accurate (`HH:MM:SS:FF`),
 * in the same format the player controls already use.
 */
describe('timecode con precisión de fotograma (exportación)', () => {
  it('la fracción de segundo ya no se trunca: 0,9 s → 1,1 s muestra los cuadros', () => {
    // 0,9 s a 30 fps = cuadro 27; 1,1 s = cuadro 33.
    expect(formatExportTimecode(0.9)).toBe('00:00:00:27');
    expect(formatExportTimecode(1.1)).toBe('00:00:01:03');
  });

  it('la etiqueta del rango 0,9 s → 1,1 s es coherente con su duración (0,2 s)', () => {
    expect(formatExportRange({ start: 0.9, end: 1.1, duration: 0.2 })).toBe(
      'Exportando 00:00:00:27 → 00:00:01:03 (0.2 s)'
    );
  });

  it('el cabezal en 3,5 s muestra el cuadro (antes «00:00:03»)', () => {
    // 3,5 s a 30 fps = cuadro 15 del segundo 3.
    expect(formatExportTimecode(3.5)).toBe('00:00:03:15');
  });

  it('el límite del rango cae en el cuadro que le toca (0,933 s → cuadro 28 a 30 fps)', () => {
    expect(formatExportTimecode(0.933)).toBe('00:00:00:28');
  });

  it('respeta los fps del proyecto (60 fps)', () => {
    // 0,9 s a 60 fps = cuadro 54; el formato a 30 fps sería distinto.
    expect(formatExportTimecode(0.9, 60)).toBe('00:00:00:54');
    expect(formatExportTimecode(0.9, 60)).not.toBe(formatExportTimecode(0.9, 30));
    expect(formatExportRange({ start: 0.9, end: 1.1, duration: 0.2 }, 60)).toBe(
      'Exportando 00:00:00:54 → 00:00:01:06 (0.2 s)'
    );
  });

  it('usa el mismo formato que los controles del reproductor', () => {
    for (const t of [0, 0.9, 1.1, 3.5, 65.1, 3725]) {
      expect(formatExportTimecode(t, 30)).toBe(formatTimecode(t, 30));
    }
  });

  it('los valores inválidos siguen siendo 00:00:00:00', () => {
    expect(formatExportTimecode(NaN)).toBe('00:00:00:00');
    expect(formatExportTimecode(Infinity)).toBe('00:00:00:00');
    expect(formatExportTimecode(-5)).toBe('00:00:00:00');
  });
});
