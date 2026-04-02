#!/usr/bin/env node

const { program } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { Gateway } = require('../lib');
const pkg = require('../package.json');
const { checkForUpdates } = require('../lib/update-checker');

const path = require('path');
const scriptName = path.basename(process.argv[1], '.js');
const isInteractiveShell = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

// Check for updates in background (non-blocking)
// Only check when running actual commands, not for --help or --version
const shouldCheckUpdate = process.argv.length > 2 &&
  !process.argv.includes('--help') &&
  !process.argv.includes('-h') &&
  !process.argv.includes('--version') &&
  !process.argv.includes('-V') &&
  isInteractiveShell;

if (shouldCheckUpdate) {
  // Run update check asynchronously without blocking
  setImmediate(() => {
    checkForUpdates(pkg.version, pkg.name, { silent: false }).catch(() => {
      // Silently ignore errors
    });
  });
}

program
  .name(scriptName === 'tgw' ? 'tgw' : 'tokligence')
  .description('Tokligence Gateway CLI - Multi-provider LLM Gateway')
  .version(pkg.version);

program
  .command('start')
  .description('Start Tokligence Gateway server')
  .option('-p, --port <port>', 'Port to listen on', '8081')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-d, --daemon', 'Run in daemon mode')
  .action(async (options) => {
    // Check if API keys are configured
    const hasEmail = process.env.TOKLIGENCE_EMAIL;
    const hasOpenAI = process.env.TOKLIGENCE_OPENAI_API_KEY;
    const hasAnthropic = process.env.TOKLIGENCE_ANTHROPIC_API_KEY;

    if (!hasEmail) {
      console.log(chalk.yellow('\n⚠️  TOKLIGENCE_EMAIL not set'));
    }

    if (!hasOpenAI && !hasAnthropic) {
      console.log(chalk.yellow('⚠️  No API keys configured'));
      console.log(chalk.gray('Gateway will run in loopback mode only.\n'));
      console.log(chalk.gray('To enable providers, set:'));
      console.log(chalk.gray('  export TOKLIGENCE_OPENAI_API_KEY=sk-...'));
      console.log(chalk.gray('  export TOKLIGENCE_ANTHROPIC_API_KEY=sk-ant-...\n'));
    }

    const spinner = ora('Starting Tokligence Gateway...').start();

    try {
      const gateway = new Gateway(options);
      await gateway.start();

      spinner.succeed(chalk.green(`Gateway started on http://${options.host}:${options.port}`));

      if (!options.daemon) {
        console.log(chalk.yellow('\nPress Ctrl+C to stop the server\n'));

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
          console.log('\n' + chalk.yellow('Shutting down...'));
          await gateway.stop();
          process.exit(0);
        });
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to start gateway'));

      console.error(chalk.yellow('\nReason:'), error.message);

      if (error.message.includes('not responding')) {
        console.log(chalk.cyan('\nPossible causes:'));
        console.log('  1. Missing TOKLIGENCE_EMAIL environment variable');
        console.log('  2. Port already in use');
        console.log('  3. Configuration error');

        console.log(chalk.cyan('\nDebug steps:'));
        console.log('  1. Check logs:   ', chalk.white('tgw logs'));
        console.log('  2. Check port:   ', chalk.white(`lsof -i :${options.port || 8081}`));
        console.log('  3. Check process:', chalk.white('ps aux | grep gatewayd'));
        console.log('  4. Check config: ', chalk.white('ls ~/.tokligence/config/'));
      }

      console.log(chalk.gray('\nFor more help: https://github.com/tokligence/tokligence-gateway-npm#troubleshooting'));

      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop Tokligence Gateway server')
  .action(async () => {
    const spinner = ora('Stopping Tokligence Gateway...').start();

    try {
      const gateway = new Gateway();
      await gateway.stop();
      spinner.succeed(chalk.green('Gateway stopped'));
    } catch (error) {
      spinner.fail(chalk.red('Failed to stop gateway'));
      console.error(error.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check Tokligence Gateway status')
  .action(async () => {
    try {
      const gateway = new Gateway();
      const status = await gateway.status();

      if (status.running) {
        console.log(chalk.green('✓ Gateway is running'));
        console.log(`  PID: ${status.pid}`);
        console.log(`  Port: ${status.port}`);
        console.log(`  Uptime: ${status.uptime}`);
      } else {
        console.log(chalk.yellow('○ Gateway is not running'));
      }
    } catch (error) {
      console.error(chalk.red('Failed to check status:'), error.message);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize Tokligence Gateway configuration')
  .option('-f, --force', 'Overwrite existing configuration')
  .action(async (options) => {
    const spinner = ora('Initializing configuration...').start();

    try {
      const gateway = new Gateway();
      await gateway.init(options);
      spinner.succeed(chalk.green('Configuration initialized'));
      console.log(chalk.gray('Configuration file created at: ~/.tokligence/config.yaml'));
    } catch (error) {
      spinner.fail(chalk.red('Failed to initialize configuration'));
      console.error(error.message);
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Manage Tokligence Gateway configuration')
  .addCommand(
    program.createCommand('get')
      .argument('<key>', 'Configuration key to get')
      .description('Get configuration value')
      .action(async (key) => {
        try {
          const gateway = new Gateway();
          const value = await gateway.getConfig(key);
          console.log(value);
        } catch (error) {
          console.error(chalk.red('Failed to get configuration:'), error.message);
          process.exit(1);
        }
      })
  )
  .addCommand(
    program.createCommand('set')
      .argument('<key>', 'Configuration key to set')
      .argument('<value>', 'Configuration value to set')
      .description('Set configuration value')
      .action(async (key, value) => {
        try {
          const gateway = new Gateway();
          await gateway.setConfig(key, value);
          console.log(chalk.green(`✓ Set ${key} = ${value}`));
        } catch (error) {
          console.error(chalk.red('Failed to set configuration:'), error.message);
          process.exit(1);
        }
      })
  )
  .addCommand(
    program.createCommand('list')
      .description('List all configuration')
      .action(async () => {
        try {
          const gateway = new Gateway();
          const config = await gateway.listConfig();
          console.log(JSON.stringify(config, null, 2));
        } catch (error) {
          console.error(chalk.red('Failed to list configuration:'), error.message);
          process.exit(1);
        }
      })
  );

program
  .command('logs')
  .description('View Tokligence Gateway logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <lines>', 'Number of lines to show', '20')
  .action(async (options) => {
    try {
      const gateway = new Gateway();
      await gateway.logs(options);
    } catch (error) {
      console.error(chalk.red('Failed to view logs:'), error.message);
      process.exit(1);
    }
  });

program
  .command('chat')
  .description('Interactive AI assistant for Tokligence Gateway configuration and help')
  .option('-m, --model <model>', 'Preferred model to use')
  .action(async (options) => {
    try {
      const { startChat } = require('../lib/chat');
      await startChat(options);
    } catch (error) {
      console.error(chalk.red('Failed to start chat:'), error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
