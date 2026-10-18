/**
 * TypeScript support modules of the edge gateway. The Python course reads `cert.pem` / `key.pem`
 * from disk; the TypeScript runtime has no file system, so the deploy's TLS material is a provided
 * module the listener imports (`import {cert, key} from 'gateway/tls'`).
 */
export const supportModulesTs: Record<string, string> = {
  'gateway/tls.ts': `/**
 * The TLS material the deploy mounts for the listener (provided): the contents of cert.pem and
 * key.pem, a self-signed P-256 certificate for CN=gateway. Pass them to Fastify's \`https\` option.
 */
export const cert = \`-----BEGIN CERTIFICATE-----
MIIBeTCCAR+gAwIBAgIUWt3X/LC5XYTrr5QjZKOHbV3iV9EwCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHZ2F0ZXdheTAeFw0yNjEwMTgwMDE1MjFaFw0zNjEwMTUwMDE1
MjFaMBIxEDAOBgNVBAMMB2dhdGV3YXkwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAT+nvwr/PcTgo6cabnW8tGey3YpGDL7AzkZuJT4u4plkrx+nup6c4vwY7MnmS+v
6YIm+6yvmHh2U8tQv+oFK91Vo1MwUTAdBgNVHQ4EFgQUUJCAv3HuRzcYHUnohb7B
mLcKQVEwHwYDVR0jBBgwFoAUUJCAv3HuRzcYHUnohb7BmLcKQVEwDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiB6UcGknb0NTWs0Pash9qg8v78YrByn
GLH7RMg/ACsDkgIhAJqW7vYxGSwzO+v/QeLO+h055WbYPPrbsFcnq4m8awDu
-----END CERTIFICATE-----
\`;

export const key = \`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYriNVjyDVzMBBgzn
acNetBJCbwkW57LVVpVg4q76VbKhRANCAAT+nvwr/PcTgo6cabnW8tGey3YpGDL7
AzkZuJT4u4plkrx+nup6c4vwY7MnmS+v6YIm+6yvmHh2U8tQv+oFK91V
-----END PRIVATE KEY-----
\`;
`,
};
