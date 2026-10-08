# 🎬 HydraCut — Web Video Studio

> **100% Client-Side Multitrack Video Editor** impulsado por WebCodecs API, Web Audio API y renderizado en Canvas acelerado por GPU. Cero servidores, cero subida de archivos y máxima privacidad.

![HydraCut Preview](https://img.shields.io/badge/Status-v1.0%20Stable-cyan)
![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-emerald)
![Acceleration](https://img.shields.io/badge/Hardware-WebCodecs%20GPU-blue)
![Zero Cloud](https://img.shields.io/badge/Privacy-Zero%20Uploads-purple)

---

## ⚡ Características Principales

* **🎞️ Timeline Multitrack Fluido:**
  * Pistas de video, superposición Picture-in-Picture (PiP), pistas de audio dedicadas y capas de texto.
  * Snapping magnético inteligente bidireccional (ajuste milimétrico a bordes de clips vecinos y cabezal de reproducción).
  * Recorte dinámico por extremos (*Trim In* / *Trim Out*).
  * Corte instantáneo de clips en la posición del cabezal (tecla `S` o botón de tijera).
  * Zoom anclado al cursor (*Anchor Zoom*) con `Ctrl + Rueda` y ajuste de pantalla (*Fit to Screen*).

* **🌊 Formas de Onda & Miniaturas:**
  * Extracción y dibujo automático de picos de audio (*Audio Waveforms*) en clips sonoros.
  * Tira de fotogramas secuenciales (*Filmstrip*) en clips de video.

* **🎨 Transiciones & Efectos en Tiempo Real:**
  * Fundidos suaves a negro (`fade-black`) y a blanco (`fade-white`).
  * Desplazamiento lateral (`slide-left`) y barrido de cortinilla (`wipe-right`).
  * Control de velocidad de reproducción (0.5x, 1x, 1.5x, 2x).

* **🚀 Exportación Acelerada por Hardware:**
  * Pipeline offline ultra-rápido utilizando `VideoEncoder` y `AudioEncoder` de **WebCodecs API** junto a `mp4-muxer`.
  * Generación de archivo `.mp4` listo para compartir directamente en el disco local sin enviar un solo byte a la nube.

* **💾 Persistencia & Privacidad Total:**
  * Almacenamiento local mediante IndexedDB y soporte para Origin Private File System (OPFS).
  * Exportación e importación de proyectos en formato `.json`.

---

## 🛠️ Tecnologías

* **Frontend:** React 18, TypeScript, Tailwind CSS, Lucide Icons
* **Estado:** Zustand
* **Motor Multimedia:** WebCodecs API, Web Audio API (`AudioContext`), OffscreenCanvas
* **Muxing MP4:** `mp4-muxer`
* **Testing:** Vitest, Puppeteer Core (Google Chrome headless)

---

## 🚀 Instalación y Uso Local

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo
npm run dev

# 3. Compilar para producción
npm run build

# 4. Ejecutar tests unitarios
npm test
```

---

## ☁️ Despliegue en Cloudflare Pages

1. Conecta este repositorio en tu panel de **Cloudflare Pages**.
2. Parámetros de compilación:
   * **Framework preset:** `Vite`
   * **Build command:** `npm run build`
   * **Build output directory:** `dist`
3. ¡Listo! Tu editor se desplegará instantáneamente a nivel global.

---

## 📜 Licencia

MIT © 2026 [HydraApps](https://github.com/juanpimg)
