const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const tar = require('tar');
const { promisify } = require('util');
const { pipeline } = require('stream');
const streamPipeline = promisify(pipeline);

class BinaryManager {
  constructor() {
    const pkg = require('../package.json');
    this.config = pkg.tokligenceGateway;
    this.platform = this.getPlatform();
    this.arch = this.getArch();
    this.binaryDir = path.join(__dirname, '..', '.bin');
    this.binaryPath = path.join(this.binaryDir, this.getBinaryName());
    this.daemonBinaryPath = path.join(this.binaryDir, this.getDaemonBinaryName());
  }

  getPlatform() {
    const platform = os.platform();
    const platformMap = {
      'darwin': 'darwin',
      'linux': 'linux',
      'win32': 'windows'
    };

    if (!(platform in platformMap)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    return platformMap[platform];
  }

  getArch() {
    const arch = os.arch();
    const archMap = {
      'x64': 'amd64',
      'arm64': 'arm64'
    };

    if (!(arch in archMap)) {
      throw new Error(`Unsupported architecture: ${arch}`);
    }

    return archMap[arch];
  }

  getBinaryName() {
    const base = this.config.binaryName;
    return os.platform() === 'win32' ? `${base}.exe` : base;
  }

  getDaemonBinaryName() {
    const base = this.config.daemonBinaryName;
    return os.platform() === 'win32' ? `${base}.exe` : base;
  }

  getDownloadUrl(binaryType = 'gateway') {
    const version = this.config.version;
    const repo = this.config.repo;
    const buildSuffix = this.config.buildSuffix || '';

    // Construct the binary name as it appears in GitHub releases
    // Format: gateway-v0.2.0-3-ge092ec5-darwin-amd64
    // The buildSuffix contains the git commit info like "-3-ge092ec5"
    const binaryName = `${binaryType}-v${version}${buildSuffix}-${this.platform}-${this.arch}`;
    const extension = this.platform === 'windows' ? '.exe' : '';

    return `https://github.com/${repo}/releases/download/v${version}/${binaryName}${extension}`;
  }

  async ensureBinaryDir() {
    if (!fs.existsSync(this.binaryDir)) {
      fs.mkdirSync(this.binaryDir, { recursive: true });
    }
  }

  async downloadBinary(url, targetPath, retries = 3) {
    console.log(`Downloading from ${url}...`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios({
          method: 'GET',
          url: url,
          responseType: 'stream',
          headers: {
            'User-Agent': 'tokligence-gateway-npm'
          },
          maxRedirects: 5,
          timeout: 60000 // 60 seconds timeout
        });

        const writer = fs.createWriteStream(targetPath);
        await streamPipeline(response.data, writer);

        // Make the binary executable on Unix-like systems
        if (os.platform() !== 'win32') {
          fs.chmodSync(targetPath, '755');
        }

        console.log(`✓ Download complete`);
        return;

      } catch (error) {
        if (attempt < retries) {
          console.log(`Download failed (attempt ${attempt}/${retries}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        } else {
          throw error;
        }
      }
    }
  }

  async install() {
    try {
      await this.ensureBinaryDir();

      // Check if binaries already exist
      if (fs.existsSync(this.binaryPath) && fs.existsSync(this.daemonBinaryPath)) {
        console.log('Binaries already installed');
        return true;
      }

      console.log(`Installing Tokligence Gateway v${this.config.version} for ${this.platform}-${this.arch}...`);

      // Download gateway binary
      const gatewayUrl = this.getDownloadUrl('gateway');
      await this.downloadBinary(gatewayUrl, this.binaryPath);
      console.log('✓ Gateway binary installed');

      // Download gatewayd binary
      const daemonUrl = this.getDownloadUrl('gatewayd');
      await this.downloadBinary(daemonUrl, this.daemonBinaryPath);
      console.log('✓ Daemon binary installed');

      console.log(`\nInstallation complete! You can now run 'tokligence' command.`);
      return true;
    } catch (error) {
      console.error('Failed to install binaries:', error.message);

      // If download fails, provide helpful message
      if (error.response && error.response.status === 404) {
        console.error('\nBinary not found. This might mean:');
        console.error('1. The version specified in package.json doesn\'t exist');
        console.error('2. The platform/architecture combination is not available');
        console.error(`\nTried to download from: ${error.config.url}`);
      }

      throw error;
    }
  }

  async uninstall() {
    try {
      if (fs.existsSync(this.binaryDir)) {
        fs.rmSync(this.binaryDir, { recursive: true, force: true });
        console.log('Binaries uninstalled');
      }
    } catch (error) {
      console.error('Failed to uninstall binaries:', error.message);
    }
  }

  getBinaryPath() {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error('Gateway binary not found. Please run npm install again.');
    }
    return this.binaryPath;
  }

  getDaemonBinaryPath() {
    if (!fs.existsSync(this.daemonBinaryPath)) {
      throw new Error('Daemon binary not found. Please run npm install again.');
    }
    return this.daemonBinaryPath;
  }
}

module.exports = BinaryManager;