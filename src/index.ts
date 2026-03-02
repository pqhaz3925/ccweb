import { loadConfig } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { startWebServer } from './transports/web.js';
import { startTelegramBot } from './transports/telegram.js';
import { closeDb } from './core/db.js';

async function main() {
  console.log('CCWeb v0.1.0 starting...');
  const config = loadConfig();

  const sessionManager = new SessionManager(config);

  // Start web server
  const server = await startWebServer(sessionManager, config.web.port, config.web.host);

  // Start Telegram bot if configured
  let bot: any = null;
  if (config.telegram.token) {
    bot = await startTelegramBot(sessionManager, config.telegram.token, config.telegram.allowedUsers);
  } else {
    console.log('[telegram] No token configured, skipping Telegram bot');
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await sessionManager.interrupt();
    if (bot) bot.stop();
    await server.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('CCWeb ready!');
  console.log(`  Web:      http://localhost:${config.web.port}`);
  if (config.telegram.token) {
    console.log('  Telegram: Bot connected');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
