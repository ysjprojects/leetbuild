/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,scss}'],
  theme: {
    extend: {
      colors: {
        plum: {
          950: '#0d0517',
          900: '#150826',
          800: '#1f0d38',
          700: '#2b144d',
          600: '#3a1d68',
          500: '#4f2a8c',
          400: '#7a4fc7',
          300: '#a78bfa',
          200: '#d6c6f5',
        },
        candy: {
          200: '#ffd4ee',
          300: '#ffb0dc',
          400: '#ff7ac8',
          500: '#ff3fa6',
          600: '#e6208c',
          700: '#b8146d',
        },
        cream: '#fbf6ff',
      },
      fontFamily: {
        code: ['var(--font-code)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      screens: {
        touch: {raw: 'only screen and (pointer: coarse)'},
      },
    },
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/typography')],
};
