/**
 * Voz en off local (P0 del audit2): narrar el montaje sin salir de la app.
 *
 * La parte probada sin micrófono es la PURA:
 * - la máquina de estados (`inactiva → pidiendo → grabando → procesando →
 *   lista / denegada / error / cancelada`),
 * - la clasificación del error de permiso (concedido / denegado / no
 *   disponible) y sus mensajes en español (siempre con la salida de importar
 *   un archivo),
 * - el PCM capturado (unión de trozos, duración exacta al ritmo del
 *   dispositivo, mono/estéreo) y su envoltura a WAV REUTILIZANDO
 *   `encodeWavData` (sin un segundo codificador),
 * - el nombre de la toma (`Locución N`), el contrato de limpieza (el
 *   micrófono se suelta en TODOS los caminos) y la construcción del
 *   `MediaItem` (un audio normal: deshacible, persistido y saneado como
 *   cualquier otro).
 *
 * Lo que necesita un micrófono de verdad (pedir el permiso, el nivel en
 * vivo) se cubre en la suite de navegador; aquí el cableado se guarda con
 * aserciones de fuente, como hacen las suites de paridad móvil y volumen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  transicionGrabacion,
  clasificarErrorMicrofono,
  mensajeErrorMicrofono,
  hayMicrofono,
  pedirMicrofono,
  liberarMicrofono,
  unirPcm,
  calcularDuracionVoz,
  normalizarCanalesVoz,
  codificarWavVoz,
  calcularPicosVoz,
  siguienteNombreVoz,
  construirNombreArchivoVoz,
  crearIdVoz,
  formatearTiempoVoz,
  construirMediaItemVoz,
  iniciarCapturaVoz,
  VOZ_MENSAJE_DENEGADA,
  VOZ_MENSAJE_NO_DISPONIBLE,
  VOZ_AVISO_MONITOR,
  VOZ_BASE_NOMBRE,
  VOZ_PICOS_CELDAS,
  type EstadoGrabacion,
  type EventoGrabacion,
} from '../core/utils/recording';
import { useProjectStore } from '../store/useProjectStore';
import { sanitizeImportedProject } from '../core/storage/projectStorage';

const aqui = dirname(fileURLToPath(import.meta.url));
function fuente(relativa: string): string {
  return readFileSync(join(aqui, relativa), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Máquina de estados                                                  */
/* ------------------------------------------------------------------ */

