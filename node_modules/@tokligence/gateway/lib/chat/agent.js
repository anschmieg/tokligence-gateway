const { Gateway } = require('../index');
const { loadKnowledge, getDoc, searchDocs } = require('./knowledge');
const os = require('os');

/**
 * Chat Agent with Function Calling
 *
 * Provides tools for the LLM to execute gateway configuration commands.
 * Handles cross-platform differences (Windows, macOS, Linux).
 */

// Create gateway instance for tool execution
const gateway = new Gateway();

/**
 * Detect whether a config key is sensitive (API keys, secrets, tokens, etc.).
 * Any value under such keys must never be sent to a remote LLM unmasked.
 */
function isSensitiveConfigKey(key) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  const patterns = [
    'api_key',
    'apikey',
    'secret',
    'token',
    'password',
    'passphrase',
    'credential',
    'auth_key',
    // Treat PII-style identifiers as sensitive too
    'email',
    'display_name',
    'admin_email',
    'name'
  ];
  return patterns.some(p => lower.includes(p));
}

/**
 * Return a redacted placeholder instead of the real secret value.
 */
function maskSensitiveValue(value) {
  if (!value) return '';
  const str = String(value);
  const len = str.length;
  const prefix = str.slice(0, 4);
  // Expose only coarse-grained information: overall length and a short prefix.
  // This is enough for the local user to recognise which key it is, but
  // prevents the full secret from ever entering the LLM context.
  return `***redacted*** (len=${len}, prefix=${prefix})`;
}

