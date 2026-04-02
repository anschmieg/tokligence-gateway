const readline = require('readline');
const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs');
const path = require('path');
const { LLMDetector, selectEndpoint } = require('./detector');
const { loadKnowledge, checkForUpdates, buildSystemPrompt } = require('./knowledge');
const { createClient, getModel, createStreamingChat } = require('./client');
const { tools, parseToolCalls, executeToolCalls, getPlatformInfo } = require('./agent');

/**
 * Main chat interface
 *
 * Interactive CLI chat for helping users configure and use Tokligence Gateway
 */
class ChatSession {
  constructor(endpoint, client, model, knowledge) {
    this.endpoint = endpoint;
    this.client = client;
    this.model = model;
    this.knowledge = knowledge;
    this.messages = [];
    this.conversationHistory = [];

    // Initialize system prompt
    const systemPrompt = buildSystemPrompt(knowledge);
    this.messages.push({
      role: 'system',
      content: systemPrompt
    });
  }

  /**
   * Start the interactive chat loop
   */
  async start() {
    const platformInfo = getPlatformInfo();

    // Load and display ASCII logo
    try {
      const logoPath = path.join(__dirname, '../../data/logo_ascii.txt');
      const logo = fs.readFileSync(logoPath, 'utf8');
      console.log(chalk.cyan(logo));
    } catch (error) {
      // Fallback to simple header if logo file not found
      console.log(chalk.cyan('\n╔═══════════════════════════════════════════╗'));
      console.log(chalk.cyan('║  ') + chalk.bold.white('⚡ TOKLIGENCE') + chalk.cyan('                    ║'));
      console.log(chalk.cyan('║  ') + chalk.gray('AI Gateway Assistant') + chalk.cyan('             ║'));
      console.log(chalk.cyan('╚═══════════════════════════════════════════╗\n'));
    }

    console.log(`Using: ${chalk.green(this.endpoint.name)}`);
    console.log(`Model: ${chalk.green(this.model)}`);
    console.log(`Platform: ${chalk.blue(platformInfo.platform)}`);

    // Brief privacy & safety notice
    console.log(chalk.gray(
      '\nPrivacy & safety: this assistant is designed to minimise data sent to remote LLM providers (e.g. masking API keys/tokens/secrets).'
    ));
    console.log(chalk.gray(
      'Do NOT paste raw API keys, tokens, passwords, or other secrets into this chat. Instead, use environment variables'
    ));
    console.log(chalk.gray(
      'or local config (e.g. "export TOKLIGENCE_OPENAI_API_KEY=..."; "tgw config set openai_api_key ...").'
    ));
    console.log(chalk.gray(
      'This tool is designed with modern data protection practices in mind (e.g. minimising what is sent to remote LLMs),'
    ));
    console.log(chalk.gray(
      'and works best when you also avoid sharing personal or secret information directly in chat. Thank you for your support.\n'
    ));

    // Check for documentation updates (async, non-blocking)
    this.checkUpdatesAsync();

    console.log(chalk.gray('Type your questions or requests. Type "exit" or "quit" to end the session.\n'));

    // Keep Node process alive for interactive sessions, even if
    // Commander or other libraries would normally allow the event
    // loop to exit when no pending work is detected.
    const keepAlive = setInterval(() => {}, 1 << 30);

    // Create readline interface
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.yellow('You: '),
      terminal: true  // Ensure terminal mode is enabled
    });

    // Flag to track if we're processing a response
    let isProcessing = false;

    rl.prompt();

    rl.on('line', async (input) => {
      // Prevent multiple simultaneous processing
      if (isProcessing) {
        return;
      }
      const userInput = input.trim();

      // Check for exit commands
      if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
        console.log(chalk.gray('\nGoodbye! 👋\n'));
        rl.close();
        return;
      }

      // Skip empty input
      if (!userInput) {
        rl.prompt();
        return;
      }

      // Add user message
      this.messages.push({
        role: 'user',
        content: userInput
      });

      // Mark as processing
      isProcessing = true;

      // Get AI response
      try {
        await this.getResponse(rl);
      } catch (error) {
        // Ensure we always return to prompt even if getResponse fails
        console.error(chalk.red(`\n❌ Unexpected error: ${error.message}\n`));
      } finally {
        // Always mark as done processing
        isProcessing = false;
      }

      // Always return to prompt after response
      console.log(''); // Add blank line before next prompt

      // Force a new prompt - use setImmediate to ensure it happens after any pending I/O
      setImmediate(() => {
        if (!rl.closed && rl.terminal) {
          rl.prompt();
        }
      });
    });

    // Handle close event
    rl.on('close', () => {
      clearInterval(keepAlive);
      // Only exit if we're not processing
      if (!isProcessing) {
        console.log(chalk.gray('\nGoodbye! 👋\n'));
        process.exit(0);
      }
    });

    // Prevent accidental stdin close
    process.stdin.on('end', () => {
      clearInterval(keepAlive);
      // Ignore stdin end events during normal operation
      if (!isProcessing) {
        console.log(chalk.gray('\nInput stream ended.\n'));
      }
    });
  }

  /**
   * Get AI response with tool calling support
   */
  async getResponse(rl) {
    let spinner = null;

    try {
      // Show thinking indicator
      // Note: discardStdin=false is critical here; otherwise
      // ora will create its own readline interface and swallow
      // user input after the first response.
      spinner = ora({
        text: chalk.gray('Thinking...'),
        spinner: 'dots',
        color: 'cyan',
        discardStdin: false
      }).start();

      let shouldContinue = true;
      let iterationCount = 0;
      const maxIterations = 5; // Prevent infinite loops

      while (shouldContinue && iterationCount < maxIterations) {
        iterationCount++;

        // Update spinner for iterations after first
        if (iterationCount > 1) {
          spinner.text = chalk.gray(`Processing (step ${iterationCount})...`);
        }

        // Create streaming chat completion
        const stream = await createStreamingChat(
          this.client,
          this.endpoint,
          this.model,
          this.messages,
          {
            tools,
            temperature: 0.7,
            maxTokens: 2048
          }
        );

        // Stop spinner and show Assistant label when response starts
        spinner.stop();
        if (iterationCount === 1) {
          console.log(chalk.cyan('\nAssistant: '));
        }

        let assistantMessage = '';
        let toolCalls = [];

        // Process stream based on endpoint type
        if (this.endpoint.type === 'google') {
          // Google Gemini streaming format
          for await (const chunk of stream.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              process.stdout.write(chunkText);
              assistantMessage += chunkText;
            }

            // Handle function calls
            if (chunk.functionCalls) {
              for (const fc of chunk.functionCalls) {
                toolCalls.push({
                  id: `google_${Date.now()}_${toolCalls.length}`,
                  type: 'function',
                  function: {
                    name: fc.name,
                    arguments: JSON.stringify(fc.args)
                  }
                });
              }
            }
          }

          shouldContinue = toolCalls.length > 0;
        } else if (this.endpoint.type === 'anthropic') {
          // Anthropic streaming format
          for await (const event of stream) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                process.stdout.write(event.delta.text);
                assistantMessage += event.delta.text;
              }
            } else if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                toolCalls.push({
                  id: event.content_block.id,
                  type: 'function',
                  function: {
                    name: event.content_block.name,
                    arguments: ''
                  }
                });
              }
            } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
              // Accumulate tool arguments
              const lastTool = toolCalls[toolCalls.length - 1];
              if (lastTool) {
                lastTool.function.arguments += event.delta.partial_json;
              }
            } else if (event.type === 'message_stop') {
              shouldContinue = toolCalls.length > 0;
            }
          }
        } else {
          // OpenAI streaming format
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;

            if (delta?.content) {
              // Stream text content to user
              process.stdout.write(delta.content);
              assistantMessage += delta.content;
            }

            // Handle tool calls
            if (delta?.tool_calls) {
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index;

                if (!toolCalls[index]) {
                  toolCalls[index] = {
                    id: toolCallDelta.id || '',
                    type: 'function',
                    function: {
                      name: '',
                      arguments: ''
                    }
                  };
                }

                if (toolCallDelta.id) {
                  toolCalls[index].id = toolCallDelta.id;
                }

                if (toolCallDelta.function?.name) {
                  toolCalls[index].function.name += toolCallDelta.function.name;
                }

                if (toolCallDelta.function?.arguments) {
                  toolCalls[index].function.arguments += toolCallDelta.function.arguments;
                }
              }
            }

            // Check if done
            if (chunk.choices[0]?.finish_reason === 'stop') {
              shouldContinue = false;
            } else if (chunk.choices[0]?.finish_reason === 'tool_calls') {
              shouldContinue = true;
            }
          }
        }

        console.log(''); // New line after streaming

        // Build assistant message object
        const messageObj = {
          role: 'assistant',
          content: assistantMessage || null
        };

        if (toolCalls.length > 0) {
          messageObj.tool_calls = toolCalls;
        }

        this.messages.push(messageObj);

        // Execute tool calls if present
        if (toolCalls.length > 0) {
          const parsedToolCalls = parseToolCalls(messageObj);
          const toolResults = await executeToolCalls(parsedToolCalls);

          // Add tool results to messages
          for (const result of toolResults) {
            this.messages.push(result);
          }

          // Continue the loop to get final response
          shouldContinue = true;
        } else {
          shouldContinue = false;
        }
      }

      // Ensure spinner is stopped at the end
      if (spinner && spinner.isSpinning) {
        spinner.stop();
      }

      if (iterationCount >= maxIterations) {
        console.log(chalk.yellow('\n⚠️  Maximum iterations reached. Please start a new query.'));
      }
    } catch (error) {
      // Make sure to stop spinner on error
      if (spinner && spinner.isSpinning) {
        spinner.stop();
      }
      console.error(chalk.red(`\n❌ Error: ${error.message}\n`));

      // Platform-specific error handling
      const platformInfo = getPlatformInfo();
      if (error.message.includes('ECONNREFUSED')) {
        console.log(chalk.yellow(`Note: Could not connect to ${this.endpoint.name}`));
        if (this.endpoint.local) {
          console.log(chalk.gray(`Please make sure it's running on ${this.endpoint.baseURL}`));
        }
      } else if (error.message.includes('401') || error.message.includes('unauthorized')) {
        console.log(chalk.yellow('Note: API key may be invalid or expired'));
      }
    }
  }

  /**
   * Check for documentation updates asynchronously
   */
  async checkUpdatesAsync() {
    try {
      const updateInfo = await checkForUpdates();
      if (updateInfo) {
        console.log(chalk.yellow(`\n📢 Documentation update available!`));
        console.log(chalk.gray(`   Current: ${updateInfo.current}`));
        console.log(chalk.gray(`   Latest: ${updateInfo.latest}`));
        console.log(chalk.gray(`   Visit: ${updateInfo.url}\n`));
      }
    } catch (error) {
      // Silently fail - not critical
    }
  }
}

