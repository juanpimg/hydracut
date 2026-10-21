import { encodeWavData, WAV_MIME } from '../export/wavExporter';
import { medirNivel } from './levelMeter';
import type { MediaItem } from '../../types/project';

/**
 * Voz en off local: grabar la narración sin salir de la app.
 *
 * Todo lo que se puede probar sin micrófono vive aquí (puro): la máquina de
 * estados, la clasificación del permiso, el PCM (unión, duración exacta al
 * ritmo del dispositivo, mono/estéreo), la envoltura a WAV —que REUTILIZA
 * `encodeWavData`, sin un segundo codificador—, el nombre de la toma, el
 * contrato de limpieza y la construcción del `MediaItem`.
 *
 * La captura en sí (`iniciarCapturaVoz`) usa Web Audio con un `ScriptProcessor`
 * (tamaño fijo) porque es lo único que funciona en Chrome y Firefox sin un
 * `AudioWorklet` externo: los trozos se copian a memoria y al detener se
 * codifican a WAV con el ritmo REAL del contexto (el del dispositivo).
 *
 * Dos decisiones honestas del diseño:
 * - La monitorización está SILENCIADA por construcción (el procesador va a un
 *   `GainNode` a cero): la toma nunca vuelve por los altavoces y no hay
 *   acople. La vista PREVIA sí sigue sonando (es otro grafo), así que la UI
 *   enseña `VOZ_AVISO_MONITOR`: se pide `echoCancellation` al navegador, pero
 *   es un mejor esfuerzo y se dice.
 * - El micrófono se suelta en TODOS los caminos (`liberarMicrofono`): parar,
 *   cancelar, desmontar y error. Una pista abierta se ve como indicador de
 *   grabación para el usuario: no puede quedarse colgada.
 */

/* ------------------------------------------------------------------ */
/* Copy (español, caso oración, problema + recuperación)                */
/* ------------------------------------------------------------------ */

/** Etiqueta del control (nombra la acción, como manda DESIGN.md). */
export const VOZ_ETIQUETA_GRABAR = 'Grabar voz en off';

/** Base del nombre de cada toma. */
export const VOZ_BASE_NOMBRE = 'Locución';

/** Celdas de pico de la toma (paridad con el audio importado: 80). */
export const VOZ_PICOS_CELDAS = 80;

/** Tamaño de bloque del procesador de captura. */
export const VOZ_TAMANO_BLOQUE = 4096;

/**
 * Permiso denegado: dice que el micro está bloqueado Y que se puede importar
 * un archivo en vez de grabar (la puerta alternativa nunca se esconde).
 */
export const VOZ_MENSAJE_DENEGADA =
  'El micrófono está bloqueado: permite el acceso en el navegador o importa un archivo de audio desde Medios.';

/** Sin acceso al micrófono (sin `getUserMedia`, sin dispositivo): no culpa. */
export const VOZ_MENSAJE_NO_DISPONIBLE =
  'Este navegador no puede grabar voz en off: no hay acceso al micrófono. Importa un archivo de audio desde Medios.';

/** Fallo genérico con el detalle y la salida de importar. */
export function mensajeErrorVoz(detalle?: string): string {
  const causa = typeof detalle === 'string' && detalle.length > 0 ? detalle : 'error desconocido';
  return `No se pudo grabar la voz en off: ${causa}. Prueba de nuevo o importa un archivo de audio desde Medios.`;
}

/**
 * Nota de monitorización: la cancelación de eco del navegador NO es fiable y
 * se dice. La toma nunca suena por los altavoces (grafo silenciado), pero la
 * vista previa sí sigue sonando mientras se graba.
 */
export const VOZ_AVISO_MONITOR =
  'La vista previa sigue sonando mientras grabas: usa auriculares o baja el volumen general para que no se cuele en la toma. El navegador intenta cancelar el eco, pero no es fiable.';

/* ------------------------------------------------------------------ */
/* Máquina de estados                                                  */
/* ------------------------------------------------------------------ */

/** Estados de la grabación (el contrato que prueba la suite). */
export type EstadoGrabacion =
  | 'inactiva'
  | 'pidiendo'
  | 'grabando'
  | 'procesando'
  | 'lista'
  | 'denegada'
  | 'error'
  | 'cancelada';

