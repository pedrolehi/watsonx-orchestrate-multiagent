import {
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
  Sse,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { BrokerWidgetService } from './broker-widget/broker-widget.service';
import { WidgetAuthDto } from './dto/widget-auth.dto';

@Controller('broker')
@ApiTags('Broker')
export class BrokerController {
  constructor(
    private readonly brokerWidgetService: BrokerWidgetService,
    private readonly authService: AuthService,
  ) {}

  @Post('widget-auth')
  @ApiOperation({ summary: 'Autenticar Widget' })
  @ApiResponse({
    status: 201,
    description: 'Realizar autenticação do Widget e validar acessos',
  })
  @ApiBody({ type: WidgetAuthDto })
  async widgetAuth(@Body() body: WidgetAuthDto) {
    // Lógica para processar o widget
    return this.brokerWidgetService.auth(body);
  }

  @Post('widget-conversation')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: 'Processar conversa do widget' })
  @ApiResponse({ status: 201, description: 'Conversa processada com sucesso' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        sender: {
          type: 'string',
          description: 'Quem está enviando a mensagem',
          example: 'user',
        },
        text: {
          type: 'string',
          description: 'Texto da mensagem',
          example: 'Olá, preciso de ajuda',
        },
        avatar: {
          type: 'string',
          description: 'URL do avatar do usuário',
          example: 'https://example.com/avatar.jpg',
        },
        timestamp: {
          type: 'string',
          description: 'Timestamp da mensagem',
          example: '2025-07-07T10:30:00.000Z',
        },
        sessionId: {
          type: 'string',
          description: 'ID da sessão/conversa',
          example: 'session_123456',
        },
        assistantId: {
          type: 'string',
          description: 'ID do assistente',
          example: 'assistant_watson_123',
        },
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Arquivos opcionais (imagem, documento, etc.)',
        },
      },
      required: ['sender', 'text', 'sessionId', 'assistantId'],
    },
  })
  async widget(
    @Body() body: any,
    @UploadedFiles() files?: Array<Express.Multer.File>,
  ) {
    if (!body || !body.message) {
      throw new Error('Mensagem não encontrada no corpo da requisição');
    }

    try {
      // Logs defensivos sobre arquivos recebidos
      const hasFiles = Array.isArray(files) && files.length > 0;
      if (hasFiles) {
        console.debug(
          '[BrokerController] Arquivos recebidos:',
          files.map((f) => ({
            name: f.originalname,
            size: f.size,
            mimetype: f.mimetype,
            hasBuffer: !!f.buffer,
          })),
        );
      }

      // Parse da mensagem
      const messageData = JSON.parse(body?.message);

      // Processar mensagem sem validação de token
      return this.brokerWidgetService.run(messageData, files);
    } catch (error) {
      console.error('Erro ao processar mensagem do widget:', error);
      throw new Error('Erro ao processar mensagem');
    }
  }

  /**
   * Endpoint SSE para conversa com streaming de status
   * Retorna eventos de status durante o processamento e a resposta final no fim
   */
  @Post('widget-conversation-stream')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @Sse()
  @ApiOperation({
    summary: 'Processar conversa do widget com streaming SSE de status',
  })
  @ApiResponse({
    status: 200,
    description: 'Stream SSE de eventos de status e resposta final',
  })
  @ApiConsumes('multipart/form-data')
  widgetStream(
    @Body() body: any,
    @UploadedFiles() files?: Array<Express.Multer.File>,
  ): Observable<MessageEvent> {
    if (!body || !body.message) {
      throw new Error('Mensagem não encontrada no corpo da requisição');
    }

    try {
      const messageData = JSON.parse(body?.message);
      return this.brokerWidgetService.runWithStreaming(messageData, files);
    } catch (error) {
      console.error('Erro ao processar streaming:', error);
      throw new Error('Erro ao processar streaming');
    }
  }
}