/**
 * Main entry point for tgw chat
 */
async function startChat(options = {}) {
  try {
    console.log(chalk.bold('\n🚀 Starting Tokligence Gateway Chat...\n'));

    // Step 1: Detect available LLM endpoints
    const detector = new LLMDetector();
    await detector.detectAll();

    // Step 2: Select the best endpoint
    const endpoint = await selectEndpoint(detector);

    // Step 3: Create client
    const client = createClient(endpoint);
    const model = getModel(endpoint, options.model);

    // Step 4: Load knowledge base
    console.log('📚 Loading knowledge base...\n');
    const knowledge = await loadKnowledge();

    // Step 5: Start chat session
    const session = new ChatSession(endpoint, client, model, knowledge);
    await session.start();
  } catch (error) {
    console.error(chalk.red(`\n❌ Failed to start chat: ${error.message}\n`));

    // Provide helpful guidance
    const platformInfo = getPlatformInfo();
    console.log(chalk.yellow('Troubleshooting:'));

    if (platformInfo.isWindows) {
      console.log(chalk.gray('  • Check if Ollama/vLLM/LM Studio is running'));
      console.log(chalk.gray('  • Verify environment variables in System Properties'));
      console.log(chalk.gray('  • Try running as Administrator'));
    } else {
      console.log(chalk.gray('  • Check if Ollama/vLLM/LM Studio is running'));
      console.log(chalk.gray('  • Verify environment variables: printenv | grep TOKLIGENCE'));
      console.log(chalk.gray('  • Check file permissions in ~/.tokligence/'));
    }

    console.log(chalk.gray('\nFor more help, visit: https://github.com/tokligence/tokligence-gateway\n'));

    process.exit(1);
  }
}

module.exports = {
  startChat,
  ChatSession
};
