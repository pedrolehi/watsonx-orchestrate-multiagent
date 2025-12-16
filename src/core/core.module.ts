import { Module } from '@nestjs/common';
import { CoreService } from './core.service';
import { WatsonxModule } from '../watsonxorchestrate/watsonx.module';
import { PersistenceModule } from '../database/session/persistence.module';

@Module({
  imports: [WatsonxModule, PersistenceModule],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
