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

### 1.1 Estado actual (medido el 2026-10-20)

```bash
$ npm test
 Test Files  37 passed (37)
      Tests  818 passed (818)

$ npm run test:browser
  TOTAL          140 checks  0 FAIL
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
  coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/tests/**', 'dist/**', '**/*.d.ts', ...], thresholds: { lines: 40, branches: 60, functions: 60, statements: 40 } },
}
```

`src/tests/browser/**` está excluido a propósito: son scripts `.mjs` de Node
para el harness de navegador, **no** suites de Vitest.

### 2.2 Suites existentes

| Fichero | Tests | Qué verifica |
|---------|-------|--------------|
| `src/tests/audioEngine-hardening.test.ts` | 11 | Tolerancia a fallos de la Web Audio API, fallback de reloj dual |
| `src/tests/audio-fades.test.ts` | 34 | Fundidos de audio por clip: curvas `linear`/`equalPower`, envolvente, cuantización |
| `src/tests/audio-fades-persistence.test.ts` | 8 | Persistencia de los fundidos (proyecto guardado/recuperado) |
| `src/tests/challenger-stress.test.ts` | 13 | Estrés adversarial de `MasterClock`/`AudioEngine`, latencia de `togglePlay()` |
| `src/tests/challenger-stress-verification.test.ts` | 14 | `MediaSourcePool.syncVideoTime` (histeresis, cooldown, seeks), compositor sin asignaciones, aislamiento de render de `MobileBottomBar` |
| `src/tests/clipboard-export-range.test.ts` | 43 | Portapapeles (copiar/pegar/duplicar), preajustes y rango de exportación |
| `src/tests/clipGestures.test.ts` | 8 | Historial por gesto (drag/trim con un único undo) |
| `src/tests/color-filters.test.ts` | 31 | Filtros de color: normalización, preajustes, paridad preview/export |
| `src/tests/crossfade.test.ts` | 52 | Fundido de cruce: mezcla lineal, marcadores, solape deliberado vs ilegal |
| `src/tests/data-integrity.test.ts` | 22 | Integridad del estado: mediaPool en el historial, clips, pistas bloqueadas |
| `src/tests/engine-correctness.test.ts` | 35 | Corrección del motor: failover de reloj, resync en seek, liberación de recursos |
| `src/tests/engine.test.ts` | 30 | Orden de capas del compositor, jerarquía de pistas, **contrato real del exportador** (dimensiones pares y audio planar `f32-planar`) |
| `src/tests/exporterConfig.test.ts` | 14 | Sonda de encoder, selección de config AVC, traducción de errores |
| `src/tests/export-pipeline.test.ts` | 32 | Pipeline de export: fallback a MediaRecorder, nivel AVC, duración de audio, muxing |
| `src/tests/features.test.ts` | 17 | Waveforms, transiciones, snapping, controles de velocidad |
| `src/tests/keyframes.test.ts` | 48 | Keyframes de transform: orden, interpolación lineal, evaluación |
| `src/tests/keyframes-persistence.test.ts` | 4 | Persistencia de los keyframes (proyecto guardado/recuperado) |
| `src/tests/lifecycle-integration.test.ts` | 22 | Ciclo de vida: liberación de recursos, errores de persistencia, autosave al cerrar |
| `src/tests/master-volume.test.ts` | 13 | Volumen maestro: clamp, persistencia, ruta de `AudioEngine` |
| `src/tests/mobile-parity.test.ts` | 19 | Paridad móvil: ±1 fotograma, volumen maestro, 4×, `fade-white` (guardas de regresión) |
| `src/tests/multi-select.test.ts` | 38 | Multi-selección y acciones en lote (aditiva, rango, goma, un solo undo) |
| `src/tests/perf-storage.test.ts` | 34 | Object URLs, miniaturas, autosave con debounce, escritura atómica del índice |
| `src/tests/playback-acceptance.test.ts` | 24 | Aceptación de reproducción 60 FPS (R1–R5), incl. simulación de 10 minutos y aislamiento de render |
| `src/tests/playback-speed.test.ts` | 25 | Velocidad y pitch: `resolvePlayback`, compensación en cents, preview/export |
| `src/tests/product-features-r1.test.ts` | 29 | Funciones de producto R1 (portapapeles, solapamiento, papelera, ausentes) |
| `src/tests/project-portability.test.ts` | 43 | Portabilidad: backup con medios embebidos (límite 64 MB), importación con reporte |
| `src/tests/projectStorage-hardening.test.ts` | 4 | Endurecimiento de `projectStorage` |
| `src/tests/projectStorage.test.ts` | 18 | Persistencia multi-proyecto (IndexedDB + OPFS) |
| `src/tests/quality-guard.test.ts` | 5 | **Guarda de calidad del propio suite** (ver §5) |
| `src/tests/render-scale.test.ts` | 18 | `computeRenderScale`: el preview se rasteriza a la resolución de pantalla |
| `src/tests/timecode.test.ts` | 7 | Timecode `HH:MM:SS:FF` y etiqueta del rango de exportación |
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

