/**
 * Formateadores numéricos compartidos de la UI (auditoría audit2 M7/M8).
 *
 * Regla de copy nº7: coma decimal y un espacio antes de la unidad
 * (`0,8 s`, `1,5 KB`, `6,4 kbps`). Un solo módulo para que el diálogo de
 * exportación, la tarjeta de medios y el inspector no diverjan: el mismo
 * número se lee igual en las tres superficies.
 */

/** Dígitos con coma decimal española (`0.8` → `0,8`). */
function conComa(valor: number, decimales: number): string {
  const seguro = Number.isFinite(valor) ? valor : 0;
  return seguro.toFixed(decimales).replace('.', ',');
}

/**
 * Duración en segundos con unidad (`0,8 s`, `5,0 s`).
 *
 * Para rótulos de la UI (fundidos, resumen de exportación). Los nombres de
 * archivo y los formatos fijados por la suite de navegador siguen usando su
 * propio formato de máquina.
 */
export function formatearDuracion(segundos: number, decimales = 1): string {
  const valor = Number.isFinite(segundos) && segundos > 0 ? segundos : 0;
  return `${conComa(valor, decimales)} s`;
}

/**
 * Tamaño en bytes en formato legible (`1,5 KB`, `4,8 MB`).
 *
 * Misma regla que el almacenamiento del proyecto: `0 B` para valores no
 * finitos o no positivos.
 */
export function formatearBytes(bytes: number): string {
  const valor = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (valor < 1024) return `${Math.round(valor)} B`;
  const unidades = ['KB', 'MB', 'GB', 'TB'];
  let escalado = valor / 1024;
  let unidad = 0;
  while (escalado >= 1024 && unidad < unidades.length - 1) {
    escalado /= 1024;
    unidad++;
  }
  const redondeado =
    escalado >= 100 ? String(Math.round(escalado)) : conComa(escalado, 1);
  return `${redondeado} ${unidades[unidad]}`;
}

/**
 * Bitrate efectivo en bits por segundo (`800 bps`, `6,4 kbps`, `6,40 Mbps`).
 *
 * Se calcula con el tamaño real del archivo producido, no con una estimación.
 */
export function formatearBitrate(bytes: number, duracionSegundos: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'no disponible';
  if (!Number.isFinite(duracionSegundos) || duracionSegundos <= 0) return 'no disponible';
  const bps = (bytes * 8) / duracionSegundos;
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${conComa(bps / 1000, 1)} kbps`;
  return `${conComa(bps / 1_000_000, 2)} Mbps`;
}
