import { INestApplication } from '@nestjs/common';
import { createServer, proxy } from 'aws-serverless-express';
import { eventContext } from 'aws-serverless-express/middleware';
import express from 'express';
import { Server } from 'http';
import { pino } from 'pino';

import createApp from './main';

const logger = pino({ level: 'info' }).child({ context: 'Vercel Serverless' });

let cachedServer: Server;

async function bootstrap(): Promise<Server> {
  if (cachedServer) {
    return cachedServer;
  }

  try {
    const expressApp = express();
    expressApp.use(eventContext());
    
    const nestApp: INestApplication = await createApp();
    await nestApp.init();
    
    // Acesso ao Express subjacente usando o adaptador HTTP
    const expressInstance = nestApp.getHttpAdapter().getInstance();
    
    // Copiar as rotas do app NestJS para o nosso app Express
    if (expressInstance && expressInstance._router && expressInstance._router.stack) {
      expressApp._router = expressInstance._router;
    } else {
      logger.warn('Não foi possível acessar as rotas do Express no app NestJS');
    }
    
    cachedServer = createServer(expressApp);
    return cachedServer;
  } catch (error) {
    logger.error('Failed to initialize serverless handler:', error);
    throw error;
  }
}

export default async function handler(req: any, res: any) {
  try {
    const server = await bootstrap();
    return proxy(server, req, res);
  } catch (error) {
    logger.error('Error in serverless handler:', error);
    res.status(500).send('Internal Server Error');
  }
}
