import { INestApplication } from '@nestjs/common';
import { APIGatewayProxyEvent, APIGatewayProxyHandler, APIGatewayProxyResult, Context } from 'aws-lambda';
import { createServer, proxy } from 'aws-serverless-express';
import express from 'express';
import { Server } from 'http';
import { pino } from 'pino';

import createApp from './main';

const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info'
}).child({ context: 'Vercel Serverless' });

let cachedServer: Server;
let cachedApp: INestApplication;

async function bootstrap(): Promise<Server> {
  if (cachedServer) {
    logger.info('Using cached server instance');
    return cachedServer;
  }

  try {
    logger.info('Initializing server for serverless environment');
    const expressApp = express();
    
    // Remover o eventContext middleware que está causando problemas de tipagem
    // Não é essencial para o funcionamento na Vercel, é mais importante para AWS Lambda
    
    // Criar e inicializar a aplicação NestJS
    const nestApp: INestApplication = await createApp();
    await nestApp.init();
    cachedApp = nestApp;
    
    // Obter a instância do Express usado pelo NestJS
    const expressInstance = nestApp.getHttpAdapter().getInstance();
    
    // Assegurar que as rotas são copiadas corretamente
    if (expressInstance && expressInstance._router) {
      logger.info('Copying routes from NestJS Express instance');
      expressApp._router = expressInstance._router;
    } else {
      logger.warn('Could not access Express router from NestJS app');
    }
    
    cachedServer = createServer(expressApp);
    logger.info('Serverless server initialized successfully');
    return cachedServer;
  } catch (error) {
    logger.error('Failed to initialize serverless handler:', error);
    if (error instanceof Error) {
      logger.error(error.stack || 'No stack trace available');
    }
    throw error;
  }
}

// Corrigindo o handler para retornar o tipo correto
const handler: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  // Manter alive o contexto da lambda até que a resposta seja completada
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }
  
  try {
    const server = await bootstrap();
    
    return await new Promise<APIGatewayProxyResult>((resolve, reject) => {
      const proxyPromise = proxy(server, event, context);
      
      // Garantir que sempre retornamos um objeto compatível com APIGatewayProxyResult
      if (proxyPromise instanceof Promise) {
        proxyPromise
          .then(response => {
            if (typeof response === 'object' && 'statusCode' in response) {
              resolve(response as APIGatewayProxyResult);
            } else {
              // Fallback para uma resposta padrão se o proxy não retornar o formato esperado
              resolve({
                statusCode: 200,
                body: typeof response === 'string' ? response : JSON.stringify(response),
                headers: { 'Content-Type': 'application/json' }
              });
            }
          })
          .catch(error => {
            logger.error('Error in proxy handling:', error);
            resolve({
              statusCode: 500,
              body: JSON.stringify({ error: 'Internal Server Error' }),
              headers: { 'Content-Type': 'application/json' }
            });
          });
      } else {
        // Se não for uma Promise, tratar como resposta direta
        resolve({
          statusCode: 200,
          body: typeof proxyPromise === 'string' ? proxyPromise : JSON.stringify(proxyPromise),
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });
  } catch (error) {
    logger.error('Error in serverless handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }
};

// Exportação para HTTP standard handler (Vercel)
export default async function (req: any, res: any) {
  try {
    const server = await bootstrap();
    return proxy(server, req, res);
  } catch (error) {
    logger.error('Error in HTTP handler:', error);
    res.status(500).send('Internal Server Error');
  }
}

// Também exportar o handler para Lambda
export { handler };
