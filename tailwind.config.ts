import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import type {Config} from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

import {colors, cssVariables, day, night} from './src/styles/palette';

/** Night on `:root`, Day when the theme hook (src/lib/theme.ts) sets `data-theme="light"`; `color-scheme` keeps native controls and scrollbars in step. */
const themes = plugin(({addBase}) => {
  addBase({
    ':root': {colorScheme: 'dark', ...cssVariables(night)},
    ':root[data-theme="light"]': {colorScheme: 'light', ...cssVariables(day)},
  });
});

export default {
  content: ['./src/**/*.{ts,tsx,scss}'],
  theme: {
    extend: {
      colors,
      fontFamily: {
        code: ['var(--font-code)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      screens: {
        touch: {raw: 'only screen and (pointer: coarse)'},
      },
    },
  },
  plugins: [forms, typography, themes],
} satisfies Config;