describe('voz en off · la máquina de estados es total y cerrada', () => {
  const estados: EstadoGrabacion[] = [
    'inactiva',
    'pidiendo',
    'grabando',
    'procesando',
    'lista',
    'denegada',
    'error',
    'cancelada',
  ];
  const eventos: EventoGrabacion[] = [
    'pedir',
    'permitida',
    'denegada',
    'no-disponible',
    'fallo',
    'detener',
    'cancelar',
    'guardada',
    'descartar',
    'reintentar',
  ];

  /** Tabla completa del contrato (estado × evento → siguiente o `null`). */
  const tabla: Record<EstadoGrabacion, Record<EventoGrabacion, EstadoGrabacion | null>> = {
    inactiva: {
      pedir: 'pidiendo',
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: null,
      detener: null,
      cancelar: null,
      guardada: null,
      descartar: null,
      reintentar: null,
    },
    pidiendo: {
      pedir: null,
      permitida: 'grabando',
      denegada: 'denegada',
      'no-disponible': 'error',
      fallo: 'error',
      detener: null,
      cancelar: 'cancelada',
      guardada: null,
      descartar: null,
      reintentar: null,
    },
    grabando: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: 'error',
      detener: 'procesando',
      cancelar: 'cancelada',
      guardada: null,
      descartar: null,
      reintentar: null,
    },
    procesando: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: 'error',
      detener: null,
      cancelar: 'cancelada',
      guardada: 'lista',
      descartar: null,
      reintentar: null,
    },
    lista: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: null,
      detener: null,
      cancelar: null,
      guardada: null,
      descartar: 'inactiva',
      reintentar: null,
    },
    denegada: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: null,
      detener: null,
      cancelar: null,
      guardada: null,
      descartar: 'inactiva',
      reintentar: 'pidiendo',
    },
    error: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: null,
      detener: null,
      cancelar: null,
      guardada: null,
      descartar: 'inactiva',
      reintentar: 'pidiendo',
    },
    cancelada: {
      pedir: null,
      permitida: null,
      denegada: null,
      'no-disponible': null,
      fallo: null,
      detener: null,
      cancelar: null,
      guardada: null,
      descartar: 'inactiva',
      reintentar: 'pidiendo',
    },
  };

  it('cada celda de la tabla da el estado pactado (80 celdas)', () => {
    for (const estado of estados) {
      for (const evento of eventos) {
        expect(
          transicionGrabacion(estado, evento),
          `${estado} + ${evento}`
        ).toBe(tabla[estado][evento]);
      }
    }
  });

  it('el camino feliz llega a lista y se descarta a inactiva', () => {
    let estado: EstadoGrabacion | null = 'inactiva';
    for (const evento of ['pedir', 'permitida', 'detener', 'guardada'] as const) {
      estado = transicionGrabacion(estado as EstadoGrabacion, evento);
    }
    expect(estado).toBe('lista');
    expect(transicionGrabacion('lista', 'descartar')).toBe('inactiva');
  });

  it('denegar el permiso lleva a denegada y reintentar vuelve a pedir', () => {
    expect(transicionGrabacion('pidiendo', 'denegada')).toBe('denegada');
    expect(transicionGrabacion('denegada', 'reintentar')).toBe('pidiendo');
  });

  it('cancelar descarta la toma sin guardarla', () => {
    expect(transicionGrabacion('grabando', 'cancelar')).toBe('cancelada');
    // Cancelada nunca guarda: no hay transición a procesando ni a lista.
    expect(transicionGrabacion('cancelada', 'guardada')).toBe(null);
    expect(transicionGrabacion('cancelada', 'detener')).toBe(null);
  });

  it('un fallo en procesando lleva a error (la toma no queda a medias)', () => {
    expect(transicionGrabacion('procesando', 'fallo')).toBe('error');
    expect(transicionGrabacion('error', 'guardada')).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* Permiso: clasificación y mensajes                                   */
/* ------------------------------------------------------------------ */

describe('voz en off · el permiso distingue sus tres salidas reales', () => {
  it('NotAllowedError y SecurityError son denegación', () => {
    expect(clasificarErrorMicrofono({ name: 'NotAllowedError' })).toBe('denegada');
    expect(clasificarErrorMicrofono({ name: 'SecurityError' })).toBe('denegada');
  });

  it('NotFoundError y OverconstrainedError son indisponibilidad', () => {
    expect(clasificarErrorMicrofono({ name: 'NotFoundError' })).toBe('no-disponible');
    expect(clasificarErrorMicrofono({ name: 'OverconstrainedError' })).toBe('no-disponible');
  });

  it('lo demás (AbortError, TypeError, null, texto) es error genérico', () => {
    expect(clasificarErrorMicrofono({ name: 'AbortError' })).toBe('error');
    expect(clasificarErrorMicrofono(new TypeError('x'))).toBe('error');
    expect(clasificarErrorMicrofono(null)).toBe('error');
    expect(clasificarErrorMicrofono('roto')).toBe('error');
  });

  it('la denegación dice que se puede importar un archivo en vez de grabar', () => {
    expect(VOZ_MENSAJE_DENEGADA).toContain('bloqueado');
    expect(VOZ_MENSAJE_DENEGADA).toContain('importa un archivo');
    expect(mensajeErrorMicrofono('denegada')).toBe(VOZ_MENSAJE_DENEGADA);
  });

  it('la indisponibilidad ofrece importar y no culpa al usuario', () => {
    expect(VOZ_MENSAJE_NO_DISPONIBLE).toMatch(/importa un archivo/i);
    expect(VOZ_MENSAJE_NO_DISPONIBLE).not.toMatch(/bloqueado|permiso denegado/i);
    expect(mensajeErrorMicrofono('no-disponible')).toBe(VOZ_MENSAJE_NO_DISPONIBLE);
  });

  it('el error genérico da el detalle y la salida de importar', () => {
    const mensaje = mensajeErrorMicrofono('error', 'fallo del dispositivo');
    expect(mensaje).toContain('fallo del dispositivo');
    expect(mensaje).toContain('importa un archivo');
  });
});

/* ------------------------------------------------------------------ */
/* Disponibilidad y petición                                           */
/* ------------------------------------------------------------------ */

describe('voz en off · pedir el micrófono con constraints honestos', () => {
  const descriptorPrevio = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => {
    if (descriptorPrevio) Object.defineProperty(globalThis, 'navigator', descriptorPrevio);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('sin navigator no hay micrófono (nodo, SSR)', () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(hayMicrofono()).toBe(false);
  });

  it('sin getUserMedia no hay micrófono', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: {} },
      configurable: true,
      writable: true,
    });
    expect(hayMicrofono()).toBe(false);
  });

  it('pedir sin getUserMedia lanza la indisponibilidad (no rompe)', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
    await expect(pedirMicrofono()).rejects.toThrow(VOZ_MENSAJE_NO_DISPONIBLE);
  });

  it('la petición pide solo audio con cancelación de eco (mejor esfuerzo)', async () => {
    const falsoStream = { id: 'falso' };
    let restricciones: unknown = null;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: (r: unknown) => {
            restricciones = r;
            return Promise.resolve(falsoStream);
          },
        },
      },
      configurable: true,
      writable: true,
    });
    await expect(pedirMicrofono()).resolves.toBe(falsoStream);
    expect(restricciones).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  });

  it('denegar traduce el NotAllowedError al mensaje de denegación', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: () => Promise.reject({ name: 'NotAllowedError' }),
        },
      },
      configurable: true,
      writable: true,
    });
    await expect(pedirMicrofono()).rejects.toThrow(VOZ_MENSAJE_DENEGADA);
  });
});

