import { Module } from '@nestjs/common';
import { CoreService } from './core.service';
import { WatsonxModule } from '../watsonxorchestrate/watsonx.module';

@Module({
  imports: [WatsonxModule],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
