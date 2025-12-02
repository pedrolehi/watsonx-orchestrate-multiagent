import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrokerWidgetModule } from './broker-widget/broker-widget.module';
import { BrokerController } from './broker.controller';
import { TextToSpeechModule } from '../watsonxorchestrate/text-to-speech.module';
import { SpeechToTextModule } from '../watsonxorchestrate/speech-to-text.module';
import { AudioCacheService } from '../watsonxorchestrate/audio-cache.service';

@Module({
  imports: [
    BrokerWidgetModule,
    AuthModule,
    TextToSpeechModule,
    SpeechToTextModule,
  ],
  controllers: [BrokerController],
  providers: [AudioCacheService],
  exports: [AudioCacheService],
})
export class BrokerModule {}
