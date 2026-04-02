#!/usr/bin/env node

const { spawn } = require('child_process');
const BinaryManager = require('../lib/binary');

// This is a direct wrapper for the gatewayd binary
const manager = new BinaryManager();

try {
  const binaryPath = manager.getDaemonBinaryPath();

  // Pass all arguments directly to the binary
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit'
  });

  child.on('error', (err) => {
    console.error('Failed to start gatewayd:', err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
} catch (error) {
  console.error(error.message);
  console.error('\nPlease run: npm install -g @tokligence/gateway');
  process.exit(1);
}