### 2.4 Lint (ESLint)

ESLint 9 con flat config (`eslint.config.js`, en la raíz del paquete):

```bash
npm run lint               # == eslint .  → 0 errores, 2 avisos (2026-10-20)
npx eslint src/core/engine/Compositor.ts   # un fichero
```

Capas activas: `recommended` de `@eslint/js`, `recommended` de
`typescript-eslint` (sin reglas con tipos: rápido a propósito) y
`eslint-plugin-react-hooks` (`rules-of-hooks` como error,
`exhaustive-deps` como aviso).

Dos reglas llevan opciones no estándar, ambas documentadas en
`eslint.config.js`:

- `@typescript-eslint/no-explicit-any` sigue en error para el código de
  producción, pero está en `off` bajo `src/tests/**`: los dobles de test con
  `any` (contextos de canvas falsos, stores falsos, …) son el patrón
  establecido y prohibirlos añadiría docenas de comentarios sin beneficio.
- `no-unused-vars` (base y TS) usa `argsIgnorePattern: '^_'`,
  `varsIgnorePattern: '^_'` e `ignoreRestSiblings: true`: el prefijo `_`
  marca lo intencionadamente no usado y el idioma `const { x, ...rest }`
  queda permitido.

**Ninguna regla está en `off` a nivel global.** Los únicos comentarios
`eslint-disable` que quedan (2, ambos `react-hooks/exhaustive-deps` en
`ClipItem.tsx` y `ClipInspector.tsx`) suprimen avisos reales de efectos
intencionadamente de un solo montaje. Los 39 `eslint-disable` de
`@typescript-eslint/no-explicit-any` que había en `src/tests/` se eliminaron
al quedar cubiertos por la excepción de tests.

Estado: `npm run lint` sale con código 0; quedan 2 avisos
(`react-hooks/exhaustive-deps` en `src/hooks/useIsMobile.ts:67,106`,
dependencias omitidas a propósito en los listeners de resize — no se tocan
para no arriesgar el comportamiento).

El lint ya encontró un bug real: `src/tests/browser/suite-known-issues.mjs`
usaba `waitForAppReady` y `dismissWelcome` sin importarlos (ReferenceError
latente en la ruta de recarga HMR). Se añadió el import que faltaba.

### 2.5 Cobertura

Proveedor `@vitest/coverage-v8` (devDependency instalada):

```bash
npm run test:coverage      # == vitest run --coverage (text + html en ./coverage/)
```

Umbrales (`test.coverage.thresholds` en `vite.config.ts`), fijados con
margen bajo lo medido para informar sin tumbar nunca el build:

| Métrica | Umbral | Medido (2026-10-20) |
|---------|--------|---------------------|
| Líneas | 40 | 50,48 |
| Ramas | 60 | 77,58 |
| Funciones | 60 | 80,31 |
| Sentencias | 40 | 50,48 |

> Las UI sin test de componentes (`src/components/`, `src/hooks`) y el
> fichero solo-de-tipos `src/types/project.ts` lastran el porcentaje de
> líneas: es el número real, no un objetivo. Subir los umbrales solo desde un
> valor medido, nunca desde una conjetura.

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
| `src/tests/browser/suite-features.mjs` | Funciones de producto: portapapeles, color, velocidad, presets/rango, almacenamiento, multi-selección |
| `src/tests/browser/suite-known-issues.mjs` | Defectos conocidos (informativo; con `--strict` fallan) |

### 3.2 Checks por suite (medidos el 2026-10-20)

| Suite | Checks |
|-------|--------|
| `layout` | 92 |
| `playback` | 4 |
| `export` | 8 |
| `known-issues` | 14 |
| `features` | 22 |
| **Total** | **140** |

### 3.2 Ejecutar

```bash
# Todas las suites
npm run test:browser

# Una sola suite
npm run test:browser layout
npm run test:browser playback
npm run test:browser export
npm run test:browser features
npm run test:browser known-issues

# Con el navegador visible
npm run test:browser -- --headed

# Los "defectos conocidos" también hacen fallar la ejecución
npm run test:browser -- --strict
```

