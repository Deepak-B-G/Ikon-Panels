import { Handler } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import express from 'express';
import serverless from 'serverless-http';

let server: Handler;

async function bootstrap(): Promise<Handler> {
  const expressApp = express();

  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    logger: ['error', 'warn', 'log'],
  });

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: '*',
  });

  app.setGlobalPrefix('api/v1');
  await app.init();

  return serverless(expressApp);
}

export const handler: Handler = async (event, context, callback) => {
  console.log('EVENT:', JSON.stringify(event));

  if (!server) {
    server = await bootstrap();
  }

  return server(event, context, callback);
};
