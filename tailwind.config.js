/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          950: '#0a0a0c',
          900: '#121316',
          850: '#17181d',
          800: '#1e2026',
          750: '#252830',
          700: '#2e323b',
          600: '#3f4450',
          500: '#5c6375',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
          purple: '#8b5cf6',
          emerald: '#10b981',
          rose: '#f43f5e',
          amber: '#f59e0b',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      }
    },
  },
  plugins: [],
}
