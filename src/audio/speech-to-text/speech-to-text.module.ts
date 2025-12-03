import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SpeechToTextService } from './speech-to-text.service';
import { AudioConverterService } from './audio-converter.service';

@Module({
  imports: [ConfigModule],
  providers: [SpeechToTextService, AudioConverterService],
  exports: [SpeechToTextService],
})
export class SpeechToTextModule {}
