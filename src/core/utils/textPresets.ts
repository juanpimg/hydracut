import { TextStyle } from '../../types/project';

/**
 * Plantillas de títulos (Feature A).
 *
 * Módulo puro (sin React ni DOM): las definiciones de los estilos curados,
 * la lista de tipografías disponibles y el helper para aplicar una plantilla
 * al `textStyle` de un clip.
 *
 * La lista de fuentes es la MISMA que ofrece el Inspector y la que el
 * `Compositor` sabe dibujar (`ctx.font = "<weight> <size>px <family>"` en
 * `src/core/engine/Compositor.ts::drawTextToCanvas`): el canvas acepta
 * cualquier familia instalada en el sistema, y estas 6 son las que la app
 * ofrece en el desplegable de tipografía.
 */
export interface TextFontOption {
  label: string;
  value: string;
}

export const TEXT_FONTS: ReadonlyArray<TextFontOption> = [
  { label: 'Inter (Sans-serif)', value: 'Inter, sans-serif' },
  { label: 'Montserrat (Display Bold)', value: 'Montserrat, sans-serif' },
  { label: 'Bebas Neue (Condensed)', value: '"Bebas Neue", sans-serif' },
  { label: 'Oswald (Condensed Display)', value: 'Oswald, sans-serif' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono, monospace' },
  { label: 'Georgia (Serif)', value: 'Georgia, serif' },
];

/** Estilo por defecto de un clip de texto nuevo (el histórico de `addTextClip`). */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 48,
  color: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
  fontFamily: 'Inter, sans-serif',
  textAlign: 'center',
  fontWeight: 'bold',
  padding: 16,
  borderRadius: 8,
};

/**
 * Una plantilla de título curada: un estilo COMPLETO y coherente
 * (tipografía, peso, tamaño, color, alineación, caja de fondo y contorno).
 *
 * Nota: `TextStyle` no tiene campos de sombra ni de interletreado, así que el
 * relieve lo aporta el contorno (`strokeColor` / `strokeWidth`) que el
 * `Compositor` ya dibuja alrededor de cada glifo.
 */
export interface TextPreset {
  id: string;
  /** Etiqueta en español mostrada en el Inspector. */
  label: string;
  /** Pista en español (tamaño y uso sugerido). */
  hint: string;
  style: TextStyle;
}

export const TEXT_PRESETS: ReadonlyArray<TextPreset> = [
  {
    id: 'titulo-limpio',
    label: 'Título limpio',
    hint: 'Titular neutro sobre caja oscura · 56 px',
    style: {
      fontSize: 56,
      color: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      fontWeight: 'bold',
      padding: 16,
      borderRadius: 8,
      strokeColor: 'rgba(0, 0, 0, 0.75)',
      strokeWidth: 4,
    },
  },
  {
    id: 'subtitulo',
    label: 'Subtítulo',
    hint: 'Texto de apoyo discreto bajo el titular · 28 px',
    style: {
      fontSize: 28,
      color: '#f1f5f9',
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      fontWeight: 'normal',
      padding: 10,
      borderRadius: 6,
      strokeColor: 'rgba(0, 0, 0, 0.75)',
      strokeWidth: 3,
    },
  },
  {
    id: 'cinta-cine',
    label: 'Cinta de cine',
    hint: 'Cartela amarilla sobre negro, condensed · 64 px',
    style: {
      fontSize: 64,
      color: '#facc15',
      backgroundColor: '#000000',
      fontFamily: '"Bebas Neue", sans-serif',
      textAlign: 'center',
      fontWeight: 'normal',
      padding: 12,
      borderRadius: 0,
      strokeColor: 'rgba(0, 0, 0, 0.9)',
      strokeWidth: 6,
      highlightColor: '#facc15',
    },
  },
  {
    id: 'neon',
    label: 'Neón',
    hint: 'Cian luminoso sin caja, para intros · 60 px',
    style: {
      fontSize: 60,
      color: '#67e8f9',
      backgroundColor: 'transparent',
      fontFamily: 'Montserrat, sans-serif',
      textAlign: 'center',
      fontWeight: '800',
      padding: 16,
      borderRadius: 8,
      strokeColor: '#0e7490',
      strokeWidth: 2,
      highlightColor: '#f472b6',
    },
  },
  {
    id: 'marcador',
    label: 'Marcador',
    hint: 'Tinta oscura sobre resaltador amarillo · 44 px',
    style: {
      fontSize: 44,
      color: '#111827',
      backgroundColor: '#facc15',
      fontFamily: 'Montserrat, sans-serif',
      textAlign: 'center',
      fontWeight: '900',
      padding: 12,
      borderRadius: 4,
      strokeColor: 'rgba(0, 0, 0, 0)',
      strokeWidth: 0,
      highlightColor: '#111827',
    },
  },
  {
    id: 'minimalista',
    label: 'Minimalista',
    hint: 'Blanco fino sin caja ni contorno · 40 px',
    style: {
      fontSize: 40,
      color: '#ffffff',
      backgroundColor: 'transparent',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      fontWeight: '600',
      padding: 8,
      borderRadius: 0,
      strokeColor: 'rgba(0, 0, 0, 0)',
      strokeWidth: 0,
    },
  },
];

/** Plantilla por id (`undefined` si no existe). */
export function getTextPreset(id: string): TextPreset | undefined {
  return TEXT_PRESETS.find((preset) => preset.id === id);
}

/**
 * Aplica una plantilla al estilo actual de un clip.
 *
 * FUSIONA (`{...actual, ...plantilla}`), no sustituye: el texto del clip no se
 * toca (esta función ni siquiera recibe el texto) y las claves que la
 * plantilla no define (p. ej. `animationPreset` o `highlightColor` ajustados a
 * mano) se conservan. Acepta el id de la plantilla o su estilo directamente.
 *
 * Lanza un `Error` si el id no existe (el llamador decide cómo informar).
 */
export function applyTextPreset(
  current: TextStyle | undefined,
  preset: string | TextStyle
): TextStyle {
  const style: TextStyle | undefined =
    typeof preset === 'string' ? getTextPreset(preset)?.style : preset;
  if (!style) {
    throw new Error(`Plantilla de texto desconocida: "${preset}"`);
  }
  return { ...(current ?? DEFAULT_TEXT_STYLE), ...style };
}

/**
 * Plantilla que coincide EXACTAMENTE con el estilo actual (`null` si el
 * usuario lo personalizó después de aplicarla).
 *
 * Solo compara las claves que la plantilla define: los ajustes manuales de
 * otras claves (p. ej. la animación de letras) no desmarcan la plantilla.
 */
export function matchTextPreset(current: TextStyle | undefined): string | null {
  if (!current) return null;
  for (const preset of TEXT_PRESETS) {
    const keys = Object.keys(preset.style) as Array<keyof TextStyle>;
    if (keys.every((key) => current[key] === preset.style[key])) return preset.id;
  }
  return null;
}
