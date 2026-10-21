# Primitivas UI (ola U0)

Familia única de componentes del sistema de diseño. Reglas globales: solo
tokens de `DESIGN.md` (cero hex en este directorio), radio máximo 12 px,
sin gradientes, sin desenfoques en paneles, sin sombras de color, todo en español
y todo operable por teclado con foco visible.

| Componente | Props clave | La regla que importa |
|---|---|---|
| `Button` | `variant: ghost\|secondary\|primary\|danger`, `size: sm(28)\|md(32)\|lg(36)`, `icon`, `loading`; reenvía `ref` | Sin gradientes ni brillos; radio 4; `icon` sin hijos exige `aria-label` en el uso |
| `IconButton` | `aria-label` (obligatorio), `title` (tooltip nativo), `size: sm\|md` (28/32), `active` | Un icono solo nunca se explica: siempre `aria-label` + `title` |
| `SegmentedControl` | `options` (1–4), `value`, `onChange`, `ariaLabel`, `name` | Sustituye a los grupos de botones llenos; la activa es `accent-soft` + `text-accent`, nunca relleno sólido |
| `Slider` | `label`, `value`, `min`, `max`, `step`, `unit`, `onChange`, `testid`, `ariaLabel`, `title` | Deslizador + número editable + unidad editan el MISMO valor; `aria-valuetext` con unidad; `testid` nombra al deslizador y `${testid}-numero` al campo |
| `Toggle` | `pressed`, `onChange`, `label` | Único `rounded-full` legítimo del sistema (pastilla diminuta); activo persistente `accent-soft` + acento |
| `Checkbox` | `checked`, `onChange`, `label` | Caja de 16 px, acento al marcar, nada fuera del token |
| `Select` / `Input` | Props nativas; reenvían `ref` | 32 px, `bg-raised`, borde 1 px, foco en acento |
| `Panel` | `caption`, `actions`, `children` | `bg-panel` + `border-b border-subtle`; cabecera `caption` |
| `Section` | `titulo`, `abiertaPorDefecto`, `alRestablecer` | Colapsable con `aria-expanded`; el reset es por sección |
| `Badge` | `variant: neutral\|accent\|danger\|warning\|success` | 20 px; nunca decorativo de estado rutinario |
| `Tooltip` | `content`, `delay` (400 ms), `side` | En portal; también con foco (teclado); `Esc` lo oculta |
| `Toast` / `ToastHost` / `useToasts` | `toast: { titulo, detalle?, tono: info\|error\|success }` | Esquina inferior derecha, auto-descarte ~5 s, semánticos reales; `push` también anuncia por la región viva |
| `Dialog` | `titulo`, `descripcion?`, `acciones?`, `onCerrar`, `ancho?` (440) | Máx. 560 px de alto, SIN scroll interno, `Esc`, trampa + restauración de foco, telón `bg-black/60` |
| `Menu` / `MenuItem` / `MenuSeparador` | `ancla` (ref), `abierto`, `onCerrar`, `ariaLabel` | En portal, `overlay`, sombra única; clic-fuera + `Esc`; flechas/Inicio/Fin |
| `Field` | `etiqueta`, `pista?`, `htmlFor?`, `requerido?` | La etiqueta siempre nombra al control; la pista da unidades/formato |

## Clases de tokens (copiar de aquí, no inventar)

Superficies: `bg-app` `bg-panel` `bg-raised` `bg-overlay`
`border-border-subtle` `border-border` · Texto: `text-text-1` `text-text-2`
`text-text-3` · Acento: `text-accent` `bg-accent` `bg-accent-fill`
`bg-accent-soft` `border-accent` `ring-accent` · Semánticos: `text-danger`
`text-warning` `text-success` (`bg-*`/`border-*` igual) · Clips:
`bg-clip-video` `bg-clip-audio` `bg-clip-text` `bg-clip-fx` · Tipo:
`text-caption` `text-body-sm` `text-body` `text-body-lg` `text-title`
`text-timecode` (con `font-mono` + `.tabular`).
