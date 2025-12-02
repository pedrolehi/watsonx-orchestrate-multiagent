import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import SpeechToTextV1 from 'ibm-watson/speech-to-text/v1';
import { IamAuthenticator } from 'ibm-watson/auth';

@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);
  private readonly speechToText: SpeechToTextV1;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('SPEECH_TO_TEXT_API_KEY');
    const url = this.configService.get<string>('SPEECH_TO_TEXT_URL');

    if (!apiKey) {
      this.logger.warn(
        'SPEECH_TO_TEXT_API_KEY not configured. STT service will not work.',
      );
    }

    if (!url) {
      this.logger.warn(
        'SPEECH_TO_TEXT_URL not configured. STT service will not work.',
      );
    }

    if (apiKey && url) {
      this.speechToText = new SpeechToTextV1({
        authenticator: new IamAuthenticator({
          apikey: apiKey,
        }),
        serviceUrl: url,
      });
      this.logger.log('Speech-to-Text service initialized');
    }
  }

  /**
   * Reconhece áudio e converte em texto
   * @param audioBuffer Buffer com o áudio
   * @param contentType Tipo MIME do áudio (ex: audio/wav, audio/flac, audio/ogg)
   * @returns Texto transcrito
   */
  async recognize(
    audioBuffer: Buffer,
    contentType: string = 'audio/wav',
  ): Promise<string> {
    if (!this.speechToText) {
      throw new Error(
        'Speech-to-Text service not configured. Check environment variables.',
      );
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('Audio buffer cannot be empty');
    }

    // Validar content type
    const validContentTypes = [
      'audio/wav',
      'audio/flac',
      'audio/ogg',
      'audio/ogg;codecs=opus',
    ];
    if (!validContentTypes.includes(contentType)) {
      throw new Error(
        `Invalid content type: ${contentType}. Supported: ${validContentTypes.join(', ')}`,
      );
    }

    try {
      this.logger.debug('Recognizing audio', {
        size: audioBuffer.length,
        contentType,
      });

      const response = await this.speechToText.recognize({
        audio: audioBuffer,
        contentType: contentType,
        model: 'pt-BR_BroadbandModel', // Modelo em português brasileiro
        maxAlternatives: 1,
      });

      const result = response.result;

      if (
        !result.results ||
        result.results.length === 0 ||
        !result.results[0].alternatives ||
        result.results[0].alternatives.length === 0
      ) {
        this.logger.warn('No transcription results found');
        return '';
      }

      const transcript = result.results[0].alternatives[0].transcript;
      const confidence = result.results[0].alternatives[0].confidence;

      this.logger.debug('Audio recognized successfully', {
        transcriptLength: transcript.length,
        confidence: confidence,
      });

      return transcript.trim();
    } catch (error) {
      this.logger.error('Error recognizing audio', {
        error: error.message,
        contentType,
      });
      throw error;
    }
  }
}
