#!/usr/bin/env node

const BinaryManager = require('../lib/binary');

async function preUninstall() {
  console.log('\n🧹 Tokligence Gateway - Cleaning up...\n');

  const manager = new BinaryManager();

  try {
    await manager.uninstall();
  } catch (error) {
    console.error('Warning: Failed to clean up binaries:', error.message);
  }
}

// Only run if this is the main module
if (require.main === module) {
  preUninstall();
}