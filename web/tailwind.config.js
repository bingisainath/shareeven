// /** @type {import('tailwindcss').Config} */
// module.exports = {
//   content: ["./src/**/*.{js,jsx,ts,tsx}"],

//   theme: {
//     extend: {
//       colors : {
//         primary : "#f0abfc",
//         secondary : "#c026d3",
//       }
//     },
//   },
//   plugins: [],
// }


/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Body text; headings and big numbers use the display face
        sans: ['"DM Sans Variable"', '"DM Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['"Manrope Variable"', 'Manrope', '"DM Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Purple-based primary palette
        primary: {
          50: '#f6f4fa',
          100: '#ece8f5',
          200: '#d9d1eb',
          300: '#bcaed9',
          400: '#9a86c3',
          500: '#7b64aa',
          600: '#654e94',
          700: '#543f7d',  // Main primary: a calm, deep purple
          800: '#443468',
          900: '#372a53',
          950: '#231a36',
        },
        // Secondary purple/indigo
        secondary: {
          50: '#f6f4fa',
          100: '#ece8f5',
          200: '#d9d1eb',
          300: '#bcaed9',
          400: '#9a86c3',
          500: '#7b64aa',
          600: '#654e94',
          700: '#543f7d',
          800: '#443468',
          900: '#372a53',
        },
        // Accent rose/pink for expenses
        accent: {
          50: '#fbf3f4',
          100: '#f6e3e6',
          200: '#ecc6cc',
          300: '#dc9ca6',
          400: '#c9707e',
          500: '#b4505f',  // Muted red for money owed and destructive actions
          600: '#9c3f4e',
          700: '#813341',
          800: '#6a2b37',
          900: '#58262f',
        },
        // Success for positive balances
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
        },
        // Warnings (amber): offline banner, receipt warnings, "reduced" tags
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        // Muted slate for backgrounds
        muted: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(#543f7d, #543f7d)',
        'gradient-secondary': 'linear-gradient(#ece8f5, #ece8f5)',
        'gradient-accent': 'linear-gradient(#b4505f, #b4505f)',
        'gradient-success': 'linear-gradient(#15803d, #15803d)',
        'gradient-app': 'linear-gradient(#f6f6f8, #f6f6f8)',
        'gradient-card': 'linear-gradient(#ffffff, #ffffff)',
      },
      boxShadow: {
        'soft': '0 1px 2px rgba(15, 23, 42, 0.06)',
        'card': '0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)',
        'elevated': '0 8px 24px rgba(15, 23, 42, 0.12)',
        'glow': '0 1px 3px rgba(15, 23, 42, 0.08)',
        'glow-accent': '0 1px 3px rgba(15, 23, 42, 0.08)',
      },
      backdropBlur: {
        xs: '2px',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      animation: {
        'slide-in': 'slideIn 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateX(-100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
}