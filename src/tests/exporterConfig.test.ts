import { describe, it, expect, afterEach, vi } from 'vitest';
import { selectSupportedVideoConfig } from '../core/export/webcodecsExporter';

const REAL_VIDEO_ENCODER = (globalThis as Record<string, unknown>).VideoEncoder;
const REAL_VIDEO_FRAME = (globalThis as Record<string, unknown>).VideoFrame;

afterEach(() => {
  // Restore globals so other suites see a pristine environment
  if (REAL_VIDEO_ENCODER === undefined) delete (globalThis as Record<string, unknown>).VideoEncoder;
  else (globalThis as Record<string, unknown>).VideoEncoder = REAL_VIDEO_ENCODER;
  if (REAL_VIDEO_FRAME === undefined) delete (globalThis as Record<string, unknown>).VideoFrame;
  else (globalThis as Record<string, unknown>).VideoFrame = REAL_VIDEO_FRAME;
  vi.restoreAllMocks();
});

function mockWebCodecs(supported: Record<string, boolean>, seen: unknown[] = []) {
  (globalThis as Record<string, unknown>).VideoFrame = class {};
  (globalThis as Record<string, unknown>).VideoEncoder = {
    isConfigSupported: vi.fn(async (cfg: unknown) => {
      seen.push(cfg);
      const codec = (cfg as { codec: string }).codec;
      return { supported: !!supported[codec], config: cfg };
    }),
  };
}

describe('selectSupportedVideoConfig (export encoder guard)', () => {
  it('devuelve null cuando WebCodecs no existe (entorno sin VideoEncoder)', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    await expect(selectSupportedVideoConfig(1920, 1080, 6_000_000, 30)).resolves.toBeNull();
  });

  it('prefiere High Profile y valida la configuración completa (dims+bitrate+fps)', async () => {
    const seen: unknown[] = [];
    mockWebCodecs({ 'avc1.640028': true }, seen);
    const codec = await selectSupportedVideoConfig(1920, 1080, 8_000_000, 30);
    expect(codec).toBe('avc1.640028');
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
    });
  });

  it('recurre a Main y luego a Baseline cuando los perfiles superiores no son soportados', async () => {
    mockWebCodecs({ 'avc1.640028': false, 'avc1.4d002a': false, 'avc1.42001f': true });
    await expect(selectSupportedVideoConfig(3840, 2160, 20_000_000, 60)).resolves.toBe(
      'avc1.42001f'
    );

    const seen2: unknown[] = [];
    mockWebCodecs({ 'avc1.640028': false, 'avc1.4d002a': true, 'avc1.42001f': true }, seen2);
    await expect(selectSupportedVideoConfig(1080, 1920, 8_000_000, 30)).resolves.toBe(
      'avc1.4d002a'
    );
    // No debe seguir probando tras encontrar soporte
    expect(seen2.length).toBe(2);
  });

  it('devuelve null si ningún perfil soporta la configuración (p. ej. 4K en GPU limitada)', async () => {
    mockWebCodecs({ 'avc1.640028': false, 'avc1.4d002a': false, 'avc1.42001f': false });
    await expect(selectSupportedVideoConfig(3840, 2160, 20_000_000, 60)).resolves.toBeNull();
  });

  it('tolera rechazos (throw) de isConfigSupported y sigue con el siguiente candidato', async () => {    (globalThis as Record<string, unknown>).VideoFrame = class {};
    (globalThis as Record<string, unknown>).VideoEncoder = {
      isConfigSupported: vi.fn(async (cfg: unknown) => {
        const codec = (cfg as { codec: string }).codec;
        if (codec === 'avc1.640028') throw new Error('nope');
        return { supported: codec === 'avc1.4d002a', config: cfg };
      }),
    };
    await expect(selectSupportedVideoConfig(1920, 1080)).resolves.toBe('avc1.4d002a');
  });
});

describe('toActionableExportError (traductor de errores de encoder)', () => {
  const dims = { width: 3840, height: 2160, fps: 60 };

  it('traduce "Operation is not supported" a mensaje accionable en español', async () => {
    const { toActionableExportError } = await import('../core/export/webcodecsExporter');
    const raw = new DOMException('Operation is not supported', 'EncodingError');
    const out = toActionableExportError(raw, dims);
    expect(out.message).toContain('3840x2160@60fps');
    expect(out.message).toContain('1080p');
    expect(out.message).toContain('Operation is not supported');
  });

  it('traduce "Encoder must be configured first" en vez del síntoma críptico', async () => {
    const { toActionableExportError } = await import('../core/export/webcodecsExporter');
    const raw = new DOMException(
      "Failed to execute 'encode' on 'VideoEncoder': Encoder must be configured first.",
      'InvalidStateError'
    );
    const out = toActionableExportError(raw, dims);
    expect(out.message).toContain('codificador');
    expect(out.message).toContain('720p');
  });

  it('traduce la causa del error-callback en lugar de devolverla cruda', async () => {
    const { toActionableExportError } = await import('../core/export/webcodecsExporter');
    const cause = new DOMException('Operation is not supported', 'NotSupportedError');
    const out = toActionableExportError(new Error('flush failed'), dims, cause);
    // Nunca debe devolver el error crudo del callback (bug original):
    expect(out).not.toBe(cause);
    expect(out.message).toContain('3840x2160@60fps');
    expect(out.message).toContain('Operation is not supported');
    expect(out.message).toContain('1080p');
  });

  it('traduce "Encoder creation error" asíncrono del callback', async () => {
    const { toActionableExportError } = await import('../core/export/webcodecsExporter');
    const cause = new DOMException('Encoder creation error.', 'OperationError');
    const out = toActionableExportError(new Error('flush failed'), dims, cause);
    expect(out).not.toBe(cause);
    expect(out.message).toContain('Encoder creation error.');
    expect(out.message).toContain('rechazó la exportación');
  });

  it('deja intactos los errores no relacionados con el encoder', async () => {
    const { toActionableExportError } = await import('../core/export/webcodecsExporter');
    const raw = new Error('Exportación cancelada por el usuario');
    expect(toActionableExportError(raw, dims)).toBe(raw);
    const typeRaw = new TypeError('Cannot read properties of null');
    expect(toActionableExportError(typeRaw, dims)).toBe(typeRaw);
  });
});

