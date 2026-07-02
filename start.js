#!/usr/bin/env node
// Reads port from openclaw-office.config.json and starts Next.js
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

let port = 4200;
let host = process.env.HOST || process.env.HOSTNAME || '127.0.0.1';

// Read from config
try {
  if (existsSync('openclaw-office.config.json')) {
    const config = JSON.parse(readFileSync('openclaw-office.config.json', 'utf8'));
    port = config.deployment?.port || config.port || 4200;
  }
} catch {}

// Env override still works
if (process.env.PORT) port = process.env.PORT;

console.log(`Starting OpenClaw Office on ${host}:${port}...`);

// If standalone build exists (Docker/production), use it directly
const standalonePath = '.next/standalone/server.js';
if (existsSync(standalonePath)) {
  process.env.PORT = String(port);
  process.env.HOSTNAME = host;
  execSync(`node ${standalonePath}`, { stdio: 'inherit', env: { ...process.env, PORT: String(port), HOSTNAME: host } });
} else {
  execSync(`npx next start -p ${port} -H ${host}`, { stdio: 'inherit' });
}
