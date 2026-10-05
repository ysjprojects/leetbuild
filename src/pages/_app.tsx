import '@/styles/globals.scss';

import type {AppProps} from 'next/app';
import {JetBrains_Mono, Sora} from 'next/font/google';
import {type FC, memo} from 'react';

const sora = Sora({subsets: ['latin'], weight: ['400', '500', '600', '700', '800']});
const mono = JetBrains_Mono({subsets: ['latin'], variable: '--font-code', weight: ['400', '600']});

const App: FC<AppProps> = memo(({Component, pageProps}) => (
  <div className={`${sora.className} ${mono.variable}`}>
    <Component {...pageProps} />
  </div>
));
App.displayName = 'App';

export default App;
