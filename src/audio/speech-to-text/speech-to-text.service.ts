import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import SpeechToTextV1 from 'ibm-watson/speech-to-text/v1';
import { IamAuthenticator } from 'ibm-watson/auth';
import { AudioConverterService } from './audio-converter.service';

@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);
  private readonly speechToText: SpeechToTextV1;
  private readonly confidenceThreshold: number;
  private readonly customizationId: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly audioConverter: AudioConverterService,
  ) {
    const apiKey = this.configService.get<string>('SPEECH_TO_TEXT_API_KEY');
    const url = this.configService.get<string>('SPEECH_TO_TEXT_URL');

    // Threshold de confiança (0-1). Valores recomendados: 0.2-0.7
    // Resultados abaixo deste threshold serão rejeitados ou avisados
    const threshold = this.configService.get<string>(
      'SPEECH_TO_TEXT_CONFIDENCE_THRESHOLD',
    );
    this.confidenceThreshold = threshold ? parseFloat(threshold) : 0.2;

    // ID do modelo customizado (opcional) - permite adicionar palavras em inglês ao vocabulário
    // Para criar: https://cloud.ibm.com/docs/speech-to-text?topic=speech-to-text-languageCreate
    this.customizationId = this.configService.get<string>(
      'SPEECH_TO_TEXT_CUSTOMIZATION_ID',
    );

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
      this.logger.log('Speech-to-Text service initialized', {
        confidenceThreshold: this.confidenceThreshold,
      });
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

    // Se for WebM, converter para WAV primeiro (formato sem perdas, ideal para STT)
    let finalAudioBuffer = audioBuffer;
    let finalContentType = contentType;

    if (
      contentType === 'audio/webm' ||
      contentType === 'audio/webm;codecs=opus'
    ) {
      this.logger.log('Convertendo WebM para WAV (PCM 16-bit, mono, 16kHz)...');
      try {
        finalAudioBuffer =
          await this.audioConverter.convertWebmToWav(audioBuffer);
        finalContentType = 'audio/wav';
        this.logger.log('Conversão WebM para WAV concluída');
      } catch (error) {
        this.logger.error('Erro ao converter WebM para WAV', {
          error: error.message,
        });
        throw new Error(
          `Não foi possível converter WebM para WAV: ${error.message}. ` +
            `Certifique-se de que o FFmpeg está instalado.`,
        );
      }
    }

    // Validar content type - apenas formatos aceitos pelo IBM Speech-to-Text
    const validContentTypes = [
      'audio/wav',
      'audio/flac',
      'audio/ogg',
      'audio/ogg;codecs=opus',
    ];

    if (!validContentTypes.includes(finalContentType)) {
      throw new Error(
        `Invalid content type: ${contentType} (converted to ${finalContentType}). Supported: ${validContentTypes.join(', ')}`,
      );
    }

    try {
      this.logger.debug('Recognizing audio', {
        originalSize: audioBuffer.length,
        finalSize: finalAudioBuffer.length,
        originalContentType: contentType,
        finalContentType: finalContentType,
      });

      // Estratégia multilíngue: tentar com modelos português e inglês em paralelo
      // Isso melhora a precisão quando há mistura de idiomas (ex: "teste forms")
      // Conforme Stack Overflow: https://stackoverflow.com/questions/72723732
      const primaryModel =
        this.configService.get<string>('SPEECH_TO_TEXT_MODEL') || 'pt-BR'; // LSM português
      const useMultilingual =
        this.configService.get<string>('SPEECH_TO_TEXT_MULTILINGUAL') !==
        'false'; // Habilitado por padrão

      // Configurações para lidar com silêncios longos
      // inactivity_timeout: tempo de inatividade (silêncio) em segundos antes de considerar fim do áudio
      // Valores recomendados: 30-300 segundos (padrão: 30)
      // Para pausas longas, aumentar este valor
      const inactivityTimeout =
        this.configService.get<number>('SPEECH_TO_TEXT_INACTIVITY_TIMEOUT') ||
        300; // 5 minutos por padrão para suportar pausas longas

      // end_of_phrase_silence_time: tempo de silêncio para considerar fim de frase (em segundos)
      // Valores recomendados: 0.4-3.0 segundos (padrão: 0.4)
      const endOfPhraseSilenceTime =
        this.configService.get<number>(
          'SPEECH_TO_TEXT_END_OF_PHRASE_SILENCE_TIME',
        ) || 2.5; // 2.5 segundos para tolerar pausas longas entre frases

      const baseParams: any = {
        audio: finalAudioBuffer,
        contentType: finalContentType,
        maxAlternatives: 3,
        smartFormatting: true,
        profanityFilter: false,
        timestamps: true,
        wordConfidence: true,
        inactivityTimeout: inactivityTimeout, // Suporta silêncios longos (até 5 minutos)
        endOfPhraseSilenceTime: endOfPhraseSilenceTime, // Tolerância para pausas entre frases
        splitTranscriptAtPhraseEnd: true, // Divide transcrição em frases quando há silêncio
      };

      // Adicionar customization_id se configurado
      if (this.customizationId) {
        baseParams.customizationId = this.customizationId;
        this.logger.debug('Using custom language model', {
          customizationId: this.customizationId,
        });
      }

      // Chamar modelo português (principal)
      const ptParams = {
        ...baseParams,
        model: primaryModel,
      };

      // Se multilíngue estiver habilitado, também chamar modelo inglês em paralelo
      const promises: Promise<any>[] = [this.speechToText.recognize(ptParams)];

      if (useMultilingual) {
        const enParams = {
          ...baseParams,
          model: 'en-US_Multimedia', // Next-generation modelo inglês
        };
        promises.push(this.speechToText.recognize(enParams));
      }

      // Executar chamadas em paralelo
      const responses = await Promise.allSettled(promises);

      // Processar resultados
      const results: Array<{
        transcript: string;
        confidence: number;
        model: string;
        alternatives: any[];
      }> = [];

      // Processar resultado português
      if (responses[0].status === 'fulfilled') {
        const ptResult = this.extractBestAlternative(
          responses[0].value.result,
          primaryModel,
        );
        if (ptResult) {
          results.push(ptResult);
        }
      } else {
        this.logger.warn('Erro ao reconhecer com modelo português', {
          error: (responses[0] as PromiseRejectedResult).reason,
        });
      }

      // Processar resultado inglês (se disponível)
      if (useMultilingual && responses[1]?.status === 'fulfilled') {
        const enResult = this.extractBestAlternative(
          responses[1].value.result,
          'en-US',
        );
        if (enResult) {
          results.push(enResult);
        }
      } else if (useMultilingual && responses[1]?.status === 'rejected') {
        this.logger.warn('Erro ao reconhecer com modelo inglês', {
          error: (responses[1] as PromiseRejectedResult).reason,
        });
      }

      // Escolher o melhor resultado baseado na confiança
      if (results.length === 0) {
        this.logger.warn('No transcription results found from any model');
        return '';
      }

      // Coletar TODAS as alternativas de todos os modelos para análise completa
      const allAlternatives: Array<{
        transcript: string;
        confidence: number;
        model: string;
      }> = [];

      for (const result of results) {
        // Adicionar a melhor alternativa de cada modelo
        allAlternatives.push({
          transcript: result.transcript,
          confidence: result.confidence,
          model: result.model,
        });

        // Adicionar outras alternativas do mesmo modelo (se houver)
        if (result.alternatives && result.alternatives.length > 1) {
          for (let i = 1; i < result.alternatives.length; i++) {
            allAlternatives.push({
              transcript: result.alternatives[i].transcript,
              confidence: result.alternatives[i].confidence,
              model: result.model,
            });
          }
        }
      }

      // Ordenar TODAS as alternativas por confiança
      allAlternatives.sort((a, b) => b.confidence - a.confidence);
      const bestOverallAlternative = allAlternatives[0];

      // Log detalhado de TODAS as alternativas para debug
      this.logger.log('Todas as alternativas de transcrição', {
        totalModels: results.length,
        totalAlternatives: allAlternatives.length,
        allAlternatives: allAlternatives.map((alt, index) => ({
          rank: index + 1,
          model: alt.model,
          transcript: alt.transcript,
          confidence: alt.confidence.toFixed(3),
        })),
        selected: {
          model: bestOverallAlternative.model,
          transcript: bestOverallAlternative.transcript,
          confidence: bestOverallAlternative.confidence.toFixed(3),
        },
      });

      // Usar a melhor alternativa encontrada
      const transcript = bestOverallAlternative.transcript;
      const confidence = bestOverallAlternative.confidence;

      // Verificar threshold de confiança (recomendação IBM)
      if (confidence < this.confidenceThreshold) {
        this.logger.warn(
          `Transcrição com confiança baixa (${confidence.toFixed(2)}) abaixo do threshold (${this.confidenceThreshold}). Resultado pode estar incorreto.`,
          {
            transcript,
            confidence,
            threshold: this.confidenceThreshold,
            allAlternatives: allAlternatives.map((alt) => alt.transcript),
          },
        );
        // Continuamos mesmo assim, mas avisamos o usuário via log
      }

      this.logger.debug('Audio recognized successfully', {
        transcriptLength: transcript.length,
        confidence: confidence,
        threshold: this.confidenceThreshold,
        aboveThreshold: confidence >= this.confidenceThreshold,
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

  /**
   * Extrai todas as alternativas de um resultado do IBM Speech-to-Text
   * @param result Resultado da API
   * @param modelName Nome do modelo usado
   * @returns Objeto com melhor alternativa e todas as alternativas, ou null se não houver resultados
   */
  private extractBestAlternative(
    result: any,
    modelName: string,
  ): {
    transcript: string;
    confidence: number;
    model: string;
    alternatives: Array<{ transcript: string; confidence: number }>;
  } | null {
    if (
      !result.results ||
      result.results.length === 0 ||
      !result.results[0].alternatives ||
      result.results[0].alternatives.length === 0
    ) {
      return null;
    }

    const alternatives = result.results[0].alternatives || [];
    const sortedAlternatives = alternatives
      .map((alt: any) => ({
        transcript: alt.transcript,
        confidence: alt.confidence || 0,
      }))
      .sort((a: any, b: any) => b.confidence - a.confidence);

    const best = sortedAlternatives[0];

    this.logger.debug(`Alternativas do modelo ${modelName}`, {
      model: modelName,
      totalAlternatives: sortedAlternatives.length,
      alternatives: sortedAlternatives.map((alt, idx) => ({
        rank: idx + 1,
        transcript: alt.transcript,
        confidence: alt.confidence.toFixed(3),
      })),
    });

    return {
      transcript: best.transcript,
      confidence: best.confidence,
      model: modelName,
      alternatives: sortedAlternatives,
    };
  }
}
