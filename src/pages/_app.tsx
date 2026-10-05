import '@/styles/globals.scss';

import type {AppProps} from 'next/app';
import {type FC, memo} from 'react';

const App: FC<AppProps> = memo(({Component, pageProps}) => <Component {...pageProps} />);
App.displayName = 'App';

export default App;
