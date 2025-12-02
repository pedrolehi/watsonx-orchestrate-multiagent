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
  ApiProduces,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import multer from 'multer';
import { Observable } from 'rxjs';
import { promisify } from 'util';
import { AuthService } from '../auth/auth.service';
import { BrokerWidgetService } from './broker-widget/broker-widget.service';
import { WidgetAuthDto } from './dto/widget-auth.dto';
import { TextToSpeechService } from '../watsonxorchestrate/text-to-speech.service';
import { SpeechToTextService } from '../watsonxorchestrate/speech-to-text.service';
import { AudioCacheService } from '../watsonxorchestrate/audio-cache.service';
import { TextToSpeechDto } from './dto/text-to-speech.dto';
import { SpeechToTextDto } from './dto/speech-to-text.dto';

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
    private readonly textToSpeechService: TextToSpeechService,
    private readonly speechToTextService: SpeechToTextService,
    private readonly audioCacheService: AudioCacheService,
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

  @Post('text-to-speech')
  @ApiOperation({ summary: 'Sintetizar texto em áudio' })
  @ApiResponse({
    status: 200,
    description: 'Áudio gerado com sucesso',
    content: {
      'audio/wav': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiProduces('audio/wav')
  @ApiBody({ type: TextToSpeechDto })
  async textToSpeech(
    @Body() body: TextToSpeechDto,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { text, voice } = body;

      // Verificar cache primeiro
      const cached = this.audioCacheService.get(text, voice || '');
      if (cached) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Content-Length', cached.audio.length.toString());
        res.setHeader('X-Cache', 'HIT');
        res.send(cached.audio);
        return;
      }

      // Gerar áudio
      const result = await this.textToSpeechService.synthesize(text, voice);

      // Armazenar no cache
      this.audioCacheService.set(
        text,
        voice || '',
        result.audio,
        result.contentType,
      );

      // Retornar áudio
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Length', result.audio.length.toString());
      res.setHeader('X-Cache', 'MISS');
      res.send(result.audio);
    } catch (error) {
      res.status(500).json({
        error: 'Erro ao sintetizar texto',
        message: error.message,
      });
    }
  }

  @Post('speech-to-text')
  @UseInterceptors(
    FilesInterceptor('audio', 1, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    }),
  )
  @ApiOperation({ summary: 'Transcrever áudio em texto' })
  @ApiResponse({
    status: 200,
    description: 'Texto transcrito com sucesso',
    schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          example: 'Texto transcrito do áudio',
        },
      },
    },
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        audio: {
          type: 'string',
          format: 'binary',
        },
        contentType: {
          type: 'string',
          enum: [
            'audio/wav',
            'audio/flac',
            'audio/ogg',
            'audio/ogg;codecs=opus',
          ],
          example: 'audio/wav',
        },
      },
    },
  })
  async speechToText(
    @Req() req: any,
    @Body() body: SpeechToTextDto,
    @UploadedFiles() files?: Array<Express.Multer.File>,
  ): Promise<{ text: string }> {
    const audioFile = files && files.length > 0 ? files[0] : req.file;

    if (!audioFile) {
      throw new Error('Arquivo de áudio não encontrado');
    }

    const contentType = body.contentType || audioFile.mimetype || 'audio/wav';

    const audioBuffer = audioFile.buffer;

    const text = await this.speechToTextService.recognize(
      audioBuffer,
      contentType,
    );

    return { text };
  }
}
