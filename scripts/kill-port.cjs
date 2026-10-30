#!/usr/bin/env node
'use strict';

const net = require('net');
const { execSync } = require('child_process');
const port = Number(process.argv[2]);

if (!port) process.exit(0);

try {
  if (process.platform === 'win32') {
    killWindowsListeners(port);
  } else {
    execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
  }
} catch {}

const probe = net.createServer();
probe.listen(port, '::', () => {
  probe.close();
  process.exit(0);
});

probe.on('error', () => process.exit(0));

function killWindowsListeners(targetPort) {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();

  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== 'TCP') continue;

    const localAddress = parts[1];
    const state = parts[3];
    const pid = parts[4];

    if (state !== 'LISTENING') continue;
    if (!localAddress.endsWith(`:${targetPort}`)) continue;
    if (pid && pid !== '0') pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } catch {}
  }
}
