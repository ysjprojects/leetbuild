import {type FC, memo} from 'react';

import {useTheme} from '@/lib/theme';

/** Header button: shows the theme it switches to (a sun by night, a moon by day). */
const ThemeToggle: FC = memo(() => {
  const [theme, toggle] = useTheme();
  const label = theme === 'light' ? 'switch to dark mode' : 'switch to light mode';
  return (
    <button
      aria-label={label}
      className="border-ink-600 bg-ink-800 text-ink-200 hover:border-iris-400/60 hover:text-ink-50 rounded-full border p-1.5 transition"
      onClick={toggle}
      title={label}
      type="button">
      <svg
        aria-hidden
        fill="none"
        height={14}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        viewBox="0 0 24 24"
        width={14}>
        {theme === 'light' ? (
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        ) : (
          <>
            <circle cx={12} cy={12} r={4} />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </>
        )}
      </svg>
    </button>
  );
});
ThemeToggle.displayName = 'ThemeToggle';

export default ThemeToggle;
