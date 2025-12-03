import { Module } from '@nestjs/common';
import { AudioCacheService } from './audio-cache.service';

@Module({
  providers: [AudioCacheService],
  exports: [AudioCacheService],
})
export class AudioCacheModule {}