/* ------------------------------------------------------------------ */
/* Limpieza: el micrófono se suelta en todos los caminos               */
/* ------------------------------------------------------------------ */

describe('voz en off · liberar el micrófono nunca deja la pista abierta', () => {
  function pistaFalsa(): { detenida: boolean; stop: () => void } {
    const pista = {
      detenida: false,
      stop: () => {
        pista.detenida = true;
      },
    };
    return pista;
  }

  it('detiene TODAS las pistas del stream', () => {
    const a = pistaFalsa();
    const b = pistaFalsa();
    liberarMicrofono({ getTracks: () => [a, b] } as unknown as MediaStream);
    expect(a.detenida).toBe(true);
    expect(b.detenida).toBe(true);
  });

  it('null, undefined y streams sin pistas no lanzan', () => {
    expect(() => liberarMicrofono(null)).not.toThrow();
    expect(() => liberarMicrofono(undefined)).not.toThrow();
    expect(() => liberarMicrofono({} as MediaStream)).not.toThrow();
    expect(() =>
      liberarMicrofono({ getTracks: () => [] } as unknown as MediaStream)
    ).not.toThrow();
  });

  it('una pista que lanza al detenerse no impide soltar las demás', () => {
    const mala = { stop: () => { throw new Error('pista rota'); } };
    const buena = pistaFalsa();
    expect(() =>
      liberarMicrofono({ getTracks: () => [mala, buena] } as unknown as MediaStream)
    ).not.toThrow();
    expect(buena.detenida).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* PCM: unión, duración exacta y canales                               */
/* ------------------------------------------------------------------ */

describe('voz en off · el PCM queda intacto y la duración es exacta', () => {
  it('unirPcm concatena los trozos en orden sin tocar las muestras', () => {
    const unido = unirPcm([
      new Float32Array([0.1, 0.2]),
      new Float32Array([]),
      new Float32Array([-0.5]),
    ]);
    // Float32: la comparación es con tolerancia (0.1 no es exacto en 32 bits).
    expect(unido.length).toBe(3);
    for (const [i, esperado] of [0.1, 0.2, -0.5].entries()) {
      expect(unido[i]).toBeCloseTo(esperado, 6);
    }
  });

  it('unirPcm sin trozos da silencio vacío (no null)', () => {
    expect(unirPcm([]).length).toBe(0);
  });

  it('la duración es muestras / ritmo (el ritmo del dispositivo)', () => {
    expect(calcularDuracionVoz(48000, 48000)).toBe(1);
    expect(calcularDuracionVoz(22050, 44100)).toBeCloseTo(0.5, 10);
    expect(calcularDuracionVoz(1000, 16000)).toBeCloseTo(0.0625, 10);
  });

  it('la duración sanea lo imposible (ritmo o muestras inválidos → 0)', () => {
    expect(calcularDuracionVoz(100, 0)).toBe(0);
    expect(calcularDuracionVoz(-5, 48000)).toBe(0);
    expect(calcularDuracionVoz(100, NaN)).toBe(0);
    expect(calcularDuracionVoz(NaN, 48000)).toBe(0);
  });

  it('el mono se conserva y el estéreo se conserva (PCM mono/estéreo)', () => {
    const mono = [new Float32Array([0.1, 0.2])];
    expect(normalizarCanalesVoz(mono).length).toBe(1);
    const estereo = [new Float32Array([0.1]), new Float32Array([0.2])];
    const normalizado = normalizarCanalesVoz(estereo);
    expect(normalizado.length).toBe(2);
    expect(normalizado[1][0]).toBeCloseTo(0.2, 6);
  });

  it('más de dos canales se recortan a estéreo (la toma es voz, no 5.1)', () => {
    const tres = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])];
    expect(normalizarCanalesVoz(tres).length).toBe(2);
  });

  it('sin canales hay un mono vacío (el WAV no se rompe)', () => {
    const normalizado = normalizarCanalesVoz([]);
    expect(normalizado.length).toBe(1);
    expect(normalizado[0].length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* WAV: reutiliza encodeWavData, sin un segundo codificador            */
/* ------------------------------------------------------------------ */

describe('voz en off · el WAV reutiliza el codificador del export', () => {
  it('no hay un segundo codificador RIFF en el módulo de grabación', () => {
    const grabacion = fuente('../core/utils/recording.ts');
    expect(grabacion).toContain('encodeWavData');
    expect(grabacion).not.toContain('RIFF');
    expect(grabacion).not.toContain('WAVE');
    expect(grabacion).not.toContain('setInt16');
  });

  it('codifica un WAV mono a 16 bits con el ritmo dado', async () => {
    const blob = codificarWavVoz([new Float32Array([0, 0.5, -0.5, 1, -1])], 44100);
    expect(blob.type).toBe('audio/wav');
    const vista = new DataView(await blob.arrayBuffer());
    const texto = (a: number, b: number): string => {
      let fuera = '';
      for (let i = a; i < b; i++) fuera += String.fromCharCode(vista.getUint8(i));
      return fuera;
    };
    expect(texto(0, 4)).toBe('RIFF');
    expect(vista.getUint16(22, true)).toBe(1);
    expect(vista.getUint32(24, true)).toBe(44100);
    // 5 muestras × 1 canal × 2 B + 44 de cabecera.
    expect(blob.size).toBe(44 + 10);
    expect(vista.getInt16(50, true)).toBe(32767);
  });

  it('una toma vacía no produce un WAV mudo: lanza en español', () => {
    expect(() => codificarWavVoz([new Float32Array([])], 48000)).toThrow(
      /no capturó ningún sonido/
    );
  });

  it('un ritmo imposible cae al ritmo del export (no a un WAV corrupto)', async () => {
    const blob = codificarWavVoz([new Float32Array([0.25])], NaN);
    const vista = new DataView(await blob.arrayBuffer());
    expect(vista.getUint32(24, true)).toBe(48000);
  });
});

/* ------------------------------------------------------------------ */
/* Picos, nombre, id y temporizador                                    */
/* ------------------------------------------------------------------ */

describe('voz en off · picos, nombre y temporizador', () => {
  it('el silencio da picos a cero', () => {
    expect(calcularPicosVoz(new Float32Array(1000), 8)).toEqual(new Array(8).fill(0));
  });

  it('los picos se normalizan a [0, 1] por celdas', () => {
    const mitad = new Float32Array(100).fill(0.5);
    const picos = calcularPicosVoz(mitad, 4);
    expect(picos.length).toBe(4);
    for (const pico of picos) {
      expect(pico).toBeGreaterThan(0);
      expect(pico).toBeLessThanOrEqual(1);
    }
  });

  it('una ráfaga en una celda no mancha las vecinas', () => {
    const muestras = new Float32Array(100);
    muestras[5] = 0.9;
    const picos = calcularPicosVoz(muestras, 4);
    expect(picos[0]).toBeCloseTo(1, 2);
    expect(picos[1]).toBe(0);
    expect(picos[2]).toBe(0);
    expect(picos[3]).toBe(0);
  });

  it('las celdas imposibles se sanean a una', () => {
    expect(calcularPicosVoz(new Float32Array([0.5]), 0).length).toBe(1);
    expect(calcularPicosVoz(new Float32Array([]), 80).length).toBe(80);
  });

  it('el nombre es «Locución N» con el primer hueco libre', () => {
    expect(VOZ_BASE_NOMBRE).toBe('Locución');
    expect(siguienteNombreVoz([])).toBe('Locución 1');
    expect(siguienteNombreVoz(['Locución 1'])).toBe('Locución 2');
    expect(siguienteNombreVoz(['Locución 1', 'Locución 2', 'Clip 1'])).toBe('Locución 3');
    // Ignora mayúsculas, espacios y la extensión del archivo.
    expect(siguienteNombreVoz(['locución 1.wav', '  Locución 2  '])).toBe('Locución 3');
  });

  it('el archivo de la toma es un .wav con el nombre de la toma', () => {
    expect(construirNombreArchivoVoz('Locución 1')).toBe('Locución 1.wav');
  });

  it('el id es único y con prefijo de voz', () => {
    const a = crearIdVoz();
    const b = crearIdVoz();
    expect(a).toMatch(/^voz_/);
    expect(a).not.toBe(b);
  });

  it('el temporizador es m:ss (0:00, 0:07, 1:05)', () => {
    expect(formatearTiempoVoz(0)).toBe('0:00');
    expect(formatearTiempoVoz(7.4)).toBe('0:07');
    expect(formatearTiempoVoz(65)).toBe('1:05');
    expect(formatearTiempoVoz(NaN)).toBe('0:00');
    expect(formatearTiempoVoz(-3)).toBe('0:00');
  });

  it('hay 80 celdas de pico (paridad con el audio importado)', () => {
    expect(VOZ_PICOS_CELDAS).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* Captura: grafo silenciado, nivel y liberación                       */
/* ------------------------------------------------------------------ */

describe('voz en off · la captura nunca suena por los altavoces', () => {
  /** Fábrica falsa de AudioContext (nodo: sin Web Audio real). */
  function fabricaFalsa() {
    const procesadores: {
      onaudioprocess: ((ev: {
        inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array };
      }) => void) | null;
      connect: () => void;
      disconnect: () => void;
    }[] = [];
    const ganancias: { gain: { value: number }; connect: () => void }[] = [];
    const contexto = {
      sampleRate: 48000,
      destination: {},
      createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
      createAnalyser: () => ({
        fftSize: 4,
        getFloatTimeDomainData: (destino: Float32Array) => destino.fill(0.5),
      }),
      createScriptProcessor: () => {
        const procesador = {
          onaudioprocess: null as never,
          connect: () => {},
          disconnect: () => {},
        };
        procesadores.push(procesador);
        return procesador;
      },
      createGain: () => {
        const ganancia = { gain: { value: 1 }, connect: () => {} };
        ganancias.push(ganancia);
        return ganancia;
      },
      close: () => {},
    };
    const stream = { getTracks: () => [] as { stop: () => void }[] };
    return { contexto, procesadores, ganancias, stream };
  }

  function eventoAudio(muestras: number[]): {
    inputBuffer: { numberOfChannels: number; getChannelData: (ch: number) => Float32Array };
  } {
    return {
      inputBuffer: {
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(muestras),
      },
    };
  }

  it('sin AudioContext no graba: lanza en español sin romper', () => {
    const previo = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    try {
      const stream = { getTracks: () => [] } as unknown as MediaStream;
      expect(() => iniciarCapturaVoz(stream)).toThrow(/no puede grabar voz en off/);
    } finally {
      if (previo !== undefined) {
        (globalThis as { AudioContext?: unknown }).AudioContext = previo;
      }
    }
  });

  it('la monitorización va a ganancia cero (el micro no vuelve por los altavoces)', () => {
    const falsa = fabricaFalsa();
    const control = iniciarCapturaVoz(
      falsa.stream as unknown as MediaStream,
      () => falsa.contexto as any
    );
    try {
      expect(falsa.ganancias.length).toBe(1);
      expect(falsa.ganancias[0].gain.value).toBe(0);
    } finally {
      control.liberar();
    }
  });

  it('los trozos del procesador se recogen por canal al ritmo del contexto', () => {
    const falsa = fabricaFalsa();
    const control = iniciarCapturaVoz(
      falsa.stream as unknown as MediaStream,
      () => falsa.contexto as any
    );
    try {
      expect(control.ritmo).toBe(48000);
      falsa.procesadores[0].onaudioprocess?.(eventoAudio([0.1, 0.2]));
      falsa.procesadores[0].onaudioprocess?.(eventoAudio([0.3]));
      const canales = control.recoger();
      expect(canales.length).toBe(1);
      expect(canales[0].length).toBe(3);
      for (const [i, esperado] of [0.1, 0.2, 0.3].entries()) {
        expect(canales[0][i]).toBeCloseTo(esperado, 6);
      }
    } finally {
      control.liberar();
    }
  });

  it('el nivel lee el analizador (0.5 sostenido → pico 0.5)', () => {
    const falsa = fabricaFalsa();
    const control = iniciarCapturaVoz(
      falsa.stream as unknown as MediaStream,
      () => falsa.contexto as any
    );
    try {
      expect(control.leerNivel()).toBeCloseTo(0.5, 6);
    } finally {
      control.liberar();
    }
  });

  it('detener y liberar son idempotentes y sueltan las pistas', () => {
    const falsa = fabricaFalsa();
    let sueltas = 0;
    const stream = { getTracks: () => [{ stop: () => { sueltas += 1; } }] } as unknown as MediaStream;
    const control = iniciarCapturaVoz(
      stream,
      () => falsa.contexto as any
    );
    expect(() => {
      control.detener();
      control.detener();
      control.liberar();
      control.liberar();
    }).not.toThrow();
    expect(sueltas).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* La toma es un medio normal: historial, persistencia y saneado       */
/* ------------------------------------------------------------------ */

describe('voz en off · la toma es un medio normal del pool', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('construirMediaItemVoz hace un audio con la duración exacta', () => {
    const blob = new Blob(['1234'], { type: 'audio/wav' });
    const item = construirMediaItemVoz({
      id: 'voz_prueba',
      nombre: 'Locución 1',
      blob,
      duracion: 2.5,
      url: 'blob:falso',
      miniatura: 'data:falsa',
      picos: [0.1, 0.9],
      opfsPath: 'media_falsa',
      ahora: 1700000000000,
    });
    expect(item.id).toBe('voz_prueba');
    expect(item.type).toBe('audio');
    expect(item.name).toBe('Locución 1');
    expect(item.duration).toBe(2.5);
    expect(item.size).toBe(blob.size);
    expect(item.url).toBe('blob:falso');
    expect(item.thumbnailUrl).toBe('data:falsa');
    expect(item.waveformPeaks).toEqual([0.1, 0.9]);
    expect(item.opfsPath).toBe('media_falsa');
    expect(item.createdAt).toBe(1700000000000);
    expect(item.status).toBeUndefined();
  });

  it('añadir la toma es UN paso del historial (se deshace y se rehace)', () => {
    const tienda = useProjectStore.getState();
    const blob = new Blob(['toma'], { type: 'audio/wav' });
    const item = construirMediaItemVoz({
      id: 'voz_historial',
      nombre: 'Locución 1',
      blob,
      duracion: 1,
      url: 'blob:falso',
      miniatura: '',
      ahora: 1,
    });
    const pasosAntes = useProjectStore.getState().past.length;
    tienda.addMediaItem(item);
    expect(useProjectStore.getState().project.mediaPool.map((m) => m.id)).toContain(
      'voz_historial'
    );
    expect(useProjectStore.getState().past.length).toBe(pasosAntes + 1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.mediaPool.map((m) => m.id)).not.toContain(
      'voz_historial'
    );
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.mediaPool.map((m) => m.id)).toContain(
      'voz_historial'
    );
  });

  it('la toma sobrevive al saneado de importación como cualquier audio', () => {
    const blob = new Blob(['toma'], { type: 'audio/wav' });
    const item = construirMediaItemVoz({
      id: 'voz_saneada',
      nombre: 'Locución 1',
      blob,
      duracion: 3.25,
      url: 'blob:falso',
      miniatura: '',
      picos: [0.2],
      opfsPath: 'voz_saneada_Locución 1.wav',
      ahora: 1,
    });
    const base = {
      id: 'proj_x',
      name: 'X',
      aspectRatio: '16:9',
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      tracks: [
        { id: 't1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
      ],
      clips: [],
      mediaPool: [item],
      duration: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    const saneado = sanitizeImportedProject(base as never, {
      projectId: 'proj_x',
      fallbackName: 'X',
    });
    const toma = saneado.project.mediaPool.find((m) => m.id === 'voz_saneada');
    expect(toma).toBeDefined();
    expect(toma?.type).toBe('audio');
    expect(toma?.name).toBe('Locución 1');
    expect(toma?.duration).toBeCloseTo(3.25, 6);
    expect(toma?.opfsPath).toBe('voz_saneada_Locución 1.wav');
  });
});

/* ------------------------------------------------------------------ */
/* Cableado de la UI (fuente: no hay jsdom en esta suite)              */
/* ------------------------------------------------------------------ */

describe('voz en off · el cableado existe (bin, hoja móvil, avisos)', () => {
  it('el bin ofrece «Grabar voz en off» con las primitivas del sistema', () => {
    const bin = fuente('../components/media/MediaBin.tsx');
    // La etiqueta canónica (el literal vive en `recording.ts`, sin duplicar).
    expect(bin).toContain('VOZ_ETIQUETA_GRABAR');
    expect(bin).toContain("from '../ui/Button'");
    expect(bin).toContain("from '../ui/IconButton'");
    expect(bin).toContain('<Button');
    // Sin brillos ni pulsos: el estado de grabación es legible sin alarma.
    expect(bin).not.toContain('animate-pulse');
    expect(bin).not.toContain('backdrop-blur');
  });

  it('el bin pide el permiso, suelta el micro y guarda la toma en OPFS', () => {
    const bin = fuente('../components/media/MediaBin.tsx');
    expect(bin).toContain('pedirMicrofono');
    expect(bin).toContain('liberarMicrofono');
    expect(bin).toContain('saveMediaToOPFS');
    expect(bin).toContain('addMediaItem');
    expect(bin).toContain('createObjectURL');
    // La limpieza vive también en el desmontaje (sin pista abierta al salir).
    expect(bin).toContain('clearInterval');
    expect(bin).toContain('cancelAnimationFrame');
  });

  it('el bin muestra temporizador, nivel, detener y descartar mientras graba', () => {
    const bin = fuente('../components/media/MediaBin.tsx');
    expect(bin).toContain('Detener');
    expect(bin).toContain('Descartar');
    expect(bin).toContain('formatearTiempoVoz');
    expect(bin).toContain('Nivel de entrada');
    // El nivel se lee del control (`leerNivel`, que usa el analizador) y se
    // pinta de forma imperativa, sin estado por fotograma.
    expect(bin).toContain('leerNivel');
    expect(bin).toContain('requestAnimationFrame');
  });

  it('el bin avisa del eco sin fiarse de la cancelación del navegador', () => {
    const bin = fuente('../components/media/MediaBin.tsx');
    expect(bin).toContain('auriculares');
    expect(VOZ_AVISO_MONITOR).toContain('auriculares');
    expect(VOZ_AVISO_MONITOR).toContain('volumen general');
    const grabacion = fuente('../core/utils/recording.ts');
    expect(grabacion).toContain('echoCancellation: true');
  });

  it('la denegación se anuncia con role="alert" y salida a importar', () => {
    const bin = fuente('../components/media/MediaBin.tsx');
    expect(bin).toContain('role="alert"');
    // El mensaje sale de `mensajeErrorMicrofono` (el literal vive en el
    // módulo, con la salida a importar incluida).
    expect(bin).toContain('mensajeErrorMicrofono');
    expect(bin).toContain('VOZ_MENSAJE_DENEGADA');
  });

  it('la hoja móvil ofrece la voz en off en la hoja de Audio', () => {
    const hoja = fuente('../components/mobile/MobileBottomSheet.tsx');
    // El control vive en el bin y se reutiliza (sin duplicar la UI).
    expect(hoja).toContain('ControlVozEnOff');
    expect(hoja).toContain("'Audio'");
    // La hoja de medios ya la trae vía el bin (la suite la monta dentro).
    const maquetacion = fuente('../components/mobile/MobileCapCutLayout.tsx');
    expect(maquetacion).toContain("return 'Audio'");
  });
});
