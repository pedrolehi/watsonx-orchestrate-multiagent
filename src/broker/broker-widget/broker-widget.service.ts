import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, Subject } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { AuthService } from '../../auth/auth.service';
import { CoreService } from '../../core/core.service';
import { CoreRunDto } from '../../core/dto/core.dto';
import { StatusEvent } from '../../watsonxorchestrate/tool-status.constants';
import { SpeechToTextService } from '../../audio/speech-to-text/speech-to-text.service';
import { WatsonxService } from '../../watsonxorchestrate/watsonx.service';
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

  // Cache em memória para dados de autenticação por sessionId
  // Formato: Map<sessionId, { userData, acessoRelatorios, timestamp }>
  private readonly userAuthCache = new Map<
    string,
    {
      userData: any;
      acessoRelatorios?: any;
      timestamp: number;
    }
  >();

  // TTL do cache: 1 hora (3600000 ms)
  private readonly CACHE_TTL = 3600000;

  constructor(
    private readonly coreService: CoreService,
    private readonly authService: AuthService,
    private readonly speechToTextService: SpeechToTextService,
    private readonly watsonxService: WatsonxService,
  ) {}

  /**
   * Obtém dados do usuário do cache ou autentica se necessário
   */
  private async getUserData(
    sessionId: string,
    chapa?: string,
    emplid?: string,
  ): Promise<
    { userData: any; acessoRelatorios?: any } | { error: string } | null
  > {
    // Verificar cache primeiro
    const cached = this.userAuthCache.get(sessionId);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.CACHE_TTL) {
        this.logger.debug('Usando dados do usuário do cache', {
          sessionId,
          cacheAge: `${Math.round(age / 1000)}s`,
        });
        return {
          userData: cached.userData,
          acessoRelatorios: cached.acessoRelatorios,
        };
      } else {
        // Cache expirado, remover
        this.userAuthCache.delete(sessionId);
        this.logger.debug('Cache expirado, removendo', { sessionId });
      }
    }

    // Cache não encontrado ou expirado, autenticar
    if (!chapa && (!emplid || emplid === '0000000')) {
      return null;
    }

    let userData: any = null;
    let acessoRelatorios: any = null;

    if (chapa) {
      this.logger.log('Autenticando funcionário por CHAPA', {
        chapa,
        sessionId,
      });
      const authResult = await this.authService.identifyEmployee(chapa);
      if (authResult.success) {
        userData = authResult.data;
        acessoRelatorios = authResult.acessoRelatorios;
        this.logger.log('Funcionário autenticado com sucesso');
      } else {
        this.logger.warn('Falha na autenticação do funcionário', {
          chapa,
          error: authResult.error,
        });
        return { error: authResult.error || 'Erro ao autenticar funcionário' };
      }
    } else if (emplid && emplid !== '0000000') {
      this.logger.log('Autenticando aluno por EMPLID', { emplid, sessionId });
      const authResult = await this.authService.identifyStudent(emplid);
      if (authResult.success) {
        userData = authResult.data;
        this.logger.log('Aluno autenticado com sucesso');
      } else {
        this.logger.warn('Falha na autenticação do aluno', {
          emplid,
          error: authResult.error,
        });
        return { error: authResult.error || 'Erro ao autenticar aluno' };
      }
    }

    // Armazenar no cache se autenticação foi bem-sucedida
    if (userData) {
      this.userAuthCache.set(sessionId, {
        userData,
        acessoRelatorios,
        timestamp: Date.now(),
      });
      this.logger.debug('Dados do usuário armazenados no cache', { sessionId });
    }

    return userData ? { userData, acessoRelatorios } : null;
  }

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
    try {
      this.logger.log('User message', {
        sessionId: data.sessionId,
        text:
          data.text?.substring(0, 50) + (data.text?.length > 50 ? '...' : ''),
      });

      // Nota: A validação do assistente e persistência de conversa foram movidas/removidas
      // conforme a reestruturação para focar apenas no novo CoreModule Watsonx.

      const hasFiles = !!files && files.length > 0;

      // Verificar se é a primeira mensagem baseado no mapeamento interno do CoreService
      // O backend controla o thread_id, não o widget
      const isFirstMessage = !this.coreService.hasExistingThread(
        data.sessionId,
      );

      // Extrair apenas os valores essenciais para o contexto do agent
      const emplid = data.user?.emplid || data.user?.context?.emplid;
      const chapa = data.user?.chapa || data.user?.context?.chapa;
      // assistantId é o UUID do agent no Watson Orchestrate
      const agentId = data.assistantId;

      // Saudação: usar do widget (hora local do usuário) ou calcular no servidor como fallback
      // SEMPRE calcular para garantir que esteja disponível no contexto
      const greeting =
        data.user?.greeting ||
        data.user?.context?.greeting ||
        this.getGreetingByTime();

      // Garantir que greeting sempre seja uma string válida
      const finalGreeting = greeting || this.getGreetingByTime();

      // ===== AUTENTICAÇÃO AUTOMÁTICA (com cache) =====
      // Obtém dados do usuário do cache ou autentica se necessário
      // Nas mensagens subsequentes, reutiliza os dados já autenticados
      const authResult = await this.getUserData(data.sessionId, chapa, emplid);
      let userData: any = null;
      let acessoRelatorios: any = null;
      let authError: string | null = null;

      if (authResult) {
        // Verificar se é um erro
        if ('error' in authResult) {
          authError = authResult.error;
        } else {
          userData = authResult.userData;
          acessoRelatorios = authResult.acessoRelatorios;
        }
      }

      // Se não conseguiu autenticar, bloquear acesso na primeira mensagem
      if (!userData) {
        if (isFirstMessage) {
          authError =
            authError ||
            'Nenhum identificador de usuário fornecido ou falha na autenticação';
          const errorCode = this.generateErrorCode();
          this.logger.error('Acesso negado: usuário não autenticado', {
            authError,
            errorCode,
          });

          // Se for erro de serviço indisponível, mostrar apenas a mensagem do erro
          // Caso contrário, mostrar mensagem genérica + detalhes
          const isServiceUnavailable =
            authError && authError.includes('temporariamente indisponível');
          const errorMessage = isServiceUnavailable
            ? authError
            : 'Você não tem permissão de acesso aos recursos do assistente virtual. Verifique se está logado corretamente ou entre em contato com o suporte.';
          const errorDetails =
            !isServiceUnavailable && authError
              ? `\n\n**Detalhes:** ${authError}`
              : '';

          return {
            success: false,
            messages: [
              {
                sender: 'ai',
                message:
                  '**Não foi possível autenticar o usuário.**\n\n' +
                  errorMessage +
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
        // Nas mensagens subsequentes, apenas logar o aviso mas continuar
        this.logger.warn(
          'Dados do usuário não disponíveis no cache e não foi possível autenticar',
          {
            sessionId: data.sessionId,
          },
        );
      }

      // Construir user_info com dados do usuário autenticado
      const userInfo: any = userData
        ? {
            ...userData,
            ...(acessoRelatorios && { acessoRelatorios }),
          }
        : null;

      // Transcrever áudio ANTES de enviar para o Orchestrate
      // Arquivos de áudio não são enviados para S3 nem para Orchestrate
      // Apenas o texto transcrito é enviado como mensagem de texto
      let transcribedText: string | null = null;
      let audioFiles: Array<Express.Multer.File> = [];
      let nonAudioFiles: Array<Express.Multer.File> = [];

      this.logger.log('Verificando arquivos para transcrição', {
        hasFiles,
        filesCount: files?.length || 0,
        files: files?.map((f) => ({
          name: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
        })),
      });

      if (hasFiles && files) {
        // Separar arquivos de áudio dos outros arquivos
        audioFiles = files.filter(
          (file) =>
            file.mimetype?.startsWith('audio/') ||
            file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );
        nonAudioFiles = files.filter(
          (file) =>
            !file.mimetype?.startsWith('audio/') &&
            !file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );

        // Transcrever o primeiro arquivo de áudio encontrado
        if (audioFiles.length > 0) {
          const audioFile = audioFiles[0];
          try {
            this.logger.log('Transcrevendo áudio enviado pelo usuário', {
              fileName: audioFile.originalname,
              mimetype: audioFile.mimetype,
              bufferSize: audioFile.buffer.length,
            });

            // O serviço de Speech-to-Text aceita apenas: audio/wav, audio/flac, audio/ogg, audio/ogg;codecs=opus
            // WebM não é suportado e será rejeitado com erro claro
            transcribedText = await this.speechToTextService.recognize(
              audioFile.buffer,
              audioFile.mimetype || 'audio/ogg',
            );
            this.logger.log('Áudio transcrito com sucesso', {
              textLength: transcribedText.length,
              transcribedText:
                transcribedText.substring(0, 100) +
                (transcribedText.length > 100 ? '...' : ''),
            });
          } catch (error) {
            this.logger.error('Erro ao transcrever áudio', {
              error: error.message,
              stack: error.stack,
            });
            // Se a transcrição falhar, usar o texto original se houver
            transcribedText = null;
          }
        } else {
          this.logger.log(
            'Nenhum arquivo de áudio encontrado para transcrição',
          );
        }
      }

      // Construir o texto da mensagem: usar texto transcrito se houver áudio, senão usar texto original
      // Se for primeira mensagem e estiver vazia, enviar "oi" para iniciar a conversa
      let messageText = transcribedText || data.text || '';
      if (isFirstMessage && !messageText.trim()) {
        messageText = 'oi';
        this.logger.log(
          'Primeira mensagem vazia, enviando "oi" automaticamente',
        );
      }

      this.logger.log('Construindo payload com texto da mensagem', {
        hasTranscribedText: !!transcribedText,
        transcribedTextLength: transcribedText?.length || 0,
        hasOriginalText: !!data.text,
        originalTextLength: data.text?.length || 0,
        finalMessageText:
          messageText.substring(0, 100) +
          (messageText.length > 100 ? '...' : ''),
        finalMessageTextLength: messageText.length,
      });

      // Construir contexto simplificado - apenas dados essenciais
      const context: any = {
        // DADOS DO USUÁRIO - JÁ AUTENTICADO
        ...(userInfo && { user_info: userInfo }),

        // IMPORTANTE: is_first_message é determinado pelo backend via CoreService.hasExistingThread
        is_first_message: isFirstMessage,

        // Session ID para referência
        session_id: data.sessionId,

        // Saudação baseada na hora local do usuário (Bom dia, Boa tarde, Boa noite)
        greeting: finalGreeting,

        // Data do navegador do usuário (se disponível) para uso em cálculos de data
        ...(data.timestamp && { client_timestamp: data.timestamp }),
        // Data atual do servidor como fallback
        server_timestamp: new Date().toISOString(),
      };

      // Log detalhado do contexto para debug
      this.logger.log('Contexto sendo enviado ao Watson Orchestrate', {
        hasUserInfo: !!userInfo,
        isFirstMessage,
        greeting: finalGreeting,
        contextKeys: Object.keys(context),
      });

      const payload: CoreRunDto = {
        message: {
          type: 'text',
          text: this.sanitizeTextForWatson(messageText),
        },
        conversationId: data.sessionId,
        profileName: 'Widget User',
        context: context,
        channel: 'widget',
        agentId: agentId, // Agent ID na raiz do payload
      };

      // Enviar apenas arquivos NÃO-áudio para o CoreService
      // Arquivos de áudio já foram transcritos e o texto está na mensagem
      const filesToProcess =
        nonAudioFiles.length > 0 ? nonAudioFiles : undefined;

      // Chamada direta ao CoreService novo
      const coreResponse = await this.coreService.run(
        payload,
        null, // Assistant entity removida
        filesToProcess, // Apenas arquivos não-áudio
      );

      let response: WidgetConversationResponseDto = {
        success: true,
        messages: [],
        settings: {} as WidgetSettingsDto,
        // Adicionar texto transcrito na resposta para que o widget possa atualizar a mensagem do usuário
        ...(transcribedText && { transcribedText }),
      };

      // Padronizar a resposta do Watson independente da estrutura
      const standardizedData = await this.standardizeWatsonResponse(
        coreResponse.response,
        coreResponse.context,
      );
      response.messages = standardizedData.messages;

      // Log do texto transcrito
      if (transcribedText) {
        this.logger.log('Texto transcrito disponível na resposta', {
          transcribedTextLength: transcribedText.length,
          transcribedTextPreview: transcribedText.substring(0, 100) + '...',
        });
      }
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
    } catch (error) {
      this.logger.error('Erro no método run', {
        error: error.message,
        stack: error.stack,
        sessionId: data?.sessionId,
      });
      throw error;
    }
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
      files: files?.map((f) => ({
        name: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
      })),
    });
    this.logger.log('runWithStreaming - Detalhes dos arquivos', {
      filesCount: files?.length || 0,
      files: files?.map((f) => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        bufferLength: f.buffer?.length || 0,
      })),
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

    // IMPORTANTE: Usar shareReplay para compartilhar o Observable entre múltiplos subscribers
    // Isso evita que executeWithStatusEvents seja executado múltiplas vezes
    // Cada subscribe em um Observable "cold" executa a função de criação novamente
    // Com shareReplay, o Observable se torna "hot" e compartilha a mesma execução
    return observable.pipe(shareReplay());
  }

  /**
   * Executa o processamento e emite eventos SSE
   */
  private async executeWithStatusEvents(
    data: WidgetConversationDto,
    files: Array<Express.Multer.File> | undefined,
    subject: Subject<MessageEvent>,
  ): Promise<void> {
    console.log('[BrokerWidgetService] executeWithStatusEvents iniciado', {
      hasFiles: !!files,
      filesCount: files?.length || 0,
      files: files?.map((f) => ({
        name: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
      })),
    });
    this.logger.log('executeWithStatusEvents - Início', {
      hasFiles: !!files,
      filesCount: files?.length || 0,
      sessionId: data.sessionId,
      hasText: !!data.text,
      textLength: data.text?.length || 0,
    });
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
      // SEMPRE calcular para garantir que esteja disponível no contexto
      const greeting =
        data.user?.greeting ||
        data.user?.context?.greeting ||
        this.getGreetingByTime();

      // Garantir que greeting sempre seja uma string válida
      const finalGreeting = greeting || this.getGreetingByTime();

      // ===== AUTENTICAÇÃO AUTOMÁTICA (com cache) =====
      // Obtém dados do usuário do cache ou autentica se necessário
      // Nas mensagens subsequentes, reutiliza os dados já autenticados
      const authResult = await this.getUserData(data.sessionId, chapa, emplid);
      let userData: any = null;
      let acessoRelatorios: any = null;
      let authError: string | null = null;

      if (authResult) {
        // Verificar se é um erro
        if ('error' in authResult) {
          authError = authResult.error;
        } else {
          userData = authResult.userData;
          acessoRelatorios = authResult.acessoRelatorios;
        }
      }

      // Se não conseguiu autenticar, bloquear acesso na primeira mensagem
      if (!userData) {
        if (isFirstMessage) {
          authError =
            authError ||
            'Nenhum identificador de usuário fornecido ou falha na autenticação';
          const errorCode = this.generateErrorCode();
          this.logger.error('Acesso negado: usuário não autenticado', {
            authError,
            errorCode,
          });

          // Se for erro de serviço indisponível, mostrar apenas a mensagem do erro
          // Caso contrário, mostrar mensagem genérica + detalhes
          const isServiceUnavailable =
            authError && authError.includes('temporariamente indisponível');
          const errorMessage = isServiceUnavailable
            ? authError
            : 'Você não tem permissão de acesso aos recursos do assistente virtual. Verifique se está logado corretamente ou entre em contato com o suporte.';
          const errorDetails =
            !isServiceUnavailable && authError
              ? `\n\n**Detalhes:** ${authError}`
              : '';

          const errorMessageObj = {
            sender: 'ai',
            message:
              '**Não foi possível autenticar o usuário.**\n\n' +
              errorMessage +
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
                messages: [errorMessageObj],
                settings: {},
              },
            }),
          } as MessageEvent;

          subject.next(sseEvent);
          subject.complete();
          return;
        }
        // Nas mensagens subsequentes, apenas logar o aviso mas continuar
        this.logger.warn(
          'Dados do usuário não disponíveis no cache e não foi possível autenticar (streaming)',
          {
            sessionId: data.sessionId,
          },
        );
      }

      // Construir user_info com dados do usuário autenticado
      const userInfo: any = userData
        ? {
            ...userData,
            ...(acessoRelatorios && { acessoRelatorios }),
          }
        : null;

      // Transcrever áudio ANTES de enviar para o Orchestrate (mesma lógica do método run)
      // Arquivos de áudio não são enviados para S3 nem para Orchestrate
      // Apenas o texto transcrito é enviado como mensagem de texto
      const hasFiles = !!files && files.length > 0;
      let transcribedText: string | null = null;
      let audioFiles: Array<Express.Multer.File> = [];
      let nonAudioFiles: Array<Express.Multer.File> = [];

      this.logger.log('Verificando arquivos para transcrição (streaming)', {
        hasFiles,
        filesCount: files?.length || 0,
        files: files?.map((f) => ({
          name: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
        })),
      });

      if (hasFiles && files) {
        this.logger.log(
          'Processando arquivos - Separando áudio de outros arquivos',
          {
            totalFiles: files.length,
          },
        );

        // Separar arquivos de áudio dos outros arquivos
        audioFiles = files.filter(
          (file) =>
            file.mimetype?.startsWith('audio/') ||
            file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );
        nonAudioFiles = files.filter(
          (file) =>
            !file.mimetype?.startsWith('audio/') &&
            !file.originalname?.match(/\.(wav|webm|ogg|flac|mp3|m4a)$/i),
        );

        this.logger.log('Arquivos separados', {
          audioFilesCount: audioFiles.length,
          nonAudioFilesCount: nonAudioFiles.length,
          audioFiles: audioFiles.map((f) => ({
            name: f.originalname,
            mimetype: f.mimetype,
          })),
        });

        // Transcrever o primeiro arquivo de áudio encontrado
        if (audioFiles.length > 0) {
          const audioFile = audioFiles[0];
          try {
            this.logger.log(
              'Transcrevendo áudio enviado pelo usuário (streaming)',
              {
                fileName: audioFile.originalname,
                mimetype: audioFile.mimetype,
                bufferSize: audioFile.buffer.length,
              },
            );

            // O serviço de Speech-to-Text aceita apenas: audio/wav, audio/flac, audio/ogg, audio/ogg;codecs=opus
            // WebM não é suportado e será rejeitado com erro claro
            transcribedText = await this.speechToTextService.recognize(
              audioFile.buffer,
              audioFile.mimetype || 'audio/ogg',
            );
            this.logger.log('Áudio transcrito com sucesso (streaming)', {
              textLength: transcribedText.length,
              transcribedText:
                transcribedText.substring(0, 100) +
                (transcribedText.length > 100 ? '...' : ''),
            });
          } catch (error) {
            this.logger.error('Erro ao transcrever áudio (streaming)', {
              error: error.message,
              stack: error.stack,
            });
            transcribedText = null;
          }
        } else {
          this.logger.log(
            'Nenhum arquivo de áudio encontrado para transcrição (streaming)',
          );
        }
      }

      // Construir o texto da mensagem: usar texto transcrito se houver áudio, senão usar texto original
      // Se for primeira mensagem e estiver vazia, enviar "oi" para iniciar a conversa
      let messageText = transcribedText || data.text || '';
      if (isFirstMessage && !messageText.trim()) {
        messageText = 'oi';
        this.logger.log(
          'Primeira mensagem vazia, enviando "oi" automaticamente (streaming)',
        );
      }

      this.logger.log('Construindo payload com texto da mensagem (streaming)', {
        hasTranscribedText: !!transcribedText,
        transcribedTextLength: transcribedText?.length || 0,
        hasOriginalText: !!data.text,
        originalTextLength: data.text?.length || 0,
        finalMessageText:
          messageText.substring(0, 100) +
          (messageText.length > 100 ? '...' : ''),
        finalMessageTextLength: messageText.length,
      });

      const payload: CoreRunDto = {
        message: {
          type: 'text',
          text: this.sanitizeTextForWatson(messageText),
        },
        conversationId: data.sessionId,
        profileName: 'Widget User',
        context: (() => {
          // Construir contexto simplificado - apenas dados essenciais
          const ctx: any = {
            // DADOS DO USUÁRIO - JÁ AUTENTICADO
            ...(userInfo && { user_info: userInfo }),

            // IMPORTANTE: is_first_message é determinado pelo backend via CoreService.hasExistingThread
            is_first_message: isFirstMessage,

            // Session ID para referência
            session_id: data.sessionId,

            // Saudação baseada na hora local do usuário (Bom dia, Boa tarde, Boa noite)
            greeting: finalGreeting,

            // Data do navegador do usuário (se disponível) para uso em cálculos de data
            ...(data.timestamp && { client_timestamp: data.timestamp }),
            // Data atual do servidor como fallback
            server_timestamp: new Date().toISOString(),
          };
          return ctx;
        })(),
        channel: 'widget',
        agentId: agentId, // Agent ID na raiz do payload
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
      // Passar apenas arquivos não-áudio (arquivos de áudio já foram transcritos)
      const filesToProcess =
        nonAudioFiles.length > 0 ? nonAudioFiles : undefined;
      const coreResponse = await this.coreService.run(
        payload,
        null,
        filesToProcess, // Apenas arquivos não-áudio
        onStatus,
      );

      // Processar resposta final
      const standardizedData = await this.standardizeWatsonResponse(
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
        // Adicionar texto transcrito na resposta para que o widget possa atualizar a mensagem do usuário
        ...(transcribedText && { transcribedText }),
      };

      // Debug: verificar toolInfo nas mensagens antes de serializar
      const messagesWithToolInfo = response.messages.filter(
        (msg) => msg.toolInfo,
      );
      if (messagesWithToolInfo.length > 0) {
        this.logger.debug('Mensagens com toolInfo antes de serializar SSE', {
          count: messagesWithToolInfo.length,
          messageIds: messagesWithToolInfo.map((m) => m.messageId),
          toolInfoDetails: messagesWithToolInfo.map((m) => ({
            messageId: m.messageId,
            hasToolInfo: !!m.toolInfo,
            toolInfoKeys: m.toolInfo ? Object.keys(m.toolInfo) : [],
            hasPayload: !!m.toolInfo?.payload,
            hasResponse: !!m.toolInfo?.response,
          })),
        });

        // Verificar se toolInfo está no JSON serializado
        const serialized = JSON.stringify({
          event: 'response',
          data: response,
        });
        const parsed = JSON.parse(serialized);
        const serializedMessagesWithToolInfo = parsed.data.messages.filter(
          (msg: any) => msg.toolInfo,
        );
        this.logger.debug('Mensagens com toolInfo após serialização JSON', {
          count: serializedMessagesWithToolInfo.length,
          messageIds: serializedMessagesWithToolInfo.map(
            (m: any) => m.messageId,
          ),
          firstMessageToolInfo: serializedMessagesWithToolInfo[0]?.toolInfo
            ? {
                hasToolInfo: !!serializedMessagesWithToolInfo[0].toolInfo,
                toolInfoKeys: Object.keys(
                  serializedMessagesWithToolInfo[0].toolInfo,
                ),
                payloadPreview: JSON.stringify(
                  serializedMessagesWithToolInfo[0].toolInfo.payload,
                ).substring(0, 100),
              }
            : null,
        });
      }

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

  private async standardizeWatsonResponse(
    responseCore: any,
    context: any,
  ): Promise<{ messages: WidgetMessageDto[]; updatedVariables: any }> {
    const standardizedMessages: WidgetMessageDto[] = [];

    // Estrutura watson dialog responseCore.output.generic
    if (responseCore?.output?.generic) {
      this.logger.debug('Standardizing Watson response', {
        genericCount: responseCore.output.generic.length,
        firstMessageType: responseCore.output.generic[0]?.response_type,
        hasForms: responseCore.output.generic.some(
          (m: any) => m.response_type === 'forms',
        ),
      });

      // Criar mapas para rastrear relações entre mensagens
      const messageStepHistoryMap = new Map<string, any[]>();
      const messageParentMap = new Map<string, string | null>(); // message_id -> parent_message_id

      // Primeiro, construir os mapas de todas as mensagens
      responseCore.output.generic.forEach((msg: any) => {
        let msgStepHistory = msg._step_history || null;
        let msgParentId: string | null = null;
        const msgId = msg._message_id || msg.id;

        // Procurar step_history e parent_message_id nos itens de content
        if (msg.content) {
          if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (item?._step_history && !msgStepHistory) {
                msgStepHistory = item._step_history;
              }
              if (item?._parent_message_id && !msgParentId) {
                msgParentId = item._parent_message_id;
              }
            }
          } else {
            if (msg.content._step_history && !msgStepHistory) {
              msgStepHistory = msg.content._step_history;
            }
            if (msg.content._parent_message_id && !msgParentId) {
              msgParentId = msg.content._parent_message_id;
            }
          }
        }

        if (msgId) {
          if (msgStepHistory) {
            messageStepHistoryMap.set(msgId, msgStepHistory);
          }
          messageParentMap.set(msgId, msgParentId);
        }
      });

      let i = 0;
      while (i < responseCore.output.generic.length) {
        const message = responseCore.output.generic[i];

        // Log detalhado para forms
        if (message.response_type === 'forms') {
          this.logger.debug('Found forms message', {
            hasJsonSchema: !!message.json_schema,
            hasUiSchema: !!message.ui_schema,
            hasName: !!message.name,
            jsonSchemaTitle: message.json_schema?.title,
            propertiesCount: message.json_schema?.properties
              ? Object.keys(message.json_schema.properties).length
              : 0,
          });
        }

        // Extrair step_history ANTES de processar a mensagem
        // O step_history pode estar em vários lugares:
        // 1. message._step_history (adicionado pelo watsonx.service)
        // 2. message.content[0]._step_history (se content for array)
        // 3. Em qualquer item de message.content que tenha _step_history
        let stepHistory = message._step_history || null;
        let flowInstanceId: string | null = null;

        // Se não encontrou, procurar em todos os itens de content
        if (!stepHistory && message.content) {
          if (Array.isArray(message.content)) {
            // Procurar em todos os itens do array
            for (const item of message.content) {
              if (item?._step_history) {
                stepHistory = item._step_history;
              }
              // Também capturar flowInstanceId se disponível
              if (item?._flow_instance_id) {
                flowInstanceId = item._flow_instance_id;
              }
            }
          } else if (message.content._step_history) {
            stepHistory = message.content._step_history;
          }
          if (message.content._flow_instance_id) {
            flowInstanceId = message.content._flow_instance_id;
          }
        }

        // Fallback: tentar no context
        if (!stepHistory && context?.stepHistory) {
          stepHistory = context.stepHistory;
        }

        // Verificar se a mensagem menciona uma ferramenta no texto (indicador de resposta de tool)
        // Exemplos: "The result from the `gep_flow_consulta_saldo_horas` tool", "Error in flow execution"
        const messageText = message.text || message.content?.[0]?.text || '';
        const mentionsTool = this.messageMentionsTool(messageText);

        // Detectar mensagens "Tool is processing..." (is_async: true ou texto específico)
        let isAsyncToolProcessing = false;
        let skipRender = false;

        // Procurar flags nos itens de content
        if (message.content) {
          if (Array.isArray(message.content)) {
            for (const item of message.content) {
              if (item?._is_async) {
                isAsyncToolProcessing = item._is_async;
              }
              if (item?._skip_render) {
                skipRender = item._skip_render;
              }
            }
          } else {
            if (message.content._is_async) {
              isAsyncToolProcessing = message.content._is_async;
            }
            if (message.content._skip_render) {
              skipRender = message.content._skip_render;
            }
          }
        }

        // Também verificar pelo texto (fallback)
        const isToolProcessingText =
          messageText.includes('Tool is processing') ||
          messageText.includes('Please wait until the tool completes') ||
          messageText.includes('A new flow has started') ||
          messageText.includes(
            'This chat session is currently dedicated to the flow',
          );

        const isToolProcessingMessage =
          isAsyncToolProcessing || isToolProcessingText;

        // Se for mensagem "Tool is processing...", extrair flowInstanceId do texto
        if (isToolProcessingMessage && !flowInstanceId) {
          const flowInstanceIdMatch = messageText.match(
            /flow instance ID ([a-f0-9-]+)/i,
          );
          if (flowInstanceIdMatch && flowInstanceIdMatch[1]) {
            flowInstanceId = flowInstanceIdMatch[1];
            this.logger.debug('FlowInstanceId extraído do texto da mensagem', {
              flowInstanceId,
              messageText: messageText.substring(0, 100),
            });
          }
        }

        // Verificar se esta mensagem é descendente (filha, neta, etc.) de uma mensagem que tinha tool_calls
        // Isso indica que esta mensagem é a resposta da ferramenta
        let currentMessageId: string | null =
          message._message_id || message.id || null;
        let hasAncestorWithToolCalls = false;
        const visitedIds = new Set<string>(); // Prevenir loops infinitos

        // Rastrear a cadeia de ancestrais até encontrar uma mensagem com tool_calls
        while (currentMessageId && !visitedIds.has(currentMessageId)) {
          visitedIds.add(currentMessageId);

          // Verificar se a mensagem atual tinha tool_calls
          const currentStepHistory =
            messageStepHistoryMap.get(currentMessageId);
          if (currentStepHistory && this.hasToolCalls(currentStepHistory)) {
            hasAncestorWithToolCalls = true;
            break;
          }

          // Ir para o próximo ancestral
          currentMessageId = messageParentMap.get(currentMessageId) || null;
        }

        // Também verificar o parent direto (para compatibilidade)
        let directParentId: string | null = null;
        if (message.content) {
          if (Array.isArray(message.content)) {
            for (const item of message.content) {
              if (item?._parent_message_id) {
                directParentId = item._parent_message_id;
                break;
              }
            }
          } else if (message.content._parent_message_id) {
            directParentId = message.content._parent_message_id;
          }
        }

        // Verificar se o parent direto tinha tool_calls
        let directParentHadToolCalls = false;
        if (directParentId) {
          const directParentStepHistory =
            messageStepHistoryMap.get(directParentId);
          if (directParentStepHistory) {
            directParentHadToolCalls = this.hasToolCalls(
              directParentStepHistory,
            );
          }
        }

        const parentHadToolCalls =
          hasAncestorWithToolCalls || directParentHadToolCalls;

        // Log para debug
        if (stepHistory) {
          this.logger.debug(
            'Step history encontrado para extração de toolInfo',
            {
              messageType: message.response_type,
              hasStepHistory: !!stepHistory,
              stepHistoryLength: Array.isArray(stepHistory)
                ? stepHistory.length
                : 0,
              messageKeys: Object.keys(message),
            },
          );
        } else {
          this.logger.debug('Step history não encontrado', {
            messageType: message.response_type,
            hasMessageStepHistory: !!message._step_history,
            hasContent: !!message.content,
            isContentArray: Array.isArray(message.content),
            hasContentStepHistory: !!(
              message.content &&
              Array.isArray(message.content) &&
              message.content[0]?._step_history
            ),
            hasContextStepHistory: !!context?.stepHistory,
            messageKeys: Object.keys(message),
          });
        }

        const standardizedMessage = this.processMessageByType(
          message,
          i,
          responseCore.output.generic,
          context,
        );

        if (standardizedMessage) {
          // Se skip_render estiver ativo, não adicionar a mensagem
          if (skipRender) {
            this.logger.debug('Mensagem ignorada devido a skip_render', {
              messageText: messageText.substring(0, 100),
            });
            i++; // Incrementar manualmente antes do continue
            continue; // Pula para próxima mensagem
          }

          // Ignorar mensagens "Tool is processing..." completamente
          if (isToolProcessingMessage) {
            this.logger.debug('Mensagem "Tool is processing" ignorada', {
              messageText: messageText.substring(0, 100),
            });
            i++; // Incrementar manualmente antes do continue
            continue; // Pula para próxima mensagem
          }
          // LÓGICA SIMPLIFICADA: Só adicionar toolInfo se:
          // 1. A mensagem tem tool_response no step_history (resposta direta da ferramenta)
          // 2. A mensagem tem flowInstanceId (indica que uma ferramenta foi executada)
          // 3. A mensagem é "Tool is processing..." (is_async: true) - mesmo que ainda não tenha resposta completa

          const hasToolResponse =
            stepHistory && this.hasToolResponse(stepHistory);
          // Para mensagens "Tool is processing...", também verificar se tem tool_calls (payload)
          const hasToolCalls = stepHistory && this.hasToolCalls(stepHistory);
          const shouldAddToolInfo =
            hasToolResponse ||
            hasToolCalls ||
            flowInstanceId ||
            isToolProcessingMessage;

          this.logger.debug('Verificando se deve adicionar toolInfo', {
            hasToolResponse,
            flowInstanceId,
            isToolProcessingMessage,
            shouldAddToolInfo,
            messageText: messageText.substring(0, 100),
          });

          if (shouldAddToolInfo) {
            // Tentar extrair do step_history primeiro (pode ter tool_response ou tool_calls)
            let toolInfo =
              (hasToolResponse || hasToolCalls) && stepHistory
                ? this.extractToolInfoFromStepHistory(stepHistory)
                : null;

            // IMPORTANTE: Sempre buscar response da flow instance
            // O step_history não tem o output real, apenas mensagens de texto
            // O output real vem de tasks[].output.data ou flowInstance.error
            if (flowInstanceId) {
              this.logger.debug(
                'Buscando toolInfo na flow instance (output real)',
                {
                  flowInstanceId,
                  hasToolInfo: !!toolInfo,
                  hasPayload: !!toolInfo?.payload,
                  hasResponseFromStepHistory: !!toolInfo?.response,
                },
              );
              const flowInstanceToolInfo =
                await this.extractToolInfoFromFlowInstance(flowInstanceId);
              if (flowInstanceToolInfo) {
                toolInfo = {
                  toolName: toolInfo?.toolName || flowInstanceToolInfo.toolName,
                  toolCallId:
                    toolInfo?.toolCallId || flowInstanceToolInfo.toolCallId,
                  payload: toolInfo?.payload || flowInstanceToolInfo.payload,
                  response: flowInstanceToolInfo.response,
                };
                this.logger.debug(
                  'ToolInfo atualizado com dados da flow instance',
                  {
                    hasPayload: !!toolInfo.payload,
                    hasResponse: !!toolInfo.response,
                    responseSource: flowInstanceToolInfo.response
                      ? 'flow_instance'
                      : 'step_history',
                  },
                );
              }
            }

            // Adicionar toolInfo se:
            // 1. Tiver payload OU response (resposta completa)
            // 2. OU for mensagem "Tool is processing..." e tiver pelo menos o payload (ainda processando)
            if (toolInfo) {
              const hasPayloadOrResponse =
                toolInfo.payload || toolInfo.response;
              const isProcessingWithPayload =
                isToolProcessingMessage && toolInfo.payload;

              this.logger.debug(
                'Verificando condições para adicionar toolInfo',
                {
                  hasToolInfo: !!toolInfo,
                  hasPayload: !!toolInfo.payload,
                  hasResponse: !!toolInfo.response,
                  hasPayloadOrResponse,
                  isProcessingWithPayload,
                  isToolProcessingMessage,
                  shouldAdd: hasPayloadOrResponse || isProcessingWithPayload,
                },
              );

              if (hasPayloadOrResponse || isProcessingWithPayload) {
                this.logger.debug('ToolInfo adicionado à mensagem', {
                  toolName: toolInfo.toolName,
                  hasPayload: !!toolInfo.payload,
                  hasResponse: !!toolInfo.response,
                  source: hasToolResponse ? 'step_history' : 'flow_instance',
                  isToolProcessing: isToolProcessingMessage,
                  toolInfoPayload: toolInfo.payload
                    ? JSON.stringify(toolInfo.payload).substring(0, 100)
                    : 'null',
                });
                standardizedMessage.toolInfo = toolInfo;
                // Log adicional para debug
                this.logger.debug('ToolInfo serializado na mensagem', {
                  messageId: standardizedMessage.messageId,
                  hasToolInfo: !!standardizedMessage.toolInfo,
                  toolInfoKeys: standardizedMessage.toolInfo
                    ? Object.keys(standardizedMessage.toolInfo)
                    : [],
                });
              } else {
                this.logger.debug(
                  'ToolInfo NÃO adicionado - condições não satisfeitas',
                  {
                    hasPayload: !!toolInfo.payload,
                    hasResponse: !!toolInfo.response,
                    isToolProcessingMessage,
                  },
                );
              }
            } else {
              this.logger.debug('ToolInfo é null - não pode adicionar', {
                hasToolResponse,
                hasToolCalls,
                flowInstanceId,
                isToolProcessingMessage,
              });
            }

            // Se for "Tool is processing..." mas não conseguiu extrair toolInfo ainda,
            // tentar buscar o payload e output/error da flow instance
            if (
              isToolProcessingMessage &&
              flowInstanceId &&
              !standardizedMessage.toolInfo
            ) {
              this.logger.debug(
                'Tentando buscar toolInfo para mensagem "Tool is processing..."',
                { flowInstanceId },
              );
              const flowInstanceToolInfo =
                await this.extractToolInfoFromFlowInstance(flowInstanceId);
              if (flowInstanceToolInfo && flowInstanceToolInfo.payload) {
                standardizedMessage.toolInfo = {
                  toolName: flowInstanceToolInfo.toolName,
                  payload: flowInstanceToolInfo.payload,
                  // response pode ser output ou error
                  response: flowInstanceToolInfo.response || undefined,
                };
                this.logger.debug(
                  'ToolInfo adicionado para "Tool is processing..."',
                  {
                    toolName: flowInstanceToolInfo.toolName,
                    hasPayload: !!flowInstanceToolInfo.payload,
                    hasResponse: !!flowInstanceToolInfo.response,
                  },
                );
              }
            }
          }

          // Debug: verificar toolInfo antes de adicionar ao array
          if (standardizedMessage.toolInfo) {
            this.logger.debug(
              'Mensagem com toolInfo sendo adicionada ao array',
              {
                messageId: standardizedMessage.messageId,
                message: standardizedMessage.message?.substring(0, 50),
                hasToolInfo: !!standardizedMessage.toolInfo,
                toolInfoKeys: Object.keys(standardizedMessage.toolInfo),
                toolInfoPayload: standardizedMessage.toolInfo.payload
                  ? JSON.stringify(
                      standardizedMessage.toolInfo.payload,
                    ).substring(0, 100)
                  : 'null',
              },
            );
          }

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
      case 'forms':
        return this.processFormsMessage(message);
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

    // Extrair toolInfo do step_history se disponível
    // O step_history pode estar em message._step_history (adicionado pelo watsonx.service)
    let stepHistory = message._step_history || null;
    if (!stepHistory && context?.stepHistory) {
      stepHistory = context.stepHistory;
    }
    const toolInfo = stepHistory
      ? this.extractToolInfoFromStepHistory(stepHistory)
      : null;

    // Extrair thinking/reasoning se disponível
    // O thinking pode estar em message._thinking (adicionado pelo watsonx.service)
    let thinking = message._thinking || null;
    if (!thinking && context?.thinking) {
      thinking = context.thinking;
    }
    // Se thinking for array, pegar o último item ou concatenar
    if (Array.isArray(thinking) && thinking.length > 0) {
      thinking = thinking[thinking.length - 1];
    }
    // Se thinking for objeto, extrair text ou content
    if (thinking && typeof thinking === 'object') {
      thinking = thinking.text || thinking.content || thinking;
    }
    // Garantir que seja string ou null
    thinking =
      typeof thinking === 'string' && thinking.trim() ? thinking.trim() : null;

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
        // Adicionar toolInfo se disponível
        ...(toolInfo && { toolInfo }),
        // Adicionar thinking se disponível
        ...(thinking && { thinking }),
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
        // Adicionar toolInfo se disponível
        ...(toolInfo && { toolInfo }),
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
          // Adicionar toolInfo se disponível
          ...(toolInfo && { toolInfo }),
          // Adicionar thinking se disponível
          ...(thinking && { thinking }),
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
          // Adicionar toolInfo se disponível
          ...(toolInfo && { toolInfo }),
        };
      }
    }

    return {
      sender: 'ai',
      message: normalizedText,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
      // Adicionar toolInfo se disponível
      ...(toolInfo && { toolInfo }),
      // Adicionar thinking se disponível
      ...(thinking && { thinking }),
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

  private processFormsMessage(message: any): any {
    this.logger.debug('Processing forms message', {
      hasJsonSchema: !!message.json_schema,
      hasUiSchema: !!message.ui_schema,
      hasFormData: !!message.form_data,
      hasName: !!message.name,
      jsonSchemaKeys: message.json_schema
        ? Object.keys(message.json_schema)
        : [],
      uiSchemaKeys: message.ui_schema ? Object.keys(message.ui_schema) : [],
    });

    // Garantir que temos os dados necessários
    if (!message.json_schema || !message.ui_schema) {
      this.logger.warn('Forms message missing required data', {
        message: JSON.stringify(message).substring(0, 500),
      });
      return null;
    }

    return {
      sender: 'ai',
      message:
        message.json_schema?.title || 'Por favor, preencha o formulário.',
      component: 'forms',
      form: {
        name: message.name || 'form',
        json_schema: message.json_schema,
        ui_schema: message.ui_schema,
        form_data: message.form_data || {},
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

    // Verificar se é um JSON de formulário (não sanitizar para preservar estrutura)
    try {
      const parsed = JSON.parse(text);
      if (parsed.form_name && parsed.form_data) {
        // É um formulário, retornar como está (já está stringificado)
        return text;
      }
    } catch {
      // Não é JSON válido, continuar com sanitização
    }

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

  /**
   * Verifica se o texto da mensagem menciona uma ferramenta
   * Isso ajuda a identificar mensagens de resposta de tool mesmo quando step_history está vazio
   */
  private messageMentionsTool(text: string): boolean {
    if (!text) return false;

    const toolIndicators = [
      /result from the.*tool/i,
      /error in flow execution/i,
      /flow.*failed/i,
      /tool.*result/i,
      /tool.*error/i,
      /flow.*error/i,
    ];

    return toolIndicators.some((pattern) => pattern.test(text));
  }

  /**
   * Verifica se o step_history contém tool_calls (chamada de ferramenta)
   * Isso indica que há um payload disponível, mesmo que ainda não tenha resposta
   */
  private hasToolCalls(stepHistory: any[]): boolean {
    if (!stepHistory || !Array.isArray(stepHistory)) {
      return false;
    }

    for (const step of stepHistory) {
      if (step.step_details && Array.isArray(step.step_details)) {
        for (const detail of step.step_details) {
          if (detail.type === 'tool_calls' && detail.tool_calls) {
            return true;
          }
          // Verificar tool_calls diretamente no detail
          if (detail.tool_calls) {
            return true;
          }
        }
      }
      // Verificar diretamente no step
      if (step.tool_calls) {
        return true;
      }
    }

    return false;
  }

  /**
   * Verifica se o step_history contém uma resposta de ferramenta (tool_response)
   * Isso indica que esta mensagem foi gerada APÓS a execução da ferramenta
   */
  private hasToolResponse(stepHistory: any[]): boolean {
    if (!stepHistory || !Array.isArray(stepHistory)) {
      return false;
    }

    for (const step of stepHistory) {
      if (step.step_details && Array.isArray(step.step_details)) {
        for (const detail of step.step_details) {
          // Se encontrou tool_response, esta mensagem contém a resposta da ferramenta
          if (detail.type === 'tool_response') {
            return true;
          }
          // Também verificar tool_output diretamente
          if (detail.tool_output) {
            return true;
          }
        }
      }
      // Verificar diretamente no step
      if (step.tool_output) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extrai informações de tool call (payload e resposta) do step_history
   * IMPORTANTE: Só deve ser chamado para mensagens que contêm tool_response
   * @param stepHistory - Array de steps da mensagem
   * @returns Objeto com toolName, toolCallId, payload (args) e response (tool_output)
   */
  private extractToolInfoFromStepHistory(stepHistory: any[]): {
    toolName?: string;
    toolCallId?: string;
    payload?: any;
    response?: any;
  } | null {
    if (!stepHistory || !Array.isArray(stepHistory)) {
      return null;
    }

    // Procurar por tool_calls e tool_response no step_history
    let toolCall: any = null;
    let toolResponse: any = null;

    for (const step of stepHistory) {
      if (step.step_details && Array.isArray(step.step_details)) {
        for (const detail of step.step_details) {
          // Encontrar tool call
          if (detail.type === 'tool_calls' && detail.tool_calls) {
            const firstToolCall = detail.tool_calls[0];
            if (firstToolCall) {
              toolCall = {
                toolName: firstToolCall.name,
                toolCallId: firstToolCall.id,
                payload: firstToolCall.args,
              };
            }
          }
        }
      }

      // Não verificar tool_output no step - o output real vem da flow instance
      if (step.tool_calls && !toolCall) {
        const firstToolCall = Array.isArray(step.tool_calls)
          ? step.tool_calls[0]
          : step.tool_calls;
        if (firstToolCall) {
          toolCall = {
            toolName: firstToolCall.name || firstToolCall.tool_name,
            toolCallId: firstToolCall.id || firstToolCall.tool_call_id,
            payload:
              firstToolCall.args ||
              firstToolCall.arguments ||
              firstToolCall.payload,
          };
        }
      }
    }

    // IMPORTANTE: Retornar toolInfo se houver tool_calls (pelo menos o payload)
    // O response pode ser null se ainda está processando (será buscado da flow instance depois)
    if (toolCall) {
      return {
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        payload: toolCall.payload,
        response: toolResponse || undefined, // Pode ser undefined se ainda está processando
      };
    }

    return null;
  }

  /**
   * Extrai informações de tool (payload e retorno) da flow instance
   * Busca nas tasks da flow instance quando o step_history não tem informações completas
   */
  private async extractToolInfoFromFlowInstance(
    flowInstanceId: string,
  ): Promise<{
    toolName?: string;
    toolCallId?: string;
    payload?: any;
    response?: any;
  } | null> {
    try {
      const flowInstance =
        await this.watsonxService.getFlowInstanceDetails(flowInstanceId);

      if (!flowInstance) {
        return null;
      }

      // INPUT: Sempre pegar do nível raiz da flow instance
      const payload = flowInstance.input || {};

      // OUTPUT/ERROR: Priorizar nível raiz, depois tasks
      let response: any = null;
      let toolName: string | null = flowInstance.name || null;

      // Se houver error no nível raiz, usar ele como response
      if (flowInstance.error) {
        try {
          // O error pode ser uma string JSON ou objeto
          const errorObj =
            typeof flowInstance.error === 'string'
              ? JSON.parse(flowInstance.error)
              : flowInstance.error;
          response = errorObj;
        } catch {
          // Se não for JSON válido, usar como string
          response = { error: flowInstance.error };
        }
      }
      // Se houver output no nível raiz e não for vazio, usar ele
      else if (
        flowInstance.output &&
        Object.keys(flowInstance.output).length > 0
      ) {
        response = flowInstance.output;
      }
      // Caso contrário, procurar nas tasks por uma task de tool
      else if (flowInstance.tasks && Array.isArray(flowInstance.tasks)) {
        for (const task of flowInstance.tasks) {
          // Procurar por tasks que são tools (geralmente têm name que corresponde ao nome da tool)
          // Tasks de tool geralmente têm input e output com os dados completos
          if (
            task.state === 'completed' &&
            task.output &&
            task.output.data &&
            (task.output.data.status !== undefined ||
              task.output.data.info !== undefined ||
              task.output.data.error !== undefined ||
              task.output.data.saldo_anterior !== undefined ||
              task.output.data.saldo_atual !== undefined)
          ) {
            toolName = task.name || toolName;
            response = task.output.data;
            // Se a task tiver input específico, usar ele (senão usar o input da flow instance)
            if (task.input && Object.keys(task.input).length > 0) {
              return {
                toolName: toolName ? toolName : undefined,
                payload: task.input,
                response,
              };
            }
            break;
          }
          // Se a task tiver error, usar ele
          if (task.error) {
            toolName = task.name || toolName;
            try {
              const errorObj =
                typeof task.error === 'string'
                  ? JSON.parse(task.error)
                  : task.error;
              response = errorObj;
            } catch {
              response = { error: task.error } as any;
            }
            break;
          }
        }
      }

      // Retornar mesmo se só tiver payload (para mensagens "Tool is processing...")
      // O response pode ser null se ainda está processando
      return {
        toolName: toolName ?? undefined,
        payload: Object.keys(payload).length > 0 ? payload : undefined,
        response: response ?? undefined,
      };
    } catch (error) {
      this.logger.warn('Erro ao buscar flow instance para toolInfo', {
        flowInstanceId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Extrai flowInstanceId de uma mensagem (pode estar em diferentes lugares)
   */
  private extractFlowInstanceIdFromMessage(
    msg: WidgetMessageDto,
  ): string | null {
    // Verificar se está no texto da mensagem (formato "Tool is processing... flow instance ID xxx")
    if (msg.message) {
      const match = msg.message.match(/flow instance ID\s+([a-f0-9-]+)/i);
      if (match && match[1]) {
        return match[1];
      }
    }
    // Verificar se toolInfo tem alguma referência (pode estar em payload ou response)
    if (msg.toolInfo?.payload) {
      const payloadStr = JSON.stringify(msg.toolInfo.payload);
      const match = payloadStr.match(
        /flow[_-]?instance[_-]?id["\s:]+([a-f0-9-]+)/i,
      );
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Faz polling da flow instance para atualizar toolInfo em tempo real
   * Envia atualizações via SSE quando detectar mudanças no output ou error
   */
  private async pollFlowInstanceForToolInfo(
    flowInstanceId: string,
    messageId: string,
    subject: Subject<MessageEvent>,
  ): Promise<void> {
    const maxAttempts = 30; // Máximo de 30 tentativas (5 minutos com intervalo de 10s)
    const pollInterval = 10000; // 10 segundos entre tentativas
    let lastToolInfo: any = null;
    let attempts = 0;

    this.logger.debug(
      'Iniciando polling da flow instance para atualizar toolInfo',
      {
        flowInstanceId,
        messageId,
        maxAttempts,
        pollInterval,
      },
    );

    while (attempts < maxAttempts) {
      try {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        attempts++;

        const flowInstance =
          await this.watsonxService.getFlowInstanceDetails(flowInstanceId);

        if (!flowInstance) {
          this.logger.debug(
            'Flow instance não encontrada, continuando polling',
            {
              flowInstanceId,
              attempt: attempts,
            },
          );
          continue;
        }

        // Extrair toolInfo atualizado da flow instance
        const updatedToolInfo =
          await this.extractToolInfoFromFlowInstance(flowInstanceId);

        if (!updatedToolInfo) {
          this.logger.debug(
            'Não foi possível extrair toolInfo da flow instance',
            {
              flowInstanceId,
              attempt: attempts,
              state: flowInstance.state,
            },
          );
          continue;
        }

        // Verificar se houve mudança no toolInfo (especialmente no response)
        const hasChanged =
          !lastToolInfo ||
          JSON.stringify(lastToolInfo.response) !==
            JSON.stringify(updatedToolInfo.response) ||
          JSON.stringify(lastToolInfo.payload) !==
            JSON.stringify(updatedToolInfo.payload);

        if (hasChanged) {
          this.logger.debug('ToolInfo atualizado detectado, enviando via SSE', {
            flowInstanceId,
            messageId,
            attempt: attempts,
            state: flowInstance.state,
            hasResponse: !!updatedToolInfo.response,
            hasPayload: !!updatedToolInfo.payload,
          });

          // Enviar atualização via SSE
          const updateEvent = {
            data: JSON.stringify({
              event: 'toolInfoUpdate',
              data: {
                messageId,
                toolInfo: updatedToolInfo,
              },
            }),
          } as MessageEvent;
          subject.next(updateEvent);

          lastToolInfo = updatedToolInfo;
        }

        // Se a flow instance estiver completa ou falhou, parar o polling
        if (
          flowInstance.state === 'completed' ||
          flowInstance.state === 'failed' ||
          flowInstance.state === 'error'
        ) {
          this.logger.debug('Flow instance finalizada, parando polling', {
            flowInstanceId,
            messageId,
            state: flowInstance.state,
            finalAttempt: attempts,
          });

          // Enviar atualização final se ainda não foi enviada
          if (hasChanged) {
            const finalUpdateEvent = {
              data: JSON.stringify({
                event: 'toolInfoUpdate',
                data: {
                  messageId,
                  toolInfo: updatedToolInfo,
                  isFinal: true,
                },
              }),
            } as MessageEvent;
            subject.next(finalUpdateEvent);
          }

          break;
        }
      } catch (error: any) {
        this.logger.warn('Erro ao fazer polling da flow instance', {
          flowInstanceId,
          messageId,
          attempt: attempts,
          error: error.message,
        });
        // Continuar tentando mesmo em caso de erro
      }
    }

    if (attempts >= maxAttempts) {
      this.logger.warn(
        'Polling da flow instance atingiu limite de tentativas',
        {
          flowInstanceId,
          messageId,
          attempts,
        },
      );
    }
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
