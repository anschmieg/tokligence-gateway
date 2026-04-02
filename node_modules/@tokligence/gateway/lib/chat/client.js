const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Create appropriate client based on endpoint type
 *
 * - OpenAI SDK for: Ollama, vLLM, LM Studio, OpenAI, Custom endpoints
 * - Anthropic SDK for: Anthropic (native, better tool support)
 * - Google Generative AI SDK for: Google Gemini (native)
 * - OpenAI SDK for: Gateway (OpenAI-compatible)
 */

/**
 * Create client for the selected endpoint
 * @param {Object} endpoint - Endpoint configuration from detector
 * @returns {Object} Client instance (OpenAI or Anthropic)
 */
function createClient(endpoint) {
  switch (endpoint.type) {
    case 'anthropic':
      // Use native Anthropic SDK for best compatibility
      return new Anthropic({
        apiKey: endpoint.apiKey
      });

    case 'google':
      // Use native Google Generative AI SDK
      return new GoogleGenerativeAI(endpoint.apiKey);

    case 'ollama':
    case 'vllm':
    case 'lmstudio':
    case 'custom':
    case 'gateway':
    case 'openai':
    default:
      // Use OpenAI SDK for all OpenAI-compatible endpoints
      return new OpenAI({
        baseURL: endpoint.baseURL,
        apiKey: endpoint.apiKey
      });
  }
}

/**
 * Test the client connection
 * @param {Object} client - Client instance
 * @param {Object} endpoint - Endpoint configuration
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection(client, endpoint) {
  try {
    if (endpoint.type === 'anthropic') {
      // Anthropic doesn't have a models.list endpoint
      // We'll just assume it's working if we have an API key
      return true;
    } else {
      // OpenAI-compatible: try to list models
      const models = await client.models.list();
      return models.data && models.data.length > 0;
    }
  } catch (error) {
    console.error(`❌ Connection test failed for ${endpoint.name}:`, error.message);
    return false;
  }
}

/**
 * Get the appropriate model name for the endpoint
 * @param {Object} endpoint - Endpoint configuration
 * @param {string} preferredModel - Optional preferred model
 * @returns {string} Model name to use
 */
function getModel(endpoint, preferredModel = null) {
  // If user specified a model and it's available, use it
  if (preferredModel && endpoint.models.includes(preferredModel)) {
    return preferredModel;
  }

  // Otherwise use the default model for this endpoint
  return endpoint.defaultModel;
}

/**
 * Create a streaming chat completion (OpenAI SDK)
 * @param {OpenAI} client - OpenAI client
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages
 * @param {Object} options - Additional options
 * @returns {Promise<Stream>} Streaming response
 */
async function createStreamingChatOpenAI(client, model, messages, options = {}) {
  return await client.chat.completions.create({
    model,
    messages,
    stream: true,
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 2048,
    tools: options.tools || undefined,
    tool_choice: options.toolChoice || undefined
  });
}

/**
 * Create a streaming chat completion (Anthropic SDK)
 * @param {Anthropic} client - Anthropic client
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages (OpenAI format)
 * @param {Object} options - Additional options
 * @returns {Promise<Stream>} Streaming response
 */
async function createStreamingChatAnthropic(client, model, messages, options = {}) {
  // Convert OpenAI messages to Anthropic format
  const { system, anthropicMessages } = convertMessagesToAnthropic(messages);

  // Convert OpenAI tools to Anthropic tools
  const anthropicTools = options.tools
    ? convertToolsToAnthropic(options.tools)
    : undefined;

  return await client.messages.stream({
    model,
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature || 0.7,
    system: system || undefined,
    messages: anthropicMessages,
    tools: anthropicTools
  });
}

/**
 * Convert OpenAI messages format to Anthropic format
 * @param {Array} messages - OpenAI format messages
 * @returns {Object} { system, anthropicMessages }
 */
function convertMessagesToAnthropic(messages) {
  let system = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      anthropicMessages.push({
        role: msg.role,
        content: msg.content
      });
    } else if (msg.role === 'tool') {
      // Anthropic uses tool_result
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        }]
      });
    }
  }

  return { system, anthropicMessages };
}

/**
 * Convert OpenAI tools format to Anthropic format
 * @param {Array} tools - OpenAI format tools
 * @returns {Array} Anthropic format tools
 */
