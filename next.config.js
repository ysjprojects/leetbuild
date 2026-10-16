/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next build` and a second `next dev` write to the same `.next` as a running dev server and
  // corrupt its module cache ("__webpack_modules__[moduleId] is not a function" on reload).
  // Point verification runs elsewhere: `NEXT_DIST_DIR=.next-verify yarn build`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};

module.exports = nextConfig;
