/**
 * Suscripción del visor al reloj maestro (auditoría T-04).
 *
 * Hasta ahora `src/App.tsx`, `src/main.tsx` y el hecho de que el visor
 * escuche al `masterClock` solo se verificaban GREPeando la fuente: un
 * `PreviewPlayer` que olvidara suscribirse pasaba los 1122 tests en verde.
 *
 * Este fichero conduce el `masterClock` REAL y afirma la consecuencia
 * observable en el camino de producción:
 * - al montar el `PreviewPlayer` REAL, este registra sus listeners de tiempo
 *   y de estado en el reloj (espiado a nivel de API pública);
 * - `masterClock.seek(t)` en pausa actualiza el store a través del listener
 *   del visor (sin la suscripción, el store no se movería);
 * - al desmontar, el visor se da de baja: un `seek()` posterior ya NO toca
 *   el store (sin el cleanup, el listener filtrado seguiría escribiendo);
 * - la raíz de composición queda fijada por comportamiento: `App()` devuelve
 *   el elemento `<MainLayout/>` (si `App` montara otro layout, falla).
 *
 * `main.tsx` no se puede importar en node (ejecuta `createRoot` al cargar),
 * así que su cableado (`createRoot` + `<App/>`) se afirma a nivel de fuente.
 *
 * Lo que esto SÍ prueba: el visor se suscribe/desuscribe al reloj y la raíz
 * monta el layout de escritorio. Lo que NO prueba: que el canvas pinte
 * (eso pertenece a la suite de navegador, con píxeles reales).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterClock } from '../core/engine/MasterClock';
import { useProjectStore } from '../store/useProjectStore';
import { PreviewPlayer } from '../components/player/PreviewPlayer';
import { App } from '../App';
import { MainLayout } from '../components/layout/MainLayout';

const aqui = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* DOM mínimo con canvas (misma forma que las suites de playback)       */
/* ------------------------------------------------------------------ */

function crearDomConCanvas() {
  class Nodo {
    nodeType = 1;
    ownerDocument: unknown = null;
  }
  class Elemento extends Nodo {
    tagName = 'DIV';
    nodeName = 'DIV';
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    childNodes: Nodo[] = [];
    textContent = '';
    setAttribute(nombre: string, valor: string) {
      this.attributes.set(nombre, valor);
    }
    setAttributeNS(_ns: string, nombre: string, valor: string) {
      this.attributes.set(nombre, valor);
    }
    getAttribute(nombre: string) {
      return this.attributes.get(nombre) ?? null;
    }
    removeAttribute(nombre: string) {
      this.attributes.delete(nombre);
    }
    appendChild<T extends Nodo>(hijo: T): T {
      this.childNodes.push(hijo);
      return hijo;
    }
    /** Caja nula: sin motor de layout todo mide 0 (como el canvas). */
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    removeChild<T extends Nodo>(hijo: T): T {
      const i = this.childNodes.indexOf(hijo);
      if (i >= 0) this.childNodes.splice(i, 1);
      return hijo;
    }
    insertBefore<T extends Nodo>(hijo: T): T {
      this.childNodes.push(hijo);
      return hijo;
    }
    addEventListener() {}
    removeEventListener() {}
  }
  class ElementoHTML extends Elemento {}
  class ElementoBoton extends ElementoHTML {}
  class ElementoIFrame extends ElementoHTML {}
  class ElementoCanvas extends ElementoHTML {
    width = 0;
    height = 0;
    /** Sin contexto 2d: `Compositor.renderFrame` sale por la vía nula. */
    getContext() {
      return null;
    }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
  }

  const doc = {
    nodeType: 9,
    createElement(etiqueta: string) {
      let el: ElementoHTML;
      if (etiqueta.toLowerCase() === 'button') el = new ElementoBoton();
      else if (etiqueta.toLowerCase() === 'canvas') el = new ElementoCanvas();
      else el = new ElementoHTML();
      el.tagName = etiqueta.toUpperCase();
      el.nodeName = etiqueta.toUpperCase();
      el.ownerDocument = doc;
      return el;
    },
    createElementNS(_ns: string, etiqueta: string) {
      return doc.createElement(etiqueta);
    },
    createTextNode(texto: string) {
      return { nodeType: 3, nodeValue: texto, ownerDocument: doc };
    },
    createComment(texto: string) {
      return { nodeType: 8, nodeValue: texto, ownerDocument: doc };
    },
    addEventListener() {},
    removeEventListener() {},
    defaultView: null as unknown,
  };

  const ventana = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    Node: Nodo,
    Element: Elemento,
    HTMLElement: ElementoHTML,
    HTMLButtonElement: ElementoBoton,
    // OBLIGATORIA para que React confirme el render en este entorno (medido:
    // sin `HTMLIFrameElement` en `window` el render arranca pero nunca hace
    // commit y los efectos jamás se ejecutan).
    HTMLIFrameElement: ElementoIFrame,
    SVGElement: ElementoHTML,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
  };
  doc.defaultView = ventana;
  return { doc, ventana, Nodo, Elemento, ElementoHTML };
}

