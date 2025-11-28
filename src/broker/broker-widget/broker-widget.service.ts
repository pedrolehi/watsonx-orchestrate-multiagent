import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, Subject } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { AuthService } from '../../auth/auth.service';
import { CoreService } from '../../core/core.service';
import { CoreRunDto } from '../../core/dto/core.dto';
import { StatusEvent } from '../../watsonxorchestrate/tool-status.constants';
import { WidgetAuthDto } from '../dto/widget-auth.dto';
import {
  WidgetContextDto,
  WidgetConversationResponseDto,
  WidgetMessageDto,
  WidgetSettingsDto,
} from '../dto/widget-conversation-response.dto';
import { WidgetConversationDto } from '../dto/widget-conversation.dto';

/**
 * Evento SSE para o widget
 */
export interface WidgetSSEEvent {
  event: string;
  data: any;
}

@Injectable()
export class BrokerWidgetService {
  private readonly logger = new Logger(BrokerWidgetService.name);

  constructor(
    private readonly coreService: CoreService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Retorna saudação baseada na hora atual
   * Bom dia: 5h - 11h59
   * Boa tarde: 12h - 17h59
   * Boa noite: 18h - 4h59
   */
  private getGreetingByTime(): string {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) {
      return 'Bom dia';
    } else if (hour >= 12 && hour < 18) {
      return 'Boa tarde';
    } else {
      return 'Boa noite';
    }
  }

  /**
   * Gera um código de erro único para rastreamento
   */
  private generateErrorCode(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `ERR-AUTH-${timestamp}-${random}`;
  }

  async auth(data: WidgetAuthDto): Promise<any> {
    this.logger.log('Widget authentication request', {
      apiKey: data['api-key'],
    });

    return {
      success: true,
      data: {
        apiKey: data['api-key'],
        authenticated: true,
      },
    };
  }

