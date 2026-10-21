/**
 * Test conductual de `useAnchoredMenu` (auditoría T-03).
 *
 * Hasta ahora solo la geometría pura (`overlayGeometry`) tenía tests: un hook
 * que nunca suscribiera `resize`/`scroll` (o que filtrara sus listeners)
 * pasaba toda la suite en verde.
 *
 * Sin jsdom (el proyecto no lo tiene) el hook REAL se monta con ReactDOM
 * sobre el DOM mínimo ya usado por las suites de playback. La `window` es la
 * del mock establecido —extendida con registro de listeners, tamaño de
 * ventana y disparo manual— porque el scheduler de React solo confirma el
 * render con la forma completa del mock (medido: una ventana mínima deja el
 * render a medias y los efectos nunca se ejecutan).
 *
 * Contrato de ciclo de vida afirmado:
 * - al abrirse calcula la posición con la geometría real,
 * - `resize` y `scroll` la recalculan,
 * - al desmontarse retira AMBOS listeners (misma función y captura; si se
 *   borrara el cleanup del hook, el registro seguiría lleno y el test
 *   agotaría la espera),
 * - cerrado no suscribe nada (control negativo: el registro sí observa).
 *
 * `Escape` y el clic fuera NO son del hook: viven en su consumidor
 * (`MobileHeader`) y se afirman a nivel de fuente para que el contrato quede
 * guardado aunque los eventos sintéticos no existan sin un DOM real (los
 * `addEventListener` del mock son no-op y React no recibe eventos).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import {
  computeAnchoredMenuPosition,
  toAnchorRect,
  type AnchoredMenuPosition,
} from '../components/layout/overlayGeometry';

const aqui = dirname(fileURLToPath(import.meta.url));
const leer = (relativa: string): string => readFileSync(join(aqui, relativa), 'utf8');

/* ------------------------------------------------------------------ */
/* DOM mínimo (misma forma que las suites de playback) + ventana que    */
/* registra sus listeners                                               */
/* ------------------------------------------------------------------ */

interface EntradaOyente {
  tipo: string;
  fn: (ev?: unknown) => void;
  captura: boolean;
}

