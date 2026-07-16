import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module';

async function bootstrap() {
  console.log('[bootstrap] Starting NestJS...');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  console.log('[bootstrap] App created, setting up logger...');

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  console.log('[bootstrap] Logger set, loading config...');

  // 获取配置服务
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') || 3000;
  const apiPrefix = configService.get<string>('app.apiPrefix') || '/ai_mule/web_api/v1';

  // 设置全局前缀
  app.setGlobalPrefix(apiPrefix);

  // 启用 CORS
  app.enableCors();

  // 全局验证管道
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 配置 Swagger
  const config = new DocumentBuilder()
    .setTitle('AI Mule Server API')
    .setDescription('AI Mule Server API 文档')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: '请输入 JWT Token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  await app.listen(port);

  console.log(`
    ========================================
    🚀 Application is running on: http://localhost:${port}
    📚 API Documentation: http://localhost:${port}/api-docs
    🔧 API Prefix: ${apiPrefix}
    🏥 Health Check: http://localhost:${port}${apiPrefix}/health
    ========================================
  `);
}

bootstrap();
