import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './presentation/filters/domain-exception.filter';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule.register(), {
    logger: ['error', 'warn', 'log'],
  });

  app.useGlobalFilters(new DomainExceptionFilter());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`[DistributedWageringProcessor] Listening on http://localhost:${port}`);
  return app;
}

if (import.meta.main) {
  bootstrap();
}
