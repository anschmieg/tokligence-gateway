const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * LLM Endpoint Detector
 *
 * Auto-detects available LLM endpoints in priority order:
 * 1. Ollama (localhost:11434) - Local, free
 * 2. vLLM (localhost:8000) - Local, free
 * 3. LM Studio (localhost:1234) - Local, free
 * 4. Custom endpoint (TOKLIGENCE_LLM_ENDPOINT)
 * 5. OpenAI (TOKLIGENCE_OPENAI_API_KEY)
 * 6. Anthropic (TOKLIGENCE_ANTHROPIC_API_KEY)
 * 7. Google Gemini (TOKLIGENCE_GOOGLE_API_KEY)
 * 8. Running Gateway (localhost:8081)
 */
class LLMDetector {
  constructor() {
    this.endpoints = [];
    this.timeout = 1000; // 1 second timeout for local endpoints
  }

  /**
   * Detect all available LLM endpoints
   * @returns {Promise<Array>} Array of detected endpoints
   */
  async detectAll() {
    console.log('🔍 Detecting available LLM endpoints...\n');

    // Detect in priority order
    await this.detectOllama();
    await this.detectVLLM();
    await this.detectLMStudio();
    await this.detectCustomEndpoint();
    await this.detectCommercialLLMs();
    await this.detectGateway();

    return this.endpoints;
  }

  /**
   * Priority 1: Detect Ollama
   */
  async detectOllama() {
    try {
      const response = await axios.get('http://localhost:11434/api/tags', {
        timeout: this.timeout
      });

      if (response.status === 200 && response.data.models) {
        const models = response.data.models.map(m => m.name);
        this.endpoints.push({
          name: 'Ollama (local)',
          type: 'ollama',
          baseURL: 'http://localhost:11434/v1',
          apiKey: 'ollama', // Ollama doesn't require a key
          models: models,
          defaultModel: models[0] || 'llama2',
          free: true,
          local: true,
          priority: 1
        });
        console.log(`✓ Found Ollama - ${models.length} model(s) available`);
        console.log(`  Models: ${models.join(', ')}`);
      }
    } catch (error) {
      // Ollama not running or not installed
    }
  }

  /**
   * Priority 2: Detect vLLM
   */
  async detectVLLM() {
    const vllmEndpoint = process.env.VLLM_ENDPOINT || 'http://localhost:8000';

    try {
      const response = await axios.get(`${vllmEndpoint}/v1/models`, {
        timeout: this.timeout
      });

      if (response.status === 200 && response.data.data) {
        const models = response.data.data.map(m => m.id);
        this.endpoints.push({
          name: 'vLLM (local)',
          type: 'vllm',
          baseURL: `${vllmEndpoint}/v1`,
          apiKey: 'vllm', // vLLM typically doesn't require a key
          models: models,
          defaultModel: models[0],
          free: true,
          local: true,
          priority: 2
        });
        console.log(`✓ Found vLLM - ${models.length} model(s) available`);
        console.log(`  Endpoint: ${vllmEndpoint}`);
        console.log(`  Models: ${models.join(', ')}`);
      }
    } catch (error) {
      // vLLM not running
    }
  }

  /**
   * Priority 3: Detect LM Studio
   */
  async detectLMStudio() {
    try {
      const response = await axios.get('http://localhost:1234/v1/models', {
        timeout: this.timeout
      });

      if (response.status === 200 && response.data.data) {
        const models = response.data.data.map(m => m.id);
        this.endpoints.push({
          name: 'LM Studio (local)',
          type: 'lmstudio',
          baseURL: 'http://localhost:1234/v1',
          apiKey: 'lm-studio',
          models: models,
          defaultModel: models[0],
          free: true,
          local: true,
          priority: 3
        });
        console.log(`✓ Found LM Studio - ${models.length} model(s) available`);
        console.log(`  Models: ${models.join(', ')}`);
      }
    } catch (error) {
      // LM Studio not running
    }
  }

  /**
   * Priority 4: Detect Custom Endpoint
   */
  async detectCustomEndpoint() {
    const customEndpoint = process.env.TOKLIGENCE_LLM_ENDPOINT;
    const customApiKey = process.env.TOKLIGENCE_LLM_API_KEY;

    if (!customEndpoint) {
      return;
    }

    try {
      const headers = {};
      if (customApiKey) {
        headers['Authorization'] = `Bearer ${customApiKey}`;
      }

      const response = await axios.get(`${customEndpoint}/models`, {
        headers,
        timeout: 5000 // Longer timeout for remote endpoints
      });

      if (response.status === 200) {
        const models = response.data.data?.map(m => m.id) || ['default'];
        this.endpoints.push({
          name: 'Custom Endpoint',
          type: 'custom',
          baseURL: customEndpoint,
          apiKey: customApiKey || 'none',
          models: models,
          defaultModel: models[0],
          free: false,
          local: false,
          priority: 4
        });
        console.log(`✓ Found Custom Endpoint`);
        console.log(`  URL: ${customEndpoint}`);
        console.log(`  Models: ${models.join(', ')}`);
      }
    } catch (error) {
      console.log(`⚠️  Custom endpoint configured but not reachable: ${customEndpoint}`);
    }
  }

