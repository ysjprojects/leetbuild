// Empty stand-in for Node-only modules fengari requires (fs, os, path, child_process, tmp, readline-sync)
// but never reaches in the browser; esbuild aliases them here when bundling the runtime worker.
export default {};
