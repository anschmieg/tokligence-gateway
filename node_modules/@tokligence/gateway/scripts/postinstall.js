#!/usr/bin/env node

const BinaryManager = require('../lib/binary');

async function postInstall() {
  // Allow skipping binary download
  if (process.env.SKIP_BINARY_DOWNLOAD === 'true') {
    console.log('\n⏭️  Skipping binary download (SKIP_BINARY_DOWNLOAD=true)\n');
    return;
  }

  console.log('\n📦 Tokligence Gateway - Post Install\n');

  const manager = new BinaryManager();

  try {
    await manager.install();
  } catch (error) {
    console.error('\n❌ Installation failed:', error.message);

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
      console.error('\n⚠️  Network timeout - please try again or check your connection');
    }

    console.error('\nYou can try:');
    console.error('1. Run: npm install -g @tokligence/gateway (retry)');
    console.error('2. Or skip download: SKIP_BINARY_DOWNLOAD=true npm install -g @tokligence/gateway');
    console.error('3. Then manually download from: https://github.com/tokligence/tokligence-gateway/releases');
    console.error('4. Check your internet connection or firewall settings');

    // Don't fail npm install completely
    process.exit(0);
  }
}

// Only run if this is the main module
if (require.main === module) {
  postInstall();
}