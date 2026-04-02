const https = require('https');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');

const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const CONFIG_DIR = process.env.TOKLIGENCE_CONFIG_DIR ||
  path.join(require('os').homedir(), '.tokligence');
const UPDATE_CONFIG_FILE = path.join(CONFIG_DIR, 'update-config.json');
const DEFAULT_TIMEOUT_MS = 30 * 1000; // 30 seconds

/**
 * Get the latest version from npm registry
 */
function getLatestVersion(packageName) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageName}/latest`;

    const req = https.get(url, { timeout: DEFAULT_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        // Drain response to free sockets, then reject
        res.resume();
        return reject(new Error(`Registry responded with status ${res.statusCode}`));
      }

      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          resolve(pkg.version);
        } catch (error) {
          reject(new Error('Failed to parse registry response'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Registry request timed out'));
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Compare version strings (semantic versioning)
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}

/**
 * Load update configuration
 */
function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_FILE)) {
      const data = fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    // Ignore errors, return default config
  }

  return {
    lastCheckTime: 0,
    skippedVersions: []
  };
}

/**
 * Save update configuration
 */
function saveUpdateConfig(config) {
  try {
    // Ensure config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    fs.writeFileSync(UPDATE_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    // Silently fail - not critical
  }
}

/**
 * Prompt user for update decision
 */
function promptUpdate(currentVersion, latestVersion) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('');
    console.log(chalk.yellow('┌─────────────────────────────────────────────────┐'));
    console.log(chalk.yellow('│') + '  ' + chalk.bold('Update Available') + '                           ' + chalk.yellow('│'));
    console.log(chalk.yellow('├─────────────────────────────────────────────────┤'));
    console.log(chalk.yellow('│') + '  Current version: ' + chalk.cyan(currentVersion) + '                    ' + chalk.yellow('│'));
    console.log(chalk.yellow('│') + '  Latest version:  ' + chalk.green(latestVersion) + '                    ' + chalk.yellow('│'));
    console.log(chalk.yellow('└─────────────────────────────────────────────────┘'));
    console.log('');
    console.log('Run ' + chalk.cyan('npm install -g @tokligence/gateway@latest') + ' to update');
    console.log('');

    rl.question('Update now? [y/N/skip]: ', (answer) => {
      rl.close();

      const response = answer.trim().toLowerCase();

      if (response === 'y' || response === 'yes') {
        resolve('update');
      } else if (response === 'skip' || response === 's') {
        resolve('skip');
      } else {
        resolve('later');
      }
    });
  });
}

function isInteractiveShell() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

/**
 * Check for updates
 */
async function checkForUpdates(currentVersion, packageName, options = {}) {
  const {
    force = false,
    silent = false,
    fetchLatestVersion = getLatestVersion
  } = options;

  try {
    const config = loadUpdateConfig();
    const now = Date.now();

    // Check if we should skip this check
    if (!force && (now - config.lastCheckTime) < UPDATE_CHECK_INTERVAL) {
      return; // Checked recently
    }

    // Update last check time
    config.lastCheckTime = now;
    saveUpdateConfig(config);

    // Get latest version from npm
    const latestVersion = await fetchLatestVersion(packageName);

    // Check if there's a new version
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return; // No update available
    }

    // Check if this version was skipped
    if (config.skippedVersions.includes(latestVersion)) {
      return; // User skipped this version
    }

    const interactive = isInteractiveShell();
    const silentMode = silent || !interactive;

    if (silentMode) {
      console.log(chalk.yellow(`\n⚠️  Update available: ${currentVersion} → ${latestVersion}`));
      console.log(chalk.gray(`Run 'npm install -g @tokligence/gateway@latest' to update\n`));
      return;
    }

    // Prompt user
    const decision = await promptUpdate(currentVersion, latestVersion);

    if (decision === 'update') {
      // Execute update
      const { spawn } = require('child_process');

      console.log(chalk.cyan('\nUpdating @tokligence/gateway...'));

      const npm = spawn('npm', ['install', '-g', '@tokligence/gateway@latest'], {
        stdio: 'inherit',
        shell: true
      });

      npm.on('close', (code) => {
        if (code === 0) {
          console.log(chalk.green('\n✓ Update completed successfully!'));
          console.log(chalk.gray('Please run your command again.\n'));
          process.exit(0);
        } else {
          console.log(chalk.red('\n✗ Update failed. Please try manually:\n'));
          console.log(chalk.cyan('  npm install -g @tokligence/gateway@latest\n'));
          process.exit(1);
        }
      });
    } else if (decision === 'skip') {
      // Add to skipped versions
      if (!config.skippedVersions.includes(latestVersion)) {
        config.skippedVersions.push(latestVersion);
        saveUpdateConfig(config);
      }
      console.log(chalk.gray(`\nSkipping version ${latestVersion}. You won't be notified about this version again.\n`));
    } else {
      console.log(chalk.gray('\nUpdate reminder: You can update later with:\n'));
      console.log(chalk.cyan('  npm install -g @tokligence/gateway@latest\n'));
    }
  } catch (error) {
    // Silently fail - update check is not critical
    // Don't interrupt the user's command
  }
}

module.exports = {
  checkForUpdates,
  getLatestVersion,
  compareVersions
};
