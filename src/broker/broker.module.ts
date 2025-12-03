import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrokerWidgetModule } from './broker-widget/broker-widget.module';
import { BrokerController } from './broker.controller';
import { TextToSpeechModule } from '../audio/text-to-speech/text-to-speech.module';
import { SpeechToTextModule } from '../audio/speech-to-text/speech-to-text.module';
import { AudioCacheModule } from '../audio/audio-cache/audio-cache.module';

@Module({
  imports: [
    BrokerWidgetModule,
    AuthModule,
    TextToSpeechModule,
    SpeechToTextModule,
    AudioCacheModule,
  ],
  controllers: [BrokerController],
})
export class BrokerModule {}
