import { Injectable, Logger } from '@nestjs/common';
import { CoreRunDto, CoreRunResponseDto } from './dto/core.dto';
import {
  WatsonxService,
  StatusCallback,
} from '../watsonxorchestrate/watsonx.service';
import { StatusEvent } from '../watsonxorchestrate/tool-status.constants';

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);

  // Mapeamento session_id -> thread_id (persistência em memória)
  // O widget controla a sessão, o backend controla o thread do Watson Orchestrate
  private readonly sessionThreadMap = new Map<string, string>();

  constructor(private readonly watsonxService: WatsonxService) {}

  /**
   * Verifica se uma sessão já tem um thread mapeado
   * Usado pelo BrokerWidgetService para determinar isFirstMessage
   */
  hasExistingThread(sessionId: string): boolean {
    return this.sessionThreadMap.has(sessionId);
  }

  /**
   * Verifica se o texto contém um formulário JSON
   */
  private isFormSubmission(text: string): boolean {
    if (!text) return false;
    try {
      const parsed = JSON.parse(text);
      return !!(parsed.form_name && parsed.form_data);
    } catch {
      return false;
    }
  }

  async run(
    payload: CoreRunDto,
    assistant: any, // Removido tipo Assistant estrito
    files?: Array<Express.Multer.File>,
    onStatus?: StatusCallback,
  ): Promise<CoreRunResponseDto> {
    const sessionId = payload.conversationId;
    this.logger.log(`Processing message for session: ${sessionId}`);

    // Integração básica: enviar mensagem e retornar resposta
    // agentId pode vir na raiz do payload (preferencial) ou no context como fallback
    const agentId = payload.agentId || payload.context?.agent_id;

    if (!agentId) {
      throw new Error(
        'Agent ID not provided. Widget must send assistantId (UUID do agent no Watson Orchestrate)',
      );
    }

    // Recuperar thread_id do mapeamento interno (session_id -> thread_id)
    // O backend persiste o thread_id, não o widget
    const existingThreadId = this.sessionThreadMap.get(sessionId);
    const isFirstMessage = !existingThreadId;

    this.logger.debug(
      `Message type: ${isFirstMessage ? 'First message (new thread)' : `Continuing thread: ${existingThreadId}`}`,
    );

    try {
      let wxResponse: any;

      if (files && files.length > 0 && existingThreadId) {
        // Upload de arquivos - requer thread_id existente
        // O upload_field_id vem do campo 'name' do file_upload response
        const uploadFieldId =
          payload.context?.upload_field_id ||
          payload.context?.upload_field_name ||
          'file_upload';

        this.logger.log('Processing file upload', {
          filesCount: files.length,
          uploadFieldId,
          threadId: existingThreadId,
        });

        // Fazer upload de cada arquivo para S3
        // S3 retorna: { fileName, id, url, statusCode, invalid }
        // NOTA: Arquivos de áudio são transcritos mas NÃO são enviados para S3
        // (o Watson Orchestrate S3 não aceita formatos de áudio como webm, ogg, etc)
        const uploadedFiles: Array<{
          fileName: string;
          id: string | null;
          url: string;
          statusCode: number;
          invalid: boolean;
        }> = [];

        for (const file of files) {
          // Pular arquivos de áudio - eles são apenas transcritos, não precisam ir para S3
          const isAudioFile =
            file.mimetype?.startsWith('audio/') ||
            file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i);

          if (isAudioFile) {
            this.logger.log('Pulando upload de arquivo de áudio para S3', {
              fileName: file.originalname,
              mimetype: file.mimetype,
            });
            // Criar entrada "vazia" para manter consistência, mas marcada como não enviada
            uploadedFiles.push({
              fileName: file.originalname,
              id: null,
              url: '',
              statusCode: 200, // Status OK mas sem upload real
              invalid: false,
            });
            continue;
          }

          const uploadResult = await this.watsonxService.uploadFileToS3(
            file.buffer,
            file.originalname,
            file.mimetype,
          );
          uploadedFiles.push(uploadResult);
        }

        // Filtrar apenas arquivos que foram uploadados com sucesso
        // Arquivos de áudio não têm URL mas são considerados sucesso (foram transcritos)
        const successfulUploads = uploadedFiles.filter(
          (f) => !f.invalid && f.statusCode === 200,
        );

        // Separar arquivos de áudio dos outros arquivos
        const audioFiles = files.filter(
          (f) =>
            f.mimetype?.startsWith('audio/') ||
            f.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );
        const nonAudioFiles = files.filter(
          (f) =>
            !f.mimetype?.startsWith('audio/') &&
            !f.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );

        this.logger.log('Files processed', {
          total: uploadedFiles.length,
          audioFiles: audioFiles.length,
          nonAudioFiles: nonAudioFiles.length,
          successful: successfulUploads.length,
          failed: uploadedFiles.length - successfulUploads.length,
          files: successfulUploads.map((f) => f.fileName),
        });

        // Se há arquivos não-áudio e nenhum foi uploadado com sucesso, retornar erro
        // (arquivos de áudio não precisam de upload para S3)
        const successfulNonAudioUploads = successfulUploads.filter((f) =>
          nonAudioFiles.some((nf) => nf.originalname === f.fileName),
        );
        if (
          nonAudioFiles.length > 0 &&
          successfulNonAudioUploads.length === 0
        ) {
          const failedFiles = uploadedFiles.filter((f) => f.invalid);
          throw new Error(
            `Falha no upload de arquivos: ${failedFiles.map((f) => f.fileName).join(', ')}`,
          );
        }

        // Verificar se o texto contém um formulário JSON
        // Se sim, enviar o texto junto com os arquivos
        const messageText = payload.message.text || '';

        const isFormSubmission = this.isFormSubmission(messageText);

        // Filtrar arquivos de áudio - eles não precisam ser enviados para Watson Orchestrate
        // (já foram transcritos e o texto transcrito está na mensagem)
        const filesToSend = successfulUploads.filter((f) => {
          const isAudio = files.some(
            (file) =>
              file.originalname === f.fileName &&
              (file.mimetype?.startsWith('audio/') ||
                file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i)),
          );
          return !isAudio; // Incluir apenas arquivos que NÃO são áudio
        });

        // Enviar mensagem apenas com arquivos que foram uploadados com sucesso
        // (excluindo arquivos de áudio que já foram transcritos)
        if (filesToSend.length > 0) {
          wxResponse = await this.watsonxService.sendMessageWithFiles(
            agentId,
            existingThreadId,
            filesToSend,
            uploadFieldId,
            payload.context,
            isFormSubmission ? messageText : undefined, // Enviar texto se for formulário
          );
        } else {
          // Se só há arquivos de áudio (que não precisam ser enviados), enviar mensagem normal
          // IMPORTANTE: Usar payload.message.text diretamente para garantir que o texto transcrito seja enviado
          const textToSend = payload.message.text || messageText;
          this.logger.log(
            'Enviando mensagem com apenas arquivos de áudio (transcritos)',
            {
              textToSendLength: textToSend.length,
              textToSendPreview:
                textToSend.substring(0, 100) +
                (textToSend.length > 100 ? '...' : ''),
              messageTextLength: messageText.length,
              payloadTextLength: payload.message.text?.length || 0,
            },
          );
          wxResponse = await this.watsonxService.sendMessageStream(
            agentId,
            existingThreadId,
            textToSend,
            payload.context,
          );
        }
      } else {
        // Fluxo normal sem arquivos
        wxResponse = await this.watsonxService.sendMessageStream(
          agentId,
          existingThreadId, // Usar thread_id do mapeamento interno
          payload.message.text,
          payload.context,
          onStatus, // Callback para eventos de status
        );
      }

      // Capturar thread_id da resposta (retornado na primeira mensagem)
      const responseThreadId = wxResponse.thread_id || wxResponse.thread?.id;

      // Persistir thread_id no mapeamento interno para próximas mensagens
      if (responseThreadId && !existingThreadId) {
        this.sessionThreadMap.set(sessionId, responseThreadId);
        this.logger.log(
          `Thread mapped: session ${sessionId} -> thread ${responseThreadId}`,
        );
      }

      const context = {
        ...(wxResponse.context || {}),
        ...(responseThreadId && { thread_id: responseThreadId }),
        session_id: sessionId,
      };

      return {
        response: wxResponse,
        context,
        settings: {},
      };
    } catch (error) {
      this.logger.error('Error in CoreService run', error);
      // Fallback de erro
      return {
        response: {
          output: {
            generic: [
              {
                response_type: 'text',
                text: 'Desculpe, ocorreu um erro ao processar sua mensagem.',
              },
            ],
          },
        },
        context: {},
        settings: {},
      };
    }
  }
}
