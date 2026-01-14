import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrokerWidgetModule } from './broker-widget/broker-widget.module';
import { BrokerController } from './broker.controller';
import { MultiagentController } from './multiagent.controller';
import { TextToSpeechModule } from '../audio/text-to-speech/text-to-speech.module';
import { SpeechToTextModule } from '../audio/speech-to-text/speech-to-text.module';
import { AudioCacheModule } from '../audio/audio-cache/audio-cache.module';
import { PersistenceModule } from '../database/session/persistence.module';
import { UtilsModule } from '../utils/utils.module';

@Module({
  imports: [
    BrokerWidgetModule,
    AuthModule,
    TextToSpeechModule,
    SpeechToTextModule,
    AudioCacheModule,
    PersistenceModule,
    UtilsModule,
  ],
  controllers: [BrokerController, MultiagentController],
})
export class BrokerModule {}