  async run(
    data: WidgetConversationDto,
    files?: Array<Express.Multer.File>,
  ): Promise<WidgetConversationResponseDto> {
    this.logger.log('User message', {
      sessionId: data.sessionId,
      text: data.text?.substring(0, 50) + (data.text?.length > 50 ? '...' : ''),
    });

    // Nota: A validação do assistente e persistência de conversa foram movidas/removidas
    // conforme a reestruturação para focar apenas no novo CoreModule Watsonx.

    const hasFiles = !!files && files.length > 0;

    // Verificar se é a primeira mensagem baseado no mapeamento interno do CoreService
    // O backend controla o thread_id, não o widget
    const isFirstMessage = !this.coreService.hasExistingThread(data.sessionId);

    // Extrair apenas os valores essenciais para o contexto do agent
    const emplid = data.user?.emplid || data.user?.context?.emplid;
    const chapa = data.user?.chapa || data.user?.context?.chapa;
    // assistantId é o UUID do agent no Watson Orchestrate
    const agentId = data.assistantId;

    // Saudação: usar do widget (hora local do usuário) ou calcular no servidor como fallback
    const greeting =
      data.user?.greeting ||
      data.user?.context?.greeting ||
      this.getGreetingByTime();

    // ===== AUTENTICAÇÃO AUTOMÁTICA NA PRIMEIRA MENSAGEM =====
    // Autentica o usuário ANTES de enviar para a LLM, eliminando a necessidade
    // da LLM chamar tools de autenticação e melhorando a performance.
    let userData: any = null;
    let acessoRelatorios: any = null;
    let authError: string | null = null;

    if (isFirstMessage) {
      if (chapa) {
        // Funcionário: autenticar por CHAPA
        this.logger.log('Autenticando funcionário por CHAPA', { chapa });
        const authResult = await this.authService.identifyEmployee(chapa);
        if (authResult.success) {
          userData = authResult.data;
          acessoRelatorios = authResult.acessoRelatorios;
          this.logger.log('Funcionário autenticado com sucesso');
        } else {
          authError = authResult.error || null;
          this.logger.warn('Falha na autenticação do funcionário', {
            error: authError,
          });
        }
      } else if (emplid && emplid !== '0000000') {
        // Aluno: autenticar por EMPLID (ignorar emplid placeholder "0000000")
        this.logger.log('Autenticando aluno por EMPLID', { emplid });
        const authResult = await this.authService.identifyStudent(emplid);
        if (authResult.success) {
          userData = authResult.data;
          this.logger.log('Aluno autenticado com sucesso');
        } else {
          authError = authResult.error || null;
          this.logger.warn('Falha na autenticação do aluno', {
            error: authError,
          });
        }
      } else {
        // Nenhum identificador fornecido
        authError =
          'Nenhum identificador de usuário fornecido (chapa ou emplid)';
        this.logger.warn('Tentativa de acesso sem identificador de usuário');
      }

      // ===== BLOQUEAR ACESSO SE AUTENTICAÇÃO FALHOU =====
      if (!userData) {
        const errorCode = this.generateErrorCode();
        this.logger.error('Acesso negado: usuário não autenticado', {
          authError,
          errorCode,
        });

        const errorDetails = authError
          ? `\n\n**Detalhes do erro:** ${authError}`
          : '';

        return {
          success: false,
          messages: [
            {
              sender: 'ai',
              message:
                '**Não foi possível autenticar o usuário.**\n\nVocê não tem permissão de acesso aos recursos do assistente virtual. Verifique se está logado corretamente ou entre em contato com o suporte.' +
                errorDetails +
                `\n\n**Código do erro:** \`${errorCode}\``,
              messageId: `error_${Date.now()}`,
              timestamp: new Date().toISOString(),
              isError: true,
            },
          ],
          settings: {},
        };
      }
    }

    // Construir user_info com dados do usuário autenticado
    const userInfo: any = userData
      ? {
          ...userData,
          ...(acessoRelatorios && { acessoRelatorios }),
        }
      : null;

    const payload: CoreRunDto = {
      message: {
        type: 'text',
        text: this.sanitizeTextForWatson(data.text || ''),
      },
      conversationId: data.sessionId,
      profileName: 'Widget User',
      context: {
        // agent_id é o UUID do agent no Watson Orchestrate (enviado pelo widget como assistantId)
        ...(agentId && { agent_id: agentId }),
        // Dados do usuário autenticado dentro de user_info
        ...(userInfo && { user_info: userInfo }),
        // IMPORTANTE: is_first_message é determinado pelo backend via CoreService.hasExistingThread
        is_first_message: isFirstMessage,
        // Session ID para referência
        session_id: data.sessionId,
        // Saudação baseada na hora local do usuário (Bom dia, Boa tarde, Boa noite)
        greeting: greeting,
      },
      channel: 'widget',
    };

    // Chamada direta ao CoreService novo
    const coreResponse = await this.coreService.run(
      payload,
      null, // Assistant entity removida
      files,
    );

    let response: WidgetConversationResponseDto = {
      success: true,
      messages: [],
      settings: {} as WidgetSettingsDto,
    };

    // Padronizar a resposta do Watson independente da estrutura
    const standardizedData = this.standardizeWatsonResponse(
      coreResponse.response,
      coreResponse.context,
    );
    response.messages = standardizedData.messages;
    // const cleanedVariablesForDB = standardizedData.updatedVariables; // Usado para persistência, ignorado aqui por enquanto

    if (
      coreResponse.settings &&
      Object.keys(coreResponse.settings).length > 0
    ) {
      response.settings = coreResponse.settings;
    }

    // Verificar se há mensagem de file_upload para ativar botão de anexos
    // O botão só aparece quando o agente pede um arquivo e desaparece após enviar
    const fileUploadMessage = standardizedData.messages.find(
      (msg) => msg.component === 'file_upload',
    );
    const hasFileUpload = !!fileUploadMessage;
    response.settings = {
      ...response.settings,
      botaoAnexo: hasFileUpload, // true só quando agente pede arquivo, false caso contrário
      // Passar o ID do campo de upload para o widget usar ao enviar arquivos
      ...(hasFileUpload &&
        fileUploadMessage?.name && {
          uploadFieldId: fileUploadMessage.name,
        }),
    };
    if (hasFileUpload) {
      this.logger.log('File upload detected, enabling attachment button', {
        uploadFieldId: fileUploadMessage?.name,
      });
    }

    // Adicionar contexto para debug no frontend
    response.context = coreResponse.context as WidgetContextDto;

    // Adicionar informações de debug do Watson (preservando lógica legada simplificada)
    if (coreResponse.response?.output?.generic) {
      const watsonResponse = coreResponse.response;
      let nodesVisited: any[] = [];
      let errors: any[] = [];
      let logMessages: any[] = [];

      watsonResponse.output.generic.forEach((msg: any) => {
        if (msg.debug?.nodes_visited) nodesVisited = msg.debug.nodes_visited;
        if (msg.debug?.errors) errors = msg.debug.errors;
        if (msg.debug?.log_messages) logMessages = msg.debug.log_messages;
      });

      response.debug = {
        nodesVisited,
        errors,
        logMessages,
        additionalInfo: {
          turnCount: coreResponse.context?.turn_count,
          sessionId: coreResponse.context?.session_id,
          assistantId: coreResponse.context?.assistant_id,
        },
      };
    }

    this.logger.log('Response', { messages: response.messages.length });

    return response;
  }

