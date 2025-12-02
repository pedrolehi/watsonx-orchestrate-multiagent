import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TextToSpeechV1 from 'ibm-watson/text-to-speech/v1';
import { IamAuthenticator } from 'ibm-watson/auth';

@Injectable()
export class TextToSpeechService {
  private readonly logger = new Logger(TextToSpeechService.name);
  private readonly textToSpeech: TextToSpeechV1;
  private readonly defaultVoice: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('TEXT_TO_SPEECH_API_KEY');
    const url = this.configService.get<string>('TEXT_TO_SPEECH_URL');
    this.defaultVoice =
      this.configService.get<string>('TEXT_TO_SPEECH_VOICE') ||
      'pt-BR_IsabelaV3Voice';

    if (!apiKey) {
      this.logger.warn(
        'TEXT_TO_SPEECH_API_KEY not configured. TTS service will not work.',
      );
    }

    if (!url) {
      this.logger.warn(
        'TEXT_TO_SPEECH_URL not configured. TTS service will not work.',
      );
    }

    if (apiKey && url) {
      this.textToSpeech = new TextToSpeechV1({
        authenticator: new IamAuthenticator({
          apikey: apiKey,
        }),
        serviceUrl: url,
      });
      this.logger.log('Text-to-Speech service initialized');
    }
  }

  /**
   * Sintetiza texto em áudio
   * @param text Texto a ser sintetizado
   * @param voice Voz a ser usada (opcional, usa default se não fornecido)
   * @returns Buffer com o áudio em formato WAV
   */
  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; contentType: string }> {
    if (!this.textToSpeech) {
      throw new Error(
        'Text-to-Speech service not configured. Check environment variables.',
      );
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const voiceToUse = voice || this.defaultVoice;

    try {
      this.logger.debug(`Synthesizing text with voice: ${voiceToUse}`, {
        textLength: text.length,
      });

      const response = await this.textToSpeech.synthesize({
        text: text,
        voice: voiceToUse,
        accept: 'audio/wav',
      });

      // Converter ReadableStream para Buffer
      const chunks: Buffer[] = [];
      const stream = response.result as any;

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          this.logger.debug('Audio synthesized successfully', {
            size: audioBuffer.length,
            voice: voiceToUse,
          });
          resolve({
            audio: audioBuffer,
            contentType: 'audio/wav',
          });
        });

        stream.on('error', (error: Error) => {
          this.logger.error('Error synthesizing audio', error);
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error('Error in synthesize', {
        error: error.message,
        voice: voiceToUse,
      });
      throw error;
    }
  }
}
