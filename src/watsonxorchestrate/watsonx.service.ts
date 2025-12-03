import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { Readable } from 'stream';
import { getToolStatusMessage, StatusEvent } from './tool-status.constants';

/**
 * Callback para eventos de status durante o processamento
 */
export type StatusCallback = (event: StatusEvent) => void;

@Injectable()
export class WatsonxService {
  private readonly logger = new Logger(WatsonxService.name);
  private readonly axiosInstance: AxiosInstance;
  private iamToken: string | null = null;
  private tokenExpiration: number = 0;

  private readonly orchestrateBaseUrl: string;
  private readonly instanceId: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    const envUrl = this.configService.get<string>('ORCHESTRATE_URL');
    if (!envUrl) {
      throw new Error('ORCHESTRATE_URL environment variable is not configured');
    }

    const instanceId = this.configService.get<string>(
      'ORCHESTRATE_INSTANCE_ID',
    );
    if (!instanceId) {
      throw new Error(
        'ORCHESTRATE_INSTANCE_ID environment variable is not configured',
      );
    }
    this.instanceId = instanceId;

    const apiKey = this.configService.get<string>('ORCHESTRATE_API_KEY');
    if (!apiKey) {
      throw new Error(
        'ORCHESTRATE_API_KEY environment variable is not configured',
      );
    }
    this.apiKey = apiKey;

    // URL base: https://api.us-south.watson-orchestrate.cloud.ibm.com/instances/{instance_id}/v1/orchestrate
    const baseURL = `${envUrl}/instances/${this.instanceId}/v1/orchestrate`;

    this.logger.log(`Watson Orchestrate baseURL: ${baseURL}`);

    this.axiosInstance = axios.create({
      baseURL,
    });