/** Eventos que mueven la máquina. */
export type EventoGrabacion =
  | 'pedir'
  | 'permitida'
  | 'denegada'
  | 'no-disponible'
  | 'fallo'
  | 'detener'
  | 'cancelar'
  | 'guardada'
  | 'descartar'
  | 'reintentar';

const TRANSICIONES: Record<EstadoGrabacion, Record<EventoGrabacion, EstadoGrabacion | null>> = {
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

/**
 * Transición pura de la máquina: el siguiente estado o `null` cuando el
 * evento es ilegal en ese estado (la UI lo ignora en vez de romper).
 */
export function transicionGrabacion(
  estado: EstadoGrabacion,
  evento: EventoGrabacion
): EstadoGrabacion | null {
  return TRANSICIONES[estado]?.[evento] ?? null;
}

/* ------------------------------------------------------------------ */
/* Permiso del micrófono                                               */
/* ------------------------------------------------------------------ */

/** Las tres salidas reales de pedir el micrófono. */
export type ClaseErrorMicrofono = 'denegada' | 'no-disponible' | 'error';

/**
 * Clasifica el error de `getUserMedia` en una de las tres salidas (pura).
 */
export function clasificarErrorMicrofono(error: unknown): ClaseErrorMicrofono {
  const nombre =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  if (nombre === 'NotAllowedError' || nombre === 'SecurityError') return 'denegada';
  if (nombre === 'NotFoundError' || nombre === 'OverconstrainedError') return 'no-disponible';
  return 'error';
}

/**
 * Mensaje en español de cada salida (todas ofrecen importar un archivo).
 */
export function mensajeErrorMicrofono(
  clase: ClaseErrorMicrofono,
  detalle?: string
): string {
  if (clase === 'denegada') return VOZ_MENSAJE_DENEGADA;
  if (clase === 'no-disponible') return VOZ_MENSAJE_NO_DISPONIBLE;
  return mensajeErrorVoz(detalle);
}

/**
 * True cuando el navegador expone `getUserMedia`. Nunca lanza (nodo/SSR).
 */
export function hayMicrofono(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    const dispositivos = (navigator as Navigator | undefined)?.mediaDevices;
    return typeof dispositivos?.getUserMedia === 'function';
  } catch {
    return false;
  }
}

/**
 * Pide el micrófono (solo audio, con cancelación de eco de mejor esfuerzo).
 *
 * Lanza un `Error` con el mensaje listo para enseñar (la `cause` dice la
 * clase: `'denegada' | 'no-disponible' | 'error'`).
 */
/**
 * `Error` con `cause` sin pedir ES2022 a la librería (el proyecto compila con
 * ES2020 + DOM): la causa viaja igual para quien la lea.
 */
function errorConCausa(mensaje: string, causa: unknown): Error {
  const error = new Error(mensaje);
  (error as Error & { cause?: unknown }).cause = causa;
  return error;
}

export async function pedirMicrofono(): Promise<MediaStream> {
  if (!hayMicrofono()) {
    throw errorConCausa(VOZ_MENSAJE_NO_DISPONIBLE, 'no-disponible');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    const clase = clasificarErrorMicrofono(error);
    throw errorConCausa(mensajeErrorMicrofono(clase), clase);
  }
}

/**
 * Suelta el micrófono: detiene TODAS las pistas del stream.
 *
 * Idempotente y nunca lanza: una pista rota no puede impedir que las demás
 * se suelten (ni romper el camino que la llama: parar, cancelar, desmontar,
 * error).
 */
export function liberarMicrofono(stream: MediaStream | null | undefined): void {
  try {
    const pistas =
      stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const pista of pistas) {
      try {
        pista.stop();
      } catch {
        // Una pista rota no retiene a las demás.
      }
    }
  } catch {
    // Un stream a medias tampoco retiene el micrófono.
  }
}

/* ------------------------------------------------------------------ */
/* PCM: unión, duración y canales                                      */
/* ------------------------------------------------------------------ */

/**
 * Concatena los trozos capturados en un solo búfer (en orden, sin tocar las
 * muestras).
 */
