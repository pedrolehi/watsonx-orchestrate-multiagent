import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TextToSpeechService } from './text-to-speech.service';

@Module({
  imports: [ConfigModule],
  providers: [TextToSpeechService],
  exports: [TextToSpeechService],
})
export class TextToSpeechModule {}
