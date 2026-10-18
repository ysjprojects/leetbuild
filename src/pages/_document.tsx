import {Head, Html, Main, NextScript} from 'next/document';

import {THEME_BOOT_SCRIPT} from '@/lib/theme';
import {night} from '@/styles/palette';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta content="dark light" name="color-scheme" />
        <meta content={night.ink[900]} name="theme-color" />
        {/* The rising-steps mark: SVG where supported, PNG sizes and the .ico elsewhere, the touch icon for iOS. */}
        <link href="/leetbuild-logo.svg" rel="icon" type="image/svg+xml" />
        <link href="/favicon-32.png" rel="icon" sizes="32x32" type="image/png" />
        <link href="/favicon-16.png" rel="icon" sizes="16x16" type="image/png" />
        <link href="/favicon.ico" rel="shortcut icon" />
        <link href="/apple-touch-icon-180.png" rel="apple-touch-icon" sizes="180x180" />
        <link href="/site.webmanifest" rel="manifest" />
        {/* Picks Night or Day before the first paint: a saved choice, else the OS preference (src/lib/theme.ts). */}
        <script dangerouslySetInnerHTML={{__html: THEME_BOOT_SCRIPT}} />
        {/* Google Translate rewrites the DOM under React's feet: https://github.com/facebook/react/issues/11538 */}
        <meta content="notranslate" name="google" />
      </Head>
      <body className="bg-ink-900 text-ink-100">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