/**
 * Tool definitions for function calling
 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'set_config',
      description: `Update a gateway configuration value. Use this when the user wants to configure or change a setting.

Available configuration keys (70+ options):

Account & Exchange:
- email: User email for identity
- display_name: Display name for gateway
- base_url: Token exchange endpoint (dev.tokligence.ai, tokligence.ai)
- marketplace_enabled: Enable marketplace integration (true/false)
- telemetry_enabled: Enable telemetry (true/false)
- admin_email: Admin email for root access
- publish_name: Service name in marketplace
- model_family: Model family label (e.g., claude-3.5-sonnet)
- price_per_1k: Price per 1K tokens

Security & Auth:
- auth_secret: Authentication secret
- auth_disabled: Disable auth (true/false)

Provider API Keys:
- openai_api_key: OpenAI API key
- openai_base_url: OpenAI API base URL
- openai_org: OpenAI organization ID
- anthropic_api_key: Anthropic API key
- anthropic_base_url: Anthropic API base URL
- anthropic_version: Anthropic API version

Logging:
- log_level: Log level (debug, info, warn, error)
- log_file_cli: CLI log file path
- log_file_daemon: Daemon log file path

Storage:
- ledger_path: Path to ledger database
- identity_path: Path to identity database

Work Mode & Routing:
- work_mode: Gateway mode (auto, passthrough, translation)
- model_provider_routes: Model-to-provider routing (pattern=provider)
- routes: General routing rules
- fallback_adapter: Fallback when no route matches

Model Aliases:
- model_aliases: Inline model aliases
- model_aliases_file: Path to model aliases file
- model_aliases_dir: Directory of alias files

Multi-Port Facade:
- enable_facade: Enable facade mode (true/false)
- multiport_mode: Enable multi-port (true/false)
- facade_port: Facade port (default: 8081)
- admin_port: Admin port (default: 8079)
- openai_port: OpenAI port (default: 8082)
- anthropic_port: Anthropic port (default: 8083)
- facade_endpoints: Endpoints on facade port
- admin_endpoints: Endpoints on admin port
- openai_endpoints: Endpoints on OpenAI port
- anthropic_endpoints: Endpoints on Anthropic port

Bridge Sessions:
- bridge_session_enabled: Enable bridge sessions (true/false)
- bridge_session_ttl: Session TTL (e.g., 5m)
- bridge_session_max_count: Max session count

Anthropic Features:
- anthropic_native_enabled: Native Anthropic SDK (true/false)
- anthropic_force_sse: Force SSE streaming (true/false)
- anthropic_token_check_enabled: Enable token check (true/false)
- anthropic_max_tokens: Max tokens for requests
- anthropic_web_search: Enable web search beta (true/false)
- anthropic_computer_use: Enable computer use beta (true/false)
- anthropic_mcp: Enable MCP beta (true/false)
- anthropic_prompt_caching: Enable prompt caching (true/false)
- anthropic_json_mode: Enable JSON mode (true/false)
- anthropic_reasoning: Enable reasoning (true/false)
- anthropic_beta_header: Custom beta header
- chat_to_anthropic: Enable chat-to-anthropic translation (true/false)

OpenAI Features:
- openai_completion_max_tokens: Max tokens cap (0 = disabled)
- openai_tool_bridge_stream: Enable tool bridge streaming (true/false)

Model Metadata:
- duplicate_tool_detection: Enable duplicate tool detection (true/false)
- model_metadata_file: Path to metadata file
- model_metadata_url: Metadata URL
- model_metadata_refresh: Refresh interval (e.g., 24h)

Hooks:
- hooks_enabled: Enable hooks system (true/false)
- hooks_script_path: Path to hook script
- hooks_script_args: Hook script arguments (comma-separated)
- hooks_script_env: Hook environment variables (KEY=VALUE pairs)
- hooks_timeout: Hook timeout (e.g., 30s)`,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Configuration key from the list above'
          },
          value: {
            type: 'string',
            description: 'Configuration value to set'
          }
        },
        required: ['key', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_config',
      description: 'Get current gateway configuration. If key is provided, returns that specific value. If no key provided, returns all configuration.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Optional configuration key to retrieve. If omitted, returns all config.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: 'Check if the gateway daemon is currently running',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_gateway',
      description: 'Start the gateway daemon in the background',
      parameters: {
        type: 'object',
        properties: {
          daemon: {
            type: 'boolean',
            description: 'Whether to run as daemon (default: true)',
            default: true
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_gateway',
      description: 'Stop the gateway daemon',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_logs',
      description: 'Get recent gateway logs',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Number of lines to retrieve (default: 50)',
            default: 50
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: 'Search the bundled Tokligence Gateway documentation for a keyword or phrase. Use this to answer configuration and usage questions from official docs.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "OpenAI API key", "routing rules", "multiport_mode").'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_doc',
      description: 'Retrieve the full text of a specific bundled documentation file (for example QUICK_START or USER_GUIDE) so you can quote or summarize it.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Document name without .md extension (e.g., "QUICK_START", "USER_GUIDE", "README").'
          }
        },
        required: ['name']
      }
    }
  }
];

/**
 * Get platform-specific information
 */
function getPlatformInfo() {
  const platform = os.platform();
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';

  return {
    platform,
    isWindows,
    isMac,
    isLinux,
    pathSeparator: isWindows ? '\\' : '/',
    homeDir: os.homedir()
  };
}

/**
 * Execute a tool function
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} Tool execution result
 */