Variables de entorno:

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `HYDRA_CHROME_PATH` | (detección automática) | Ruta del binario de Chrome/Chromium. Si está definida, manda siempre; si no, el harness prueba `CHROME_PATH`/`CHROME_BIN`, `/usr/bin/google-chrome-stable`, las ubicaciones habituales de Linux y una búsqueda en el `PATH` (así encuentra el Chrome de `browser-actions/setup-chrome` en CI). Si no hay ningún binario, `launchBrowser()` falla con un mensaje que indica la ruta probada |
| `HYDRA_DEV_HOST` | `127.0.0.1` | Host del servidor de desarrollo |
| `HYDRA_DEV_PORT` | `5199` | Puerto del servidor de desarrollo |
| `HYDRA_BASE_URL` | `http://<host>:<puerto>/` | URL base si el servidor ya está levantado |
| `HYDRA_STRICT` | `0` | Equivale a `--strict` |

> El E2E de navegador **sí forma parte de CI** (job `browser-e2e`, véase §6):
> instala Chrome con `browser-actions/setup-chrome` y ejecuta
> `npm run test:browser`. El harness levanta su propio dev server en el
> puerto 5199 y lo apaga al salir; no necesita TTY interactivo. En local se
> ejecuta igual: `npm run test:browser` reutiliza el dev server si ya está
> levantado.

---

## 4. Mapeo de los 4 niveles conceptuales a la realidad

El plan original de pruebas describía 4 niveles. La implementación real los
cubre así:

| Nivel conceptual | Dónde vive hoy |
|------------------|----------------|
| **Nivel 1 — Cobertura de funcionalidad** (R1–R6) | Suites de Vitest de la capa A: `features`, `audioEngine-hardening`, `engine-correctness`, `ui-a11y`, `timeline`, `exporterConfig`, más la ola de producto (`product-features-r1`, `clipboard-export-range`, `crossfade`, `audio-fades`, `color-filters`, `keyframes`, `playback-speed`, `master-volume`, `multi-select`, `timecode`, `mobile-parity`) |
| **Nivel 2 — Casos límite y de esquina** | `challenger-stress`, `challenger-stress-verification`, `data-integrity`, `timeline-duration`, `perf-storage`, `projectStorage-hardening`, `engine.test.ts` (contrato del exportador), `project-portability` (límite de 64 MB), `keyframes-persistence`, `audio-fades-persistence` |
| **Nivel 3 — Interacciones entre subsistemas** | `lifecycle-integration`, `playback-acceptance`, `export-pipeline`, `engine-correctness` |
| **Nivel 4 — Escenarios reales multi-dispositivo** | Harness de navegador (`src/tests/browser/`): 6 viewports × 2 `devicePixelRatio` (layout: 92 checks), reproducción/persistencia (playback), exportación real en MP4 (export) y funciones de producto en Chrome real (features: 22 checks) |

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

`.github/workflows/ci.yml` ejecuta, en cada `push` y `pull_request`, dos jobs:

```bash
verify:      npm ci → npm run typecheck → npm run lint → npm test → npm run build
browser-e2e: npm ci → setup-chrome → npm run test:browser
```

* Node 20 (`actions/setup-node@v4`), `actions/checkout@v4`.
* El job `browser-e2e` (timeout 20 min) instala Chrome real con
  `browser-actions/setup-chrome@v1`, exporta `HYDRA_CHROME_PATH` con la ruta
  detectada (`which google-chrome-stable || which google-chrome || which
  chromium`), imprime su versión y lanza `npm run test:browser`. No necesita
  el `build` antes: el harness usa el dev server de Vite, no `dist/`.
* El lint corre en `verify`: `npm run lint` debe salir con 0 errores
  (los 2 avisos actuales no fallan el paso).

---

## 7. Huecos conocidos

| Hueco | Estado | Nota |
|-------|--------|------|
| **ESLint / lint** | ✅ Instalado | ESLint 9 + `typescript-eslint` + `eslint-plugin-react-hooks` (flat config en `eslint.config.js`), script `npm run lint`, wired en CI. Véase §2.4. |
| **Cobertura** | ✅ Proveedor instalado | `@vitest/coverage-v8` 2.1.8, script `npm run test:coverage`, umbrales conservadores en `vite.config.ts`. Véase §2.5. No corre en CI (solo bajo demanda). |
| **E2E en CI** | ✅ En el pipeline | Job `browser-e2e` con Chrome real (`browser-actions/setup-chrome`). Véase §6. |
| **Tests de `src/core/utils/thumbnails.ts`** | ⚠️ En lista blanca | Genera DataURLs con Canvas/Image: sin navegador real no hay nada que afirmar. Queda en la lista blanca de `quality-guard.test.ts` con su justificación. |
| **Previsibilidad temporal** | ⚠️ Parcial | Las pruebas de latencia (`challenger-stress`) dependen de la carga de la máquina. |
