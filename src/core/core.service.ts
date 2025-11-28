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

  async run(
    payload: CoreRunDto,
    assistant: any, // Removido tipo Assistant estrito
    files?: Array<Express.Multer.File>,
    onStatus?: StatusCallback,
  ): Promise<CoreRunResponseDto> {
    const sessionId = payload.conversationId;
    this.logger.log(`Processing message for session: ${sessionId}`);

    // Integração básica: enviar mensagem e retornar resposta
    // agent_id DEVE vir do widget (como assistantId) e ser passado no context
    const agentId = payload.context?.agent_id;

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

      // Verificar se há arquivos para upload
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
        const uploadedFiles: Array<{
          fileName: string;
          id: string | null;
          url: string;
          statusCode: number;
          invalid: boolean;
        }> = [];

        for (const file of files) {
          const uploadResult = await this.watsonxService.uploadFileToS3(
            file.buffer,
            file.originalname,
            file.mimetype,
          );
          uploadedFiles.push(uploadResult);
        }

        // Filtrar apenas arquivos que foram uploadados com sucesso
        const successfulUploads = uploadedFiles.filter(
          (f) => !f.invalid && f.statusCode === 200 && f.url,
        );

        this.logger.log('Files uploaded to S3', {
          total: uploadedFiles.length,
          successful: successfulUploads.length,
          failed: uploadedFiles.length - successfulUploads.length,
          files: successfulUploads.map((f) => f.fileName),
        });

        // Se nenhum arquivo foi uploadado com sucesso, retornar erro
        if (successfulUploads.length === 0) {
          const failedFiles = uploadedFiles.filter((f) => f.invalid);
          throw new Error(
            `Falha no upload de arquivos: ${failedFiles.map((f) => f.fileName).join(', ')}`,
          );
        }

        // Enviar mensagem apenas com arquivos que foram uploadados com sucesso
        wxResponse = await this.watsonxService.sendMessageWithFiles(
          agentId,
          existingThreadId,
          successfulUploads,
          uploadFieldId,
          payload.context,
        );
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
