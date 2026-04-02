#!/usr/bin/env node

/**
 * Documentation Sync Script
 *
 * Syncs documentation from the Go repository to the npm package's knowledge base.
 * Run this during the build process to ensure docs are up-to-date.
 *
 * Usage:
 *   node scripts/sync-docs.js [go-repo-path]
 *
 * If go-repo-path is not provided, it will look for ../tokligence-gateway
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const GO_REPO_PATH = process.argv[2] || path.join(__dirname, '../../tokligence-gateway');
const KNOWLEDGE_DIR = path.join(__dirname, '../lib/knowledge');

/**
 * Calculate MD5 hash of file content
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Get git information from Go repository
 */
function getGitInfo(repoPath) {
  try {
    const commit = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8'
    }).trim();

    const tag = execSync('git describe --tags --abbrev=0', {
      cwd: repoPath,
      encoding: 'utf8'
    }).trim().replace(/^v/, ''); // Remove 'v' prefix if present

    return { commit, version: tag };
  } catch (error) {
    console.warn('⚠️  Failed to get git info:', error.message);
    return { commit: 'unknown', version: 'unknown' };
  }
}

/**
 * Copy documentation files
 */
function syncDocs() {
  console.log('📚 Syncing documentation from Go repository...\n');

  // Check if Go repo exists
  if (!fs.existsSync(GO_REPO_PATH)) {
    console.error(`❌ Go repository not found at: ${GO_REPO_PATH}`);
    console.error('Please provide the correct path as an argument:');
    console.error('  node scripts/sync-docs.js /path/to/tokligence-gateway');
    process.exit(1);
  }

  // Create knowledge directory if it doesn't exist
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }

  // Files to sync (relative to Go repo root)
  //
  // NOTE:
  // The Go repo currently uses UPPER_SNAKE_CASE for several
  // key docs (e.g. QUICK_START.md, USER_GUIDE.md). We sync
  // those directly instead of non‑existent camel‑case files.
  const filesToSync = [
    // Top‑level overview
    'README.md',

    // Core configuration and usage guides
    'docs/QUICK_START.md',
    'docs/USER_GUIDE.md',
    'docs/configuration_guide.md',

    // Prompt Firewall documentation
    'docs/PROMPT_FIREWALL.md',
    'docs/FIREWALL_REDACT_MODE.md',
    'docs/PII_ENTITIES_REFERENCE.md'
  ];

  const syncedFiles = [];
  const fileHashes = {};

  // Copy each file
  for (const file of filesToSync) {
    const sourcePath = path.join(GO_REPO_PATH, file);
    const fileName = path.basename(file);
    const destPath = path.join(KNOWLEDGE_DIR, fileName);

    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      const hash = hashFile(destPath);
      fileHashes[fileName] = hash;
      syncedFiles.push({
        name: fileName,
        source: file,
        hash: hash.substring(0, 8)
      });
      console.log(`✓ Copied ${file} -> ${fileName}`);
    } else {
      console.log(`⚠️  Skipped ${file} (not found)`);
    }
  }

  // Get git information
  const gitInfo = getGitInfo(GO_REPO_PATH);

  // Generate metadata
  const meta = {
    version: gitInfo.version,
    commit: gitInfo.commit.substring(0, 8),
    syncedAt: new Date().toISOString(),
    files: fileHashes,
    links: {
      github: 'https://github.com/tokligence/tokligence-gateway',
      npm: 'https://www.npmjs.com/package/@tokligence/gateway',
      website: 'https://tokligence.ai',
      wiki: 'https://github.com/tokligence/tokligence-gateway/wiki'
    }
  };

  // Write metadata
  const metaPath = path.join(KNOWLEDGE_DIR, '_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log('\n📋 Sync Summary:');
  console.log(`  Version: ${meta.version}`);
  console.log(`  Commit: ${meta.commit}`);
  console.log(`  Files synced: ${syncedFiles.length}`);
  console.log(`  Synced at: ${meta.syncedAt}`);

  console.log('\n✓ Documentation sync completed!\n');

  // Return summary for use in build scripts
  return {
    success: true,
    meta,
    files: syncedFiles
  };
}

// Run if called directly
if (require.main === module) {
  try {
    syncDocs();
  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    process.exit(1);
  }
}

module.exports = { syncDocs };
