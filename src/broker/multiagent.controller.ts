import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { PersistenceService } from '../database/session/persistence.service';
import { EmailService } from '../utils/email.service';

/**
 * DTO para atualização de feedback
 * IMPORTANTE: Decoradores são necessários por causa do ValidationPipe whitelist: true
 */
class MessageFeedbackDto {
  @IsOptional()
  @IsIn(['positive', 'negative', null])
  feedback: 'positive' | 'negative' | null;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @IsIn(['incorrect_info', 'incomplete_info', 'other', null])
  reason?: 'incorrect_info' | 'incomplete_info' | 'other' | null;

  @IsOptional()
  @IsString()
  reasonText?: string;
}

/**
 * Controller para operações de feedback em mensagens do multiagent
 * Endpoint: /multiagent/messages/:messageId/feedback
 */
@Controller('multiagent')
@ApiTags('Multiagent')
export class MultiagentController {
  private readonly logger = new Logger(MultiagentController.name);

  constructor(
    private readonly persistenceService: PersistenceService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Atualiza o feedback de uma mensagem específica
   * Endpoint: PATCH /multiagent/messages/:messageId/feedback
   */
  @Patch('messages/:messageId/feedback')
  @ApiOperation({ summary: 'Atualizar feedback de uma mensagem' })
  @ApiParam({
    name: 'messageId',
    description: 'ID da mensagem',
    example: 'acf0de0e-a8d9-4270-b1d7-bea1e0712aac',
  })
  @ApiBody({
    description: 'Dados do feedback',
    schema: {
      type: 'object',
      properties: {
        feedback: {
          type: 'string',
          enum: ['positive', 'negative', null],
          description: 'Tipo de feedback',
        },
        timestamp: {
          type: 'string',
          description: 'Timestamp do feedback (opcional)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Feedback atualizado com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        messageId: {
          type: 'string',
          example: 'acf0de0e-a8d9-4270-b1d7-bea1e0712aac',
        },
        feedback: { type: 'string', example: 'positive' },
        feedbackTimestamp: {
          type: 'string',
          example: '2025-01-12T10:30:00.000Z',
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Mensagem não encontrada',
  })
  async updateMessageFeedback(
    @Param('messageId') messageId: string,
    @Body() body: MessageFeedbackDto,
  ) {
    this.logger.log(`Recebendo feedback para mensagem ${messageId}`, {
      messageId,
      feedback: body.feedback,
    });

    try {
      const updatedMessage = await this.persistenceService.updateMessageFeedback(
        messageId,
        body.feedback,
        body.reason,
        body.reasonText,
      );

      if (!updatedMessage) {
        throw new NotFoundException(`Mensagem com ID ${messageId} não encontrada`);
      }

      // Fire and forget: Dispara alerta de e-mail para feedback negativo (assíncrono)
      if (body.feedback === 'negative' && updatedMessage.feedback) {
        this.sendNegativeFeedbackAlert(
          messageId,
          updatedMessage.sessionId,
          updatedMessage.feedback.reason || 'Não especificado',
          updatedMessage.feedback.comment,
          updatedMessage.assistantMessages,
        ).catch((error) => {
          // Log do erro, mas não propaga para o cliente
          this.logger.error(
            `Falha ao enviar alerta de feedback negativo: ${error.message}`,
          );
        });
      }

      return {
        success: true,
        messageId: updatedMessage.messageId,
        feedback: updatedMessage.feedback || null,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erro desconhecido';
      this.logger.error(`Erro ao atualizar feedback: ${errorMessage}`, {
        messageId,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Método privado para enviar alerta de feedback negativo
   * Fire and forget: não bloqueia a resposta HTTP
   */
  private async sendNegativeFeedbackAlert(
    messageId: string,
    sessionId: string,
    feedbackReason: string,
    feedbackComment: string | undefined,
    assistantMessages: any[],
  ): Promise<void> {
    try {
      // Extrair o conteúdo da última resposta da IA
      let aiResponse = 'Conteúdo não disponível';
      if (assistantMessages && assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1];
        aiResponse = lastMessage.text || lastMessage.content || 'Conteúdo não disponível';
      }

      // Disparar e-mail
      await this.emailService.sendNegativeFeedbackAlert({
        messageId,
        sessionId,
        aiResponse,
        feedbackReason,
        feedbackComment,
      });

      this.logger.log(`Alerta de feedback negativo enviado para messageId: ${messageId}`);
    } catch (error) {
      // Erro já será logado no catch do método chamador
      throw error;
    }
  }

  /**
   * Busca uma mensagem pelo ID
   * Endpoint: GET /multiagent/messages/:messageId
   */
  @Get('messages/:messageId')
  @ApiOperation({ summary: 'Buscar uma mensagem pelo ID' })
  @ApiParam({
    name: 'messageId',
    description: 'ID da mensagem',
    example: 'acf0de0e-a8d9-4270-b1d7-bea1e0712aac',
  })
  @ApiResponse({
    status: 200,
    description: 'Mensagem encontrada',
  })
  @ApiResponse({
    status: 404,
    description: 'Mensagem não encontrada',
  })
  async getMessage(@Param('messageId') messageId: string) {
    this.logger.log(`Buscando mensagem ${messageId}`);

    const message = await this.persistenceService.findMessageByMessageId(messageId);

    if (!message) {
      throw new NotFoundException(`Mensagem com ID ${messageId} não encontrada`);
    }

    return message;
  }

  /**
   * Estatísticas de feedback por agente
   * Endpoint: GET /multiagent/agents/:agentId/feedback-stats
   */
  @Get('agents/:agentId/feedback-stats')
  @ApiOperation({ summary: 'Obter estatísticas de feedback por agente' })
  @ApiParam({
    name: 'agentId',
    description: 'ID do agente',
    example: '2fee4c02-a4ff-45c7-b375-332d7a0f8c49',
  })
  @ApiResponse({
    status: 200,
    description: 'Estatísticas de feedback',
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number', example: 100 },
        positive: { type: 'number', example: 75 },
        negative: { type: 'number', example: 10 },
        noFeedback: { type: 'number', example: 15 },
      },
    },
  })
  async getFeedbackStats(@Param('agentId') agentId: string) {
    this.logger.log(`Buscando estatísticas de feedback para agente ${agentId}`);
    return await this.persistenceService.getFeedbackStatsByAgent(agentId);
  }
}
