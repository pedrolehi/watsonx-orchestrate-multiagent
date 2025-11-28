import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// import { patchNestJsSwagger } from 'nestjs-zod'; // Removendo se causar erro

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  // Middleware para logar todas as requisições
  app.use((req: any, res: any, next: any) => {
    console.log('=== [MIDDLEWARE] Requisição recebida ===');
    console.log('[MIDDLEWARE]', {
      method: req.method,
      url: req.url,
      path: req.path,
      originalUrl: req.originalUrl,
      headers: {
        'content-type': req.headers['content-type'],
        accept: req.headers['accept'],
      },
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
    });
    next();
  });

  // patchNestJsSwagger(); // Desativado

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      skipMissingProperties: false,
      // Não validar se for multipart/form-data (será validado depois do multer)
      skipNullProperties: false,
      skipUndefinedProperties: false,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Senac Watsonx Orchestrate Broker')
    .setDescription('Broker API for Watsonx Orchestrate Integration')
    .setVersion('1.0')
    .addTag('Broker')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT || 3334;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