export function unirPcm(trozos: Float32Array[]): Float32Array {
  let total = 0;
  for (const trozo of trozos) total += trozo?.length ?? 0;
  const unido = new Float32Array(total);
  let pos = 0;
  for (const trozo of trozos) {
    if (!trozo || trozo.length === 0) continue;
    unido.set(trozo, pos);
    pos += trozo.length;
  }
  return unido;
}

/**
 * Duración de la toma: muestras / ritmo del dispositivo. Lo imposible da 0
 * (nunca `NaN`: un `NaN` aterrizando en el `MediaItem` rompería la línea).
 */
export function calcularDuracionVoz(muestras: number, ritmo: number): number {
  if (!Number.isFinite(muestras) || muestras <= 0) return 0;
  if (!Number.isFinite(ritmo) || ritmo <= 0) return 0;
  return muestras / ritmo;
}

/**
 * Normaliza a mono/estéreo: la toma es voz (1–2 canales). Sin canales hay un
 * mono vacío para que el WAV nunca se rompa.
 */
export function normalizarCanalesVoz(canales: Float32Array[]): Float32Array[] {
  if (!Array.isArray(canales) || canales.length === 0) return [new Float32Array(0)];
  return canales.slice(0, 2);
}

/**
 * Envuelve el PCM capturado en un WAV 16 bits REUTILIZANDO `encodeWavData`
 * (el mismo codificador del export de audio: no hay un segundo).
 *
 * Lanza en español cuando la toma está vacía: un WAV mudo de 44 bytes no es
 * una toma, es basura en el pool.
 */
export function codificarWavVoz(canales: Float32Array[], ritmo: number): Blob {
  const normales = normalizarCanalesVoz(canales);
  let muestras = 0;
  for (const canal of normales) {
    if (canal && canal.length > muestras) muestras = canal.length;
  }
  if (muestras === 0) {
    throw new Error('La grabación no capturó ningún sonido: la toma se ha descartado.');
  }
  return new Blob([encodeWavData(normales, ritmo)], { type: WAV_MIME });
}

/**
 * Picos normalizados [0, 1] por celdas, del PCM capturado (para la forma de
 * onda de la toma sin decodificar nada). Misma regla que
 * `extractWaveformPeaks`: el silencio da ceros y lo audible se normaliza por
 * su máximo (con el suelo de 0,04 para que se vea la línea).
 */
export function calcularPicosVoz(muestras: Float32Array, celdas: number): number[] {
  const n = Number.isFinite(celdas) ? Math.max(1, Math.floor(celdas)) : 1;
  const total = muestras?.length ?? 0;
  if (total === 0) return new Array(n).fill(0);
  const porCelda = Math.max(1, Math.floor(total / n));
  const picos = new Array<number>(n).fill(0);
  let maximo = 0;
  for (let i = 0; i < n; i++) {
    const inicio = i * porCelda;
    if (inicio >= total) break;
    const fin = Math.min(total, inicio + porCelda);
    let maxCelda = 0;
    for (let s = inicio; s < fin; s++) {
      const valor = muestras[s] < 0 ? -muestras[s] : muestras[s];
      if (valor > maxCelda) maxCelda = valor;
    }
    picos[i] = maxCelda;
    if (maxCelda > maximo) maximo = maxCelda;
  }
  if (maximo < 0.0001) return new Array(n).fill(0);
  return picos.map((pico) =>
    pico === 0 ? 0 : Math.min(1, Math.max(0.04, Math.round((pico / maximo) * 1000) / 1000))
  );
}

/* ------------------------------------------------------------------ */
/* Nombre, id y temporizador                                           */
/* ------------------------------------------------------------------ */

/**
 * Primera `Locución N` libre (N ≥ 1). Compara sin mayúsculas, sin espacios y
 * sin la extensión, así que `locución 1.wav` también ocupa su número.
 */
export function siguienteNombreVoz(nombres: string[]): string {
  const ocupados = new Set<number>();
  for (const crudo of nombres ?? []) {
    if (typeof crudo !== 'string') continue;
    const limpio = crudo.trim().toLowerCase().replace(/\.wav$/i, '').trim();
    const coincidencia = limpio.match(/^locución\s+(\d+)$/);
    if (coincidencia) ocupados.add(parseInt(coincidencia[1], 10));
  }
  let n = 1;
  while (ocupados.has(n)) n += 1;
  return `${VOZ_BASE_NOMBRE} ${n}`;
}