describe('findWorkingVideoEncoderConfig (sonda profunda de encoder)', () => {
  const REAL_VE = (globalThis as Record<string, unknown>).VideoEncoder;
  const REAL_VF = (globalThis as Record<string, unknown>).VideoFrame;

  afterEach(() => {
    if (REAL_VE === undefined) delete (globalThis as Record<string, unknown>).VideoEncoder;
    else (globalThis as Record<string, unknown>).VideoEncoder = REAL_VE;
    if (REAL_VF === undefined) delete (globalThis as Record<string, unknown>).VideoFrame;
    else (globalThis as Record<string, unknown>).VideoFrame = REAL_VF;
    vi.restoreAllMocks();
  });

  /**
   * Mock that reproduces the real-world failure: `prefer-hardware` configures
   * synchronously but the platform encoder dies asynchronously right after
   * (OperationError "Encoder creation error"), while other modes survive.
   */
  function installMockVideoEncoder(opts: { dieOn: string[]; supportedCodecs?: string[] }) {
    (globalThis as Record<string, unknown>).VideoFrame = class {};
    const supported = opts.supportedCodecs ?? ['avc1.640028', 'avc1.4d002a', 'avc1.42001f'];
    const configureCalls: Array<{ codec: string; hw: string }> = [];

    class MockVideoEncoder {
      state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
      private errorCb: (e: Error) => void;
      constructor(init: { output: () => void; error: (e: Error) => void }) {
        this.errorCb = init.error;
      }
      configure(cfg: { codec: string; hardwareAcceleration?: string }) {
        configureCalls.push({ codec: cfg.codec, hw: cfg.hardwareAcceleration || 'no-preference' });
        this.state = 'configured';
        if (cfg.hardwareAcceleration && opts.dieOn.includes(cfg.hardwareAcceleration)) {
          // Asynchronous death, exactly like Chrome's platform encoder failure
          setTimeout(() => {
            this.state = 'closed';
            this.errorCb(new DOMException('Encoder creation error.', 'OperationError'));
          }, 0);
        }
      }
      close() {
        this.state = 'closed';
      }
      static isConfigSupported = vi.fn(async (cfg: { codec: string }) => ({
        supported: supported.includes(cfg.codec),
        config: cfg,
      }));
    }

    (globalThis as Record<string, unknown>).VideoEncoder = MockVideoEncoder;
    return { configureCalls, MockVideoEncoder };
  }

  it('detecta la muerte asíncrona de prefer-hardware y cae a no-preference', async () => {
    const { configureCalls } = installMockVideoEncoder({ dieOn: ['prefer-hardware'] });
    const { findWorkingVideoEncoderConfig } = await import('../core/export/webcodecsExporter');

    const result = await findWorkingVideoEncoderConfig(1280, 720, 8_000_000, 30, 30);
    expect(result).toEqual({ codec: 'avc1.640028', hardwareAcceleration: 'no-preference' });
    // La sonda intentó primero hardware y luego el modo por defecto
    expect(configureCalls[0].hw).toBe('prefer-hardware');
    expect(configureCalls.some((c) => c.hw === 'no-preference')).toBe(true);
  });

  it('usa prefer-hardware cuando el encoder sobrevive (equipo sano)', async () => {
    const { configureCalls } = installMockVideoEncoder({ dieOn: [] });
    const { findWorkingVideoEncoderConfig } = await import('../core/export/webcodecsExporter');

    const result = await findWorkingVideoEncoderConfig(1920, 1080, 8_000_000, 30, 30);
    expect(result).toEqual({ codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' });
    expect(configureCalls.length).toBe(1);
  });

  it('devuelve null si ninguna combinación sobrevive (para caer a MediaRecorder)', async () => {
    installMockVideoEncoder({ dieOn: ['prefer-hardware', 'no-preference', 'prefer-software'] });
    const { findWorkingVideoEncoderConfig } = await import('../core/export/webcodecsExporter');

    const result = await findWorkingVideoEncoderConfig(3840, 2160, 20_000_000, 60, 30);
    expect(result).toBeNull();
  });

  it('devuelve null si el codec no está soportado por isConfigSupported', async () => {
    installMockVideoEncoder({ dieOn: [], supportedCodecs: [] });
    const { findWorkingVideoEncoderConfig } = await import('../core/export/webcodecsExporter');

    const result = await findWorkingVideoEncoderConfig(1920, 1080, 8_000_000, 30, 30);
    expect(result).toBeNull();
  });
});
