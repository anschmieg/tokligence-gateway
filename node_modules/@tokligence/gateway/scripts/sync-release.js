#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function getLatestGatewayRelease() {
  console.log('Fetching latest Gateway release...');

  const response = await axios.get(
    'https://api.github.com/repos/tokligence/tokligence-gateway/releases/latest',
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'tokligence-gateway-npm'
      }
    }
  );

  const release = response.data;
  const version = release.tag_name.replace('v', '');

  // Find a binary asset to extract build suffix
  const linuxBinary = release.assets.find(a =>
    a.name.includes('gateway-v') && a.name.includes('linux-amd64')
  );

  let buildSuffix = '';
  if (linuxBinary) {
    const match = linuxBinary.name.match(/gateway-v[\d.]+(.+?)-linux-amd64/);
    if (match) {
      buildSuffix = match[1];
    }
  }

  return {
    version,
    buildSuffix,
    releaseUrl: release.html_url,
    publishedAt: release.published_at
  };
}

async function updatePackageJson(version, buildSuffix) {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const oldVersion = pkg.version;

  pkg.version = version;
  pkg.tokligenceGateway.version = version;
  pkg.tokligenceGateway.buildSuffix = buildSuffix;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`Updated package.json: ${oldVersion} → ${version}`);
  console.log(`Build suffix: ${buildSuffix}`);

  return oldVersion !== version;
}

async function testPackage() {
  console.log('Testing package...');
  execSync('npm test', { stdio: 'inherit' });
}

async function publishToNPM() {
  console.log('Publishing to NPM...');

  try {
    execSync('npm publish --access public', { stdio: 'inherit' });
    console.log('✓ Published to NPM successfully');
  } catch (error) {
    console.error('Failed to publish to NPM:', error.message);
    throw error;
  }
}

async function commitAndPush(version) {
  console.log('Committing changes...');

  execSync('git add package.json', { stdio: 'inherit' });
  execSync(`git commit -m "chore: sync with gateway release v${version}"`, { stdio: 'inherit' });
  execSync('git push', { stdio: 'inherit' });

  console.log('✓ Pushed to GitHub');
}

async function createGitTag(version) {
  console.log(`Creating git tag v${version}...`);

  execSync(`git tag v${version}`, { stdio: 'inherit' });
  execSync('git push --tags', { stdio: 'inherit' });

  console.log('✓ Created and pushed git tag');
}

async function main() {
  console.log('🔄 Syncing with Tokligence Gateway release...\n');

  try {
    // Get latest gateway release
    const { version, buildSuffix, releaseUrl } = await getLatestGatewayRelease();
    console.log(`Latest Gateway version: v${version}`);
    console.log(`Release URL: ${releaseUrl}\n`);

    // Update package.json
    const hasUpdate = await updatePackageJson(version, buildSuffix);

    if (!hasUpdate) {
      console.log('✓ Already up to date');
      return;
    }

    // Test the package
    await testPackage();

    // Publish to NPM if not dry run
    if (process.argv.includes('--dry-run')) {
      console.log('⚠️  Dry run mode - skipping publish and git operations');
      return;
    }

    // Commit changes
    await commitAndPush(version);

    // Publish to NPM
    await publishToNPM();

    // Create git tag
    await createGitTag(version);

    console.log(`\n✅ Successfully synced to Gateway v${version}`);
    console.log(`   NPM: https://www.npmjs.com/package/@tokligence/gateway`);
    console.log(`   GitHub: https://github.com/tokligence/tokligence-gateway-npm/releases/tag/v${version}`);

  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}