function crearDomConVentanaRegistrada() {
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

  const doc = {
    nodeType: 9,
    createElement(etiqueta: string) {
      const el =
        etiqueta.toLowerCase() === 'button' ? new ElementoBoton() : new ElementoHTML();
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

  const oyentes: EntradaOyente[] = [];
  const ventana = {
    document: doc,
    addEventListener(tipo: string, fn: (ev?: unknown) => void, captura?: boolean | AddEventListenerOptions) {
      oyentes.push({ tipo, fn, captura: captura === true });
    },
    // Solo retira cuando coincide la MISMA función con la MISMA captura (como
    // el DOM real): si el hook pasara otra referencia, el oyente seguiría
    // registrado y el test lo vería.
    removeEventListener(
      tipo: string,
      fn: (ev?: unknown) => void,
      captura?: boolean | AddEventListenerOptions
    ) {
      const i = oyentes.findIndex(
        (o) => o.tipo === tipo && o.fn === fn && o.captura === (captura === true)
      );
      if (i >= 0) oyentes.splice(i, 1);
    },
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
    oyentes,
    /** Dispara a mano los oyentes de `tipo` (los eventos sintéticos no existen). */
    despachar(tipo: string) {
      for (const o of [...oyentes]) {
        if (o.tipo === tipo) o.fn();
      }
    },
  };
  doc.defaultView = ventana;
  return { doc, ventana, Nodo, Elemento, ElementoHTML };
}

type DomFalso = ReturnType<typeof crearDomConVentanaRegistrada>;

/* ------------------------------------------------------------------ */
/* Sonda: consumidor mínimo del hook real                               */
/* ------------------------------------------------------------------ */

interface Testigo {
  position: AnchoredMenuPosition | null | undefined;
}

const OPCIONES_SONDA = {
  menuWidth: 176,
  menuHeight: 142,
  align: 'end' as const,
  gap: 6,
  padding: 8,
};

function Sonda({
  abierto,
  trigger,
  testigo,
}: {
  abierto: boolean;
  trigger: React.RefObject<HTMLElement>;
  testigo: Testigo;
}) {
  const { position } = useAnchoredMenu(abierto, trigger, OPCIONES_SONDA);
  testigo.position = position;
  return null;
}

type RectFalso = { top: number; left: number; right: number; bottom: number; width: number; height: number };

/** Rect falso del disparador (mutable entre eventos para observar el recálculo). */
function rectFalso(alto: number): RectFalso {
  return { top: alto, left: 200, right: 260, bottom: alto + 36, width: 60, height: 36 };
}

function posicionEsperada(rect: RectFalso, ventana: DomFalso['ventana']): AnchoredMenuPosition {
  return computeAnchoredMenuPosition(
    toAnchorRect(rect),
    { width: OPCIONES_SONDA.menuWidth, height: OPCIONES_SONDA.menuHeight },
    { width: ventana.innerWidth, height: ventana.innerHeight },
    { align: 'end', gap: 6, padding: 8 }
  );
}

describe('useAnchoredMenu · contrato de ciclo de vida', () => {
  let dom: DomFalso;
  let globalesPrevios: Record<string, unknown>;
  let raiz: ReturnType<typeof ReactDOM.createRoot> | null = null;

  beforeEach(() => {
    dom = crearDomConVentanaRegistrada();
    globalesPrevios = {};
    for (const clave of ['window', 'document', 'Node', 'Element', 'HTMLElement']) {
      globalesPrevios[clave] = (globalThis as Record<string, unknown>)[clave];
    }
    (globalThis as Record<string, unknown>).window = dom.ventana;
    (globalThis as Record<string, unknown>).document = dom.doc;
    (globalThis as Record<string, unknown>).Node = dom.Nodo;
    (globalThis as Record<string, unknown>).Element = dom.Elemento;
    (globalThis as Record<string, unknown>).HTMLElement = dom.ElementoHTML;
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
    vi.restoreAllMocks();
  });

  function montar(abierto: boolean, rectInicial: RectFalso) {
    const testigo: Testigo = { position: undefined };
    // Soporte mutable: el hook lee `getBoundingClientRect()` en cada evento,
    // así el test mueve el disparador mutando `soporte.rect`.
    const soporte = { rect: rectInicial };
    const disparador = {
      current: { getBoundingClientRect: () => soporte.rect } as unknown as HTMLElement,
    };
    const contenedor = dom.doc.createElement('div');
    raiz = ReactDOM.createRoot(contenedor as unknown as HTMLElement);
    raiz.render(React.createElement(Sonda, { abierto, trigger: disparador, testigo }));
    return { testigo, soporte };
  }

  it('calcula la posición inicial con la geometría real al abrirse', async () => {
    const rect = rectFalso(100);
    const { testigo } = montar(true, rect);

    await vi.waitFor(() => {
      expect(testigo.position).toEqual(posicionEsperada(rect, dom.ventana));
    });
    expect(testigo.position?.placement).toBe('bottom');
    // El hook se suscribió a ambos eventos mientras está abierto.
    expect(dom.ventana.oyentes.map((o) => o.tipo).sort()).toEqual(['resize', 'scroll']);
  });

  it('recalcula la posición al hacer resize y al hacer scroll', async () => {
    const { testigo, soporte } = montar(true, rectFalso(100));
    await vi.waitFor(() => {
      expect(testigo.position).not.toBeNull();
      expect(testigo.position).not.toBeUndefined();
    });

    // El disparador se mueve abajo: ya no cabe debajo y el menú debe voltear
    // (viewport 900: con `top=750` quedan 100 px debajo < 142 del menú).
    soporte.rect = rectFalso(750);
    dom.ventana.despachar('resize');

    await vi.waitFor(() => {
      expect(testigo.position).toEqual(posicionEsperada(soporte.rect, dom.ventana));
    });
    expect(testigo.position?.placement).toBe('top');

    // El scroll de cualquier ancestro también reposiciona (`capture: true`).
    soporte.rect = rectFalso(100);
    dom.ventana.despachar('scroll');
    await vi.waitFor(() => {
      expect(testigo.position).toEqual(posicionEsperada(soporte.rect, dom.ventana));
    });
    expect(testigo.position?.placement).toBe('bottom');
  });

  it('retira los listeners de resize y scroll al desmontar (sin fugas)', async () => {
    const { testigo } = montar(true, rectFalso(100));
    await vi.waitFor(() => {
      expect(testigo.position).not.toBeNull();
      expect(testigo.position).not.toBeUndefined();
    });
    expect(dom.ventana.oyentes).toHaveLength(2);
    const scroll = dom.ventana.oyentes.find((o) => o.tipo === 'scroll');
    // `capture: true` también caza los scrolls de cualquier ancestro con scroll.
    expect(scroll?.captura).toBe(true);

    raiz!.unmount();
    raiz = null;

    // Si se borrara el cleanup del hook, los oyentes seguirían registrados y
    // esta espera agotaría el tiempo en vez de cumplirse.
    await vi.waitFor(() => {
      expect(dom.ventana.oyentes).toHaveLength(0);
    });
  });

  it('cerrado no suscribe nada y la posición es nula', async () => {
    const { testigo } = montar(false, rectFalso(100));
    // Sin `update()` inicial no hay posición: el menú está cerrado.
    await vi.waitFor(() => {
      expect(testigo.position).toBeNull();
    });
    expect(dom.ventana.oyentes).toHaveLength(0);
  });
});

describe('useAnchoredMenu · cableado a nivel de fuente (contrato que debe fallar si se borra)', () => {
  it('el hook limpia resize y scroll con la misma función que suscribe', () => {
    const fuente = leer('../hooks/useAnchoredMenu.ts');
    expect(fuente).toContain("window.addEventListener('resize', onViewportChange)");
    expect(fuente).toContain("window.addEventListener('scroll', onViewportChange, true)");
    expect(fuente).toContain("window.removeEventListener('resize', onViewportChange)");
    expect(fuente).toContain("window.removeEventListener('scroll', onViewportChange, true)");
  });

  it('MobileHeader (consumidor) cierra el menú con Escape', () => {
    const fuente = leer('../components/mobile/MobileHeader.tsx');
    expect(fuente).toContain("window.addEventListener('keydown', onKey)");
    expect(fuente).toContain("if (e.key === 'Escape')");
    expect(fuente).toContain('closeAspectMenu(true)');
    expect(fuente).toContain("window.removeEventListener('keydown', onKey)");
  });

  it('MobileHeader (consumidor) cierra el menú al pulsar fuera (backdrop)', () => {
    const fuente = leer('../components/mobile/MobileHeader.tsx');
    expect(fuente).toContain('data-testid="mobile-aspect-backdrop"');
    expect(fuente).toContain('closeAspectMenu(false)');
  });
});
