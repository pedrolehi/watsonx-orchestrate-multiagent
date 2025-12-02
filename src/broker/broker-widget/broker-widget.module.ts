import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoreModule } from '../../core/core.module';
import { SpeechToTextModule } from '../../watsonxorchestrate/speech-to-text.module';
import { BrokerWidgetService } from './broker-widget.service';

@Module({
  imports: [CoreModule, AuthModule, SpeechToTextModule],
  providers: [BrokerWidgetService],
  exports: [BrokerWidgetService],
})
export class BrokerWidgetModule {}