    // Interceptor de REQUEST para adicionar autenticação
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        const token = await this.getIamToken();
        config.headers.Authorization = `Bearer ${token}`;
        config.headers['IAM-API_KEY'] = this.apiKey;
        return config;
      },
      (error) => {
        this.logger.error('Request error', { message: error.message });
        return Promise.reject(error);
      },
    );

    // Interceptor de RESPONSE apenas para erros
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logger.error('Response error', {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
        });
        return Promise.reject(error);
      },
    );
  }

  /**
   * Processa texto de thinking/reasoning e transforma em mensagem amigável
   * Remove termos técnicos e foca no que o agente está pensando/planejando
   */
  private processThinkingText(rawText: string): string {
    if (!rawText || typeof rawText !== 'string') {
      return 'Analisando contexto e planejando resposta';
    }

    let processed = rawText.trim();

    // Remover termos técnicos comuns
    const technicalTerms = [
      /tool\s*\(/gi,
      /function\s*\(/gi,
      /call\s+/gi,
      /api\s+call/gi,
      /endpoint/gi,
      /request/gi,
      /response/gi,
      /payload/gi,
      /parameter/gi,
      /variable/gi,
      /context\s+variable/gi,
      /step\s+\d+/gi,
      /run\./gi,
      /thread/gi,
      /message\s+id/gi,
    ];

    technicalTerms.forEach((term) => {
      processed = processed.replace(term, '');
    });

    // Transformar frases técnicas em linguagem natural
    const replacements: [RegExp, string][] = [
      [/vou\s+chamar|vou\s+usar|vou\s+executar/gi, 'vou'],
      [
        /preciso\s+obter|preciso\s+buscar|preciso\s+consultar/gi,
        'preciso consultar',
      ],
      [/verificar\s+se|checar\s+se/gi, 'verificando'],
      [/analisar\s+o|analisar\s+a/gi, 'analisando'],
      [/processar\s+o|processar\s+a/gi, 'processando'],
      [/retornar\s+o|retornar\s+a/gi, 'preparando'],
    ];

    replacements.forEach(([pattern, replacement]) => {
      processed = processed.replace(pattern, replacement);
    });

    // Limpar espaços múltiplos e pontuação estranha
    processed = processed
      .replace(/\s+/g, ' ')
      .replace(/\s*\.\s*\.\s*\./g, '')
      .replace(/\s*,\s*,/g, ',')
      .trim();

    // Capitalizar primeira letra
    if (processed.length > 0) {
      processed = processed.charAt(0).toUpperCase() + processed.slice(1);
    }

    // Se o texto ficou muito curto ou vazio após processamento, usar fallback
    if (processed.length < 10) {
      return 'Analisando contexto e planejando resposta';
    }

    // Limitar tamanho para não ficar muito longo
    if (processed.length > 100) {
      processed = processed.substring(0, 97);
    }

    return processed;
  }

  /**
   * Formata a resposta do saldo de horas em markdown
   */
  private formatSaldoHorasResponse(
    saldoAnterior: string | null | undefined,
    saldoAtual: string | null | undefined,
  ): string {
    const parts: string[] = [];

    parts.push('## Relatório de Saldo de Banco de Horas\n');

    // Saldo anterior (mês fechado)
    if (saldoAnterior !== undefined && saldoAnterior !== null) {
      parts.push(
        `**Saldo do banco de horas até outubro (mês fechado):** **${saldoAnterior}**\n`,
      );
    }

    parts.push('\n---\n\n');

    // Prévia do mês atual
    parts.push('### Prévia do Mês Atual\n');
    if (saldoAtual !== undefined && saldoAtual !== null) {
      if (saldoAtual.toLowerCase().includes('não apurado')) {
        parts.push(
          `**Prévia do banco de horas do mês de novembro:** Ponto não apurado\n`,
        );
      } else {
        parts.push(
          `**Prévia do banco de horas do mês de novembro:** ${saldoAtual}\n`,
        );
      }
    } else {
      parts.push(
        '**Prévia do banco de horas do mês de novembro:** Ponto não apurado\n',
      );
    }

    parts.push('\n---\n\n');

    // Aviso
    parts.push('### Atenção\n');
    parts.push(
      '> **Atenção:** O saldo de banco de horas é referente ao ponto do **mês fechado** e poderá ser ajustado conforme correções solicitadas pelo setor administrativo.\n',
    );

    return parts.join('');
  }

  private async getIamToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.iamToken && now < this.tokenExpiration) {
      return this.iamToken;
    }

    this.logger.log('Refreshing IAM Token...');
    try {
      const response = await axios.post(
        'https://iam.cloud.ibm.com/identity/token',
        new URLSearchParams({
          grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
          apikey: this.apiKey,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );

      this.iamToken = response.data.access_token;
      // Reduzindo 60s para margem de segurança
      this.tokenExpiration = now + response.data.expires_in - 60;
      this.logger.log('IAM Token refreshed successfully');
      return this.iamToken || '';
    } catch (error: any) {
      this.logger.error('Error refreshing IAM token', error.message);
      throw new Error('Failed to authenticate with IBM Cloud IAM');
    }
  }

  /**
   * Envia mensagem para o Watson Orchestrate (sem streaming)
   * @param agentId - ID do agente
   * @param threadId - ID do thread (opcional, não enviado na primeira mensagem)
   * @param message - Conteúdo da mensagem
   * @param context - Contexto adicional (opcional)
   */
  async sendMessage(
    agentId: string,
    threadId: string | undefined,
    message: string,
    context?: any,
  ) {
    try {
      this.logger.debug(
        `Sending message to agent ${agentId}${threadId ? `, thread ${threadId}` : ' (new thread)'}`,
      );

      const payload: any = {
        message: {
          role: 'user',
          content: message,
        },
        agent_id: agentId,
        // thread_id no body para continuar a conversa (endpoint /runs)
        ...(threadId && { thread_id: threadId }),
        ...(context && { context }),
      };

      const response = await this.axiosInstance.post('/runs', payload, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      this.logger.error(
        'Error sending message to Watson Orchestrate',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Tipos de arquivo suportados pelo Watson Orchestrate
  private readonly SUPPORTED_FILE_EXTENSIONS = [
    '.csv',
    '.doc',
    '.docx',
    '.jpeg',
    '.jpg',
    '.pdf',
    '.png',
    '.ppt',
    '.pptx',
    '.tiff',
    '.tif',
    '.txt',
    '.wav',
    '.webm',
    '.ogg',
    '.flac',
    '.xls',
    '.xlsx',
  ];

  private readonly SUPPORTED_MIME_TYPES = [
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'application/pdf',
    'image/png',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/tiff',
    'text/plain',
    'audio/wav',
    'audio/wave',
    'audio/webm',
    'audio/ogg',
    'audio/flac',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  // Tamanho máximo do arquivo: 10 MB
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024;

  /**
   * Valida se o arquivo é suportado pelo Watson Orchestrate
   */
  private validateFile(
    fileName: string,
    fileSize: number,
    mimeType?: string,
  ): { valid: boolean; error?: string } {
    // Validar tamanho
    if (fileSize > this.MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `Arquivo muito grande. Tamanho máximo: 10 MB. Tamanho do arquivo: ${(fileSize / 1024 / 1024).toFixed(2)} MB`,
      };
    }

    // Validar extensão
    const extension = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
    const hasValidExtension =
      this.SUPPORTED_FILE_EXTENSIONS.includes(extension);

    // Se não tem extensão válida, verificar se é arquivo de áudio pelo MIME type
    // (permite arquivos de áudio sem extensão, como "blob" do MediaRecorder)
    if (!hasValidExtension) {
      const isAudioByMimeType =
        mimeType &&
        mimeType.startsWith('audio/') &&
        this.SUPPORTED_MIME_TYPES.includes(mimeType);

      if (!isAudioByMimeType) {
        return {
          valid: false,
          error: `Tipo de arquivo não suportado: ${extension || 'sem extensão'}. Tipos suportados: CSV, DOC, DOCX, JPEG, PDF, PNG, PPT, PPTX, TIFF, TXT, WAV, WEBM, OGG, FLAC, XLS, XLSX`,
        };
      }
      // Se é áudio válido pelo MIME type, permitir mesmo sem extensão
      this.logger.warn(
        'Arquivo de áudio sem extensão válida, aceito pelo MIME type',
        {
          fileName,
          mimeType,
        },
      );
    }

    // Validar MIME type se fornecido
    if (mimeType && !this.SUPPORTED_MIME_TYPES.includes(mimeType)) {
      this.logger.warn('MIME type não está na lista de suportados', {
        mimeType,
        fileName,
      });
      // Não bloquear, apenas avisar (alguns browsers enviam MIME types diferentes)
    }

    return { valid: true };
  }

  /**
   * Sanitiza o nome do arquivo removendo caracteres não-ASCII
   * O S3 da IBM não aceita caracteres acentuados nos metadados
   */
  private sanitizeFileName(fileName: string): string {
    // Separar nome e extensão
    const lastDotIndex = fileName.lastIndexOf('.');
    const name = lastDotIndex > 0 ? fileName.slice(0, lastDotIndex) : fileName;
    const extension = lastDotIndex > 0 ? fileName.slice(lastDotIndex) : '';

    // Normalizar e remover acentos (NFD decompõe, regex remove diacríticos)
    const sanitizedName = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove diacríticos (acentos)
      .replace(/[^\x00-\x7F]/g, '_') // Substitui outros não-ASCII por underscore
      .replace(/\s+/g, '_') // Substitui espaços por underscore
      .replace(/_+/g, '_') // Remove underscores duplicados
      .replace(/^_|_$/g, ''); // Remove underscores no início/fim

    return sanitizedName + extension.toLowerCase();
  }

  /**
   * Faz upload de arquivo para o S3 do Watson Orchestrate
   * @param file - Arquivo a ser enviado (Buffer)
   * @param fileName - Nome do arquivo
   * @param mimeType - Tipo MIME do arquivo (ex: image/jpeg)
   * @returns Dados do upload: { fileName, id, url, statusCode, invalid }
   *
   * Tipos suportados: CSV, DOC, DOCX, JPEG, PDF, PNG, PPT, PPTX, TIFF, TXT, WAV, XLS, XLSX
   * Tamanho máximo: 10 MB
   */
  async uploadFileToS3(
    file: Buffer,
    fileName: string,
    mimeType?: string,
  ): Promise<{
    fileName: string;
    id: string | null;
    url: string;
    statusCode: number;
    invalid: boolean;
  }> {
    // Validar arquivo antes do upload
    const validation = this.validateFile(fileName, file.length, mimeType);
    if (!validation.valid) {
      this.logger.error('File validation failed', {
        fileName,
        error: validation.error,
      });
      throw new Error(validation.error);
    }

    try {
      // Gerar ID único para o arquivo (usado no fileMetaData)
      const fileId = require('crypto').randomUUID();

      // Sanitizar nome do arquivo - S3 não aceita caracteres não-ASCII
      const sanitizedFileName = this.sanitizeFileName(fileName);

      this.logger.log('Uploading file to Watson Orchestrate S3', {
        fileName,
        sanitizedFileName,
        fileId,
        fileSize: file.length,
        mimeType,
      });

      const FormData = require('form-data');
      const formData = new FormData();

      // Campo 'files' com o arquivo binário (usando nome sanitizado)
      formData.append('files', file, {
        filename: sanitizedFileName,
        contentType: mimeType || 'application/octet-stream',
      });

      // Campo 'text' vazio
      formData.append('text', '');

      // Campo 'fileMetaData' com os metadados do arquivo (usando nome sanitizado)
      const fileMetaData = [
        {
          fileName: sanitizedFileName,
          invalid: false,
          id: fileId,
          statusCode: 200,
          uploadStatus: 'uploading',
          url: '',
        },
      ];
      formData.append('fileMetaData', JSON.stringify(fileMetaData));

      const response = await this.axiosInstance.post(
        '/upload-to-s3',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        },
      );

      this.logger.log('File uploaded to S3 successfully', {
        fileName,
        response: response.data,
      });

      // S3 retorna array: [{ fileName, id, url, errorBody, errorSubject, statusCode, invalid }]
      const uploadResult = Array.isArray(response.data)
        ? response.data[0]
        : response.data;

      return {
        fileName: uploadResult.fileName || fileName,
        id: uploadResult.id || null,
        url: uploadResult.url || '',
        statusCode: uploadResult.statusCode || 200,
        invalid: uploadResult.invalid || false,
      };
    } catch (error: any) {
      this.logger.error('Error uploading file to Watson Orchestrate S3', {
        message: error.message,
        response: error.response?.data,
      });
      throw error;
    }
  }

  /**
   * Envia mensagem com arquivos anexados (resposta ao file_upload)
   * @param agentId - ID do agente
   * @param threadId - ID do thread
   * @param uploadedFiles - Lista de arquivos já uploadados para S3
   * @param uploadFieldId - ID do campo de upload (retornado no file_upload response como 'name')
   * @param baseContext - Contexto base (opcional)
   */
  async sendMessageWithFiles(
    agentId: string,
    threadId: string,
    uploadedFiles: Array<{
      fileName: string;
      id: string | null;
      url: string;
      statusCode: number;
      invalid: boolean;
    }>,
    uploadFieldId: string,
    baseContext?: any,
    messageContent?: string, // Conteúdo opcional da mensagem (ex: JSON do formulário)
  ): Promise<any> {
    try {
      this.logger.log('Sending message with files', {
        agentId,
        threadId,
        uploadFieldId,
        filesCount: uploadedFiles.length,
      });

      // Construir context.data no formato esperado pelo Watson Orchestrate
      const contextData = {
        data: [
          {
            id: uploadFieldId,
            files: uploadedFiles,
            type: 'file_download',
          },
        ],
        source: 'TOOL',
      };

      const payload: any = {
        message: {
          role: 'user',
          content: messageContent || '', // Usar conteúdo fornecido ou vazio
        },
        additional_properties: {},
        agent_id: agentId,
        thread_id: threadId,
        context: {
          ...(baseContext || {}),
          ...contextData,
        },
      };

      this.logger.debug('File upload payload', {
        payload: JSON.stringify(payload),
      });

      const response = await this.axiosInstance.post('/runs', payload, {
        params: {
          stream: true,
          stream_timeout: 120000,
          multiple_content: true,
        },
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        responseType: 'stream',
      });

      // Processar o stream SSE
      return await this.processSSEStream(response.data);
    } catch (error: any) {
      this.logger.error('Error sending message with files', {
        message: error.message,
        response: error.response?.data,
      });
      throw error;
    }
  }

  /**
   * Envia mensagem com streaming (Server-Sent Events)
   * Processa o stream SSE e retorna a resposta completa
   * @param agentId - ID do agente
   * @param threadId - ID do thread (opcional, não enviado na primeira mensagem)
   * @param message - Conteúdo da mensagem
   * @param context - Contexto adicional (opcional)
   * @param onStatus - Callback para eventos de status (opcional)
   */
  async sendMessageStream(
    agentId: string,
    threadId: string | undefined,
    message: string,
    context?: any,
    onStatus?: StatusCallback,
  ): Promise<any> {
    try {
      this.logger.debug(
        `Sending streaming message to agent ${agentId}${threadId ? `, thread ${threadId}` : ' (new thread)'}`,
      );

      // Primeira mensagem: message, agent_id e context (para chapa/emplid)
      // Mensagens seguintes: adiciona thread_id
      const payload: any = {
        message: {
          role: 'user',
          content: message,
        },
        agent_id: agentId,
        // context é enviado sempre (contém chapa/emplid para identificação)
        ...(context && { context }),
      };

      // thread_id só é enviado a partir da segunda mensagem
      if (threadId) {
        payload.thread_id = threadId;
      }

      // Log detalhado do payload sendo enviado ao Watson Orchestrate
      this.logger.log(
        '[sendMessageStream] Payload enviado ao Watson Orchestrate',
        {
          agentId,
          threadId: threadId || 'new (first message)',
          payload: JSON.stringify(payload, null, 2),
          contextKeys: context ? Object.keys(context) : [],
          hasUserInfo: !!context?.user_info,
          hasUserSummary: !!context?.user_summary,
          userSummaryChapa: context?.user_summary?.chapa,
          userInfoChapa:
            context?.user_info?.CHAPA || context?.user_info?.DADOS?.CHAPA,
        },
      );

      const response = await this.axiosInstance.post('/runs', payload, {
        params: {
          stream: true,
          stream_timeout: 120000,
          multiple_content: true,
        },
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        responseType: 'stream',
      });

      // Emitir status inicial
      if (onStatus) {
        onStatus({
          event: 'status.started',
          data: {
            message: 'Planejando próximos passos',
            timestamp: Date.now(),
          },
        });
      }

      // Processar o stream SSE
      return await this.processSSEStream(response.data, onStatus);
    } catch (error: any) {
      // Emitir status de erro
      if (onStatus) {
        onStatus({
          event: 'status.error',
          data: {
            message: 'Erro ao processar',
            timestamp: Date.now(),
          },
        });
      }
      // Quando responseType é 'stream', error.response.data é um stream, precisamos lê-lo
      let errorBody = error.message;
      if (
        error.response?.data &&
        typeof error.response.data.on === 'function'
      ) {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of error.response.data) {
            chunks.push(chunk);
          }
          errorBody = Buffer.concat(chunks).toString('utf-8');
        } catch {
          errorBody = 'Could not read error body from stream';
        }
      } else if (error.response?.data) {
        errorBody = JSON.stringify(error.response.data);
      }

      this.logger.error(
        'Error sending streaming message to Watson Orchestrate',
        {
          status: error.response?.status,
          errorBody,
        },
      );
      throw error;
    }
  }

  /**
   * Processa um stream SSE (Server-Sent Events) e retorna a resposta completa
   * @param stream - Stream do axios
   * @param onStatus - Callback para eventos de status (opcional)
   */
  private async processSSEStream(
    stream: Readable,
    onStatus?: StatusCallback,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let threadId: string | null = null;
      let hasReceivedData = false;
      let allEvents: any[] = [];
      let messageCreated: any = null;

      stream.on('data', (chunk: Buffer) => {
        hasReceivedData = true;
        const chunkStr = chunk.toString();
        buffer += chunkStr;
        const lines = buffer.split('\n');
        // Manter a última linha incompleta no buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          // Formato do Watson Orchestrate: JSON direto por linha (sem prefixo 'data:')
          try {
            const eventData = JSON.parse(trimmedLine);
            const eventType = eventData.event;

            // Log detalhado de cada evento
            this.logger.log(`[SSE] Event: ${eventType}`, {
              event: eventType,
              hasData: !!eventData.data,
              threadId: eventData.data?.thread_id,
            });

            // Armazenar todos os eventos para debug
            allEvents.push({
              event: eventType,
              timestamp: Date.now(),
              data: eventData.data,
            });

            // Capturar thread_id de qualquer evento
            if (eventData.data?.thread_id) {
              threadId = eventData.data.thread_id;
              this.logger.debug('Thread ID captured', { threadId });
            }

            // Capturar mensagem completa do evento message.created
            if (eventType === 'message.created' && eventData.data?.message) {
              messageCreated = eventData.data.message;
              this.logger.log('Message created captured', {
                messageId: messageCreated.id,
                hasContent: !!messageCreated.content,
                contentLength: messageCreated.content?.length || 0,
                hasThinking: !!messageCreated.thinking,
              });
            }

            // Capturar thinking/reasoning steps
            if (
              eventType === 'message.thinking' ||
              (eventData.data?.message?.thinking &&
                eventData.data.message.thinking.length > 0)
            ) {
              const thinkingContent =
                eventData.data?.message?.thinking ||
                eventData.data?.thinking ||
                [];

              if (thinkingContent.length > 0 && onStatus) {
                // Pegar o último thinking step
                const lastThinking = Array.isArray(thinkingContent)
                  ? thinkingContent[thinkingContent.length - 1]
                  : thinkingContent;

                const rawThinkingText =
                  typeof lastThinking === 'string'
                    ? lastThinking
                    : lastThinking?.content || lastThinking?.text || '';

                const thinkingText = rawThinkingText
                  ? this.processThinkingText(rawThinkingText)
                  : 'Analisando contexto e planejando resposta';

                this.logger.log('[SSE] Thinking detected', {
                  rawText: rawThinkingText.substring(0, 100),
                  processedText: thinkingText,
                });

                onStatus({
                  event: 'status.thinking',
                  data: {
                    message: thinkingText,
                    timestamp: Date.now(),
                  },
                });
              }
            }

            // Detectar tool_calls e emitir status
            if (onStatus) {
              // Detectar tool_calls em run.step.created ou eventos similares
              const stepDetails =
                eventData.data?.step_details ||
                eventData.data?.message?.step_details;
              if (stepDetails && Array.isArray(stepDetails)) {
                for (const detail of stepDetails) {
                  if (detail.type === 'tool_calls' && detail.tool_calls) {
                    for (const toolCall of detail.tool_calls) {
                      const toolName = toolCall.name || toolCall.function?.name;
                      if (toolName) {
                        const statusMessage = getToolStatusMessage(toolName);
                        this.logger.log(
                          `[SSE] Tool call detected: ${toolName} -> "${statusMessage}"`,
                        );
                        onStatus({
                          event: 'status.tool_call',
                          data: {
                            message: statusMessage,
                            toolName,
                            timestamp: Date.now(),
                          },
                        });
                      }
                    }
                  }
                }
              }

              // Detectar thinking/processing em eventos de step
              // Evento específico: run.step.thinking
              if (eventType === 'run.step.thinking') {
                const thinkingContent =
                  eventData.data?.thinking ||
                  eventData.data?.step?.thinking ||
                  eventData.data?.content ||
                  eventData.data?.text;

                if (thinkingContent && onStatus) {
                  const rawThinkingText =
                    typeof thinkingContent === 'string'
                      ? thinkingContent
                      : thinkingContent?.content || thinkingContent?.text || '';

                  const thinkingText = rawThinkingText
                    ? this.processThinkingText(rawThinkingText)
                    : 'Analisando contexto e planejando resposta';

                  this.logger.log('[SSE] Thinking event detected', {
                    rawText: rawThinkingText.substring(0, 100),
                    processedText: thinkingText,
                  });

                  onStatus({
                    event: 'status.thinking',
                    data: {
                      message: thinkingText,
                      timestamp: Date.now(),
                    },
                  });
                }
              } else if (
                eventType === 'run.step.created' ||
                eventType === 'run.step.in_progress'
              ) {
                const stepType = eventData.data?.type;

                // Verificar reasoning no step
                const reasoning =
                  eventData.data?.reasoning ||
                  eventData.data?.step?.reasoning ||
                  eventData.data?.step_details?.reasoning;

                if (reasoning) {
                  const rawReasoningText =
                    typeof reasoning === 'string'
                      ? reasoning
                      : reasoning?.content || reasoning?.text || '';

                  const reasoningText = rawReasoningText
                    ? this.processThinkingText(rawReasoningText)
                    : 'Raciocinando sobre a melhor abordagem';

                  this.logger.log('[SSE] Reasoning detected in step', {
                    rawText: rawReasoningText.substring(0, 100),
                    processedText: reasoningText,
                  });

                  onStatus({
                    event: 'status.thinking',
                    data: {
                      message: reasoningText,
                      timestamp: Date.now(),
                    },
                  });
                } else if (stepType === 'tool_calls') {
                  // Tool call em progresso sem detalhes específicos
                  onStatus({
                    event: 'status.processing',
                    data: {
                      message: 'Consultando informações',
                      timestamp: Date.now(),
                    },
                  });
                }
              }
            }

            // Log do conteúdo quando disponível
            if (eventData.data?.message?.content) {
              this.logger.debug('Message content', {
                content: JSON.stringify(eventData.data.message.content),
              });
            }
          } catch (parseError: any) {
            // Linha não é JSON válido
            if (
              trimmedLine.length > 0 &&
              !trimmedLine.startsWith('data:') &&
              !trimmedLine.startsWith('event:')
            ) {
              this.logger.warn('Failed to parse line as JSON', {
                linePreview: trimmedLine.substring(0, 100),
                error: parseError.message,
              });
            }
          }
        }
      });

      stream.on('end', async () => {
        this.logger.log('SSE stream ended', {
          hasThreadId: !!threadId,
          receivedData: hasReceivedData,
          totalEvents: allEvents.length,
          hasMessageCreated: !!messageCreated,
        });

        // Emitir status de conclusão
        if (onStatus) {
          onStatus({
            event: 'status.completed',
            data: {
              message: 'Finalizando resposta',
              timestamp: Date.now(),
            },
          });
        }

        // Construir resposta simples com o que recebemos
        let response: any = {
          output: {
            generic: [],
          },
        };

        // Preparar informações de debug base (declarar antes de usar)
        const debugInfo: any = {};

        // Verificar se a mensagem indica processamento assíncrono de tool
        const isAsyncTool =
          messageCreated?.additional_properties?.display_properties
            ?.is_async === true;
        const hasToolProcessingMessage = messageCreated?.content?.some(
          (item: any) =>
            item.text?.includes('Tool is processing') ||
            item.text?.includes('Please wait until the tool completes'),
        );

        if (isAsyncTool || hasToolProcessingMessage) {
          // Extrair flowinstance_id da mensagem se disponível
          let flowInstanceId: string | null = null;

          // Tentar extrair do response_metadata se disponível
          if (messageCreated?.response_metadata?.flowinstance_id) {
            flowInstanceId = messageCreated.response_metadata.flowinstance_id;
          } else if (messageCreated?.content) {
            // Tentar extrair do texto da mensagem
            for (const item of messageCreated.content) {
              if (item.text) {
                const match = item.text.match(
                  /flow instance ID\s+([a-f0-9-]+)/i,
                );
                if (match && match[1]) {
                  flowInstanceId = match[1];
                  break;
                }
              }
            }
          }

          this.logger.log('Detected async tool processing, starting polling', {
            threadId,
            isAsyncTool,
            hasToolProcessingMessage,
            flowInstanceId,
            correlationId: messageCreated?.response_metadata?.correlation_id,
            targetRunId: messageCreated?.response_metadata?.target_run_id,
          });

          // Se temos flowInstanceId, armazenar para debug (não bloquear se API não disponível)
          if (flowInstanceId) {
            debugInfo.flowInstanceId = flowInstanceId;
            this.logger.log('Flow instance ID captured', {
              flowInstanceId,
              note: 'Details will be available in step_history from thread messages',
            });

            // Tentar buscar informações sobre o flow (opcional, não bloquear se falhar)
            try {
              const flowInstance =
                await this.getFlowInstanceDetails(flowInstanceId);

              if (flowInstance) {
                debugInfo.flowInstanceDetails = flowInstance;
                this.logger.log('Flow instance details retrieved from API', {
                  flowInstanceId,
                  state: flowInstance.state,
                  flowId: flowInstance.flow_id,
                  hasSteps: !!flowInstance.steps,
                  stepsCount: Array.isArray(flowInstance.steps)
                    ? flowInstance.steps.length
                    : 0,
                });

                // Processar steps do flow instance para capturar thinking/reasoning
                if (
                  flowInstance.steps &&
                  Array.isArray(flowInstance.steps) &&
                  onStatus
                ) {
                  for (const step of flowInstance.steps) {
                    // Verificar thinking/reasoning no step
                    const thinking = step.thinking || step.reasoning;
                    if (thinking) {
                      const rawThinkingText =
                        typeof thinking === 'string'
                          ? thinking
                          : thinking?.content || thinking?.text || '';

                      const thinkingText = rawThinkingText
                        ? this.processThinkingText(rawThinkingText)
                        : 'Analisando contexto e planejando resposta';

                      this.logger.log(
                        '[Flow Instance] Thinking/Reasoning found in step',
                        {
                          stepId: step.id,
                          stepType: step.type,
                          rawText: rawThinkingText.substring(0, 100),
                          processedText: thinkingText,
                        },
                      );

                      onStatus({
                        event: 'status.thinking',
                        data: {
                          message: thinkingText,
                          timestamp: Date.now(),
                        },
                      });
                    }
                  }
                }
              }
            } catch (flowError: any) {
              // API pode não estar disponível ou endpoint diferente - não é crítico
              // As informações dos steps estão disponíveis no step_history das mensagens
              this.logger.debug(
                'Could not fetch flow instance details from API (non-critical)',
                {
                  flowInstanceId,
                  error: flowError.message,
                  note: 'Step details available in message step_history',
                },
              );
            }
          }

          // Fazer polling para buscar mensagens adicionais
          if (threadId) {
            try {
              const allMessages = await this.pollThreadMessages(
                threadId,
                20,
                2000,
                60000,
                onStatus,
              );
              // Filtrar apenas mensagens do assistente
              const assistantMessages = allMessages.filter(
                (msg: any) => msg.role === 'assistant',
              );

              // Filtrar mensagens que não são de "Tool is processing"
              const validMessages = assistantMessages.filter((msg: any) => {
                const hasProcessingText = msg.content?.some(
                  (item: any) =>
                    item.text?.includes('Tool is processing') ||
                    item.text?.includes('Please wait until the tool completes'),
                );
                return !hasProcessingText;
              });

              // IMPORTANTE: Pegar apenas a ÚLTIMA mensagem do assistente
              // Evita duplicação ao continuar conversas existentes
              const finalMessages =
                validMessages.length > 0
                  ? [validMessages[validMessages.length - 1]]
                  : [];

              // Acumular todo o conteúdo das mensagens finais
              // Preservar text quando existir junto com options ou outros tipos
              const allContent: any[] = [];
              const userActivities: any[] = [];

              finalMessages.forEach((msg: any) => {
                // Capturar flowinstance_id das mensagens se disponível
                const msgFlowInstanceId =
                  msg.response_metadata?.flowinstance_id ||
                  msg.additional_properties?.display_properties
                    ?.flowinstance_id;

                if (msgFlowInstanceId && msgFlowInstanceId !== flowInstanceId) {
                  this.logger.log('Found flow instance ID in message', {
                    messageId: msg.id,
                    flowInstanceId: msgFlowInstanceId,
                    correlationId: msg.response_metadata?.correlation_id,
                  });

                  // Se não tínhamos flowInstanceId antes, buscar agora
                  if (!flowInstanceId) {
                    flowInstanceId = msgFlowInstanceId;
                  }
                }

                // Capturar step_history se disponível
                if (msg.step_history && Array.isArray(msg.step_history)) {
                  debugInfo.stepHistory = msg.step_history;
                }

                // Detectar user activity
                const userActivity = this.detectUserActivity(msg);
                if (userActivity) {
                  userActivities.push({
                    messageId: msg.id,
                    ...userActivity,
                  });
                }

                if (msg.content && Array.isArray(msg.content)) {
                  msg.content.forEach((item: any) => {
                    // Se o item tem text e options, garantir que ambos sejam preservados
                    if (item.text && item.options) {
                      allContent.push({
                        ...item,
                        text: item.text, // Garantir que text seja preservado
                        options: item.options,
                      });
                    } else {
                      // Caso contrário, adicionar como está
                      allContent.push(item);
                    }
                  });
                }
              });

              // Adicionar user activities ao debug se houver
              if (userActivities.length > 0) {
                debugInfo.userActivities = userActivities;
              }

              if (allContent.length > 0) {
                response.output.generic = allContent;
              } else {
                // Fallback: usar todas as mensagens do assistente se não encontrou finais
                assistantMessages.forEach((msg: any) => {
                  if (msg.content && Array.isArray(msg.content)) {
                    allContent.push(...msg.content);
                  }
                });
                response.output.generic = allContent;
              }
            } catch (pollError: any) {
              this.logger.error('Error during polling', pollError.message);
              // Fallback para conteúdo inicial
              if (messageCreated?.content) {
                response.output.generic = messageCreated.content;
              }
            }
          } else {
            // Sem thread_id, usar conteúdo inicial
            if (messageCreated?.content) {
              response.output.generic = messageCreated.content;
            }
          }
        } else {
          // Mensagem normal - mesmo assim fazer polling para pegar todas as mensagens do thread
          // (pode haver options ou user activities em mensagens subsequentes)
          if (threadId) {
            try {
              const allMessages = await this.pollThreadMessages(
                threadId,
                20,
                2000,
                60000,
                onStatus,
              );
              const assistantMessages = allMessages.filter(
                (msg: any) => msg.role === 'assistant',
              );

              // Pegar apenas a ÚLTIMA mensagem do assistente (a resposta atual)
              // Não acumular todas as mensagens anteriores
              const lastAssistantMessage =
                assistantMessages[assistantMessages.length - 1];

              const allContent: any[] = [];
              const userActivities: any[] = [];

              if (lastAssistantMessage) {
                // Detectar user activity
                const userActivity =
                  this.detectUserActivity(lastAssistantMessage);
                if (userActivity) {
                  userActivities.push({
                    messageId: lastAssistantMessage.id,
                    ...userActivity,
                  });
                }

                if (
                  lastAssistantMessage.content &&
                  Array.isArray(lastAssistantMessage.content)
                ) {
                  lastAssistantMessage.content.forEach((item: any) => {
                    // Preservar text e options quando ambos existirem
                    if (item.text && item.options) {
                      allContent.push({
                        ...item,
                        text: item.text,
                        options: item.options,
                      });
                    } else {
                      allContent.push(item);
                    }
                  });
                }
              }

              // Adicionar user activities ao debug se houver
              if (userActivities.length > 0) {
                debugInfo.userActivities = userActivities;
              }

              if (allContent.length > 0) {
                response.output.generic = allContent;
              } else if (messageCreated?.content) {
                // Fallback para conteúdo inicial
                response.output.generic = messageCreated.content;
              }
            } catch (pollError: any) {
              this.logger.warn(
                'Error during polling for normal message',
                pollError.message,
              );
              // Fallback para conteúdo inicial
              if (messageCreated?.content) {
                response.output.generic = messageCreated.content;
                this.logger.log(
                  'Using message.created content (error fallback)',
                  {
                    contentItems: messageCreated.content.length,
                  },
                );
              }
            }
          } else {
            // Sem thread_id, usar conteúdo inicial
            if (messageCreated?.content) {
              response.output.generic = messageCreated.content;
            }
          }
        }

        // Detectar mensagens de erro e buscar mais informações
        const hasError = response.output.generic.some((item: any) => {
          const text = item.text || '';
          return (
            text.includes('error') ||
            text.includes('Error') ||
            text.includes('encountered an error') ||
            text.includes('I have encountered an error') ||
            text.includes('Branch condition') ||
            text.includes('flow execution') ||
            text.includes('unknown or null destination')
          );
        });

        if (hasError && threadId) {
          this.logger.warn(
            'Error message detected, fetching additional details',
            {
              threadId,
            },
          );

          try {
            // Buscar todas as mensagens do thread para ver detalhes do erro
            const threadMessages = await this.getThreadMessages(threadId);
            this.logger.log('[ERROR DEBUG] Thread messages retrieved', {
              totalMessages: threadMessages.length,
            });

            debugInfo.threadMessagesCount = threadMessages.length;

            // Procurar por mensagens de erro ou tool calls que falharam
            const errorMessages = threadMessages.filter((msg: any) => {
              const content = JSON.stringify(msg.content || '');
              return (
                content.includes('error') ||
                content.includes('Error') ||
                content.includes('failed') ||
                content.includes('Failed') ||
                content.includes('Branch condition') ||
                content.includes('flow execution') ||
                msg.role === 'tool' ||
                msg.role === 'system'
              );
            });

            // Extrair flow instance ID de qualquer mensagem que mencione "flow instance ID"
            let flowInstanceId: string | null = null;
            for (const msg of threadMessages) {
              const content = JSON.stringify(msg.content || '');
              const flowInstanceIdMatch = content.match(
                /flow instance ID\s+([a-f0-9-]+)/i,
              );
              if (flowInstanceIdMatch && flowInstanceIdMatch[1]) {
                flowInstanceId = flowInstanceIdMatch[1];
                break;
              }
            }

            if (errorMessages.length > 0) {
              debugInfo.errorMessagesCount = errorMessages.length;
              this.logger.error('[ERROR DEBUG] Error-related messages found', {
                errorMessagesCount: errorMessages.length,
                errorMessages: errorMessages.map((msg: any) => ({
                  id: msg.id,
                  role: msg.role,
                  content: msg.content,
                  created_at: msg.created_at,
                })),
              });
            }

            // Se encontramos um flow instance ID, tentar buscar informações sobre ele
            if (flowInstanceId) {
              this.logger.error(
                '[ERROR DEBUG] Flow instance ID extracted from error',
                {
                  flowInstanceId,
                },
              );
              debugInfo.failedFlowInstanceId = flowInstanceId;

              // Tentar buscar informações sobre este flow instance específico
              try {
                const flowInstance = await this.getFlowInstances({
                  instance_id: flowInstanceId,
                });

                if (flowInstance) {
                  // Se retornou array, pegar o primeiro item
                  const instance = Array.isArray(flowInstance)
                    ? flowInstance[0]
                    : flowInstance;

                  debugInfo.flowInstanceDetails = instance;

                  // Extrair informações importantes do erro
                  const errorInfo: any = {
                    instanceId: instance.instance_id,
                    name: instance.name,
                    state: instance.state,
                    executionSummary: instance.execution_summary,
                    error: instance.error,
                  };

                  // Extrair sequência de steps
                  if (instance.sequence?.steps) {
                    errorInfo.steps = instance.sequence.steps;
                  }

                  // Extrair tasks com erro
                  if (instance.tasks && Array.isArray(instance.tasks)) {
                    this.logger.log(
                      '[ERROR DEBUG] Analyzing tasks from flow instance',
                      {
                        totalTasks: instance.tasks.length,
                        taskNames: instance.tasks.map((t: any) => t.name),
                      },
                    );

                    const failedTasks = instance.tasks.filter(
                      (task: any) => task.state === 'failed' || task.error,
                    );
                    const tasksWithError = instance.tasks.filter(
                      (task: any) =>
                        task.output?.message?.includes(
                          'results to undefined',
                        ) || task.output?.message?.includes('object Object'),
                    );

                    // ANÁLISE ESPECÍFICA DO identify_student
                    const identifyStudentTask = instance.tasks.find(
                      (task: any) => task.name === 'identify_student',
                    );

                    if (identifyStudentTask) {
                      // Extrair o output.data completo
                      const outputData = identifyStudentTask.output?.data;

                      // Log detalhado do output completo ANTES de processar
                      this.logger.log(
                        '[ERROR DEBUG] identify_student RAW OUTPUT',
                        {
                          rawOutput: identifyStudentTask.output,
                          rawOutputData: outputData,
                          outputKeys: outputData
                            ? Object.keys(outputData)
                            : null,
                          outputStringified: JSON.stringify(
                            identifyStudentTask.output,
                            null,
                            2,
                          ),
                        },
                      );

                      // Extrair status - confirmado que está em output.data.status
                      const status = outputData?.status;

                      // Log confirmando o sucesso e verificando mudanças
                      this.logger.log(
                        '[ERROR DEBUG] identify_student CONFIRMED SUCCESS',
                        {
                          status: status,
                          isSuccess: status === 200,
                          statusType: typeof status,
                          outputDataKeys: outputData
                            ? Object.keys(outputData)
                            : null,
                          hasStatus: 'status' in (outputData || {}),
                          statusValue: outputData?.status,
                          // Verificar estrutura completa para comparar com versão anterior
                          outputDataStructure: {
                            hasError: 'error' in (outputData || {}),
                            hasStatus: 'status' in (outputData || {}),
                            hasUrl: 'url' in (outputData || {}),
                            hasUserInfo: 'user_info' in (outputData || {}),
                            userInfoType: typeof outputData?.user_info,
                            userInfoIsObject:
                              typeof outputData?.user_info === 'object' &&
                              outputData?.user_info !== null,
                            userInfoKeys: outputData?.user_info
                              ? Object.keys(outputData.user_info)
                              : null,
                          },
                          // Verificar se o formato mudou
                          possibleFormatChange: {
                            statusWasDirectlyInOutput:
                              !outputData || 'status' in outputData,
                            statusWasInData:
                              outputData?.data?.status !== undefined,
                            note: 'If this worked before, check if the output structure changed',
                          },
                        },
                      );

                      errorInfo.identifyStudentAnalysis = {
                        name: identifyStudentTask.name,
                        state: identifyStudentTask.state,
                        input: identifyStudentTask.input,
                        // Status confirmado
                        status: status,
                        isSuccess: status === 200,
                        // Output completo
                        outputData: outputData,
                        outputDataKeys: outputData
                          ? Object.keys(outputData)
                          : null,
                        // Output completo serializado
                        fullOutputData: JSON.stringify(outputData, null, 2),
                      };

                      this.logger.error(
                        '[ERROR DEBUG] identify_student task analysis',
                        errorInfo.identifyStudentAnalysis,
                      );

                      // Log específico sobre o problema da branch
                      if (status === 200) {
                        // Verificar se é string ou número
                        const isString = typeof status === 'string';
                        const isNumber = typeof status === 'number';
                        const statusAsNumber = Number(status);
                        const statusAsString = String(status);

                        this.logger.error(
                          '[ERROR DEBUG] BRANCH CONDITION TYPE ANALYSIS',
                          {
                            identifyStudentStatus: status,
                            identifyStudentStatusType: typeof status,
                            isString: isString,
                            isNumber: isNumber,
                            statusAsNumber: statusAsNumber,
                            statusAsString: statusAsString,
                            strictEquality200: status === 200,
                            looseEquality200: status == 200,
                            numberEquality200: Number(status) === 200,
                            problem:
                              "Branch condition 'status == 200' may be failing due to type mismatch or variable availability",
                            possibleCauses: [
                              "Variable 'status' is a string '200' instead of number 200 - use 'status == 200' (loose) or 'Number(status) == 200'",
                              "Variable 'status' is not available when branch is evaluated - check variable scope",
                              'The condition \'user_info.CODIGO == "200"\' may be causing issues if user_info is not available',
                              'Branch is evaluating before identify_student completes',
                            ],
                            recommendations: [
                              "If status is string: Change condition to 'status == \"200\"' or 'Number(status) == 200'",
                              "If status is number: Condition 'status == 200' should work - check variable availability",
                              'Check if both conditions (user_info.CODIGO and status) are available when branch evaluates',
                              'Verify the order of execution - identify_student must complete before branch evaluates',
                            ],
                            branchErrorMessage:
                              "The conditions '[object Object],[object Object]' results to undefined",
                            note: "The error suggests objects are being compared. Check if 'user_info' is being compared as object instead of user_info.CODIGO",
                          },
                        );
                      } else {
                        this.logger.error(
                          '[ERROR DEBUG] identify_student STATUS NOT 200',
                          {
                            expectedStatus: 200,
                            actualStatus: status,
                            statusType: typeof status,
                            problem:
                              'identify_student returned status: ' + status,
                          },
                        );
                      }
                    } else {
                      this.logger.warn(
                        '[ERROR DEBUG] identify_student task NOT FOUND',
                        {
                          availableTasks: instance.tasks.map(
                            (t: any) => t.name,
                          ),
                        },
                      );
                    }

                    // ANÁLISE DA BRANCH "Ramificação 2" ou "Verificação Identifica Aluno Sucesso"
                    const branchTask = instance.tasks.find(
                      (task: any) =>
                        task.name === 'Ramificação 2' ||
                        task.name?.includes('Verificação') ||
                        task.name?.includes('Branch'),
                    );

                    if (branchTask) {
                      // Tentar entender o que a branch está recebendo
                      // A branch provavelmente está recebendo o output do identify_student
                      // Precisamos verificar se está recebendo output.data (objeto) ou output.data.status (número)

                      errorInfo.branchAnalysis = {
                        name: branchTask.name,
                        state: branchTask.state,
                        input: branchTask.input,
                        output: branchTask.output,
                        message: branchTask.output?.message,
                        // Verificar se a mensagem indica problema com objetos
                        hasObjectComparisonError:
                          branchTask.output?.message?.includes(
                            'object Object',
                          ) ||
                          branchTask.output?.message?.includes(
                            'results to undefined',
                          ),
                        // Tentar identificar qual valor está sendo comparado
                        branchOutputData: branchTask.output?.data,
                        branchToEdge: branchTask.output?.data?.to_edge,
                      };

                      this.logger.error(
                        '[ERROR DEBUG] Branch task analysis',
                        errorInfo.branchAnalysis,
                      );

                      // Análise detalhada do problema
                      if (identifyStudentTask && branchTask) {
                        const identifyOutput = identifyStudentTask.output?.data;
                        const branchInput = branchTask.input;

                        // Verificar user_info.CODIGO também (segunda condição da branch)
                        const userInfo = identifyOutput?.user_info;
                        const userInfoCodigo = userInfo?.CODIGO;
                        const userInfoType = typeof userInfo;
                        const codigoType = typeof userInfoCodigo;

                        // Verificar se há outras branches com o mesmo problema
                        const allBranches = instance.tasks.filter(
                          (task: any) =>
                            task.name?.includes('Verificação') ||
                            task.name?.includes('Ramificação') ||
                            task.name?.includes('Branch') ||
                            task.output?.message?.includes('object Object'),
                        );

                        this.logger.error(
                          '[ERROR DEBUG] BRANCH CONDITION ANALYSIS - BOTH CONDITIONS',
                          {
                            branchName: branchTask.name,
                            branchConditions: [
                              'user_info.CODIGO == "200"',
                              'status == 200',
                            ],
                            // Análise da primeira condição: user_info.CODIGO
                            userInfo: userInfo,
                            userInfoType: userInfoType,
                            userInfoIsObject:
                              typeof userInfo === 'object' && userInfo !== null,
                            userInfoCodigo: userInfoCodigo,
                            codigoType: codigoType,
                            codigoValue: userInfoCodigo,
                            codigoIsString: codigoType === 'string',
                            codigoEquals200String: userInfoCodigo === '200',
                            codigoEquals200Number: userInfoCodigo === 200,
                            // Análise da segunda condição: status
                            identifyStudentStatus: identifyOutput?.status,
                            identifyStudentStatusType:
                              typeof identifyOutput?.status,
                            statusIsNumber:
                              typeof identifyOutput?.status === 'number',
                            statusIsString:
                              typeof identifyOutput?.status === 'string',
                            statusEquals200: identifyOutput?.status === 200,
                            statusEquals200String:
                              identifyOutput?.status === '200',
                            // Problema identificado
                            problem:
                              "Branch has TWO conditions. The error '[object Object],[object Object]' suggests BOTH are returning objects",
                            rootCauseAnalysis: [
                              'Condition 1: \'user_info.CODIGO == "200"\' - If user_info is an object instead of user_info.CODIGO, this fails',
                              "Condition 2: 'status == 200' - If status is an object instead of a number, this fails",
                              'Both conditions may be accessing objects instead of their properties/values',
                            ],
                            whyItWorkedBefore: [
                              'Previously, Orchestrate may have automatically extracted values from variables',
                              'Variable references may have been resolved differently (implicit property access)',
                              'The output structure from identify_student may have been different',
                              'Orchestrate platform may have been updated, changing variable resolution behavior',
                              'Variable scoping or timing may have changed',
                            ],
                            possibleCauses: [
                              "Variable 'user_info' in branch is pointing to the entire object instead of user_info.CODIGO",
                              "Variable 'status' in branch is pointing to output.data instead of output.data.status",
                              'The branch is evaluating before variables are properly populated',
                              'Variable references in Orchestrate may need explicit property access (behavior change)',
                              'Orchestrate update may have changed how nested properties are accessed',
                            ],
                            investigationNeeded: [
                              'Check if Orchestrate was updated recently',
                              'Compare current flow configuration with previous working version',
                              'Verify if variable references need to be more explicit now',
                              'Check if there is a difference in how output.data is structured vs before',
                              'Review Orchestrate release notes for recent changes to variable resolution',
                            ],
                            solution: [
                              "Verify 'user_info' variable points to 'flow.identify_student.output.data.user_info.CODIGO' not just 'user_info'",
                              "Verify 'status' variable points to 'flow.identify_student.output.data.status' not 'output.data'",
                              'In branch condition, use explicit paths: \'flow.identify_student.output.data.user_info.CODIGO == "200"\'',
                              "In branch condition, use explicit paths: 'flow.identify_student.output.data.status == 200'",
                            ],
                            branchInput: branchInput,
                            branchOutput: branchTask.output,
                            allBranchesWithError: allBranches.map((b: any) => ({
                              name: b.name,
                              message: b.output?.message,
                            })),
                          },
                        );
                      }
                    }

                    if (failedTasks.length > 0) {
                      errorInfo.failedTasks = failedTasks.map((task: any) => ({
                        name: task.name,
                        state: task.state,
                        error: task.error,
                        output: task.output,
                      }));
                    }

                    if (tasksWithError.length > 0) {
                      errorInfo.tasksWithConditionError = tasksWithError.map(
                        (task: any) => ({
                          name: task.name,
                          state: task.state,
                          output: task.output,
                          message: task.output?.message,
                        }),
                      );
                    }

                    // Log de todas as tasks em ordem de execução
                    errorInfo.allTasksExecution = instance.tasks.map(
                      (task: any) => ({
                        name: task.name,
                        state: task.state,
                        created_at: task.created_at,
                        updated_at: task.updated_at,
                        hasOutput: !!task.output,
                        outputMessage: task.output?.message,
                        outputData: task.output?.data
                          ? JSON.stringify(task.output.data).substring(0, 200)
                          : null,
                      }),
                    );
                  }

                  this.logger.error(
                    '[ERROR DEBUG] Flow instance details found',
                    errorInfo,
                  );
                }
              } catch (flowError: any) {
                this.logger.warn(
                  '[ERROR DEBUG] Could not fetch specific flow instance',
                  {
                    flowInstanceId,
                    error: flowError.message,
                    status: flowError.response?.status,
                    url: flowError.config?.url,
                  },
                );
              }
            }

            // Tentar buscar flow instances com falha (pode falhar se o endpoint não existir)
            try {
              const flowInstances = await this.getFlowInstances({
                state: 'failed',
                page_size: 10,
              });

              if (
                flowInstances &&
                Array.isArray(flowInstances) &&
                flowInstances.length > 0
              ) {
                debugInfo.failedFlowsCount = flowInstances.length;

                // Encontrar o flow instance atual se estiver na lista
                const currentFailedFlow = flowInstanceId
                  ? flowInstances.find(
                      (flow: any) => flow.instance_id === flowInstanceId,
                    )
                  : null;

                if (currentFailedFlow) {
                  // Extrair informações detalhadas do flow que falhou
                  const detailedError: any = {
                    instanceId: currentFailedFlow.instance_id,
                    name: currentFailedFlow.name,
                    state: currentFailedFlow.state,
                    executionSummary: currentFailedFlow.execution_summary,
                  };

                  // Extrair sequência de steps
                  if (currentFailedFlow.sequence?.steps) {
                    detailedError.steps = currentFailedFlow.sequence.steps;
                  }

                  // Extrair tasks com problema de condição
                  if (
                    currentFailedFlow.tasks &&
                    Array.isArray(currentFailedFlow.tasks)
                  ) {
                    // ANÁLISE ESPECÍFICA DO identify_student
                    const identifyStudentTask = currentFailedFlow.tasks.find(
                      (task: any) => task.name === 'identify_student',
                    );

                    if (identifyStudentTask) {
                      detailedError.identifyStudentAnalysis = {
                        name: identifyStudentTask.name,
                        state: identifyStudentTask.state,
                        input: identifyStudentTask.input,
                        output: identifyStudentTask.output,
                        outputData: identifyStudentTask.output?.data,
                        // Tentar extrair status do output
                        status: identifyStudentTask.output?.data?.status,
                        statusCode:
                          identifyStudentTask.output?.data?.statusCode,
                        // Verificar se o status é 200 (sucesso esperado pela branch)
                        isSuccess:
                          identifyStudentTask.output?.data?.status === 200 ||
                          identifyStudentTask.output?.data?.statusCode === 200,
                        // Verificar se o output é um objeto (pode causar problema na branch)
                        outputIsObject:
                          typeof identifyStudentTask.output?.data ===
                            'object' &&
                          identifyStudentTask.output?.data !== null,
                        outputType: typeof identifyStudentTask.output?.data,
                        // Output completo para debug
                        fullOutput: JSON.stringify(
                          identifyStudentTask.output,
                        ).substring(0, 1000),
                      };
                    }

                    // ANÁLISE DA BRANCH "Ramificação 2" ou "Verificação Identifica Aluno Sucesso"
                    const branchTask = currentFailedFlow.tasks.find(
                      (task: any) =>
                        task.name === 'Ramificação 2' ||
                        task.name?.includes('Verificação') ||
                        task.name?.includes('Branch'),
                    );

                    if (branchTask) {
                      detailedError.branchAnalysis = {
                        name: branchTask.name,
                        state: branchTask.state,
                        input: branchTask.input,
                        output: branchTask.output,
                        message: branchTask.output?.message,
                        // Verificar se a mensagem indica problema com objetos
                        hasObjectComparisonError:
                          branchTask.output?.message?.includes(
                            'object Object',
                          ) ||
                          branchTask.output?.message?.includes(
                            'results to undefined',
                          ),
                      };
                    }

                    const tasksWithConditionError =
                      currentFailedFlow.tasks.filter(
                        (task: any) =>
                          task.output?.message?.includes(
                            'results to undefined',
                          ) ||
                          task.output?.message?.includes('object Object') ||
                          task.name?.includes('Ramificação') ||
                          task.name?.includes('Branch'),
                      );

                    if (tasksWithConditionError.length > 0) {
                      detailedError.tasksWithConditionError =
                        tasksWithConditionError.map((task: any) => ({
                          name: task.name,
                          state: task.state,
                          output: task.output,
                          message: task.output?.message,
                          input: task.input,
                        }));
                    }

                    // Extrair todas as tasks para ver o fluxo completo
                    detailedError.allTasks = currentFailedFlow.tasks.map(
                      (task: any) => ({
                        name: task.name,
                        state: task.state,
                        hasError: !!task.error,
                        outputMessage: task.output?.message,
                        outputData: task.output?.data
                          ? JSON.stringify(task.output.data).substring(0, 200)
                          : null,
                      }),
                    );
                  }

                  // Extrair erro parseado se disponível
                  if (currentFailedFlow.error) {
                    try {
                      const parsedError = JSON.parse(currentFailedFlow.error);
                      detailedError.parsedError = {
                        message: parsedError.message,
                        name: parsedError.name,
                      };
                    } catch (e) {
                      detailedError.rawError = currentFailedFlow.error;
                    }
                  }

                  this.logger.error(
                    '[ERROR DEBUG] Detailed flow instance error analysis',
                    detailedError,
                  );
                }

                this.logger.log('[ERROR DEBUG] Failed flow instances found', {
                  failedFlowsCount: flowInstances.length,
                  failedFlows: flowInstances.map((flow: any) => ({
                    instance_id: flow.instance_id,
                    name: flow.name,
                    state: flow.state,
                    errorMessage: flow.error
                      ? JSON.parse(flow.error)?.message || flow.error
                      : null,
                    created_at: flow.created_at,
                  })),
                });
              }
            } catch (flowError: any) {
              // API pode retornar 404 - não é crítico
              this.logger.debug(
                '[ERROR DEBUG] Flow instances API not available (non-critical)',
                {
                  error: flowError.message,
                  note: 'Error details available in step_history from thread messages',
                },
              );
            }

            // Extrair step_history de mensagens de erro para debug detalhado
            const errorMessagesWithSteps = errorMessages.filter(
              (msg: any) => msg.step_history && Array.isArray(msg.step_history),
            );

            if (errorMessagesWithSteps.length > 0) {
              debugInfo.errorStepHistory = errorMessagesWithSteps.map(
                (msg: any) => ({
                  messageId: msg.id,
                  role: msg.role,
                  content: msg.content,
                  stepHistory: msg.step_history.map((step: any) => ({
                    role: step.role,
                    stepDetails: step.step_details?.map((detail: any) => ({
                      type: detail.type,
                      toolCalls: detail.tool_calls,
                      toolOutput: detail.tool_output
                        ? JSON.stringify(detail.tool_output).substring(0, 500)
                        : null,
                      error: detail.error,
                    })),
                  })),
                }),
              );

              this.logger.error(
                '[ERROR DEBUG] Step history from error messages',
                {
                  messagesWithSteps: errorMessagesWithSteps.length,
                  stepHistory: debugInfo.errorStepHistory,
                },
              );
            }

            // Adicionar informações de erro ao debug
            debugInfo.errorDetected = true;
          } catch (errorDetailError: any) {
            this.logger.error(
              '[ERROR DEBUG] Error fetching error details',
              errorDetailError.message,
            );
          }
        }

        // Adicionar thread_id se disponível
        if (threadId) {
          response.thread_id = threadId;
        }

        // Adicionar informações de debug
        response._debug = {
          totalEvents: allEvents.length,
          events: allEvents.map((e) => e.event),
          hasMessageCreated: !!messageCreated,
          isAsyncTool,
          ...debugInfo,
        };

        // Interceptar e melhorar resposta do flow de saldo de horas
        try {
          const flowInstanceId =
            debugInfo.flowInstanceId ||
            messageCreated?.response_metadata?.flowinstance_id;

          if (flowInstanceId) {
            const flowInstance = await this.getFlowInstances({
              instance_id: flowInstanceId,
            });

            if (flowInstance) {
              const instance = Array.isArray(flowInstance)
                ? flowInstance[0]
                : flowInstance;

              // Verificar se é o flow de saldo de horas
              if (
                instance.name === 'GEP_FLOW_consulta_saldo_horas' &&
                instance.state === 'completed' &&
                instance.tasks
              ) {
                this.logger.log('Flow de saldo de horas detectado', {
                  flowInstanceId,
                  flowName: instance.name,
                  state: instance.state,
                  tasksCount: instance.tasks.length,
                });

                const saldoHorasTask = instance.tasks.find(
                  (task: any) => task.name === 'get_saldo_horas',
                );

                if (!saldoHorasTask) {
                  this.logger.warn('Task get_saldo_horas não encontrada', {
                    availableTasks: instance.tasks.map((t: any) => t.name),
                  });
                }

                if (saldoHorasTask?.output?.data) {
                  const outputData = saldoHorasTask.output.data;
                  let saldoInfo: any = null;

                  // Tentar parsear o outputData se for string
                  if (typeof outputData === 'string') {
                    try {
                      saldoInfo = JSON.parse(outputData);
                    } catch {
                      // Se não conseguir parsear, tentar usar como está
                      this.logger.warn(
                        'Could not parse saldo horas outputData as JSON',
                        { outputData: outputData.substring(0, 200) },
                      );
                    }
                  } else {
                    saldoInfo = outputData;
                  }

                  // Extrair dados do info se existir
                  // O output pode ter a estrutura: {error: null, info: {...}, status: 200}
                  // ou diretamente: {saldo_anterior: "...", saldo_atual: "..."}
                  const info = saldoInfo?.info || saldoInfo;
                  const saldoAnterior =
                    info?.saldo_anterior || saldoInfo?.saldo_anterior;
                  const saldoAtual =
                    info?.saldo_atual || saldoInfo?.saldo_atual;

                  if (saldoAnterior !== undefined || saldoAtual !== undefined) {
                    // Construir resposta formatada em markdown
                    const formattedResponse = this.formatSaldoHorasResponse(
                      saldoAnterior,
                      saldoAtual,
                    );

                    // Substituir a resposta ruim pela formatada
                    response.output.generic = [
                      {
                        response_type: 'text',
                        text: formattedResponse,
                      },
                    ];

                    this.logger.log('Saldo de horas response improved', {
                      flowInstanceId,
                      saldoAnterior,
                      saldoAtual,
                    });
                  }
                }
              }
            }
          }
        } catch (improveError: any) {
          // Não bloquear a resposta se houver erro ao melhorar
          this.logger.warn(
            'Error improving saldo horas response',
            improveError.message,
          );
        }

        this.logger.log('Returning response', {
          hasOutput: !!response.output,
          genericCount: response.output.generic.length,
          hasThreadId: !!response.thread_id,
          hasError,
        });

        resolve(response);
      });

      stream.on('error', (error) => {
        this.logger.error('SSE stream error', error);
        reject(error);
      });

      // Timeout de segurança
      setTimeout(() => {
        if (!hasReceivedData || !messageCreated) {
          this.logger.warn('SSE stream timeout');
          stream.destroy();
          resolve({
            output: {
              generic: [],
            },
            ...(threadId && { thread_id: threadId }),
            _debug: {
              timeout: true,
              totalEvents: allEvents.length,
            },
          });
        }
      }, 120000); // 2 minutos
    });
  }

  /**
   * Lista mensagens de um thread
   */
  async getThreadMessages(threadId: string) {
    try {
      this.logger.debug(`Getting messages for thread ${threadId}`);

      const response = await this.axiosInstance.get(
        `/threads/${threadId}/messages`,
        {
          headers: {
            Accept: 'application/json',
          },
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error(
        'Error getting thread messages',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  /**
   * Lista flow instances (runs de flows)
   * @param params - Parâmetros opcionais de filtro
   * @see https://developer.watson-orchestrate.ibm.com/apis/agentic-workflow/retrieve-flow-instances
   */
  async getFlowInstances(params?: {
    flow_id?: string;
    version?: string;
    state?: 'completed' | 'in_progress' | 'interrupted' | 'failed';
    instance_id?: string;
    root_only?: boolean;
    initiators?: string[];
    page?: number;
    page_size?: number;
  }) {
    try {
      this.logger.debug('Getting flow instances', params);

      // Tentar diferentes endpoints possíveis
      // baseURL já inclui /v1/orchestrate, então:
      // - /flows -> {baseURL}/flows
      // - /api/v1/orchestrate/flows -> {baseURL}/api/v1/orchestrate/flows (duplicado)
      // Vamos tentar primeiro sem /api, depois com /api se necessário
      let response;
      let lastError: any = null;

      // Tentar primeiro /flows (sem barra final)
      try {
        response = await this.axiosInstance.get('/flows', {
          params: {
            ...(params?.flow_id && { flow_id: params.flow_id }),
            ...(params?.version && { version: params.version }),
            ...(params?.state && { state: params.state }),
            ...(params?.instance_id && { instance_id: params.instance_id }),
            ...(params?.root_only !== undefined && {
              root_only: params.root_only,
            }),
            ...(params?.initiators && { initiators: params.initiators }),
            ...(params?.page && { page: params.page }),
            ...(params?.page_size && { page_size: params.page_size }),
          },
          headers: {
            Accept: 'application/json',
          },
        });
      } catch (error: any) {
        lastError = error;
        // Se falhar, tentar com /api (pode ser que o endpoint precise de /api)
        this.logger.debug('Trying alternative endpoint with /api', {
          firstError: error.message,
        });
        try {
          // Se baseURL é /v1/orchestrate, /api/flows vira /v1/orchestrate/api/flows
          // Mas pode ser que precise ser absoluto, então vamos tentar
          response = await this.axiosInstance.get('/api/flows', {
            params: {
              ...(params?.flow_id && { flow_id: params.flow_id }),
              ...(params?.version && { version: params.version }),
              ...(params?.state && { state: params.state }),
              ...(params?.instance_id && { instance_id: params.instance_id }),
              ...(params?.root_only !== undefined && {
                root_only: params.root_only,
              }),
              ...(params?.initiators && { initiators: params.initiators }),
              ...(params?.page && { page: params.page }),
              ...(params?.page_size && { page_size: params.page_size }),
            },
            headers: {
              Accept: 'application/json',
            },
          });
        } catch (error2: any) {
          // Se ambos falharem, lançar o primeiro erro
          this.logger.debug('Both endpoints failed', {
            firstError: lastError.message,
            secondError: error2.message,
          });
          throw lastError;
        }
      }

      return response.data;
    } catch (error: any) {
      this.logger.error(
        'Error getting flow instances',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  /**
   * Busca detalhes de um flow instance específico incluindo steps
   * @param instanceId - ID do flow instance
   * @returns Detalhes do flow instance incluindo steps e status
   */
  async getFlowInstanceDetails(instanceId: string) {
    try {
      this.logger.debug('Getting flow instance details', { instanceId });

      // Primeiro tentar buscar pela API de flow instances
      const instances = await this.getFlowInstances({
        instance_id: instanceId,
      });

      // Se retornou um array, pegar o primeiro item
      if (Array.isArray(instances) && instances.length > 0) {
        const instance = instances[0];
        this.logger.log('Flow instance details retrieved', {
          instanceId,
          state: instance.state,
          flowId: instance.flow_id,
          hasSteps: !!instance.steps,
          stepsCount: Array.isArray(instance.steps) ? instance.steps.length : 0,
        });
        return instance;
      }

      // Se não encontrou, retornar null
      this.logger.warn('Flow instance not found', { instanceId });
      return null;
    } catch (error: any) {
      this.logger.error(
        'Error getting flow instance details',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  /**
   * Faz polling das mensagens do thread até que não haja mais mensagens novas
   * ou até o timeout. Detecta novas mensagens por ID e acumula incrementalmente.
   * @param threadId - ID do thread
   * @param maxAttempts - Número máximo de tentativas (default: 20)
   * @param intervalMs - Intervalo entre tentativas em ms (default: 2000)
   * @param timeoutMs - Timeout total em ms (default: 60000)
   * @param onStatus - Callback opcional para eventos de status (thinking/reasoning)
   */
  private async pollThreadMessages(
    threadId: string,
    maxAttempts: number = 20,
    intervalMs: number = 2000,
    timeoutMs: number = 60000,
    onStatus?: StatusCallback,
  ): Promise<any[]> {
    const startTime = Date.now();
    let seenMessageIds = new Set<string>();
    let attempts = 0;
    let lastMessages: any[] = [];
    let noNewMessagesCount = 0; // Contador de tentativas sem novas mensagens

    this.logger.log('Starting thread polling', {
      threadId,
      maxAttempts,
      intervalMs,
      timeoutMs,
    });

    while (attempts < maxAttempts) {
      // Verificar timeout
      if (Date.now() - startTime > timeoutMs) {
        this.logger.warn('Polling timeout reached', {
          attempts,
          elapsed: Date.now() - startTime,
        });
        break;
      }

      try {
        const messages = await this.getThreadMessages(threadId);
        const currentMessageCount = messages.length;

        // Detectar novas mensagens comparando IDs
        const newMessages = messages.filter(
          (msg: any) => msg.id && !seenMessageIds.has(msg.id),
        );

        if (newMessages.length > 0) {
          // Novas mensagens encontradas
          newMessages.forEach((msg: any) => {
            if (msg.id) {
              seenMessageIds.add(msg.id);
            }

            // Capturar flowinstance_id se disponível
            const msgFlowInstanceId =
              msg.response_metadata?.flowinstance_id ||
              msg.additional_properties?.display_properties?.flowinstance_id;

            if (msgFlowInstanceId) {
              this.logger.log('Flow instance ID found in message', {
                messageId: msg.id,
                flowInstanceId: msgFlowInstanceId,
                correlationId: msg.response_metadata?.correlation_id,
                targetRunId: msg.response_metadata?.target_run_id,
              });
            }

            // Verificar thinking/reasoning na mensagem
            if (msg.thinking) {
              this.logger.log('[Polling] Thinking found in message', {
                messageId: msg.id,
                thinking:
                  typeof msg.thinking === 'string'
                    ? msg.thinking.substring(0, 100)
                    : JSON.stringify(msg.thinking).substring(0, 100),
              });
            }

            if (msg.reasoning) {
              this.logger.log('[Polling] Reasoning found in message', {
                messageId: msg.id,
                reasoning:
                  typeof msg.reasoning === 'string'
                    ? msg.reasoning.substring(0, 100)
                    : JSON.stringify(msg.reasoning).substring(0, 100),
              });
            }

            // Capturar step_history se disponível
            if (msg.step_history && Array.isArray(msg.step_history)) {
              const stepDetails = msg.step_history.map((step: any) => {
                // Verificar reasoning nos steps
                if (step.reasoning) {
                  this.logger.log('[Polling] Reasoning found in step_history', {
                    messageId: msg.id,
                    reasoning:
                      typeof step.reasoning === 'string'
                        ? step.reasoning.substring(0, 100)
                        : JSON.stringify(step.reasoning).substring(0, 100),
                  });
                }

                const details = Array.isArray(step.step_details)
                  ? step.step_details.map((detail: any) => {
                      // Verificar reasoning nos step_details
                      if (detail.reasoning) {
                        this.logger.log(
                          '[Polling] Reasoning found in step_details',
                          {
                            messageId: msg.id,
                            reasoning:
                              typeof detail.reasoning === 'string'
                                ? detail.reasoning.substring(0, 100)
                                : JSON.stringify(detail.reasoning).substring(
                                    0,
                                    100,
                                  ),
                          },
                        );
                      }

                      return {
                        type: detail.type,
                        reasoning: detail.reasoning,
                        tool_calls: detail.tool_calls
                          ? detail.tool_calls.map((tc: any) => ({
                              name: tc.name,
                              id: tc.id,
                              args: tc.args,
                            }))
                          : null,
                        tool_output: detail.tool_output
                          ? JSON.stringify(detail.tool_output).substring(0, 200)
                          : null,
                      };
                    })
                  : [];

                return {
                  role: step.role,
                  hasDetails: !!step.step_details,
                  detailsCount: details.length,
                  details: details,
                };
              });
            }
          });

          this.logger.debug('New messages', { count: newMessages.length });

          noNewMessagesCount = 0; // Reset contador
        } else {
          // Nenhuma mensagem nova
          noNewMessagesCount++;
          this.logger.debug('No new messages', {
            attempt: attempts + 1,
            messageCount: currentMessageCount,
            noNewMessagesCount,
          });
        }

        // Verificar se devemos parar
        if (noNewMessagesCount >= 2) {
          // 2 tentativas consecutivas sem novas mensagens
          const lastMessage = messages[messages.length - 1];
          const isStillProcessing =
            lastMessage?.additional_properties?.display_properties?.is_async ===
              true ||
            lastMessage?.content?.some(
              (item: any) =>
                item.text?.includes('Tool is processing') ||
                item.text?.includes('Please wait until the tool completes'),
            );

          // Verificar se última mensagem requer user activity
          const lastMessageActivity = lastMessage
            ? this.detectUserActivity(lastMessage)
            : null;

          if (!isStillProcessing) {
            return messages;
          } else {
            // Ainda processando, continuar
            this.logger.debug('Still processing, continuing polling');
            noNewMessagesCount = 0; // Reset para continuar
          }
        }

        lastMessages = messages;

        // Aguardar antes da próxima tentativa
        if (attempts < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }

        attempts++;
      } catch (error: any) {
        this.logger.error('Error during polling attempt', {
          attempt: attempts + 1,
          error: error.message,
        });
        // Continuar tentando mesmo com erro
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    }

    return lastMessages;
  }

  /**
   * Detecta se uma mensagem requer interação do usuário (user activity)
   * @param message - Mensagem do thread
   * @returns Objeto com tipo de activity ou null se não requer
   */
  private detectUserActivity(message: any): {
    type: string;
    details: any;
  } | null {
    if (!message || !message.content || !Array.isArray(message.content)) {
      return null;
    }

    // Verificar cada item do conteúdo
    for (const item of message.content) {
      // Tipo: option (botões/opções)
      if (item.response_type === 'option' || item.type === 'option') {
        return {
          type: 'option',
          details: {
            hasOptions: !!item.options,
            optionsCount: item.options?.length || 0,
            text: item.text || null, // Incluir text se existir
            title: item.text || item.title || null,
            options: item.options,
            // Incluir todos os campos relevantes
            id: item.id || null,
            name: item.name || null,
          },
        };
      }

      // Tipo: boolean (sim/não)
      if (
        item.response_type === 'boolean' ||
        item.type === 'boolean' ||
        (item.name && item.name.includes('boolean'))
      ) {
        return {
          type: 'boolean',
          details: {
            text: item.text || null, // Incluir text se existir
            default: item.default,
            options: item.options,
            title: item.text || item.title || null,
            id: item.id || null,
            name: item.name || null,
          },
        };
      }

      // Tipo: datepicker (calendário)
      // Watson pode retornar como 'date' ou 'datepicker'
      if (
        item.response_type === 'date' ||
        item.response_type === 'datepicker' ||
        item.type === 'datepicker' ||
        (item.name && item.name.includes('date'))
      ) {
        return {
          type: 'datepicker',
          details: {
            text: item.text || null, // Incluir text se existir
            constraints: item.constraints,
            title: item.text || item.title || null,
            id: item.id || null,
            name: item.name || null,
          },
        };
      }

      // Tipo: text input (campo de texto)
      if (
        item.response_type === 'text_input' ||
        item.type === 'text_input' ||
        (item.name && item.name.includes('input'))
      ) {
        return {
          type: 'text_input',
          details: {
            text: item.text || null, // Incluir text se existir
            placeholder: item.placeholder,
            required: item.required,
            title: item.text || item.title || null,
            id: item.id || null,
            name: item.name || null,
          },
        };
      }

      // Verificar se tem botões
      if (
        item.buttons &&
        Array.isArray(item.buttons) &&
        item.buttons.length > 0
      ) {
        return {
          type: 'buttons',
          details: {
            text: item.text || null, // Incluir text se existir
            buttonsCount: item.buttons.length,
            buttons: item.buttons,
            title: item.text || item.title || null,
            id: item.id || null,
            name: item.name || null,
          },
        };
      }

      // Verificar se é texto com opções (text + options na mesma mensagem)
      // Isso pode acontecer quando há um texto descritivo antes das opções
      if (
        item.text &&
        item.options &&
        Array.isArray(item.options) &&
        item.options.length > 0
      ) {
        return {
          type: 'text_with_options',
          details: {
            text: item.text,
            options: item.options,
            optionsCount: item.options.length,
            id: item.id || null,
            name: item.name || null,
          },
        };
      }
    }

    // Verificar step_history para tool calls que requerem resposta
    if (message.step_history && Array.isArray(message.step_history)) {
      for (const step of message.step_history) {
        if (step.step_details) {
          for (const detail of step.step_details) {
            // Tool call que requer resposta do usuário
            if (detail.type === 'tool_calls' && detail.tool_calls) {
              const toolCalls = detail.tool_calls;
              // Verificar se alguma tool requer input do usuário
              const requiresInput = toolCalls.some(
                (tc: any) =>
                  tc.name?.includes('input') ||
                  tc.name?.includes('user') ||
                  tc.args?.requires_user_input,
              );

              if (requiresInput) {
                return {
                  type: 'tool_user_input',
                  details: {
                    toolCalls: toolCalls.map((tc: any) => ({
                      name: tc.name,
                      id: tc.id,
                    })),
                  },
                };
              }
            }
          }
        }
      }
    }

    return null;
  }
}
