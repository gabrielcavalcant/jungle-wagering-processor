import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { openApiDocument } from './http/openapi';
import { ApiExceptionFilter } from './http/error-mapping';
import { NestPinoLogger } from './infrastructure/observability/logger';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(), bufferLogs: true });
  app.useGlobalFilters(new ApiExceptionFilter());
  // Swagger UI at /docs, raw contract at /docs/openapi.json (no authentication, like health).
  SwaggerModule.setup('docs', app, openApiDocument, {
    jsonDocumentUrl: 'docs/openapi.json',
    customSiteTitle: 'Wagering Processor API',
    // Request boxes open already editable and pre-filled with the examples; show how long each call took.
    swaggerOptions: { tryItOutEnabled: true, displayRequestDuration: true, docExpansion: 'list', defaultModelsExpandDepth: -1 },
  });
  // SIGTERM/SIGINT → beforeApplicationShutdown: the consumer finishes in-flight messages and
  // returns the not-started ones to the queue before the process exits.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
