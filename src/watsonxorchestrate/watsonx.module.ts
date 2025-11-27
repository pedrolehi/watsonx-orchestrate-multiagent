import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WatsonxService } from './watsonx.service';

@Module({
  imports: [ConfigModule],
  providers: [WatsonxService],
  exports: [WatsonxService],
})
export class WatsonxModule {}
