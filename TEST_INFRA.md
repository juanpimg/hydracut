# TEST_INFRA — Infraestructura de pruebas de HydraCut Studio

> **Este documento describe la infraestructura de pruebas REAL del proyecto.**
> Todo comando que aparece aquí es ejecutable y todo fichero que se menciona
> existe en el repositorio. Las antiguas referencias a una arquitectura E2E de
> 4 niveles (`src/tests/e2e/tier1-features.test.ts` …) y a `TEST_READY.md`
> correspondían a una suite que **nunca se creó**: se eliminaron de esta
> documentación el 2026-10-19.

---

## 1. Panorama

HydraCut Studio verifica su comportamiento con **dos capas complementarias**:

| Capa | Motor | Entorno | Qué cubre | Comando |
|------|-------|----------|-----------|---------|
| **A. Suites unitarias e integración** | [Vitest](https://vitest.dev) 2.x | Node.js (sin DOM real) | Algoritmos, stores, motor de medios, compositor, pipeline de export, persistencia | `npm test` |
| **B. E2E en navegador real** | Scripts Node + `puppeteer-core` | Chrome/Chromium real | Layout responsive, reproducción, deshacer/rehacer, persistencia, exportación MP4 | `npm run test:browser` |

No hay un tercer nivel: no existe `src/tests/e2e/` ni `TEST_READY.md`.

### 1.1 Estado actual (medido el 2026-10-19)

```bash
$ npm test
 Test Files  21 passed (21)
      Tests  399 passed (399)
```

> El número exacto cambia cada vez que el equipo añade una suite. **Ejecuta
> `npx vitest run` para obtener el número vigente**; esta cifra es una foto, no
> una promesa.

---

## 2. Capa A — Suites unitarias e integración (Vitest)

### 2.1 Configuración

La configuración vive en el bloque `test` de `vite.config.ts`:

```ts
test: {
  environment: 'node',        // sin jsdom: los tests que necesitan DOM lo simulan a mano
  globals: false,             // imports explícitos: import { describe, it, expect } from 'vitest'
  include: ['src/tests/**/*.test.ts'],
  exclude: ['src/tests/browser/**', 'node_modules/**', 'dist/**', '**/*.d.ts'],
  testTimeout: 15_000,        // la simulación de 10 minutos de reproducción necesita ~1,6 s
  hookTimeout: 15_000,
  coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/tests/**', 'dist/**', '**/*.d.ts', ...] },
}
```

`src/tests/browser/**` está excluido a propósito: son scripts `.mjs` de Node
para el harness de navegador, **no** suites de Vitest.

### 2.2 Suites existentes

| Fichero | Tests | Qué verifica |
|---------|-------|--------------|
| `src/tests/audioEngine-hardening.test.ts` | 11 | Tolerancia a fallos de la Web Audio API, fallback de reloj dual |
| `src/tests/challenger-stress.test.ts` | 13 | Estrés adversarial de `MasterClock`/`AudioEngine`, latencia de `togglePlay()` |
| `src/tests/challenger-stress-verification.test.ts` | 14 | `MediaSourcePool.syncVideoTime` (histeresis, cooldown, seeks), compositor sin asignaciones, aislamiento de render de `MobileBottomBar` |
| `src/tests/clipGestures.test.ts` | 8 | Historial por gesto (drag/trim con un único undo) |
| `src/tests/data-integrity.test.ts` | 22 | Integridad del estado: mediaPool en el historial, clips, pistas bloqueadas |
| `src/tests/engine-correctness.test.ts` | 35 | Corrección del motor: failover de reloj, resync en seek, liberación de recursos |
| `src/tests/engine.test.ts` | 30 | Orden de capas del compositor, jerarquía de pistas, **contrato real del exportador** (dimensiones pares y audio planar `f32-planar`) |
| `src/tests/exporterConfig.test.ts` | 14 | Sonda de encoder, selección de config AVC, traducción de errores |
| `src/tests/export-pipeline.test.ts` | 32 | Pipeline de export: fallback a MediaRecorder, nivel AVC, duración de audio, muxing |
| `src/tests/features.test.ts` | 17 | Waveforms, transiciones, snapping, controles de velocidad |
| `src/tests/lifecycle-integration.test.ts` | 22 | Ciclo de vida: liberación de recursos, errores de persistencia, autosave al cerrar |
| `src/tests/perf-storage.test.ts` | 34 | Object URLs, miniaturas, autosave con debounce, escritura atómica del índice |
| `src/tests/playback-acceptance.test.ts` | 24 | Aceptación de reproducción 60 FPS (R1–R5), incl. simulación de 10 minutos y aislamiento de render |
| `src/tests/projectStorage-hardening.test.ts` | 4 | Endurecimiento de `projectStorage` |
| `src/tests/projectStorage.test.ts` | 18 | Persistencia multi-proyecto (IndexedDB + OPFS) |
| `src/tests/quality-guard.test.ts` | 5 | **Guarda de calidad del propio suite** (ver §5) |
| `src/tests/render-scale.test.ts` | 16 | `computeRenderScale`: el preview se rasteriza a la resolución de pantalla |
| `src/tests/timeline-duration.test.ts` | 27 | Duración real del proyecto, duplicación de pistas, estados deshacibles, `NaN` |
| `src/tests/timeline.test.ts` | 27 | Utilidades de tiempo, snapping magnético, operaciones del store, jerarquía de pistas |
| `src/tests/ui-a11y.test.ts` | 24 | Accesibilidad: menús anclados, focus trap, live region, disponibilidad del botón Dividir |
| `src/tests/welcome.test.ts` | 2 | Estado de la pantalla de bienvenida |

### 2.3 Ejecutar

```bash
# Suite completa (desde apps/hydra-cut)
npm test

# Un fichero o un patrón
npx vitest run src/tests/engine.test.ts
npx vitest run src/tests/timeline

# Ver el nombre de cada test (TAP)
npx vitest run --reporter=verbose src/tests/quality-guard.test.ts

# Comprobación de tipos (sin emitir ficheros)
npm run typecheck          # == tsc --noEmit
```

---

## 3. Capa B — E2E en navegador real

### 3.1 Ficheros

| Fichero | Contenido |
|---------|-----------|
| `scripts/browser-test.mjs` | CLI: lanza el runner y propaga los argumentos |
| `src/tests/browser/run-all.mjs` | Runner: levanta (o reutiliza) el servidor de Vite, abre Chrome, ejecuta las suites e imprime el informe |
| `src/tests/browser/browser-harness.mjs` | Utilidades compartidas: arranque del dev server, lanzamiento de Chrome, selectores, diagnósticos |
| `src/tests/browser/suite-layout.mjs` | Layout responsive (6 viewports × 2 `devicePixelRatio`) |
| `src/tests/browser/suite-playback.mjs` | Reproducción, deshacer/rehacer y persistencia |
| `src/tests/browser/suite-export.mjs` | Pipeline de exportación MP4 |
| `src/tests/browser/suite-known-issues.mjs` | Defectos conocidos (informativo; con `--strict` fallan) |

### 3.2 Ejecutar

```bash
# Todas las suites
npm run test:browser

# Una sola suite
npm run test:browser layout
npm run test:browser playback
npm run test:browser export
npm run test:browser known-issues

# Con el navegador visible
npm run test:browser -- --headed

# Los "defectos conocidos" también hacen fallar la ejecución
npm run test:browser -- --strict
```

Variables de entorno:

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `HYDRA_CHROME_PATH` | `/usr/bin/google-chrome-stable` | Ruta del binario de Chrome/Chromium |
| `HYDRA_DEV_HOST` | `127.0.0.1` | Host del servidor de desarrollo |
| `HYDRA_DEV_PORT` | `5199` | Puerto del servidor de desarrollo |
| `HYDRA_BASE_URL` | `http://<host>:<puerto>/` | URL base si el servidor ya está levantado |
| `HYDRA_STRICT` | `0` | Equivale a `--strict` |

> **El E2E de navegador NO forma parte de CI** (necesita un binario de Chrome).
> Se ejecuta a mano antes de cada entrega. Véase `.github/workflows/ci.yml`.

---

## 4. Mapeo de los 4 niveles conceptuales a la realidad

El plan original de pruebas describía 4 niveles. La implementación real los
cubre así:

| Nivel conceptual | Dónde vive hoy |
|------------------|----------------|
| **Nivel 1 — Cobertura de funcionalidad** (R1–R6) | Suites de Vitest de la capa A: `features`, `audioEngine-hardening`, `engine-correctness`, `ui-a11y`, `timeline`, `exporterConfig` |
| **Nivel 2 — Casos límite y de esquina** | `challenger-stress`, `challenger-stress-verification`, `data-integrity`, `timeline-duration`, `perf-storage`, `projectStorage-hardening`, `engine.test.ts` (contrato del exportador) |
| **Nivel 3 — Interacciones entre subsistemas** | `lifecycle-integration`, `playback-acceptance`, `export-pipeline`, `engine-correctness` |
| **Nivel 4 — Escenarios reales multi-dispositivo** | Harness de navegador (`src/tests/browser/`): 6 viewports × 2 `devicePixelRatio` (layout), reproducción, persistencia y exportación real en MP4 |

---

## 5. Guarda de calidad del propio suite

`src/tests/quality-guard.test.ts` impide que la suite vuelva a mentir:

1. **Sin ficheros huérfanos**: todo `*.test.ts` de `src/tests/` declara al menos
   un `describe()`.
2. **Sin módulos de producción sin test**: todo `.ts` de `src/core/` y
   `src/store/` lo importa al menos un test (con una lista blanca corta y
   justificada para las excepciones).
3. **Sin reimplementaciones de producción**: si un test define localmente una
   función con el mismo nombre que un export de producción, o si su cuerpo
   comparte ≥ 4 constantes numéricas distintivas con una función de producción,
   la guarda falla indicando fichero y función.

> La guarda existe porque el proyecto llegó a publicar una "evidencia de
> verificación" que reimplementaba 58 líneas de `MediaSourcePool.syncVideoTime`
> y verificaba su propia copia. Ese tipo de test pasa siempre y no prueba nada.

---

## 6. Integración continua

`.github/workflows/ci.yml` ejecuta, en cada `push` y `pull_request`:

```bash
npm ci → npm run typecheck → npm test → npm run build
```

* Node 20 (`actions/setup-node@v4`), `actions/checkout@v4`.
* El E2E de navegador queda **fuera** del pipeline a propósito (requiere Chrome).

---

## 7. Huecos conocidos

| Hueco | Estado | Nota |
|-------|--------|------|
| **ESLint / lint** | ❌ No instalado | No hay dependencia de ESLint ni script de lint. El `build` ejecuta `tsc && vite build`: `tsc` sí valida los tipos, pero **no hay analysis estático de estilo**. Cualquier afirmación de "0 lint warnings" es falsa. |
| **Cobertura** | ⚠️ Configurada, no activada | El bloque `coverage` de `vite.config.ts` está listo, pero el proveedor (`@vitest/coverage-v8`) **no está instalado**. Para usarlo: `npm i -D @vitest/coverage-v8` y luego `npx vitest run --coverage`. |
| **E2E en CI** | ❌ Fuera del pipeline | Requiere un Chrome real; hoy es un paso manual. |
| **Tests de `src/core/utils/thumbnails.ts`** | ⚠️ En lista blanca | Genera DataURLs con Canvas/Image: sin navegador real no hay nada que afirmar. Queda en la lista blanca de `quality-guard.test.ts` con su justificación. |
| **Previsibilidad temporal** | ⚠️ Parcial | Las pruebas de latencia (`challenger-stress`) dependen de la carga de la máquina. |