  /**
   * Executa a conversa com streaming SSE
   * Emite eventos de status durante o processamento e a resposta final no fim
   */
  runWithStreaming(
    data: WidgetConversationDto,
    files?: Array<Express.Multer.File>,
  ): Observable<MessageEvent> {
    console.log('[BrokerWidgetService] runWithStreaming chamado:', {
      hasData: !!data,
      hasFiles: !!files,
      filesCount: files?.length || 0,
    });

    const subject = new Subject<MessageEvent>();

    // Determinar mensagem inicial baseada no contexto
    const isFirstMessage = !this.coreService.hasExistingThread(data.sessionId);
    const hasText = data.text && data.text.trim().length > 0;

    let initialMessage = 'Preparando resposta';
    if (isFirstMessage || !hasText) {
      initialMessage = 'Inicializando assistente';
    }

    // Emitir evento inicial imediatamente para garantir que o SSE sempre tenha algo
    const initialEvent = {
      data: JSON.stringify({
        event: 'status',
        data: {
          message: initialMessage,
          timestamp: Date.now(),
        },
      }),
    } as MessageEvent;

    // Criar Observable que emite o evento inicial imediatamente quando alguém se inscreve
    const observable = new Observable<MessageEvent>((subscriber) => {
      console.log(
        '[BrokerWidgetService] Observable subscribed - emitindo evento inicial',
      );

      // Emitir evento inicial imediatamente
      subscriber.next(initialEvent);
      console.log('[BrokerWidgetService] Evento inicial emitido:', {
        hasData: !!initialEvent.data,
        dataLength: initialEvent.data?.length,
      });

      // Fazer subscribe no subject para repassar eventos
      const subscription = subject.subscribe({
        next: (value) => {
          console.log('[BrokerWidgetService] Repassando evento do subject:', {
            hasData: !!value.data,
            dataLength: value.data?.length,
          });
          subscriber.next(value);
        },
        error: (err) => {
          console.error('[BrokerWidgetService] Erro no subject:', err);
          subscriber.error(err);
        },
        complete: () => {
          console.log('[BrokerWidgetService] Subject completado');
          subscriber.complete();
        },
      });

      // Executar o processamento de forma assíncrona
      this.executeWithStatusEvents(data, files, subject).catch((error) => {
        console.error(
          '[BrokerWidgetService] Erro em executeWithStatusEvents:',
          error,
        );
        const errorEvent = {
          data: JSON.stringify({
            event: 'error',
            data: {
              message: error.message || 'Erro ao processar requisição',
              timestamp: Date.now(),
            },
          }),
        } as MessageEvent;
        subject.next(errorEvent);
        subject.complete();
      });

      // Cleanup
      return () => {
        console.log('[BrokerWidgetService] Observable unsubscribe chamado');
        subscription.unsubscribe();
      };
    });

    console.log('[BrokerWidgetService] Observable criado e retornado');

    // Fazer subscribe imediatamente para garantir que o Observable comece a emitir
    // (O NestJS fará seu próprio subscribe, mas isso ajuda a garantir que os eventos sejam emitidos)
    const testSub = observable.subscribe({
      next: (value) => {
        console.log('[BrokerWidgetService] Test subscribe - evento recebido:', {
          hasData: !!value.data,
          dataLength: value.data?.length,
        });
      },
      error: (err) => {
        console.error('[BrokerWidgetService] Test subscribe - erro:', err);
      },
      complete: () => {
        console.log('[BrokerWidgetService] Test subscribe - completado');
      },
    });

    // Não fazer unsubscribe - deixar o NestJS gerenciar

    return observable;
  }

