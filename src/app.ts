import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './http/error-mapping';
import { NestPinoLogger } from './infrastructure/observability/logger';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(), bufferLogs: true });
  app.useGlobalFilters(new ApiExceptionFilter());
  // SIGTERM/SIGINT → beforeApplicationShutdown: the consumer finishes in-flight messages and
  // returns the not-started ones to the queue before the process exits.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
