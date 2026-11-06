#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

const compiled = path.resolve(__dirname, '../../../../../../dist/main/main/features/agents/acp/testing/fake-acp-agent.js');
const { startFakeAcpAgent } = require(compiled);

const script = JSON.parse(process.env.FAKE_ACP_SCRIPT || '{"turns":[]}');
const { closed } = startFakeAcpAgent(script, {
  input: Readable.toWeb(process.stdin),
  output: Writable.toWeb(process.stdout),
});

closed.then(() => process.exit(0));
