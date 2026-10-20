import { useState, type ChangeEvent } from 'react';

export interface SliderProps {
  /** Etiqueta visible a la izquierda (en español). */
  label: string;
  /** Valor actual. */
  value: number;
  /** Mínimo / máximo del rango. */
  min: number;
  max: number;
  /** Paso del deslizador y del campo. Por defecto 1. */
  step?: number;
  /** Unidad visible tras el número (px, %, dB, s…). */
  unit?: string;
  /** Cambio de valor (ya limitado al rango). */
  onChange: (value: number) => void;
  /** Deshabilita el deslizador y el campo. */
  disabled?: boolean;
}

/** Limita el valor al rango [min, max]. */
function clampSlider(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Deslizador + campo numérico editable + unidad, con etiqueta a la izquierda
 * y valor a la derecha. El `<input type="range">` nativo da el teclado
 * (flechas) y el `aria-valuetext` anuncia «valor + unidad».
 * Regla: el deslizador y el campo editan el MISMO valor, siempre limitado.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  disabled = false,
}: SliderProps) {
  // El campo muestra texto libre mientras se edita; solo se confirma al salir.
  const [texto, setTexto] = useState<string | null>(null);

  const confirmarTexto = () => {
    if (texto === null) return;
    const numero = Number(texto.replace(',', '.'));
    onChange(clampSlider(numero, min, max));
    setTexto(null);
  };

  const alCambiarRango = (evento: ChangeEvent<HTMLInputElement>) => {
    onChange(clampSlider(Number(evento.target.value), min, max));
  };

  const idCampo = `slider-${label}`;
  const textoValor = unit ? `${value} ${unit}` : `${value}`;

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={idCampo}
        className="flex-1 truncate text-body-sm text-text-2 select-none"
      >
        {label}
      </label>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={textoValor}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={alCambiarRango}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span className="inline-flex h-8 items-center gap-1 rounded border border-border bg-raised px-1.5 focus-within:border-accent">
        <input
          id={idCampo}
          type="text"
          inputMode="decimal"
          aria-label={`${label} (valor numérico)`}
          value={texto ?? String(value)}
          disabled={disabled}
          onChange={(evento) => setTexto(evento.target.value)}
          onBlur={confirmarTexto}
          onKeyDown={(evento) => {
            if (evento.key === 'Enter') (evento.target as HTMLInputElement).blur();
          }}
          className="tabular w-12 bg-transparent text-right font-mono text-timecode text-text-1 placeholder:text-text-3 focus:outline-none disabled:opacity-40"
        />
        {unit && (
          <span aria-hidden="true" className="text-body-sm text-text-3 select-none">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}