/** Archivo de la toma: el nombre de la toma con extensión `.wav`. */
export function construirNombreArchivoVoz(nombre: string): string {
  return `${nombre}.wav`;
}

/** Id de la toma (paridad con los `media_…` del pool). */
export function crearIdVoz(): string {
  return 'voz_' + Math.random().toString(36).substring(2, 9);
}

/**
 * Temporizador de la toma en `m:ss` (puro, para el indicador en vivo).
 */
export function formatearTiempoVoz(segundos: number): string {
  const total = Number.isFinite(segundos) && segundos > 0 ? Math.floor(segundos) : 0;
  const minutos = Math.floor(total / 60);
  const resto = total % 60;
  return `${minutos}:${resto.toString().padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Captura Web Audio (grafo silenciado + nivel)                        */
/* ------------------------------------------------------------------ */

/** Nodo mínimo que la captura necesita (fuente, procesador o ganancia). */
export interface NodoVoz {
  connect: (destino?: unknown) => void;
  disconnect: () => void;
}

/** Procesador que entrega los trozos de PCM por `onaudioprocess`. */
export interface ProcesadorVoz extends NodoVoz {
  onaudioprocess:
    | ((evento: {
        inputBuffer: {
          numberOfChannels: number;
          getChannelData: (canal: number) => Float32Array;
        };
      }) => void)
    | null;
}

/** Analizador para el nivel en vivo (dominio temporal). */
export interface AnalizadorVoz {
  fftSize: number;
  getFloatTimeDomainData: (destino: Float32Array) => void;
}

/** Contexto mínimo que la captura necesita (el real lo cumple). */
export interface ContextoVoz {
  readonly sampleRate: number;
  readonly destination: unknown;
  createMediaStreamSource: (stream: MediaStream) => NodoVoz;
  createScriptProcessor: (tamano: number, entradas: number, salidas: number) => ProcesadorVoz;
  createAnalyser: () => AnalizadorVoz;
  createGain: () => { gain: { value: number }; connect: (destino?: unknown) => void };
  close: () => void | Promise<void>;
}

/** Fábrica del contexto (inyectable para probar sin Web Audio real). */
export type FabricaContextoVoz = () => ContextoVoz;

/** Control de una captura en curso (dueño del grafo, NO del stream). */
export interface ControlCapturaVoz {
  /** Ritmo real de la captura (el del dispositivo). */
  ritmo: number;
  /** Pico [0, 1] del nivel de entrada en este instante. */
  leerNivel: () => number;
  /** PCM capturado hasta ahora, un `Float32Array` por canal. */
  recoger: () => Float32Array[];
  /** Para el grafo y cierra el contexto (idempotente, no suelta el micro). */
  detener: () => void;
  /** `detener()` + suelta el micrófono (idempotente). */
  liberar: () => void;
}

/**
 * Fábrica real: el `AudioContext` del navegador. Lanza en español cuando no
 * hay Web Audio (la UI degrada a importar un archivo).
 */
function crearContextoVozReal(): ContextoVoz {
  const Constructor =
    typeof AudioContext !== 'undefined' ? AudioContext : null;
  if (!Constructor) {
    throw new Error(VOZ_MENSAJE_NO_DISPONIBLE);
  }
  return new Constructor() as unknown as ContextoVoz;
}

/**
 * Arranca la captura del stream del micrófono.
 *
 * El grafo es `fuente → analizador` (nivel) y `fuente → procesador →
 * ganancia(0) → destino`: el procesador tiene que sonar hacia algún sitio
 * para que `onaudioprocess` dispare, pero va a ganancia CERO — la toma nunca
 * suena por los altavoces (sin monitorización no hay acople).
 *
 * El que llama es dueño del stream: `detener()` para el grafo y `liberar()`
 * suelta además el micrófono. Ambos son idempotentes.
 */
export function iniciarCapturaVoz(
  stream: MediaStream,
  fabrica: FabricaContextoVoz = crearContextoVozReal
): ControlCapturaVoz {
  const contexto = fabrica();
  const ritmo =
    Number.isFinite(contexto.sampleRate) && contexto.sampleRate > 0
      ? Math.round(contexto.sampleRate)
      : 48000;

  const fuente = contexto.createMediaStreamSource(stream);
  const analizador = contexto.createAnalyser();
  const canales = 1;
  const procesador = contexto.createScriptProcessor(VOZ_TAMANO_BLOQUE, canales, 1);
  const silencio = contexto.createGain();
  silencio.gain.value = 0;

  const trozos: Float32Array[][] = [[]];
  procesador.onaudioprocess = (evento) => {
    const entrada = evento?.inputBuffer;
    if (!entrada) return;
    const n = Math.max(1, Math.min(2, entrada.numberOfChannels ?? 1));
    while (trozos.length < n) trozos.push([]);
    for (let ch = 0; ch < n; ch++) {
      try {
        trozos[ch].push(entrada.getChannelData(ch).slice());
      } catch {
        // Un trozo ilegible no tira la toma entera.
      }
    }
  };

  fuente.connect(analizador);
  fuente.connect(procesador);
  procesador.connect(silencio);
  silencio.connect(contexto.destination);

  let muestrasNivel = new Float32Array(2048);
  let parado = false;
  let soltado = false;

  const detener = (): void => {
    if (parado) return;
    parado = true;
    try {
      procesador.onaudioprocess = null;
    } catch {
      // Ignorado: el procesador ya no existe.
    }
    try {
      procesador.disconnect();
    } catch {
      // Ignorado.
    }
    try {
      fuente.disconnect();
    } catch {
      // Ignorado.
    }
    try {
      const cierre = contexto.close();
      if (cierre && typeof (cierre as Promise<void>).catch === 'function') {
        (cierre as Promise<void>).catch(() => {});
      }
    } catch {
      // Ignorado: el contexto ya estaba cerrado.
    }
  };

  return {
    ritmo,
    leerNivel: () => {
      try {
        if (muestrasNivel.length !== analizador.fftSize) {
          muestrasNivel = new Float32Array(Math.max(1, analizador.fftSize));
        }
        analizador.getFloatTimeDomainData(muestrasNivel);
        return medirNivel(muestrasNivel).pico;
      } catch {
        return 0;
      }
    },
    recoger: () => trozos.map((lista) => unirPcm(lista)),
    detener,
    liberar: () => {
      detener();
      // Idempotente del todo: las pistas se sueltan una sola vez aunque el
      // desmontaje y el error llamen a la vez.
      if (soltado) return;
      soltado = true;
      liberarMicrofono(stream);
    },
  };
}

/* ------------------------------------------------------------------ */
/* La toma es un medio normal                                          */
/* ------------------------------------------------------------------ */

/** Parámetros para construir el `MediaItem` de una toma. */
export interface TomaVozParams {
  id: string;
  nombre: string;
  blob: Blob;
  /** Duración exacta (muestras / ritmo). */
  duracion: number;
  url: string;
  miniatura: string;
  picos?: number[];
  opfsPath?: string;
  ahora?: number;
}

/**
 * Construye el `MediaItem` de la toma: un audio NORMAL (tipo `audio`, como el
 * chime de prueba: sin dimensiones ni fps). Por eso entra al historial con
 * `addMediaItem` (un paso deshacible), persiste con el proyecto y el saneado
 * de importación lo conserva como a cualquier otro medio.
 */
export function construirMediaItemVoz(params: TomaVozParams): MediaItem {
  const duracion =
    Number.isFinite(params.duracion) && params.duracion > 0 ? params.duracion : 0;
  return {
    id: params.id,
    name: params.nombre,
    type: 'audio',
    url: params.url,
    duration: duracion,
    width: 0,
    height: 0,
    fps: 0,
    thumbnailUrl: params.miniatura,
    waveformPeaks: Array.isArray(params.picos) ? params.picos : undefined,
    size: params.blob?.size ?? 0,
    createdAt: Number.isFinite(params.ahora) ? (params.ahora as number) : Date.now(),
    opfsPath: params.opfsPath,
  };
}
