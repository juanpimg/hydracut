/**
 * Honestidad del resultado de exportación (worker W-40).
 *
 * En Firefox, `MediaRecorder` no puede grabar MP4: si el usuario pide MP4, el
 * respaldo produce un WebM. El modal anunciaba "Tu video MP4 ha sido
 * descargado" (el formato PEDIDO) cuando el fichero era un WebM (el formato
 * REAL del blob). Estos tests fallan sin el fix y pasan con él:
 * `buildExportResultMessage` deriva el formato del MIME real del blob (la
 * misma regla que `exportFileExtensionFor`) y avisa cuando no coincide con
 * lo pedido, siempre en español.
 */
import { describe, it, expect } from 'vitest';
import { buildExportResultMessage } from '../components/export/ExportModal';

describe('W-40 · buildExportResultMessage dice el formato real, no el pedido', () => {
  it('MP4 pedido + blob MP4 → mensaje MP4 sin aviso', () => {
    const result = buildExportResultMessage({
      requestedFormat: 'mp4',
      actualMime: 'video/mp4',
    });
    expect(result.isFormatMismatch).toBe(false);
    expect(result.message).toBe('Tu video MP4 ha sido descargado automáticamente.');
  });

  it('WebM pedido + blob WebM → mensaje WebM sin aviso', () => {
    const result = buildExportResultMessage({
      requestedFormat: 'webm',
      actualMime: 'video/webm;codecs=vp8,opus',
    });
    expect(result.isFormatMismatch).toBe(false);
    expect(result.message).toBe('Tu video WebM ha sido descargado automáticamente.');
  });

  it('MP4 pedido + blob WebM (caso Firefox con audio) → avisa y dice WebM', () => {
    const result = buildExportResultMessage({
      requestedFormat: 'mp4',
      actualMime: 'video/webm;codecs=vp8,opus',
    });
    expect(result.isFormatMismatch).toBe(true);
    // El formato real manda: dice WebM…
    expect(result.message).toMatch(/WebM/);
    // …y avisa de forma explícita de que se pidió MP4…
    expect(result.message).toMatch(/Has pedido MP4/);
    expect(result.message).toMatch(/no puede grabar MP4/);
    // …sin afirmar en ningún caso que el fichero sea MP4.
    expect(result.message).not.toMatch(/video MP4 ha sido descargado/);
  });

  it('WebM pedido + blob MP4 (inverso) → también es veraz', () => {
    const result = buildExportResultMessage({
      requestedFormat: 'webm',
      actualMime: 'video/mp4',
    });
    expect(result.isFormatMismatch).toBe(true);
    expect(result.message).toMatch(/Has pedido WebM/);
    expect(result.message).toMatch(/MP4/);
    expect(result.message).not.toMatch(/video WebM ha sido descargado/);
  });

  it('MIME vacío o desconocido → cae al formato pedido (sin mentir ni avisar)', () => {
    for (const requested of ['mp4', 'webm'] as const) {
      for (const actualMime of ['', 'application/octet-stream']) {
        const result = buildExportResultMessage({ requestedFormat: requested, actualMime });
        expect(result.isFormatMismatch).toBe(false);
        expect(result.message).toBe(
          requested === 'webm'
            ? 'Tu video WebM ha sido descargado automáticamente.'
            : 'Tu video MP4 ha sido descargado automáticamente.'
        );
      }
    }
  });

  it('el MIME con parámetros decide (mp4 antes que webm no confunde)', () => {
    expect(
      buildExportResultMessage({ requestedFormat: 'mp4', actualMime: 'video/mp4;codecs=avc1' })
        .isFormatMismatch
    ).toBe(false);
    expect(
      buildExportResultMessage({ requestedFormat: 'webm', actualMime: 'video/webm' })
        .isFormatMismatch
    ).toBe(false);
    expect(
      buildExportResultMessage({ requestedFormat: 'webm', actualMime: 'video/webm;codecs=vp9' })
        .message
    ).toBe('Tu video WebM ha sido descargado automáticamente.');
  });
});