async function executeTool(toolName, args) {
  const platformInfo = getPlatformInfo();

  try {
    switch (toolName) {
      case 'set_config': {
        const { key, value } = args;
        await gateway.setConfig(key, value);

        const sensitive = isSensitiveConfigKey(key);
        const displayValue = sensitive ? maskSensitiveValue(value) : value;

        return {
          success: true,
          message: sensitive
            ? `Configuration updated: ${key} = ${displayValue} (secret value kept local)`
            : `Configuration updated: ${key} = ${displayValue}`,
          key,
          masked: !!sensitive,
          platform: platformInfo.platform
        };
      }

      case 'get_config': {
        const { key } = args;

        // Single-key lookup
        if (key) {
          const rawValue = await gateway.getConfig(key);
          const sensitive = isSensitiveConfigKey(key);

          return {
            success: true,
            key,
            // Never return the raw secret to the LLM; only an explicit redacted form.
            value: sensitive ? maskSensitiveValue(rawValue) : rawValue,
            masked: !!sensitive,
            platform: platformInfo.platform
          };
        }

        // Full configuration summary (no raw secret values)
        const config = await gateway.listConfig();

        // Build a conservative, high-level summary to reduce the risk
        // of the model hallucinating detailed, per-field narratives.
        // We only expose a small, non-sensitive subset of fields plus
        // presence/boolean information for the rest.
        const importantKeys = [
          'work_mode',
          'routes',
          'model_provider_routes',
          'multiport_mode',
          'enable_facade',
          'facade_port',
          'admin_port',
          'openai_port',
          'anthropic_port',
          'marketplace_enabled',
          'telemetry_enabled',
          'auth_disabled'
        ];

        const summary = {
          important: {},
          // Expose which major providers are configured, without the actual tokens.
          providers: {
            openai_configured: false,
            anthropic_configured: false,
            google_configured: false
          },
          // Just a list of all keys so the model knows what exists,
          // without exposing every value.
          allKeys: Object.keys(config).sort()
        };

        for (const k of importantKeys) {
          if (Object.prototype.hasOwnProperty.call(config, k)) {
            summary.important[k] = config[k];
          }
        }

        // Provider presence detection without leaking tokens
        if (Object.prototype.hasOwnProperty.call(config, 'openai_api_key')) {
          const v = String(config.openai_api_key || '').trim();
          summary.providers.openai_configured = v.length > 0;
        }
        if (Object.prototype.hasOwnProperty.call(config, 'anthropic_api_key')) {
          const v = String(config.anthropic_api_key || '').trim();
          summary.providers.anthropic_configured = v.length > 0;
        }
        if (Object.prototype.hasOwnProperty.call(config, 'google_api_key')) {
          const v = String(config.google_api_key || '').trim();
          summary.providers.google_configured = v.length > 0;
        }

        return {
          success: true,
          summary,
          platform: platformInfo.platform
        };
      }

      case 'get_status': {
        const isRunning = await gateway.isRunning();
        const pid = await gateway.getPid();

        return {
          success: true,
          running: isRunning,
          pid: pid || null,
          platform: platformInfo.platform,
          message: isRunning
            ? `Gateway is running (PID: ${pid})`
            : 'Gateway is not running'
        };
      }

      case 'start_gateway': {
        const { daemon = true } = args;

        // Check if already running
        if (await gateway.isRunning()) {
          return {
            success: false,
            message: 'Gateway is already running',
            platform: platformInfo.platform
          };
        }

        // Platform-specific startup
        await gateway.start({ daemon });

        // Wait a moment for startup
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify it started
        const isRunning = await gateway.isRunning();
        const pid = await gateway.getPid();

        if (isRunning) {
          return {
            success: true,
            message: `Gateway started successfully (PID: ${pid})`,
            pid,
            platform: platformInfo.platform,
            note: platformInfo.isWindows
              ? 'Running on Windows - check Task Manager if issues occur'
              : 'Running in background'
          };
        } else {
          return {
            success: false,
            message: 'Gateway failed to start. Check logs for details.',
            platform: platformInfo.platform
          };
        }
      }

      case 'stop_gateway': {
        // Check if running
        if (!(await gateway.isRunning())) {
          return {
            success: false,
            message: 'Gateway is not running',
            platform: platformInfo.platform
          };
        }

        // Platform-specific shutdown
        await gateway.stop();

        // Wait a moment for shutdown
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify it stopped
        const isRunning = await gateway.isRunning();

        return {
          success: !isRunning,
          message: isRunning
            ? 'Gateway may still be shutting down'
            : 'Gateway stopped successfully',
          platform: platformInfo.platform
        };
      }

      case 'get_logs': {
        const { lines = 50 } = args;

        try {
          const logs = await gateway.logs({ lines });
          return {
            success: true,
            logs,
            lines,
            platform: platformInfo.platform
          };
        } catch (error) {
          return {
            success: false,
            message: `Failed to retrieve logs: ${error.message}`,
            platform: platformInfo.platform,
            note: platformInfo.isWindows
              ? 'Check %USERPROFILE%\\.tokligence\\logs\\ directory'
              : 'Check ~/.tokligence/logs/ directory'
          };
        }
      }

      case 'search_docs': {
        const { query } = args;
        const knowledge = loadKnowledge();
        const results = searchDocs(knowledge, query || '');

        return {
          success: true,
          query,
          results,
          count: results.length,
          note: results.length === 0
            ? 'No exact matches found for this phrase. You can still rely on the bundled docs (e.g. README, QUICK_START, USER_GUIDE, configuration_guide) and your own capability description to answer general questions.'
            : 'These matches come from the bundled docs (README, QUICK_START, USER_GUIDE, configuration_guide, etc.).',
          docs: Object.keys(knowledge.docs)
        };
      }

      case 'get_doc': {
        const { name } = args;
        const knowledge = loadKnowledge();
        const content = getDoc(knowledge, name);

        if (!content) {
          return {
            success: false,
            message: `Document not found: ${name}.md`,
            available: Object.keys(knowledge.docs)
          };
        }

        return {
          success: true,
          name,
          content,
          available: Object.keys(knowledge.docs)
        };
      }

      default:
        return {
          success: false,
          message: `Unknown tool: ${toolName}`,
          platform: platformInfo.platform
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      platform: platformInfo.platform,
      note: getPlatformSpecificErrorNote(error, platformInfo)
    };
  }
}

/**
 * Get platform-specific error notes
 */
function getPlatformSpecificErrorNote(error, platformInfo) {
  const errorMsg = error.message.toLowerCase();

  // Permission errors
  if (errorMsg.includes('permission') || errorMsg.includes('eacces')) {
    if (platformInfo.isWindows) {
      return 'Try running as Administrator';
    } else {
      return 'Try running with sudo or check file permissions';
    }
  }

  // Path errors
  if (errorMsg.includes('enoent') || errorMsg.includes('not found')) {
    if (platformInfo.isWindows) {
      return `Check paths in ${platformInfo.homeDir}\\.tokligence\\`;
    } else {
      return `Check paths in ${platformInfo.homeDir}/.tokligence/`;
    }
  }

  // Port errors
  if (errorMsg.includes('eaddrinuse') || errorMsg.includes('port')) {
    if (platformInfo.isWindows) {
      return 'Check if another process is using the port (use netstat -ano)';
    } else {
      return 'Check if another process is using the port (use lsof -i)';
    }
  }

  return null;
}

/**
 * Parse tool calls from LLM response
 * @param {Object} message - LLM message with tool calls
 * @returns {Array} Parsed tool calls
 */
function parseToolCalls(message) {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return [];
  }

  return message.tool_calls.map(toolCall => ({
    id: toolCall.id,
    name: toolCall.function.name,
    args: JSON.parse(toolCall.function.arguments)
  }));
}

/**
 * Execute all tool calls from a message
 * @param {Array} toolCalls - Parsed tool calls
 * @returns {Promise<Array>} Tool execution results
 */
async function executeToolCalls(toolCalls) {
  const results = [];

  for (const toolCall of toolCalls) {
    console.log(`\n🔧 Executing: ${toolCall.name}`, toolCall.args);

    const result = await executeTool(toolCall.name, toolCall.args);

    results.push({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.name,
      content: JSON.stringify(result)
    });

    // Show result to user
    if (result.success) {
      console.log(`✓ ${result.message || 'Success'}`);
    } else {
      console.log(`✗ ${result.message || result.error || 'Failed'}`);
      if (result.note) {
        console.log(`  Note: ${result.note}`);
      }
    }
  }

  return results;
}

module.exports = {
  tools,
  executeTool,
  parseToolCalls,
  executeToolCalls,
  getPlatformInfo,
  isSensitiveConfigKey,
  maskSensitiveValue
};
