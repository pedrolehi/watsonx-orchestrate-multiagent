import { Injectable, Logger } from '@nestjs/common';
import { CoreRunDto, CoreRunResponseDto } from './dto/core.dto';
import { WatsonxService } from '../watsonxorchestrate/watsonx.service';

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);

  constructor(private readonly watsonxService: WatsonxService) {}

  async run(
    payload: CoreRunDto,
    assistant: any, // Removido tipo Assistant estrito
    files?: Array<Express.Multer.File>,
  ): Promise<CoreRunResponseDto> {
    this.logger.log(
      `Processing message for conversation: ${payload.conversationId}`,
    );

    // Integração básica: enviar mensagem e retornar resposta
    // Assumindo que agent_id vem no contexto se assistant for null
    const agentId =
      payload.context?.assistant_id ||
      payload.context?.agent_id ||
      process.env.ORCHESTRATE_AGENT_ID;

    if (!agentId) {
      throw new Error('Agent ID not provided');
    }

    // Na primeira mensagem não enviamos thread_id
    // A partir da segunda mensagem, usamos o sessionId do widget como thread_id
    // Verificamos se já existe um thread_id no contexto (indicando que não é a primeira mensagem)
    const isFirstMessage = !payload.context?.thread_id;
    const threadId = isFirstMessage
      ? undefined
      : payload.context.thread_id || payload.conversationId;

    this.logger.debug(
      `Message type: ${isFirstMessage ? 'First message (no thread_id)' : `Continuing thread: ${threadId}`}`,
    );

    try {
      const wxResponse = await this.watsonxService.sendMessageStream(
        agentId,
        threadId,
        payload.message.text,
        payload.context,
      );

      this.logger.debug('Watson Orchestrate response received', {
        hasOutput: !!wxResponse?.output,
        hasThreadId: !!wxResponse?.thread_id,
        hasThread: !!wxResponse?.thread,
        responseKeys: wxResponse ? Object.keys(wxResponse) : [],
      });

      // Capturar thread_id da resposta (retornado na primeira mensagem)
      const responseThreadId = wxResponse.thread_id || wxResponse.thread?.id;
      const context = {
        ...(wxResponse.context || {}),
        ...(responseThreadId && { thread_id: responseThreadId }),
        // Manter o conversationId do widget como referência
        session_id: payload.conversationId,
      };

      this.logger.debug('Final context prepared', {
        hasThreadId: !!context.thread_id,
        sessionId: context.session_id,
      });

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
