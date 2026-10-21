/** @type {import('tailwindcss').Config} */
//
// Sistema de diseño de HydraCut Studio (ola U0).
// La verdad visual vive en `DESIGN.md`: este fichero es su traducción a
// clases de Tailwind. Ningún color fuera de este ramp puede aparecer en el
// chrome de la app.
//
// Nombres de clase que deben usar las olas siguientes:
// - Superficies: `bg-app` · `bg-panel` · `bg-raised` · `bg-overlay` ·
//   `border-border-subtle` · `border-border`
// - Texto: `text-text-1` · `text-text-2` · `text-text-3`
// - Acento: `text-accent` · `bg-accent` · `bg-accent-fill` ·
//   `bg-accent-soft` · `border-accent` · `ring-accent`
// - Semánticos: `text-danger` · `text-warning` · `text-success` (y `bg-*` /
//   `border-*` con el mismo nombre)
// - Tintes de clip: `bg-clip-video` · `bg-clip-audio` · `bg-clip-text` ·
//   `bg-clip-fx` (relleno suave + texto claro, nunca neón)
// - Tipo: `text-caption` · `text-body-sm` · `text-body` · `text-body-lg` ·
//   `text-title` · `text-timecode` (esta última siempre con `font-mono`)
//
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Superficies planas, apiladas por luminosidad (nunca negro puro:
        // el negro puro se come los negros del vídeo).
        app: '#0D1117',
        panel: '#161B22',
        raised: '#1F242E',
        overlay: '#262D38',
        border: {
          subtle: '#21262D',
          DEFAULT: '#30363D',
        },
        // Texto en 3 pasos (contraste ≥ 4.5:1 sobre panel y raised,
        // medido: text-3/panel 5.62, text-3/raised 5.06).
        text: {
          1: '#F0F3F6',
          2: '#9AA4B2',
          3: '#8B949E',
        },
        // Un solo acento frío, con un único significado. El relleno es lo
        // bastante oscuro para que el blanco alcance 4.5:1 (medido: 5.38) sin
        // dejar de leerse cian: es el único acento de la app.
        accent: {
          DEFAULT: '#22D3EE',
          fill: '#06748F',
          soft: 'rgba(34,211,238,.12)',
        },
        // Semánticos: solo cuando significan algo.
        danger: '#F85149',
        warning: '#D29922',
        success: '#3FB950',
        // Tintes de clip (el azul SOLO como tinte de clip de vídeo,
        // nunca como color de interfaz).
        clip: {
          video: '#1F6FEB',
          audio: '#238636',
          text: '#8957E5',
          fx: '#9E6A03',
        },
        // Alias de migración: cientos de usos de `dark-*` en los
        // componentes existentes. Cada clave apunta al token nuevo más
        // cercano para que la app no se rompa a mitad de la migración.
        // Las olas U1–U7 los irán sustituyendo por los nombres nuevos.
        dark: {
          950: '#0D1117', // = app
          900: '#161B22', // = panel
          850: '#161B22', // = panel
          800: '#1F242E', // = raised
          750: '#262D38', // = overlay
          700: '#30363D', // = border
          600: '#30363D', // = border
          500: '#8B949E', // = text-3
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      // Escala tipográfica de DESIGN.md. `caption` siempre en mayúsculas;
      // `timecode` siempre monoespaciada + tabular (ver `.tabular`).
      fontSize: {
        caption: ['11px', { lineHeight: '16px', fontWeight: '500', letterSpacing: '0.04em' }],
        'body-sm': ['12px', { lineHeight: '18px', fontWeight: '400' }],
        body: ['13px', { lineHeight: '20px', fontWeight: '400' }],
        'body-lg': ['14px', { lineHeight: '22px', fontWeight: '400' }],
        title: ['15px', { lineHeight: '22px', fontWeight: '600' }],
        timecode: ['12px', { lineHeight: '16px', fontWeight: '500' }],
      },
      // Escala de espaciado 4pt de DESIGN.md (2·4·8·12·16·24·32): coincide
      // con los pasos por defecto de Tailwind (0.5·1·2·3·4·6·8), así que no
      // hay nada que añadir; se documenta aquí para fijarla.
      spacing: {},
      // Un radio por clase de componente. Máximo 12 px: `rounded-2xl` y
      // `rounded-3xl` se limitan a 12 para que no puedan usarse por error.
      // `rounded-full` se conserva SOLO para los toggles tipo pill.
      borderRadius: {
        none: '0px',
        sm: '4px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '12px',
        '3xl': '12px',
        full: '9999px',
      },
      // Exactamente UNA sombra de overlay. Todas las variantes se igualan
      // al mismo valor neutro para que una sombra de color sea imposible
      // (`shadow-blue-500/40` etc. no tienen de dónde alimentarse: la
      // paleta ya no expone ninguna escala decorativa).
      boxShadow: {
        sm: '0 8px 24px rgba(0,0,0,.5)',
        DEFAULT: '0 8px 24px rgba(0,0,0,.5)',
        md: '0 8px 24px rgba(0,0,0,.5)',
        lg: '0 8px 24px rgba(0,0,0,.5)',
        xl: '0 8px 24px rgba(0,0,0,.5)',
        '2xl': '0 8px 24px rgba(0,0,0,.5)',
        inner: '0 8px 24px rgba(0,0,0,.5)',
        none: 'none',
        overlay: '0 8px 24px rgba(0,0,0,.5)',
      },
      // Presupuesto de movimiento: 150 ms de feedback de UI, nada más.
      // Las duraciones largas se desaconsejan (ver DESIGN.md § Movimiento).
      transitionDuration: {
        DEFAULT: '150ms',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        scaleUp: {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(24px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 0.18s ease-out both',
        scaleUp: 'scaleUp 0.16s ease-out both',
        slideUp: 'slideUp 0.22s ease-out both',
      },
    },
  },
  plugins: [],
}
