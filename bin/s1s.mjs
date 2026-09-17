#!/usr/bin/env node
// Load an optional local .env without copying secrets into arguments or logs.
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await import('../src/cli.ts');
