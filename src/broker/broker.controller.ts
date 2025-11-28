import {
  Body,
  Controller,
  Post,
  UseInterceptors,
  Req,
  Res,
  UploadedFiles,
  CallHandler,
  NestInterceptor,
  ExecutionContext,
} from '@nestjs/common';
import { Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import multer from 'multer';
import { Observable } from 'rxjs';
import { promisify } from 'util';
import { AuthService } from '../auth/auth.service';
import { BrokerWidgetService } from './broker-widget/broker-widget.service';
import { WidgetAuthDto } from './dto/widget-auth.dto';

// Interceptor para processar FormData manualmente para streaming
class FormDataStreamInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Processar FormData usando multer manualmente
    const upload = multer({
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }).any();

    const multerAny = promisify(upload);
    await multerAny(request, response);

    return next.handle();
  }
}

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

  // Endpoint normal (JSON) - sem streaming
  @Post('widget-conversation')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: 'Processar conversa do widget (JSON)' })
  @ApiResponse({ status: 201, description: 'Conversa processada com sucesso' })
  @ApiConsumes('multipart/form-data')
  async widget(
    @Req() req: any,
    @Body() body: any,
    @UploadedFiles() files?: Array<Express.Multer.File>,
  ) {
    const formData = req.body || body;

    if (!formData?.message) {
      throw new Error('Mensagem não encontrada no corpo da requisição');
    }

    const messageData = JSON.parse(formData.message);
    return this.brokerWidgetService.run(messageData, files);
  }

  // Endpoint para streaming (SSE)
  @Post('widget-conversation-stream')
  @UseInterceptors(new FormDataStreamInterceptor())
  @ApiOperation({ summary: 'Processar conversa do widget com streaming SSE' })
  @ApiResponse({
    status: 200,
    description: 'Stream SSE de eventos de status e resposta final',
  })
  @ApiConsumes('multipart/form-data')
  async widgetStream(
    @Req() req: any,
    @Res() res: Response,
    @Body() body: any,
  ): Promise<void> {
    const files = (req.files as Array<Express.Multer.File>) || undefined;
    const formData = req.body || body;

    if (!formData?.message) {
      res
        .status(400)
        .json({ error: 'Mensagem não encontrada no corpo da requisição' });
      return;
    }

    const messageData = JSON.parse(formData.message);

    // Configurar headers SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Fazer subscribe no Observable e escrever eventos SSE manualmente
    const observable = this.brokerWidgetService.runWithStreaming(
      messageData,
      files,
    );

    observable.subscribe({
      next: (event: MessageEvent) => {
        res.write(`data: ${event.data}\n\n`);
      },
      error: (error) => {
        const errorEvent = {
          data: JSON.stringify({
            event: 'error',
            data: {
              message: error.message || 'Erro ao processar requisição',
              timestamp: Date.now(),
            },
          }),
        };
        res.write(`data: ${errorEvent.data}\n\n`);
        res.end();
      },
      complete: () => {
        res.end();
      },
    });
  }
}
