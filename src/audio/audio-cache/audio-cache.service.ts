import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

interface CachedAudio {
  audio: Buffer;
  contentType: string;
  timestamp: number;
}

@Injectable()
export class AudioCacheService {
  private readonly logger = new Logger(AudioCacheService.name);
  private readonly cache: Map<string, CachedAudio> = new Map();
  private readonly ttl: number = 24 * 60 * 60 * 1000; // 24 horas em milissegundos

  /**
   * Gera hash MD5 do texto e voz para usar como chave de cache
   */
  private generateCacheKey(text: string, voice: string): string {
    const hash = crypto.createHash('md5');
    hash.update(`${text}:${voice}`);
    return hash.digest('hex');
  }

  /**
   * Verifica se o cache está expirado
   */
  private isExpired(cachedAudio: CachedAudio): boolean {
    const now = Date.now();
    return now - cachedAudio.timestamp > this.ttl;
  }

  /**
   * Obtém áudio do cache se existir e não estiver expirado
   */
  get(
    text: string,
    voice: string,
  ): { audio: Buffer; contentType: string } | null {
    const key = this.generateCacheKey(text, voice);
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    if (this.isExpired(cached)) {
      this.cache.delete(key);
      this.logger.debug('Cache expired, removed', { key });
      return null;
    }

    this.logger.debug('Cache hit', { key, size: cached.audio.length });
    return {
      audio: cached.audio,
      contentType: cached.contentType,
    };
  }

  /**
   * Armazena áudio no cache
   */
  set(text: string, voice: string, audio: Buffer, contentType: string): void {
    const key = this.generateCacheKey(text, voice);
    this.cache.set(key, {
      audio,
      contentType,
      timestamp: Date.now(),
    });
    this.logger.debug('Audio cached', { key, size: audio.length });
  }

  /**
   * Limpa cache expirado
   */
  cleanExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, cached] of this.cache.entries()) {
      if (this.isExpired(cached)) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug('Cleaned expired cache entries', { count: cleaned });
    }
  }

  /**
   * Limpa todo o cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.debug('Cache cleared', { entriesRemoved: size });
  }

  /**
   * Retorna estatísticas do cache
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}
