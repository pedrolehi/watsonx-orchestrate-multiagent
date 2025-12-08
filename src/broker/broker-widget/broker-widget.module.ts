import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoreModule } from '../../core/core.module';
import { SpeechToTextModule } from '../../audio/speech-to-text/speech-to-text.module';
import { WatsonxModule } from '../../watsonxorchestrate/watsonx.module';
import { BrokerWidgetService } from './broker-widget.service';

@Module({
  imports: [CoreModule, AuthModule, SpeechToTextModule, WatsonxModule],
  providers: [BrokerWidgetService],
  exports: [BrokerWidgetService],
})
export class BrokerWidgetModule {}