  /**
   * Executa o processamento e emite eventos SSE
   */
  private async executeWithStatusEvents(
    data: WidgetConversationDto,
    files: Array<Express.Multer.File> | undefined,
    subject: Subject<MessageEvent>,
  ): Promise<void> {
    console.log('[BrokerWidgetService] executeWithStatusEvents iniciado');
    try {
      // Verificar se é a primeira mensagem baseado no mapeamento interno do CoreService
      // O backend controla o thread_id, não o widget
      const isFirstMessage = !this.coreService.hasExistingThread(
        data.sessionId,
      );

      // Extrair apenas os valores essenciais para o contexto do agent
      const emplid = data.user?.emplid || data.user?.context?.emplid;
      const chapa = data.user?.chapa || data.user?.context?.chapa;
      const agentId = data.assistantId;

      // Saudação: usar do widget (hora local do usuário) ou calcular no servidor como fallback
      const greeting =
        data.user?.greeting ||
        data.user?.context?.greeting ||
        this.getGreetingByTime();

      // ===== AUTENTICAÇÃO AUTOMÁTICA NA PRIMEIRA MENSAGEM =====
      let userData: any = null;
      let acessoRelatorios: any = null;
      let authError: string | null = null;

      if (isFirstMessage) {
        if (chapa) {
          // Funcionário: autenticar por CHAPA
          this.logger.log('Autenticando funcionário por CHAPA (streaming)', {
            chapa,
          });
          const authResult = await this.authService.identifyEmployee(chapa);
          if (authResult.success) {
            userData = authResult.data;
            acessoRelatorios = authResult.acessoRelatorios;
            this.logger.log('Funcionário autenticado com sucesso');
          } else {
            authError =
              authResult.error || 'Falha na autenticação do funcionário';
            this.logger.warn('Falha na autenticação do funcionário', {
              chapa,
              error: authError,
            });
          }
        } else if (emplid && emplid !== '0000000') {
          // Aluno: autenticar por EMPLID
          this.logger.log('Autenticando aluno por EMPLID (streaming)', {
            emplid,
          });
          const authResult = await this.authService.identifyStudent(emplid);
          if (authResult.success) {
            userData = authResult.data;
            this.logger.log('Aluno autenticado com sucesso');
          } else {
            authError = authResult.error || 'Falha na autenticação do aluno';
            this.logger.warn('Falha na autenticação do aluno', {
              emplid,
              error: authError,
            });
          }
        } else {
          // Nenhum identificador fornecido
          authError =
            'Nenhum identificador de usuário fornecido (chapa ou emplid)';
          this.logger.warn('Tentativa de acesso sem identificador de usuário');
        }

        // ===== BLOQUEAR ACESSO SE AUTENTICAÇÃO FALHOU =====
        if (!userData) {
          const errorCode = this.generateErrorCode();
          this.logger.error('Acesso negado: usuário não autenticado', {
            authError,
            errorCode,
          });

          const errorDetails = authError
            ? `\n\n**Detalhes do erro:** ${authError}`
            : '';

          const errorMessage = {
            sender: 'ai',
            message:
              '**Não foi possível autenticar o usuário.**\n\nVocê não tem permissão de acesso aos recursos do assistente virtual. Verifique se está logado corretamente ou entre em contato com o suporte.' +
              errorDetails +
              `\n\n**Código do erro:** \`${errorCode}\``,
            messageId: `error_${Date.now()}`,
            timestamp: new Date().toISOString(),
            isError: true,
          };

          const sseEvent = {
            data: JSON.stringify({
              event: 'response',
              data: {
                messages: [errorMessage],
                settings: {},
              },
            }),
          } as MessageEvent;

          subject.next(sseEvent);
          subject.complete();
          return;
        }
      }

      // Construir user_info com dados do usuário autenticado
      const userInfo: any = userData
        ? {
            ...userData,
            ...(acessoRelatorios && { acessoRelatorios }),
          }
        : null;

      const payload: CoreRunDto = {
        message: {
          type: 'text',
          text: this.sanitizeTextForWatson(data.text || ''),
        },
        conversationId: data.sessionId,
        profileName: 'Widget User',
        context: {
          ...(agentId && { agent_id: agentId }),
          // Dados do usuário autenticado dentro de user_info
          ...(userInfo && { user_info: userInfo }),
          // thread_id é gerenciado internamente pelo CoreService
          // is_first_message é determinado pelo backend via CoreService.hasExistingThread
          is_first_message: isFirstMessage,
          session_id: data.sessionId,
          // Saudação baseada na hora local do usuário
          greeting: greeting,
        },
        channel: 'widget',
      };

      // Callback para emitir eventos de status
      const onStatus = (statusEvent: StatusEvent) => {
        const sseEvent = {
          data: JSON.stringify({
            event: 'status',
            data: {
              message: statusEvent.data.message,
              toolName: statusEvent.data.toolName,
              timestamp: statusEvent.data.timestamp,
              type: statusEvent.event,
            },
          }),
        } as MessageEvent;
        subject.next(sseEvent);
      };

      // Chamar o CoreService com callback de status
      const coreResponse = await this.coreService.run(
        payload,
        null,
        files,
        onStatus,
      );

      // Processar resposta final
      const standardizedData = this.standardizeWatsonResponse(
        coreResponse.response,
        coreResponse.context,
      );

      // Verificar se há file_upload para ativar botão
      const fileUploadMessage = standardizedData.messages.find(
        (msg) => msg.component === 'file_upload',
      );
      const hasFileUpload = !!fileUploadMessage;

      const response: WidgetConversationResponseDto = {
        success: true,
        messages: standardizedData.messages,
        settings: {
          botaoAnexo: hasFileUpload, // true só quando agente pede arquivo
          // Passar o ID do campo de upload para o widget usar ao enviar arquivos
          ...(hasFileUpload &&
            fileUploadMessage?.name && {
              uploadFieldId: fileUploadMessage.name,
            }),
        } as WidgetSettingsDto,
        context: coreResponse.context as WidgetContextDto,
      };

      // Emitir resposta final
      const finalEvent = {
        data: JSON.stringify({
          event: 'response',
          data: response,
        }),
      } as MessageEvent;
      subject.next(finalEvent);

      // Completar o stream
      subject.complete();
    } catch (error: any) {
      this.logger.error('Error in streaming execution', error);

      // Emitir evento de erro
      const errorEvent = {
        data: JSON.stringify({
          event: 'error',
          data: {
            message: 'Erro ao processar mensagem',
            error: error.message,
          },
        }),
      } as MessageEvent;
      subject.next(errorEvent);
      subject.complete();
    }
  }