  /**
   * Priority 5-7: Detect Commercial LLMs
   */
  async detectCommercialLLMs() {
    // OpenAI (Priority 5)
    const openaiKey = process.env.TOKLIGENCE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.endpoints.push({
        name: 'OpenAI',
        type: 'openai',
        baseURL: 'https://api.openai.com/v1',
        apiKey: openaiKey,
        models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4-turbo',
        free: false,
        local: false,
        priority: 5
      });
      console.log('✓ Found OpenAI API Key');
    }

    // Anthropic (Priority 6)
    const anthropicKey = process.env.TOKLIGENCE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.endpoints.push({
        name: 'Anthropic',
        type: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        apiKey: anthropicKey,
        models: [
          'claude-sonnet-4-5-20250929',  // Latest Sonnet 4.5
          'claude-haiku-4-5-20251001',   // Latest Haiku 4.5
          'claude-opus-4-1-20250805',    // Latest Opus 4.1
          'claude-3-5-haiku-20241022',   // Haiku 3.5
          'claude-3-haiku-20240307'      // Haiku 3
        ],
        defaultModel: 'claude-sonnet-4-5-20250929',
        free: false,
        local: false,
        priority: 6
      });
      console.log('✓ Found Anthropic API Key');
    }

    // Google Gemini (Priority 7)
    const googleKey = process.env.TOKLIGENCE_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      this.endpoints.push({
        name: 'Google Gemini',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: googleKey,
        models: [
          'gemini-2.5-pro',         // Latest Pro model (2025)
          'gemini-2.5-flash',       // Latest Flash model (2025)
          'gemini-2.0-flash'        // Gemini 2.0 Flash
        ],
        defaultModel: 'gemini-2.5-flash',
        free: false,
        local: false,
        priority: 7
      });
      console.log('✓ Found Google Gemini API Key');
    }
  }

  /**
   * Priority 8: Detect Running Gateway
   */
  async detectGateway() {
    try {
      const response = await axios.get('http://localhost:8081/health', {
        timeout: this.timeout
      });

      if (response.status === 200) {
        this.endpoints.push({
          name: 'Tokligence Gateway',
          type: 'gateway',
          baseURL: 'http://localhost:8081',
          apiKey: 'gateway',
          models: ['gateway-unified'],
          defaultModel: 'gateway-unified',
          free: true,
          local: true,
          priority: 8
        });
        console.log('✓ Found running Tokligence Gateway');
      }
    } catch (error) {
      // Gateway not running - this is OK, it's optional
    }
  }

  /**
   * Sort endpoints by priority and return the best one
   * @returns {Object|null} Best available endpoint
   */
  getBest() {
    if (this.endpoints.length === 0) {
      return null;
    }

    // Sort by priority (lower number = higher priority)
    this.endpoints.sort((a, b) => a.priority - b.priority);
    return this.endpoints[0];
  }

  /**
   * Get all detected endpoints sorted by priority
   * @returns {Array} All endpoints
   */
  getAll() {
    return this.endpoints.sort((a, b) => a.priority - b.priority);
  }
}

/**
 * Interactive endpoint selection
 * @param {LLMDetector} detector - The detector instance
 * @returns {Promise<Object>} Selected endpoint
 */
async function selectEndpoint(detector) {
  const endpoints = detector.getAll();

  if (endpoints.length === 0) {
    console.log('\n❌ No LLM endpoints detected!\n');
    console.log('Please configure one of the following:\n');
    console.log('📦 Local LLMs (recommended, free):');
    console.log('  - Ollama: https://ollama.ai');
    console.log('  - vLLM: https://docs.vllm.ai');
    console.log('  - LM Studio: https://lmstudio.ai\n');
    console.log('🔑 Commercial LLMs:');
    console.log('  - export TOKLIGENCE_OPENAI_API_KEY=sk-...');
    console.log('  - export TOKLIGENCE_ANTHROPIC_API_KEY=sk-ant-...');
    console.log('  - export TOKLIGENCE_GOOGLE_API_KEY=AIza...\n');
    console.log('🔧 Custom endpoint:');
    console.log('  - export TOKLIGENCE_LLM_ENDPOINT=http://your-llm.com/v1');
    console.log('  - export TOKLIGENCE_LLM_API_KEY=optional-key\n');
    process.exit(1);
  }

  // If only one endpoint, use it
  if (endpoints.length === 1) {
    const endpoint = endpoints[0];
    console.log(`\n✓ Using ${endpoint.name}`);
    if (endpoint.free) {
      console.log('  (Free, ' + (endpoint.local ? 'running locally' : 'remote') + ')');
    }
    console.log('');
    return endpoint;
  }

  // Multiple endpoints - show selection
  console.log('\n✓ Multiple LLM endpoints detected:\n');
  endpoints.forEach((ep, idx) => {
    const badge = ep.free ? '🆓' : '💳';
    const location = ep.local ? 'local' : 'remote';
    console.log(`  ${idx + 1}. ${badge} ${ep.name} (${location})`);
  });

  // Auto-select the best one (highest priority)
  const best = detector.getBest();
  console.log(`\n✓ Auto-selecting: ${best.name} (highest priority)`);
  if (best.free) {
    console.log('  (Free, ' + (best.local ? 'running locally' : 'remote') + ')');
  }
  console.log('');

  return best;
}

module.exports = {
  LLMDetector,
  selectEndpoint
};