function convertToolsToAnthropic(tools) {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

/**
 * Create a streaming chat completion (Google SDK)
 * @param {GoogleGenerativeAI} client - Google client
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages (OpenAI format)
 * @param {Object} options - Additional options
 * @returns {Promise<Stream>} Streaming response
 */
async function createStreamingChatGoogle(client, model, messages, options = {}) {
  // Convert OpenAI messages to Google format
  const { systemInstruction, googleMessages} = convertMessagesToGoogle(messages);

  // Convert OpenAI tools to Google tools
  const googleTools = options.tools
    ? convertToolsToGoogle(options.tools)
    : undefined;

  const genModel = client.getGenerativeModel({
    model,
    systemInstruction,
    tools: googleTools
  });

  const chat = genModel.startChat({
    history: googleMessages.slice(0, -1) // All but last message
  });

  // Send last message and stream response
  const lastMessage = googleMessages[googleMessages.length - 1];
  return await chat.sendMessageStream(lastMessage.parts);
}

/**
 * Convert OpenAI messages to Google Gemini format
 * @param {Array} messages - OpenAI format messages
 * @returns {Object} { systemInstruction, googleMessages }
 */
function convertMessagesToGoogle(messages) {
  let systemInstruction = '';
  const googleMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = msg.content;
    } else if (msg.role === 'user') {
      googleMessages.push({
        role: 'user',
        parts: [{ text: msg.content }]
      });
    } else if (msg.role === 'assistant') {
      googleMessages.push({
        role: 'model',
        parts: [{ text: msg.content || '' }]
      });
    } else if (msg.role === 'tool') {
      // Google uses functionResponse
      googleMessages.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: msg.name,
            response: JSON.parse(msg.content)
          }
        }]
      });
    }
  }

  return { systemInstruction, googleMessages };
}

/**
 * Convert OpenAI tools to Google Gemini format
 * @param {Array} tools - OpenAI format tools
 * @returns {Array} Google format tools
 */
function convertToolsToGoogle(tools) {
  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }))
  };
}

/**
 * Unified streaming chat creation
 * @param {Object} client - Client instance (OpenAI, Anthropic, or Google)
 * @param {Object} endpoint - Endpoint configuration
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages
 * @param {Object} options - Additional options
 * @returns {Promise<Stream>} Streaming response
 */
async function createStreamingChat(client, endpoint, model, messages, options = {}) {
  if (endpoint.type === 'anthropic') {
    return await createStreamingChatAnthropic(client, model, messages, options);
  } else if (endpoint.type === 'google') {
    return await createStreamingChatGoogle(client, model, messages, options);
  } else {
    return await createStreamingChatOpenAI(client, model, messages, options);
  }
}

/**
 * Create a non-streaming chat completion (OpenAI SDK)
 * @param {OpenAI} client - OpenAI client
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Chat completion response
 */
async function createChatOpenAI(client, model, messages, options = {}) {
  return await client.chat.completions.create({
    model,
    messages,
    stream: false,
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 2048,
    tools: options.tools || undefined,
    tool_choice: options.toolChoice || undefined
  });
}

/**
 * Create a non-streaming chat completion (Anthropic SDK)
 * @param {Anthropic} client - Anthropic client
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages (OpenAI format)
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Chat completion response
 */
async function createChatAnthropic(client, model, messages, options = {}) {
  const { system, anthropicMessages } = convertMessagesToAnthropic(messages);
  const anthropicTools = options.tools
    ? convertToolsToAnthropic(options.tools)
    : undefined;

  return await client.messages.create({
    model,
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature || 0.7,
    system: system || undefined,
    messages: anthropicMessages,
    tools: anthropicTools
  });
}

/**
 * Unified chat creation
 * @param {Object} client - Client instance (OpenAI or Anthropic)
 * @param {Object} endpoint - Endpoint configuration
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Chat completion response
 */
async function createChat(client, endpoint, model, messages, options = {}) {
  if (endpoint.type === 'anthropic') {
    return await createChatAnthropic(client, model, messages, options);
  } else {
    return await createChatOpenAI(client, model, messages, options);
  }
}

module.exports = {
  createClient,
  testConnection,
  getModel,
  createStreamingChat,
  createChat,
  convertMessagesToAnthropic,
  convertToolsToAnthropic
};