  // --- Métodos Auxiliares de Transformação de UI (Mantidos do Legado para compatibilidade com Widget) ---

  private standardizeWatsonResponse(
    responseCore: any,
    context: any,
  ): { messages: WidgetMessageDto[]; updatedVariables: any } {
    const standardizedMessages: WidgetMessageDto[] = [];

    // Estrutura watson dialog responseCore.output.generic
    if (responseCore?.output?.generic) {
      let i = 0;
      while (i < responseCore.output.generic.length) {
        const message = responseCore.output.generic[i];
        const standardizedMessage = this.processMessageByType(
          message,
          i,
          responseCore.output.generic,
          context,
        );

        if (standardizedMessage) {
          standardizedMessages.push(standardizedMessage);

          // Lógica de look-ahead para combinar mensagens (Option + Text, etc)
          const currentMessage = responseCore.output.generic[i];
          const nextMessage = responseCore.output.generic[i + 1];

          if (
            (standardizedMessage.buttons ||
              standardizedMessage.component === 'select' ||
              standardizedMessage.component === 'autocomplete') &&
            i + 1 < responseCore.output.generic.length &&
            nextMessage?.response_type === 'option'
          ) {
            const isCurrentOptionEmpty =
              currentMessage.response_type === 'option' &&
              (!currentMessage.options || currentMessage.options.length === 0);
            const hasTitle = nextMessage?.title;

            if (!isCurrentOptionEmpty && !hasTitle) {
              i++; // Pula o próximo item
            } else if (isCurrentOptionEmpty) {
              i++;
            } else if (hasTitle) {
              i++;
            }
          }
        }
        i++;
      }
    }
    // Estrutura watson action: responseCore.outputs
    else if (responseCore?.outputs) {
      for (const output of responseCore.outputs) {
        const standardizedMessage = this.processByType(output, context);
        if (standardizedMessage) {
          standardizedMessages.push(standardizedMessage);
        }
      }
    }

    return {
      messages: standardizedMessages,
      updatedVariables: context,
    };
  }

  private processMessageByType(
    message: any,
    index: number,
    messages: any[],
    context: any,
  ): WidgetMessageDto | null {
    switch (message.response_type) {
      case 'text':
        return this.processTextMessage(message, index, messages, context);
      case 'conversational_search':
        return this.processTextMessage(message, index, messages, context);
      case 'option':
        return this.processOptionMessage(message, context);
      case 'video':
        return this.processVideoMessage(message);
      case 'image':
        return this.processImageMessage(message);
      case 'file_upload':
        return this.processFileUploadMessage(message);
      case 'date':
        return this.processDateMessage(message);
      case 'pause':
        return null;
      default:
        return null;
    }
  }

