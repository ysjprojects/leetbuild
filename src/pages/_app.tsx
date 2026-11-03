import '@/styles/globals.scss';

import type {AppProps} from 'next/app';
import localFont from 'next/font/local';
import {type FC, memo} from 'react';

// Sora and JetBrains Mono (SIL OFL 1.1, licences beside the files): the latin subset of the variable
// fonts Google Fonts serves, self-hosted so that building the site never depends on fetching them.
const sora = localFont({src: '../fonts/Sora-latin.woff2', weight: '400 800', display: 'swap'});
const mono = localFont({
  src: '../fonts/JetBrainsMono-latin.woff2',
  weight: '400 600',
  variable: '--font-code',
  display: 'swap',
});

const App: FC<AppProps> = memo(({Component, pageProps}) => (
  <div className={`${sora.className} ${mono.variable}`}>
    <Component {...pageProps} />
  </div>
));
App.displayName = 'App';

export default App;
