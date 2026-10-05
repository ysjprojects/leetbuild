import {Head, Html, Main, NextScript} from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        {/* Google Translate rewrites the DOM under React's feet: https://github.com/facebook/react/issues/11538 */}
        <meta content="notranslate" name="google" />
      </Head>
      <body className="bg-plum-900 text-cream">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
