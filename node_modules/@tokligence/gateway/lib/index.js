const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const BinaryManager = require('./binary');

class Gateway {
  constructor(options = {}) {
    this.options = {
      port: options.port || 8081,  // Changed to 8081 to match gatewayd default
      host: options.host || 'localhost',
      config: options.config || null,
      daemon: options.daemon || false,
      ...options
    };

    this.binaryManager = new BinaryManager();
    this.process = null;
    this.pidFile = path.join(process.env.HOME || process.env.USERPROFILE, '.tokligence', 'gateway.pid');
    this.logFile = path.join(process.env.HOME || process.env.USERPROFILE, '.tokligence', 'gateway.log');
  }

  async start() {
    if (await this.isRunning()) {
      throw new Error('Gateway is already running');
    }

    const binaryPath = this.options.daemon
      ? this.binaryManager.getDaemonBinaryPath()
      : this.binaryManager.getBinaryPath();

    const args = [];

    // Add configuration options
    if (this.options.port) {
      args.push('--port', this.options.port.toString());
    }

    if (this.options.host) {
      args.push('--host', this.options.host);
    }

    if (this.options.config) {
      args.push('--config', this.options.config);
    }

    // Ensure log directory exists
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let logFd;

      // For daemon mode, we let gatewayd handle its own logging
      // The log_file_daemon config in gateway.ini tells it where to write
      // This avoids the stdio WriteStream issue

      this.process = spawn(binaryPath, args, {
        detached: this.options.daemon,
        stdio: this.options.daemon ? 'ignore' : 'inherit',
        cwd: path.join(process.env.HOME || process.env.USERPROFILE, '.tokligence')
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start gateway: ${err.message}`));
      });

      // Save PID for daemon mode
      if (this.options.daemon) {
        fs.writeFileSync(this.pidFile, this.process.pid.toString());
        this.process.unref();
      }

      // Wait a bit and check if the server is responding
      setTimeout(async () => {
        try {
          await this.healthCheck();
          resolve();
        } catch (error) {
          // Server might need more time to start
          setTimeout(async () => {
            try {
              await this.healthCheck();
              resolve();
            } catch (error) {
              reject(new Error('Gateway started but is not responding'));
            }
          }, 2000);
        }
      }, 1000);
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      return;
    }

    // Try to stop daemon process
    if (fs.existsSync(this.pidFile)) {
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));

      try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(this.pidFile);
      } catch (error) {
        if (error.code === 'ESRCH') {
          // Process doesn't exist, clean up PID file
          fs.unlinkSync(this.pidFile);
        } else {
          throw error;
        }
      }
    } else {
      throw new Error('No running gateway found');
    }
  }

  async status() {
    const running = await this.isRunning();

    if (!running) {
      return { running: false };
    }

    const pid = this.getPid();

    // Try to get more info from the API
    try {
      const response = await axios.get(`http://${this.options.host}:${this.options.port}/health`);

      return {
        running: true,
        pid: pid,
        port: this.options.port,
        host: this.options.host,
        uptime: response.data.uptime || 'unknown',
        version: response.data.version || 'unknown'
      };
    } catch (error) {
      // Basic status if API is not responding
      return {
        running: true,
        pid: pid,
        port: this.options.port,
        host: this.options.host,
        uptime: 'unknown',
        version: 'unknown'
      };
    }
  }

  async isRunning() {
    // Check if process is running
    if (this.process && !this.process.killed) {
      return true;
    }

    // Check daemon process via PID file
    if (fs.existsSync(this.pidFile)) {
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));

      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
        return true;
      } catch (error) {
        // Process doesn't exist, clean up stale PID file
        try {
          fs.unlinkSync(this.pidFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }

    // Check for any gatewayd process using pgrep
    // Use exact match to avoid matching pgrep itself
    try {
      const { execSync } = require('child_process');
      const result = execSync('pgrep -x gatewayd', { encoding: 'utf8' });
      if (result.trim()) {
        return true;
      }
    } catch (error) {
      // pgrep returns non-zero exit code when no process found
    }

    // Final fallback: try health check on default port
    try {
      await this.healthCheck();
      return true;
    } catch (error) {
      return false;
    }
  }

  async healthCheck() {
    try {
      const response = await axios.get(
        `http://${this.options.host}:${this.options.port}/health`,
        { timeout: 5000 }
      );
      return response.data;
    } catch (error) {
      throw new Error('Health check failed');
    }
  }

  getPid() {
    if (this.process) {
      return this.process.pid;
    }

    if (fs.existsSync(this.pidFile)) {
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
      // Verify the process still exists
      try {
        process.kill(pid, 0);
        return pid;
      } catch (error) {
        // Process doesn't exist, clean up PID file
        try {
          fs.unlinkSync(this.pidFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }

    // Try to find gatewayd process via pgrep
    // Use exact match to avoid matching pgrep itself
    try {
      const { execSync } = require('child_process');
      const result = execSync('pgrep -x gatewayd', { encoding: 'utf8' });
      const pids = result.trim().split('\n');
      if (pids.length > 0 && pids[0]) {
        return parseInt(pids[0]);
      }
    } catch (error) {
      // pgrep returns non-zero when no process found
    }

    return null;
  }

  async init(options = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const configBaseDir = path.join(homeDir, '.tokligence', 'config');
    const settingsFile = path.join(configBaseDir, 'settings.ini');
    const envDir = path.join(configBaseDir, 'dev');
    const envFile = path.join(envDir, 'gateway.ini');

    // Check if already initialized
    if (fs.existsSync(settingsFile) && !options.force) {
      throw new Error('Configuration already exists. Use --force to overwrite.');
    }

    // Create directories
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }

    // Create settings.ini
    const settingsContent = `# Tokligence Gateway Settings
# Generated by @tokligence/gateway npm package

environment=dev
`;

    fs.writeFileSync(settingsFile, settingsContent);

    // Create dev/gateway.ini (main configuration)
    // This template matches the Go repo's config/dev/gateway.ini structure
    const envConfig = `# Tokligence Gateway Configuration - Development Environment
# Generated by @tokligence/gateway npm package
#
# Configuration Hierarchy (priority from high to low):
# 1. Environment variables (e.g., TOKLIGENCE_WORK_MODE, TOKLIGENCE_OPENAI_API_KEY)
#    - Highest priority, overrides everything
#    - Set via: export TOKLIGENCE_XXX=value or in .env file
# 2. This gateway.ini file (environment-specific: live/dev/test)
#    - Environment-specific overrides
#    - Loaded based on TOKLIGENCE_ENV or --env flag
# 3. Default values in code
#    - Lowest priority, used when no override is specified
#
# Example: If TOKLIGENCE_WORK_MODE=passthrough is set as env var,
#          it will override work_mode=auto in this file

# ========================================
# Token Exchange & Account Configuration
# ========================================

# Token Exchange endpoint for dev workflows - using tokligence domain
base_url=https://dev.tokligence.ai

# Dev account identity; typically a test inbox
email=\${TOKLIGENCE_EMAIL:-cs@tokligence.ai}

# Name shown when listing the gateway locally
display_name=Dev Gateway

# Toggle provider publishing for local testing
enable_provider=false
marketplace_enabled=false
telemetry_enabled=true

# Service name to push to marketplace during dev
publish_name=local-dev

# Label for the model class advertised to consumers
model_family=claude-3.5-sonnet
price_per_1k=0.5000

# ========================================
# Security & Authentication
# ========================================

auth_secret=tokligence-dev-secret

# Disable auth for dev convenience
auth_disabled=true

# Admin email for root admin access
admin_email=admin@local

# ========================================
# Provider API Configuration
# ========================================

# OpenAI Provider
# Get your API key from: https://platform.openai.com/api-keys
# openai_api_key=\${TOKLIGENCE_OPENAI_API_KEY}
# openai_base_url=https://api.openai.com/v1
# openai_org=

# Anthropic Provider
# Get your API key from: https://console.anthropic.com/
# anthropic_api_key=\${TOKLIGENCE_ANTHROPIC_API_KEY}
# anthropic_base_url=https://api.anthropic.com
# anthropic_version=2023-06-01

# ========================================
# Logging Configuration
# ========================================

# Dev-specific log files
# Override per process if needed:
#   TOKLIGENCE_LOG_FILE_CLI=... TOKLIGENCE_LOG_FILE_DAEMON=...
log_file_cli=\${HOME}/.tokligence/logs/dev-cli.log
log_file_daemon=\${HOME}/.tokligence/logs/dev-gatewayd.log
log_level=debug

# ========================================
# Storage Paths
# ========================================

ledger_path=\${HOME}/.tokligence/ledger-dev.db
identity_path=\${HOME}/.tokligence/identity.db

# ========================================
# Work Mode & Routing
# ========================================

# Work Mode: controls passthrough vs translation behavior globally for all endpoints
# This is a critical setting that affects how the gateway handles requests:
#   - auto (default):        Smart routing - automatically choose passthrough or translation
#                            based on endpoint+model match (e.g., /v1/responses+gpt* = passthrough,
#                            /v1/responses+claude* = translation)
#   - passthrough:           Delegation-only mode - only allow direct passthrough/delegation
#                            to upstream providers, reject any translation requests
#   - translation:           Translation-only mode - only allow translation between API formats,
#                            reject any passthrough requests
# Override with: TOKLIGENCE_WORK_MODE=auto|passthrough|translation
work_mode=auto

# Model-first provider routing (pattern=>provider). The gateway inspects the requested
# model and picks the provider before considering which endpoint was called. Customize
# this list to add providers such as kimi*/qwen*/etc. Accepted separators: commas or newlines.
# Examples:
#   model_provider_routes=gpt*=openai,claude*=anthropic
#   model_provider_routes=o1*=openai,glm*=kimi
model_provider_routes=gpt*=openai,claude*=anthropic

# General routing rules (pattern=>adapter pairs, comma-separated)
# routes=gpt*=>openai,claude*=>anthropic

# Fallback adapter when no route matches
# fallback_adapter=loopback

# ========================================
# Model Aliases
# ========================================

# Model alias hot-reload sources (optional)
# Directory of alias files where each line is "incoming=>target" or "incoming=target"
# model_aliases_dir=config/model_aliases.d

# Single file for model aliases
# model_aliases_file=config/model_aliases.txt

# Inline model aliases (comma or newline separated)
# model_aliases=my-gpt=>gpt-4,my-claude=>claude-3-5-sonnet-20241022

# ========================================
# Facade / Multi-Port Configuration
# ========================================

# Port scheme: facade=8081, admin=8079, openai=8082, anthropic=8083
enable_facade=true
multiport_mode=true
facade_port=8081
admin_port=8079
openai_port=8082
anthropic_port=8083

# Optional endpoint selections per port (defaults: facade=openai_core,openai_responses,anthropic,admin,health)
# facade_endpoints=openai_core,openai_responses,anthropic,admin,health
# admin_endpoints=admin,health
# openai_endpoints=openai_core,openai_responses
# anthropic_endpoints=anthropic

# ========================================
# Bridge Session Management
# ========================================

# Bridge session management (deprecated; stateless bridge path in use)
bridge_session_enabled=false
bridge_session_ttl=5m
bridge_session_max_count=1000

# ========================================
# Anthropic Feature Toggles
# ========================================

# Native Anthropic SDK support
# anthropic_native_enabled=true

# Force SSE streaming for Anthropic
# anthropic_force_sse=true

# Token check for Anthropic requests
# anthropic_token_check_enabled=false

# Max tokens for Anthropic requests
# anthropic_max_tokens=8192

# Anthropic beta capability toggles (off by default)
# anthropic_web_search=false
# anthropic_computer_use=false
# anthropic_mcp=false
# anthropic_prompt_caching=false
# anthropic_json_mode=false
# anthropic_reasoning=false

# Custom Anthropic beta header
# anthropic_beta_header=

# Enable chat-to-anthropic translation
# chat_to_anthropic=false

# ========================================
# OpenAI Feature Toggles
# ========================================

# OpenAI completion max_tokens cap used by in-process sidecar (0 = disabled)
# openai_completion_max_tokens=16384

# OpenAI tool bridge streaming (default false for coding agents)
# openai_tool_bridge_stream=false

# ========================================
# Model Metadata
# ========================================

# Duplicate tool detection guard for Responses flow
# duplicate_tool_detection=false

# Model metadata (context/max cap) sources
# model_metadata_file=data/model_metadata.json
# model_metadata_url=https://raw.githubusercontent.com/tokligence/tokligence-gateway/main/data/model_metadata.json
# model_metadata_refresh=24h

# ========================================
# Hooks System
# ========================================

# Enable hooks system
# hooks_enabled=false

# Hook script path
# hooks_script_path=scripts/hooks.sh

# Hook script arguments (comma-separated)
# hooks_script_args=arg1,arg2

# Hook script environment variables (comma-separated KEY=VALUE pairs)
# hooks_script_env=ENV1=value1,ENV2=value2

# Hook timeout duration
# hooks_timeout=30s
`;

    fs.writeFileSync(envFile, envConfig);

    // Create logs directory
    const logsDir = path.join(homeDir, '.tokligence', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    console.log('✓ Configuration initialized successfully!\n');
    console.log('Configuration files created:');
    console.log(`  Settings: ${settingsFile}`);
    console.log(`  Environment: ${envFile}\n`);
    console.log('Next steps:');
    console.log('  1. Set your API keys (choose one):');
    console.log('     a) Via environment variables (recommended):');
    console.log('        export TOKLIGENCE_EMAIL="your@email.com"');
    console.log('        export TOKLIGENCE_OPENAI_API_KEY="sk-..."');
    console.log('        export TOKLIGENCE_ANTHROPIC_API_KEY="sk-ant-..."\n');
    console.log('     b) Edit config file directly:');
    console.log(`        nano ${envFile}\n`);
    console.log('  2. Start the gateway:');
    console.log('        tgw start -d\n');
    console.log('  3. Check status:');
    console.log('        tgw status\n');
  }

  getEnvConfigPath() {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const settingsFile = path.join(homeDir, '.tokligence', 'config', 'settings.ini');

    let env = 'dev';

    // Read environment from settings.ini if it exists
    if (fs.existsSync(settingsFile)) {
      const ini = require('ini');
      try {
        const settings = ini.parse(fs.readFileSync(settingsFile, 'utf8'));
        env = settings.environment || 'dev';
      } catch (error) {
        // Use default if parsing fails
      }
    }

    return path.join(homeDir, '.tokligence', 'config', env, 'gateway.ini');
  }

  async listConfig() {
    const envFile = this.getEnvConfigPath();

    if (!fs.existsSync(envFile)) {
      throw new Error(`Configuration file not found: ${envFile}\nRun 'tgw init' to create it.`);
    }

    const ini = require('ini');
    const content = fs.readFileSync(envFile, 'utf8');
    return ini.parse(content);
  }

  async getConfig(key) {
    const config = await this.listConfig();

    if (!(key in config)) {
      throw new Error(`Configuration key not found: ${key}`);
    }

    return config[key];
  }

  async setConfig(key, value) {
    const envFile = this.getEnvConfigPath();

    if (!fs.existsSync(envFile)) {
      throw new Error(`Configuration file not found: ${envFile}\nRun 'tgw init' to create it.`);
    }

    const ini = require('ini');
    const config = await this.listConfig();

    config[key] = value;

    // Stringify with proper formatting
    const content = ini.stringify(config);
    fs.writeFileSync(envFile, content);
  }

  async logs(options = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const logsDir = path.join(homeDir, '.tokligence', 'logs');

    if (!fs.existsSync(logsDir)) {
      console.log('No logs available. Start the gateway first: tgw start');
      return;
    }

    // Find all log files
    const files = fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(logsDir, f),
        mtime: fs.statSync(path.join(logsDir, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime); // Sort by most recent first

    if (files.length === 0) {
      console.log('No log files found');
      return;
    }

    // Use the most recent log file
    const latestLog = files[0].path;
    console.log(`Viewing: ${files[0].name}\n`);

    if (options.follow) {
      // Follow logs (like tail -f)
      const { spawn } = require('child_process');
      const tail = spawn('tail', ['-f', '-n', options.lines || '20', latestLog], {
        stdio: 'inherit'
      });

      process.on('SIGINT', () => {
        tail.kill();
        process.exit(0);
      });
    } else {
      // Show last N lines
      const { execSync } = require('child_process');
      try {
        const output = execSync(`tail -n ${options.lines || 20} "${latestLog}"`, { encoding: 'utf8' });
        console.log(output);
      } catch (error) {
        console.error('Failed to read log file:', error.message);
      }
    }
  }

  // Proxy methods for API calls
  async chat(options) {
    const response = await axios.post(
      `http://${this.options.host}:${this.options.port}/v1/chat/completions`,
      options
    );
    return response.data;
  }

  async completion(options) {
    const response = await axios.post(
      `http://${this.options.host}:${this.options.port}/v1/completions`,
      options
    );
    return response.data;
  }

  async listModels() {
    const response = await axios.get(
      `http://${this.options.host}:${this.options.port}/v1/models`
    );
    return response.data;
  }
}

module.exports = { Gateway };
module.exports.Gateway = Gateway;
module.exports.default = Gateway;