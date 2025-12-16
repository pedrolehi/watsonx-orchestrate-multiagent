import { Injectable, Logger } from '@nestjs/common';
import { CoreRunDto, CoreRunResponseDto } from './dto/core.dto';
import {
  WatsonxService,
  StatusCallback,
} from '../watsonxorchestrate/watsonx.service';
import { StatusEvent } from '../watsonxorchestrate/tool-status.constants';
import { PersistenceService } from '../database/session/persistence.service';
import { extractCollaboratorFromStepHistory } from '../database/session/collaborator-extractor.helper';
import { randomUUID } from 'crypto';

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);

  // Mapeamento session_id -> thread_id (persistência em memória)
  // O widget controla a sessão, o backend controla o thread do Watson Orchestrate
  private readonly sessionThreadMap = new Map<string, string>();

  constructor(
    private readonly watsonxService: WatsonxService,
    private readonly persistenceService: PersistenceService,
  ) {}

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

      // Extrair userId (CPF criptografado) do contexto
      // Usar o CPF criptografado diretamente como userId, sem descriptografar
      const userId =
        payload.context?.user_info?.DADOS?.CPF ||
        payload.context?.user_info?.cpf ||
        null;

      // Extrair step_history da resposta
      // O step_history pode estar em diferentes lugares na resposta
      let stepHistory: Array<any> | undefined;
      if (
        wxResponse.output?.generic &&
        Array.isArray(wxResponse.output.generic)
      ) {
        // Procurar step_history nas mensagens
        for (const msg of wxResponse.output.generic) {
          if (msg._step_history && Array.isArray(msg._step_history)) {
            stepHistory = msg._step_history;
            break;
          }
          if (msg.content && Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (item._step_history && Array.isArray(item._step_history)) {
                stepHistory = item._step_history;
                break;
              }
            }
          }
        }
      }
      // Fallback: tentar diretamente na resposta
      if (!stepHistory) {
        stepHistory =
          wxResponse.step_history || wxResponse.output?.step_history;
      }

      // Extrair assistente colaborador do step_history
      const collaboratorInfo = extractCollaboratorFromStepHistory(stepHistory);

      // Salvar/atualizar Session
      try {
        await this.persistenceService.saveSession(
          sessionId,
          responseThreadId || existingThreadId || '',
          agentId,
          userId || undefined,
          payload.context?.user_info,
          payload.channel || 'widget',
        );
      } catch (error) {
        this.logger.warn('Erro ao salvar sessão', { error: error.message });
      }

      // Salvar mensagem única (input + output em um único documento)
      const messageId =
        wxResponse.message_id ||
        wxResponse.output?.generic?.[0]?._message_id ||
        randomUUID();
      try {
        // Extrair toolInfo e ragInfo da resposta
        const toolInfo = this.extractToolInfo(wxResponse, stepHistory);

        // Log para debug: verificar se tool foi chamada
        if (toolInfo) {
          this.logger.debug('Tool detectada e extraída', {
            toolName: toolInfo.toolName,
            hasPayload: !!toolInfo.payload,
            hasResponse: !!toolInfo.response,
            hasResult: !!toolInfo.result,
            status: toolInfo.status,
            resultPreview: toolInfo.result?.substring(0, 200),
          });
        } else {
          this.logger.debug('Nenhuma tool detectada na resposta');
        }

        const thinking = wxResponse.thinking || wxResponse.output?.thinking;

        // Calcular tempo de resposta (opcional, pode não estar disponível)
        const requestTimestamp = payload.context?.timestamp
          ? new Date(payload.context.timestamp).getTime()
          : Date.now();
        const responseTime = Date.now() - requestTimestamp;

        // Preparar arrays de mensagens como vêm da thread
        // Formato da thread: array de objetos com role e content
        let userMessages: Array<any> = [
          {
            role: 'user',
            content: payload.message.text || '',
            ...(payload.message.mediaUrl && {
              mediaUrl: payload.message.mediaUrl,
            }),
            ...(payload.message.mimeType && {
              mimeType: payload.message.mimeType,
            }),
          },
        ];

        // Mensagens do assistente vêm em output.generic (array)
        // Garantir que sempre temos um array válido, mesmo em caso de erro
        let assistantMessages: Array<any> = [];
        if (
          wxResponse.output?.generic &&
          Array.isArray(wxResponse.output.generic)
        ) {
          assistantMessages = wxResponse.output.generic;
        } else if (wxResponse.output) {
          assistantMessages = [wxResponse.output];
        } else if (wxResponse.error) {
          // Se houver erro, criar uma mensagem de erro para salvar
          assistantMessages = [
            {
              response_type: 'text',
              text: `Error: ${wxResponse.error.message || JSON.stringify(wxResponse.error)}`,
              error: wxResponse.error,
            },
          ];
        } else {
          // Fallback: usar a resposta completa
          assistantMessages = [wxResponse];
        }

        // Validar que temos arrays válidos antes de salvar
        if (!userMessages || userMessages.length === 0) {
          this.logger.warn('Tentativa de salvar mensagem sem userMessages', {
            sessionId,
            messageId,
          });
          // Garantir que temos pelo menos uma mensagem vazia
          userMessages = [{ role: 'user', content: '' }];
        }

        if (!assistantMessages || assistantMessages.length === 0) {
          this.logger.warn(
            'Tentativa de salvar mensagem sem assistantMessages',
            {
              sessionId,
              messageId,
              hasOutput: !!wxResponse.output,
              hasError: !!wxResponse.error,
            },
          );
          // Garantir que temos pelo menos uma mensagem vazia
          assistantMessages = [{ response_type: 'text', text: '' }];
        }

        await this.persistenceService.saveMessage(
          userId || sessionId, // Fallback para sessionId se não houver userId
          sessionId,
          responseThreadId || existingThreadId || '',
          messageId,
          userMessages, // Array de mensagens do usuário
          assistantMessages, // Array de mensagens do assistente
          stepHistory,
          toolInfo,
          thinking,
          payload.context,
          undefined,
          agentId,
          undefined,
          collaboratorInfo.collaboratorAgentId,
          collaboratorInfo.collaboratorAgentName,
          undefined, // parentMessageId
          responseTime,
        );

        this.logger.debug('Mensagem salva com sucesso', {
          sessionId,
          messageId,
          userMessagesCount: userMessages.length,
          assistantMessagesCount: assistantMessages.length,
          hasError: !!wxResponse.error,
        });
      } catch (error) {
        this.logger.error('Erro ao salvar mensagem', {
          error: error.message,
          stack: error.stack,
          sessionId,
          messageId,
          userId: userId || sessionId,
        });
        // Não re-lançar o erro para não quebrar o fluxo, mas logar como error
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

  /**
   * Extrai toolInfo da resposta do Watson Orchestrate
   */
  private extractToolInfo(
    wxResponse: any,
    stepHistory?: Array<any>,
  ):
    | {
        toolName?: string;
        toolCallId?: string;
        payload?: any;
        response?: any;
        result?: string; // String do resultado da tool
        flowInstanceId?: string;
        status?: 'pending' | 'processing' | 'completed' | 'failed';
        ragInfo?: {
          topic?: string;
          query?: string;
          source?: string;
          relevanceScore?: number;
        };
      }
    | undefined {
    if (!stepHistory || !Array.isArray(stepHistory)) {
      this.logger.debug(
        'extractToolInfo: stepHistory não disponível ou não é array',
      );
      return undefined;
    }

    this.logger.debug(
      'extractToolInfo: Procurando tool_calls no step_history',
      {
        stepHistoryLength: stepHistory.length,
      },
    );

    // Procurar por tool_calls no step_history
    for (const step of stepHistory) {
      if (step.step_details && Array.isArray(step.step_details)) {
        for (const detail of step.step_details) {
          if (detail.type === 'tool_calls' && detail.tool_calls) {
            const toolCall = detail.tool_calls[0];
            if (toolCall) {
              this.logger.debug('extractToolInfo: Tool chamada encontrada', {
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                hasArgs: !!toolCall.args,
              });

              const toolInfo: any = {
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                payload: toolCall.args,
                status: 'completed',
              };

              // Procurar por tool_response
              for (const step2 of stepHistory) {
                if (step2.step_details && Array.isArray(step2.step_details)) {
                  for (const detail2 of step2.step_details) {
                    if (
                      detail2.type === 'tool_response' &&
                      detail2.tool_call_id === toolCall.id
                    ) {
                      // Extrair response completo (prioridade: result > output > tool_output > content)
                      toolInfo.response =
                        detail2.result ||
                        detail2.output ||
                        detail2.tool_output ||
                        detail2.content;

                      // Extrair result como string (prioridade: result > output > tool_output > content)
                      if (detail2.result) {
                        toolInfo.result =
                          typeof detail2.result === 'string'
                            ? detail2.result
                            : JSON.stringify(detail2.result);
                      } else if (detail2.output) {
                        toolInfo.result =
                          typeof detail2.output === 'string'
                            ? detail2.output
                            : JSON.stringify(detail2.output);
                      } else if (detail2.tool_output) {
                        toolInfo.result =
                          typeof detail2.tool_output === 'string'
                            ? detail2.tool_output
                            : JSON.stringify(detail2.tool_output);
                      } else if (detail2.content) {
                        // content pode ser a resposta quando não há result/output (ex: "Transferring to - gep_agent")
                        toolInfo.result =
                          typeof detail2.content === 'string'
                            ? detail2.content
                            : JSON.stringify(detail2.content);
                      }

                      this.logger.debug(
                        'extractToolInfo: Tool response encontrada',
                        {
                          toolName: toolCall.name,
                          toolCallId: toolCall.id,
                          hasResult: !!toolInfo.result,
                          resultLength: toolInfo.result?.length,
                          resultPreview: toolInfo.result?.substring(0, 200),
                          hasResponse: !!toolInfo.response,
                          hasContent: !!detail2.content,
                          contentPreview: detail2.content?.substring(0, 200),
                          responseKeys: Object.keys(detail2),
                          // Log completo do detail2 para debug
                          detail2Structure: {
                            hasResult: !!detail2.result,
                            hasOutput: !!detail2.output,
                            hasToolOutput: !!detail2.tool_output,
                            hasContent: !!detail2.content,
                            type: detail2.type,
                          },
                        },
                      );
                      break;
                    }
                  }
                }
              }

              // Se não encontrou tool_response, a tool pode estar ainda processando
              if (!toolInfo.response && !toolInfo.result) {
                toolInfo.status = 'processing';
                this.logger.debug(
                  'extractToolInfo: Tool chamada mas sem resposta ainda',
                  {
                    toolName: toolCall.name,
                    toolCallId: toolCall.id,
                  },
                );
              }

              // Verificar se é RAG
              const isRAG =
                toolCall.name?.toLowerCase().includes('rag') ||
                toolCall.name?.toLowerCase().includes('search') ||
                toolCall.name?.toLowerCase().includes('knowledge') ||
                toolCall.name?.toLowerCase().includes('retrieval') ||
                toolCall.name?.toLowerCase().includes('conversational_search');

              if (isRAG && toolInfo.response) {
                // Extrair tópico do userInput ou response
                const topic = this.extractRAGTopic(
                  toolCall.args?.query || toolCall.args?.text,
                  toolInfo.response,
                );
                toolInfo.ragInfo = {
                  topic,
                  query: toolCall.args?.query || toolCall.args?.text,
                  source: toolInfo.response?.source,
                  relevanceScore: toolInfo.response?.score,
                };
              }

              // Procurar flowInstanceId
              if (toolInfo.response?.flow_instance_id) {
                toolInfo.flowInstanceId = toolInfo.response.flow_instance_id;
              }

              return toolInfo;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Extrai tópico/assunto de uma consulta RAG
   */
  private extractRAGTopic(query?: string, response?: any): string | undefined {
    if (query) {
      // Retornar os primeiros 100 caracteres da query como tópico
      return query.substring(0, 100);
    }
    if (response?.text) {
      return response.text.substring(0, 100);
    }
    return undefined;
  }
}
