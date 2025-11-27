import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CoreService } from '../../core/core.service';
import { CoreRunDto } from '../../core/dto/core.dto';
import { WidgetAuthDto } from '../dto/widget-auth.dto';
import {
  WidgetContextDto,
  WidgetConversationResponseDto,
  WidgetMessageDto,
  WidgetSettingsDto,
} from '../dto/widget-conversation-response.dto';
import { WidgetConversationDto } from '../dto/widget-conversation.dto';

@Injectable()
export class BrokerWidgetService {
  private readonly logger = new Logger(BrokerWidgetService.name);

  constructor(private readonly coreService: CoreService) {}

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
    // Log consolidado de entrada do widget
    this.logger.log('User conversation', {
      sessionId: data.sessionId,
      assistantId: data.assistantId,
      text: data.text,
      hasFiles: !!files && files.length > 0,
      fileCount: files ? files.length : 0,
      fileInfo: files
        ? files.map((file) => ({
            originalname: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
          }))
        : null,
    });

    // Nota: A validação do assistente e persistência de conversa foram movidas/removidas
    // conforme a reestruturação para focar apenas no novo CoreModule Watsonx.

    const hasFiles = !!files && files.length > 0;

    // Incluir thread_id do contexto anterior se disponível (para manter a sessão)
    const previousThreadId =
      data.user?.thread_id || data.user?.context?.thread_id;
    const isFirstMessage = !previousThreadId;

    const payload: CoreRunDto = {
      message: {
        type: 'text',
        text: this.sanitizeTextForWatson(data.text || ''),
      },
      conversationId: data.sessionId,
      profileName: 'Widget User',
      context: {
        ...data.user,
        ...(previousThreadId && { thread_id: previousThreadId }),
        ...(isFirstMessage && { is_first_message: true }),
        // Garantir que resultAluno e emplid estejam no contexto para o welcome_tool
        resultAluno: data.user?.resultAluno || data.user?.context?.resultAluno,
        emplid:
          data.user?.emplid || data.user?.context?.emplid || data.user?.chapa,
        filesReceived: hasFiles,
        attachmentNames: hasFiles
          ? files.map((file) => file.originalname)
          : undefined,
        assistant_id: data.assistantId,
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

    this.logger.log('Response prepared', {
      sessionId: data.sessionId,
      totalMessages: response.messages.length,
      hasSettings: !!response.settings,
      hasFiles: !!files && files.length > 0,
      hasDebug: !!response.debug,
    });

    return response;
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
        message: message.text,
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
        message: message.text,
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
          message: message.text,
          component: componentType,
          options: this.extractButtons(options),
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
        };
      }

      if (!isNextMessageMultiselect) {
        return {
          sender: 'ai',
          message: nextMessage.title
            ? `${message.text}\n\n${nextMessage.title}`
            : message.text,
          buttons: this.extractButtons(nextMessage.options),
          messageId: randomUUID(),
          timestamp: new Date().toISOString(),
        };
      }
    }

    return {
      sender: 'ai',
      message: message.text,
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
      const finalTitle =
        message.title || message.text || 'Selecione uma das opções:';
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
      message: message.title || message.text || 'Selecione uma opção:',
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
      message: message.text || 'Vídeo',
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