  private processByType(output: any, context: any): any | null {
    switch (output.type) {
      case 'text':
        return this.processText(output, context);
      case 'conversational_search':
        return this.processText(output, context);
      case 'option':
        return this.processOption(output, context);
      case 'video':
        return this.processVideo(output);
      case 'image':
        return this.processImage(output);
      case 'file_upload':
        return this.processFileUpload(output);
      case 'date':
      case 'datepicker':
        return this.processDate(output);
      case 'pause':
        return null;
      default:
        return null;
    }
  }

  private processTextMessage(
    message: any,
    index: number,
    messages: any[],
    context: any,
  ): WidgetMessageDto | null {
    if (!message.text || message.text.trim() === '') return null;

    // Normaliza quebras de linha escapadas
    const normalizedText = this.normalizeNewlines(message.text);
    const nextMessage = messages[index + 1];

    const shouldRenderDatepicker =
      context?.calendario === true ||
      context?.skills?.['actions skill']?.skill_variables?.calendario === true;
    const shouldRenderMonthYearPicker =
      context?.calendarioMesAno === true ||
      context?.skills?.['actions skill']?.skill_variables?.calendarioMesAno ===
        true;

    if (shouldRenderMonthYearPicker) {
      const constraints = this.buildDateConstraints(context);
      if (context?.calendarioMesAno === true) context.calendarioMesAno = false;
      return {
        sender: 'ai',
        message: normalizedText,
        component: 'datepicker',
        options: { mode: 'month-year', constraints: constraints },
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
      };
    }

    if (shouldRenderDatepicker) {
      const constraints = this.buildDateConstraints(context);
      if (context?.calendario === true) context.calendario = false;
      return {
        sender: 'ai',
        message: normalizedText,
        component: 'datepicker',
        options: { constraints: constraints },
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
      };
    }

    if (nextMessage && nextMessage.response_type === 'option') {
      const isNextMessageMultiselect =
        context?.multiselect === true ||
        context?.skills?.['actions skill']?.skill_variables?.multiselect ===
          true;

      if (isNextMessageMultiselect) {
        let options = nextMessage.options || [];
        // Lógica simplificada de options fallback removida por ser muito específica do legado

        const componentType = options.length > 5 ? 'autocomplete' : 'select';
        if (context?.multiselect === true) context.multiselect = false;

        return {
          sender: 'ai',
          message: normalizedText,
          component: componentType,
          options: this.extractButtons(options),
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
        };
      }

      if (!isNextMessageMultiselect) {
        const nextTitle = nextMessage.title
          ? this.normalizeNewlines(nextMessage.title)
          : '';
        return {
          sender: 'ai',
          message: nextTitle
            ? `${normalizedText}\n\n${nextTitle}`
            : normalizedText,
          buttons: this.extractButtons(nextMessage.options),
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
        };
      }
    }

    return {
      sender: 'ai',
      message: normalizedText,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processOptionMessage(
    message: any,
    context: any,
  ): WidgetMessageDto | null {
    const isMultiselect = context?.multiselect === true;

    if (!isMultiselect && (!message.options || message.options.length === 0))
      return null;

    if (isMultiselect) {
      let options = message.options || [];
      const componentType = options.length > 5 ? 'autocomplete' : 'select';
      const finalTitle = this.normalizeNewlines(
        message.title || message.text || 'Selecione uma das opções:',
      );
      context.multiselect = false;

      return {
        sender: 'ai',
        component: componentType,
        title: finalTitle,
        options: this.extractButtons(options),
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
      };
    }

    return {
      sender: 'ai',
      message: this.normalizeNewlines(
        message.title || message.text || 'Selecione uma opção:',
      ),
      buttons: this.extractButtons(message.options),
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processImageMessage(message: any): any {
    return {
      sender: 'ai',
      image: {
        url: message.source,
        title: message.title,
        alt: message.description,
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processVideoMessage(message: any): any {
    return {
      sender: 'ai',
      message: this.normalizeNewlines(message.text || 'Vídeo'),
      video: {
        url: message.source || message.videoDetails?.source || '',
        title: message.title || message.videoDetails?.title || '',
        description:
          message.description || message.videoDetails?.description || '',
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Processa mensagem de file_upload do Watson Orchestrate
   * Ativa o botão de attachments no widget
   * O campo 'name' é importante - deve ser enviado de volta ao fazer upload
   */
  private processFileUploadMessage(message: any): any {
    return {
      sender: 'ai',
      message: this.normalizeNewlines(
        message.text || 'Por favor, envie o arquivo solicitado.',
      ),
      component: 'file_upload',
      name: message.name, // Adicionar name no nível da mensagem para facilitar acesso
      options: {
        name: message.name, // Nome do campo de upload - IMPORTANTE para resposta
        uploadFieldName: message.name, // Alias para facilitar uso no widget
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processDateMessage(message: any): any {
    return {
      sender: 'ai',
      message: this.normalizeNewlines(
        message.text || 'Por favor, selecione uma data.',
      ),
      component: 'datepicker',
      name: message.name, // Nome do campo - IMPORTANTE para resposta
      options: {
        name: message.name,
        constraints: {}, // Pode ser expandido com constraints do Watson se disponíveis
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processText(output: any, context: any): any {
    // Simplificado: reutilizando lógica similar se necessário, ou retornando simples
    return {
      sender: 'ai',
      message: output.content || output.text || '',
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processOption(output: any, context: any): any {
    // Simplificado para actions
    return {
      sender: 'ai',
      message: output.content || 'Selecione uma opção:',
      buttons: this.extractButtons(output.options),
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processImage(output: any): any {
    return {
      sender: 'ai',
      image: {
        url: output.source,
        title: output.title,
        alt: output.description,
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processVideo(output: any): any {
    return {
      sender: 'ai',
      message: output.content || 'Vídeo',
      video: {
        url: output.source,
        title: output.title,
        description: output.description,
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processFileUpload(output: any): any {
    return {
      sender: 'ai',
      message: output.text || 'Por favor, envie o arquivo solicitado.',
      component: 'file_upload',
      options: {
        name: output.name,
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private processDate(output: any): any {
    return {
      sender: 'ai',
      message: output.text || 'Por favor, selecione uma data.',
      component: 'datepicker',
      name: output.name, // Nome do campo - IMPORTANTE para resposta
      options: {
        name: output.name,
        constraints: output.constraints || {},
      },
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private sanitizeTextForWatson(text: string): string {
    if (!text) return '';
    return text
      .replace(/\t/g, ' ')
      .replace(/\r\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Normaliza quebras de linha escapadas (\\n) para quebras reais (\n)
   * O Watson Orchestrate às vezes retorna \\n em vez de \n
   */
  private normalizeNewlines(text: string): string {
    if (!text) return '';
    // Converte \\n (escapado) para \n real
    return text.replace(/\\n/g, '\n');
  }

  private extractButtons(options: any[]): any[] {
    if (!options || !Array.isArray(options)) return [];
    return options.map((option: any) => {
      if (typeof option.value === 'object' && option.value !== null) {
        return {
          id: option.value.id ?? option.id,
          label: option.label ?? option.value.label ?? option,
          value: option.value.value ?? option.value.input?.text ?? option,
          link: option.link,
          type: option.type,
          filename: option.filename,
          fileType: option.fileType,
        };
      }
      return {
        id: option.id,
        label: option.label ?? option,
        value: option.value ?? option,
        link: option.link,
        type: option.type,
        filename: option.filename,
        fileType: option.fileType,
      };
    });
  }

  private buildDateConstraints(context: any): any {
    const constraints: any = { disableFuture: true };
    const dataInicial = context?.dataInicialSlot || context?.dataInicial;

    if (dataInicial) {
      try {
        let parsedDate: Date;
        if (dataInicial.includes('/')) {
          const parts = dataInicial.split('/');
          if (parts.length === 2) {
            parsedDate = new Date(
              parseInt(parts[1]),
              parseInt(parts[0]) - 1,
              1,
            );
          } else if (parts.length === 3) {
            parsedDate = new Date(
              parseInt(parts[2]),
              parseInt(parts[1]) - 1,
              parseInt(parts[0]),
            );
          } else {
            parsedDate = new Date(dataInicial);
          }
        } else {
          parsedDate = new Date(dataInicial);
        }

        if (!isNaN(parsedDate.getTime())) {
          constraints.disablePast = parsedDate.toISOString();
        }
      } catch (error) {
        // ignorar erro de parse
      }
    }
    return constraints;
  }
}
