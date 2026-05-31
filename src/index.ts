import { loadConfig } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { startWebServer } from './transports/web.js';
import { startTelegramBot } from './transports/telegram.js';
import { closeDb } from './core/db.js';

async function main() {
  console.log('CCWeb v0.1.0 starting...');
  const config = loadConfig();

  const sessionManager = new SessionManager(config);

  // Start web server. Loud warning if it's reachable off-box with no auth —
  // the dashboard exposes unauthenticated permission/MCP/prompt control.
  if (config.web.host !== '127.0.0.1' && config.web.host !== 'localhost' && !config.web.password) {
    console.warn(
      `[web] SECURITY WARNING: binding to ${config.web.host} without web.password set. ` +
      `The dashboard is UNAUTHENTICATED and lets anyone with network access run code on this host. ` +
      `Set web.password in ccweb.config.json, or bind web.host to 127.0.0.1 and use a reverse proxy / SSH tunnel.`
    );
  }
  const server = await startWebServer(sessionManager, config.web.port, config.web.host, config.web.password);

  // Start Telegram bot if configured
  let bot: any = null;
  if (config.telegram.token) {
    bot = await startTelegramBot(sessionManager, config.telegram);
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

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Process kept alive:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Process kept alive:', reason);
});
