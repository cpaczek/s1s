// Load .env with `node --env-file=.env scripts/set-demo-secret.mjs`.
// Send the key over stdin, never in command arguments, files, or console output.
import { spawn } from 'node:child_process';
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required');
const child = spawn('pnpm', ['exec', 'wrangler', 'secret', 'put', 'TYPESAFE_API_KEY'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(process.env.TYPESAFE_API_KEY);
child.on('error', () => { console.error('Unable to start Wrangler'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
