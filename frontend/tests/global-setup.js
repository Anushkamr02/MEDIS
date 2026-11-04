import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Start Node directly so Windows teardown does not depend on shell taskkill. */
export default async function setup() {
  const url = 'http://127.0.0.1:5180';
  if (await fetch(url).then(() => true, () => false)) {
    throw new Error('Port 5180 is already in use. Stop that server before running the isolated UI tests.');
  }
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5180', '--strictPort'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://medis-test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'synthetic-test-key',
      VITE_API_URL: 'http://127.0.0.1:5181',
    },
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  const deadline = Date.now() + 15000;
  try {
    while (!await fetch(url).then((response) => response.ok, () => false)) {
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Test server failed to start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    server.kill();
    throw error;
  }
  return async () => {
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  };
}
