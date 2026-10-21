/**
 * Ronda de audio: solo de pista (P0), medidor de nivel (P1) y exportar solo
 * el audio a WAV (P0).
 *
 * - El solo es una decisión de mezcla pura: una pista en solo silencia a las
 *   demás (no es lo mismo que silenciar: el silencio es por pista, el solo es
 *   monitorización y manda sobre las otras). La misma regla vale para el
 *   preview (`AudioEngine`) y para el export (WAV y vídeo).
 * - El medidor es un pico en tiempo real leído de un `AnalyserNode` del
 *   master, pintado de forma imperativa (sin `setState` por fotograma).
 * - El WAV se codifica del PCM ya mezclado por `renderOfflineAudio` (no se
 *   copia el render): 16 bits, RIFF válido, ritmo y canales reales.
 *
 * Los componentes no se montan aquí (no hay jsdom): el cableado se guarda con
 * aserciones de fuente, como hacen las suites de paridad móvil y volumen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hasSoloedTrack,
  isTrackSilencedBySolo,
  applySoloToTracks,
} from '../core/engine/AudioEngine';
import { medirNivel, picoADecibelios } from '../core/utils/levelMeter';
import { encodeWavData, buildWavFileName } from '../core/export/wavExporter';
import { useProjectStore } from '../store/useProjectStore';
import { sanitizeImportedProject } from '../core/storage/projectStorage';
import type { Track } from '../types/project';

const aqui = dirname(fileURLToPath(import.meta.url));
function fuente(relativa: string): string {
  return readFileSync(join(aqui, relativa), 'utf8');
}

/** Pista mínima para decidir el solo (datos, sin lógica). */
function pista(id: string, parche: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    type: 'audio',
    isMuted: false,
    isLocked: false,
    isVisible: true,
    ...parche,
  };
}

/* ------------------------------------------------------------------ */
/* Solo · regla de mezcla pura                                         */
/* ------------------------------------------------------------------ */

describe('solo · la regla de mezcla es pura (preview ≡ export)', () => {
  it('sin ninguna pista en solo nada queda silenciado', () => {
    const pistas = [pista('a'), pista('b')];
    expect(hasSoloedTrack(pistas)).toBe(false);
    expect(isTrackSilencedBySolo(pista('a'), false)).toBe(false);
    expect(isTrackSilencedBySolo(pista('b'), false)).toBe(false);
    expect(isTrackSilencedBySolo(undefined, false)).toBe(false);
  });

  it('una pista en solo silencia a las demás, no a sí misma', () => {
    const pistas = [pista('a', { solo: true }), pista('b')];
    expect(hasSoloedTrack(pistas)).toBe(true);
    expect(isTrackSilencedBySolo(pista('a', { solo: true }), true)).toBe(false);
    expect(isTrackSilencedBySolo(pista('b'), true)).toBe(true);
    // Un clip sin pista (pista borrada) no puede estar en solo: calla.
    expect(isTrackSilencedBySolo(undefined, true)).toBe(true);
  });

  it('varias pistas en solo suenan a la vez', () => {
    const pistas = [pista('a', { solo: true }), pista('b', { solo: true }), pista('c')];
    expect(hasSoloedTrack(pistas)).toBe(true);
    expect(isTrackSilencedBySolo(pista('a', { solo: true }), true)).toBe(false);
    expect(isTrackSilencedBySolo(pista('b', { solo: true }), true)).toBe(false);
    expect(isTrackSilencedBySolo(pista('c'), true)).toBe(true);
  });

  it('applySoloToTracks no toca nada (ni asigna) cuando no hay solo', () => {
    const pistas = [pista('a'), pista('b', { isMuted: true })];
    expect(applySoloToTracks(pistas)).toBe(pistas);
  });

  it('applySoloToTracks enmudece a las no solo y respeta a las solo', () => {
    const sola = pista('a', { solo: true });
    const otra = pista('b');
    const muda = pista('c', { isMuted: true });
    const salida = applySoloToTracks([sola, otra, muda]);
    expect(salida[0]).toBe(sola);
    expect(salida[1]).toEqual(pista('b', { isMuted: true }));
    expect(salida[2]).toEqual(pista('c', { isMuted: true }));
  });
});

/* ------------------------------------------------------------------ */
/* Solo · store (historial) e importación                              */
/* ------------------------------------------------------------------ */