type DomFalso = ReturnType<typeof crearDomConCanvas>;

describe('el visor se suscribe al reloj maestro', () => {
  let dom: DomFalso;
  let globalesPrevios: Record<string, unknown>;
  let raiz: ReturnType<typeof ReactDOM.createRoot> | null = null;

  beforeEach(() => {
    dom = crearDomConCanvas();
    globalesPrevios = {};
    for (const clave of ['window', 'document', 'Node', 'Element', 'HTMLElement']) {
      globalesPrevios[clave] = (globalThis as Record<string, unknown>)[clave];
    }
    (globalThis as Record<string, unknown>).window = dom.ventana;
    (globalThis as Record<string, unknown>).document = dom.doc;
    (globalThis as Record<string, unknown>).Node = dom.Nodo;
    (globalThis as Record<string, unknown>).Element = dom.Elemento;
    (globalThis as Record<string, unknown>).HTMLElement = dom.ElementoHTML;

    useProjectStore.getState().resetProject();
    // Estado determinista del reloj a través de la API pública.
    masterClock.pause();
    masterClock.seek(0);
  });

  afterEach(() => {
    if (raiz) {
      raiz.unmount();
      raiz = null;
    }
    for (const [clave, valor] of Object.entries(globalesPrevios)) {
      if (valor === undefined) delete (globalThis as Record<string, unknown>)[clave];
      else (globalThis as Record<string, unknown>)[clave] = valor;
    }
    masterClock.pause();
    masterClock.seek(0);
    vi.restoreAllMocks();
  });

  async function montarVisor() {
    const espiaTiempo = vi.spyOn(masterClock, 'subscribeTime');
    const espiaEstado = vi.spyOn(masterClock, 'subscribeState');
    const contenedor = dom.doc.createElement('div');
    raiz = ReactDOM.createRoot(contenedor as unknown as HTMLElement);
    raiz.render(React.createElement(PreviewPlayer));
    // Sin esta espera, conducir el reloj justo después de montar correría
    // ANTES de que el efecto se suscriba y la consecuencia no se observaría.
    await vi.waitFor(() => {
      expect(espiaTiempo).toHaveBeenCalled();
      expect(espiaEstado).toHaveBeenCalled();
    });
    return { espiaTiempo, espiaEstado };
  }

  it('registra sus listeners de tiempo y de estado al montarse', async () => {
    // Si el visor olvidara suscribirse, `montarVisor` agotaría la espera y
    // este test fallaría sin llegar a afirmar.
    const { espiaTiempo, espiaEstado } = await montarVisor();
    expect(espiaTiempo).toHaveBeenCalledTimes(1);
    expect(espiaEstado).toHaveBeenCalledTimes(1);
  });

  it('conducir el reloj actualiza el store a través del listener del visor', async () => {
    await montarVisor();
    expect(useProjectStore.getState().currentTime).toBe(0);

    // `seek()` notifica a los suscriptores de tiempo por la vía pública; el
    // listener del visor sincroniza el store cuando está en pausa.
    masterClock.seek(4.5);

    await vi.waitFor(() => {
      expect(useProjectStore.getState().currentTime).toBeCloseTo(4.5, 9);
    });
  });

  it('al desmontar se da de baja: el reloj ya no escribe en el store', async () => {
    await montarVisor();
    masterClock.seek(4.5);
    await vi.waitFor(() => {
      expect(useProjectStore.getState().currentTime).toBeCloseTo(4.5, 9);
    });

    raiz!.unmount();
    raiz = null;

    // Sin el cleanup del visor, este `seek()` seguiría escribiendo el store
    // desde el listener filtrado y la aserción fallaría con 2.
    useProjectStore.getState().setCurrentTime(0);
    masterClock.seek(2);

    // La notificación es síncrona (seek → notifyTime → setCurrentTime), sin
    // relojes de por medio: si algo siguiera suscrito, ya habría escrito. Se
    // drenan microtareas (determinista, sin dormir tiempo real) para cazar
    // escrituras diferidas antes de afirmar.
    await Promise.resolve();
    await Promise.resolve();
    expect(useProjectStore.getState().currentTime).toBe(0);
  });
});

describe('raíz de composición', () => {
  it('App monta el layout principal (no otro shell)', () => {
    // `App` es un componente función sin hooks: invocarlo devuelve el
    // elemento que monta, sin necesidad de DOM.
    const elemento = App();
    expect(React.isValidElement(elemento)).toBe(true);
    expect(elemento.type).toBe(MainLayout);
  });

  it('main.tsx arranca la app con createRoot sobre <App/>', () => {
    // `main.tsx` ejecuta el render al importarse y no se puede cargar en
    // node: el cableado se afirma sobre la fuente real.
    const fuente = readFileSync(join(aqui, '..', 'main.tsx'), 'utf8');
    expect(fuente).toContain("import App from './App'");
    expect(fuente).toContain('createRoot');
    expect(fuente).toContain('<App');
  });
});
