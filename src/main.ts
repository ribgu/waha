import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { WAHA_WEBHOOKS } from '@waha/structures/webhooks';
import {
  getNestJSLogLevels,
  getPinoLogLevel,
  getPinoTransport,
} from '@waha/utils/logging';
import { json, urlencoded } from 'express';
import { Logger as NestJSPinoLogger } from 'nestjs-pino';
import { LoggerErrorInterceptor } from 'nestjs-pino';
import { Logger } from 'pino';
import pino from 'pino';

import { WhatsappConfigService } from './config.service';
import { AppModuleCore } from './core/app.module.core';
import { SwaggerConfiguratorCore } from './core/SwaggerConfiguratorCore';
import { AllExceptionsFilter } from './nestjs/AllExceptionsFilter';
import { getWAHAVersion, VERSION, WAHAVersion } from './version';

const logger: Logger = pino({
  level: getPinoLogLevel(),
  transport: getPinoTransport(),
}).child({ name: 'Bootstrap' });

// Error handling for unexpected errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  if (err instanceof Error) {
    logger.error(err.stack);
  }
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise);
  if (reason instanceof Error) {
    logger.error(reason.stack);
  } else {
    logger.error('Unhandled rejection reason:', reason);
  }
});
logger.info('NODE - Catching unhandled rejections and exceptions enabled');

// Signal handling
process.on('SIGINT', () => {
  logger.info('SIGINT received');
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
});

// Load appropriate modules based on version
async function loadModules(): Promise<
  [typeof AppModuleCore, typeof SwaggerConfiguratorCore]
> {
  const version = getWAHAVersion();

  if (version === WAHAVersion.CORE) {
    logger.info('Loading Core version modules');
    const { AppModuleCore } = await import('./core/app.module.core');
    const { SwaggerConfiguratorCore } = await import(
      './core/SwaggerConfiguratorCore'
    );
    return [AppModuleCore, SwaggerConfiguratorCore];
  }
  // Ignore if it's core version - there's no plus module
  logger.info('Loading Plus version modules');
  // @ts-ignore
  const { AppModulePlus } = await import('./plus/app.module.plus');
  // @ts-ignore
  const { SwaggerConfiguratorPlus } = await import('./plus/SwaggerConfiguratorPlus'); // prettier-ignore
  // @ts-ignore
  return [AppModulePlus, SwaggerConfiguratorPlus];
}

// Create and configure NestJS application
async function createApp(): Promise<INestApplication> {
  try {
    const version = getWAHAVersion();
    logger.info(`WAHA (WhatsApp HTTP API) - Running ${version} version...`);
    
    const [AppModule, SwaggerModule] = await loadModules();
    const httpsOptions = AppModule.getHttpsOptions(logger);
    
    // Create NestJS application
    const app = await NestFactory.create(AppModule, {
      logger: getNestJSLogLevels(),
      httpsOptions: httpsOptions,
      bufferLogs: true,
      forceCloseConnections: true,
    });
    
    // Configure logging
    app.useLogger(app.get(NestJSPinoLogger));
    app.useGlobalInterceptors(new LoggerErrorInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    
    // Configure CORS and body parsing
    app.enableCors();
    app.use(json({ limit: '50mb' }));
    app.use(urlencoded({ limit: '50mb', extended: false }));
    
    // Configure WebSockets
    app.useWebSocketAdapter(new WsAdapter(app));

    // Configure Swagger documentation
    const swaggerConfigurator = new SwaggerModule(app);
    swaggerConfigurator.configure(WAHA_WEBHOOKS);

    // Final app preparation
    AppModule.appReady(app, logger);
    app.enableShutdownHooks();
    
    logger.info(VERSION, 'Environment');
    logger.info('Application successfully created and configured');
    
    return app;
  } catch (error) {
    logger.error('Failed to create application:', error);
    if (error instanceof Error) {
      logger.error(error.stack || 'No stack trace available');
    }
    throw error;
  }
}

// For traditional server - used in development
async function bootstrap() {
  const app = await createApp();
  const config = app.get(WhatsappConfigService);
  await app.listen(config.port);
  logger.info(`WhatsApp HTTP API is running on: ${await app.getUrl()}`);
}

// Only start server in non-serverless environments
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'vercel') {
  logger.info('Starting in traditional server mode');
  bootstrap().catch((error) => {
    logger.error(error, `Failed to start WAHA: ${error}`);
    if (error instanceof Error) {
      logger.error(error.stack || 'No stack trace available');
    }
    process.exit(1);
  });
} else {
  logger.info('Running in serverless mode - no server started');
}

// Export for serverless use
export default createApp;