describe('solo · el store lo deshace y la importación lo sanea', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('toggleTrackSolo aísla la pista y se deshace con un Ctrl+Z', () => {
    const tienda = useProjectStore.getState();
    expect(tienda.project.tracks.find((t) => t.id === 'track_audio_1')?.solo).not.toBe(true);
    tienda.toggleTrackSolo('track_audio_1');
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === 'track_audio_1')?.solo
    ).toBe(true);
    useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === 'track_audio_1')?.solo
    ).not.toBe(true);
  });

  it('toggleTrackSolo conmuta (segunda llamada lo quita)', () => {
    const tienda = useProjectStore.getState();
    tienda.toggleTrackSolo('track_audio_1');
    useProjectStore.getState().toggleTrackSolo('track_audio_1');
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === 'track_audio_1')?.solo
    ).not.toBe(true);
  });

  it('una pista inexistente no empuja historial fantasma', () => {
    const antes = useProjectStore.getState().past.length;
    useProjectStore.getState().toggleTrackSolo('pista_que_no_existe');
    expect(useProjectStore.getState().past.length).toBe(antes);
  });

  it('la importación conserva el solo y sanea lo inválido', () => {
    const base = {
      id: 'proj_x',
      name: 'X',
      aspectRatio: '16:9',
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      clips: [],
      mediaPool: [],
      duration: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    const saneado = sanitizeImportedProject(
      {
        ...base,
        tracks: [
          { id: 't1', name: 'A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true, solo: true },
          { id: 't2', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true, solo: 'sí' },
          { id: 't3', name: 'T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
        ],
      } as never,
      { projectId: 'proj_x', fallbackName: 'X' }
    );
    expect(saneado.project.tracks.find((t) => t.id === 't1')?.solo).toBe(true);
    expect(saneado.project.tracks.find((t) => t.id === 't2')?.solo).not.toBe(true);
    expect('solo' in (saneado.project.tracks.find((t) => t.id === 't3') as object)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Solo · cableado (motor, cabecera, export)                           */
/* ------------------------------------------------------------------ */

describe('solo · el cableado existe (motor, cabecera, export)', () => {
  it('el modelo declara Track.solo opcional', () => {
    expect(fuente('../types/project.ts')).toContain('solo?: boolean');
  });

  it('el motor honra el solo en la mezcla del preview', () => {
    const motor = fuente('../core/engine/AudioEngine.ts');
    expect(motor).toContain('hasSoloedTrack');
    expect(motor).toContain('isTrackSilencedBySolo');
    expect(motor).toContain('setMeterEnabled');
  });

  it('la cabecera de pista ofrece el solo con aria-pressed', () => {
    const cabecera = fuente('../components/timeline/TrackHeader.tsx');
    expect(cabecera).toContain('toggleTrackSolo');
    expect(cabecera).toContain('aria-pressed');
    expect(cabecera).toContain('>S<');
    expect(cabecera).toContain('Solo');
  });

  it('el export de audio aplica la misma regla (sin tocar el de vídeo)', () => {
    const wav = fuente('../core/export/wavExporter.ts');
    expect(wav).toContain('applySoloToTracks');
    expect(wav).toContain('renderOfflineAudio');
    expect(wav).not.toContain('OfflineAudioContext');
    const modal = fuente('../components/export/ExportModal.tsx');
    expect(modal).toContain('Audio (WAV)');
    // El nombre (`…_audio.wav`) lo pone `buildWavFileName`, probada aparte.
    expect(modal).toContain('buildWavFileName');
  });
});

/* ------------------------------------------------------------------ */
/* Medidor · pico y recorte puros                                      */
/* ------------------------------------------------------------------ */

describe('medidor · el pico y el recorte se calculan sin React', () => {
  it('el silencio da pico 0 sin recorte', () => {
    const medido = medirNivel(new Float32Array([0, 0, 0, 0]));
    expect(medido.pico).toBe(0);
    expect(medido.recorta).toBe(false);
  });

  it('el pico es el máximo absoluto (positivo o negativo)', () => {
    expect(medirNivel(new Float32Array([0.5, -0.25, 0.1])).pico).toBeCloseTo(0.5, 6);
    expect(medirNivel(new Float32Array([0.2, -0.8, 0.1])).pico).toBeCloseTo(0.8, 6);
  });

  it('una muestra a fondo de escala marca recorte', () => {
    expect(medirNivel(new Float32Array([0.1, 0.5])).recorta).toBe(false);
    expect(medirNivel(new Float32Array([0.1, 0.99])).recorta).toBe(true);
    expect(medirNivel(new Float32Array([0.1, -1])).recorta).toBe(true);
  });

  it('el pico se expresa en dB (1 = 0 dB, 0.5 ≈ −6 dB)', () => {
    expect(picoADecibelios(1)).toBeCloseTo(0, 6);
    expect(picoADecibelios(0.5)).toBeCloseTo(-6.0206, 3);
    expect(picoADecibelios(0)).toBe(-Infinity);
  });

  it('el bucle va por rAF y escribe el DOM, sin estado por fotograma', () => {
    const nivel = fuente('../core/utils/levelMeter.ts');
    expect(nivel).toContain('requestAnimationFrame');
    expect(nivel).toContain('cancelAnimationFrame');
    expect(nivel).toContain('getFloatTimeDomainData');
    expect(nivel).toContain('.transform');
    // El nivel nunca vive en estado React (sería un render por fotograma).
    expect(nivel).not.toContain('useState');
  });

  it('el transporte (escritorio y móvil) trae el medidor con interruptor', () => {
    for (const ruta of [
      '../components/player/PlayerControls.tsx',
      '../components/mobile/MobilePreviewPlayer.tsx',
    ]) {
      const vista = fuente(ruta);
      expect(vista).toContain('medidor-nivel');
      expect(vista).toContain('aria-pressed');
      expect(vista).toContain('Medidor');
      expect(vista).toContain('setMeterEnabled');
    }
  });
});

/* ------------------------------------------------------------------ */
/* WAV · codificador byte a byte                                       */
/* ------------------------------------------------------------------ */

describe('wav · la cabecera y el PCM son válidos', () => {
  it('la cabecera RIFF/WAVE declara ritmo, canales y 16 bits', () => {
    const canales = [new Float32Array([0, 0])];
    const wav = encodeWavData(canales, 8000);
    const vista = new DataView(wav);
    const texto = (inicio: number, fin: number): string => {
      let fuera = '';
      for (let i = inicio; i < fin; i++) fuera += String.fromCharCode(vista.getUint8(i));
      return fuera;
    };
    expect(texto(0, 4)).toBe('RIFF');
    expect(vista.getUint32(4, true)).toBe(36 + 4);
    expect(texto(8, 12)).toBe('WAVE');
    expect(texto(12, 16)).toBe('fmt ');
    expect(vista.getUint32(16, true)).toBe(16);
    expect(vista.getUint16(20, true)).toBe(1);
    expect(vista.getUint16(22, true)).toBe(1);
    expect(vista.getUint32(24, true)).toBe(8000);
    expect(vista.getUint32(28, true)).toBe(16000);
    expect(vista.getUint16(32, true)).toBe(2);
    expect(vista.getUint16(34, true)).toBe(16);
    expect(texto(36, 40)).toBe('data');
    expect(vista.getUint32(40, true)).toBe(4);
    expect(wav.byteLength).toBe(44 + 4);
  });

  it('el PCM codifica un payload conocido en 16 bits', () => {
    const canales = [new Float32Array([0, 0.5, -0.5, 1, -1])];
    const wav = encodeWavData(canales, 44100);
    const vista = new DataView(wav);
    expect(vista.getInt16(44, true)).toBe(0);
    expect(vista.getInt16(46, true)).toBe(16384);
    expect(vista.getInt16(48, true)).toBe(-16384);
    expect(vista.getInt16(50, true)).toBe(32767);
    expect(vista.getInt16(52, true)).toBe(-32768);
  });

  it('el estéreo se intercala izquierda/derecha', () => {
    const canales = [new Float32Array([1, 1]), new Float32Array([-1, -1])];
    const wav = encodeWavData(canales, 48000);
    const vista = new DataView(wav);
    expect(vista.getUint16(22, true)).toBe(2);
    expect(vista.getUint32(28, true)).toBe(48000 * 2 * 2);
    expect(vista.getInt16(44, true)).toBe(32767);
    expect(vista.getInt16(46, true)).toBe(-32768);
    expect(vista.getInt16(48, true)).toBe(32767);
    expect(vista.getInt16(50, true)).toBe(-32768);
    expect(wav.byteLength).toBe(44 + 8);
  });

  it('las muestras fuera de rango se recortan antes de codificar', () => {
    const canales = [new Float32Array([2, -2])];
    const wav = encodeWavData(canales, 48000);
    const vista = new DataView(wav);
    expect(vista.getInt16(44, true)).toBe(32767);
    expect(vista.getInt16(46, true)).toBe(-32768);
  });

  it('el archivo se nombra «…_audio.wav»', () => {
    expect(buildWavFileName('Mi proyecto de vídeo')).toBe('mi_proyecto_de_vídeo_audio.wav');
    expect(buildWavFileName('')).toBe('proyecto_audio.wav');
  });
});
