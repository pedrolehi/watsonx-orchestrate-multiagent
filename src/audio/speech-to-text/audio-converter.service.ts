import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class AudioConverterService {
  private readonly logger = new Logger(AudioConverterService.name);
  private ffmpegPath: string | null = null;
  private readonly saveSamples: boolean;
  private readonly samplesDir: string;

  constructor(private readonly configService: ConfigService) {
    // Tentar carregar FFmpeg do pacote @ffmpeg-installer/ffmpeg
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
      this.ffmpegPath = ffmpegInstaller.path;
      this.logger.log(
        `FFmpeg carregado do pacote @ffmpeg-installer/ffmpeg: ${this.ffmpegPath}`,
      );
    } catch (error) {
      this.logger.warn(
        'Pacote @ffmpeg-installer/ffmpeg não encontrado. Tentando usar FFmpeg do sistema.',
        { error: error.message },
      );
      this.ffmpegPath = null;
    }

    // Configuração para salvar amostras de teste
    this.saveSamples =
      this.configService.get<string>('SAVE_AUDIO_SAMPLES') === 'true';
    this.samplesDir = path.join(
      process.cwd(),
      this.configService.get<string>('AUDIO_SAMPLES_DIR') || 'audio-samples',
    );

    // Criar diretório de amostras se necessário
    if (this.saveSamples) {
      if (!fs.existsSync(this.samplesDir)) {
        fs.mkdirSync(this.samplesDir, { recursive: true });
        this.logger.log(`Diretório de amostras criado: ${this.samplesDir}`);
      }
    }
  }

  /**
   * Converte WebM para WAV usando FFmpeg (formato sem perdas, ideal para STT)
   * @param webmBuffer Buffer com o áudio em formato WebM
   * @returns Promise<Buffer> Buffer com o áudio em formato WAV
   */
  async convertWebmToWav(webmBuffer: Buffer): Promise<Buffer> {
    // Obter caminho do FFmpeg
    const ffmpeg = await this.getFfmpeg();
    if (!ffmpeg) {
      throw new Error(
        'FFmpeg não está disponível. Por favor, instale o pacote @ffmpeg-installer/ffmpeg ou instale o FFmpeg no sistema.',
      );
    }

    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `input_${Date.now()}.webm`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.wav`);

    try {
      // Escrever buffer WebM em arquivo temporário
      fs.writeFileSync(inputPath, webmBuffer);

      // Converter usando FFmpeg
      await this.runFfmpegConversion(ffmpeg, inputPath, outputPath);

      // Ler arquivo WAV convertido
      const wavBuffer = fs.readFileSync(outputPath);

      // Salvar amostra para teste se configurado
      if (this.saveSamples) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          // Salvar arquivo convertido (WAV)
          const samplePath = path.join(
            this.samplesDir,
            `converted_${timestamp}.wav`,
          );
          fs.copyFileSync(outputPath, samplePath);

          // Salvar arquivo original (WebM) para comparação
          const originalPath = path.join(
            this.samplesDir,
            `original_${timestamp}.webm`,
          );
          fs.copyFileSync(inputPath, originalPath);

          this.logger.log(`Amostras de áudio salvas:`);
          this.logger.log(`  - Original (WebM): ${originalPath}`);
          this.logger.log(`  - Convertido (WAV): ${samplePath}`);
        } catch (error) {
          this.logger.warn('Erro ao salvar amostra de áudio', {
            error: error.message,
          });
        }
      }

      return wavBuffer;
    } catch (error) {
      this.logger.error('Erro ao converter WebM para WAV', {
        error: error.message,
      });
      throw error;
    } finally {
      // Limpar arquivos temporários (exceto se salvos como amostra)
      if (!this.saveSamples) {
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (cleanupError) {
          this.logger.warn('Erro ao limpar arquivos temporários', {
            error: cleanupError.message,
          });
        }
      }
    }
  }

  /**
   * Verifica se FFmpeg está disponível e retorna o caminho
   */
  private async getFfmpeg(): Promise<string | null> {
    // Se já temos o caminho do pacote npm, usar ele
    if (this.ffmpegPath) {
      return this.ffmpegPath;
    }

    // Caso contrário, tentar encontrar no sistema
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      // Tentar encontrar ffmpeg no PATH
      await execAsync('ffmpeg -version');
      return 'ffmpeg';
    } catch {
      // Tentar caminhos comuns
      const commonPaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe', // Windows
        '/usr/bin/ffmpeg', // Linux
        '/usr/local/bin/ffmpeg', // macOS/Linux
      ];

      for (const ffmpegPath of commonPaths) {
        try {
          await execAsync(`"${ffmpegPath}" -version`);
          return ffmpegPath;
        } catch {
          continue;
        }
      }

      return null;
    }
  }

  /**
   * Executa a conversão usando FFmpeg
   */
  private async runFfmpegConversion(
    ffmpegPath: string,
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Comando FFmpeg para converter WebM para WAV com otimizações para STT
    // -acodec pcm_s16le: PCM 16-bit little-endian (sem perdas)
    // -ac 1: Mono (reduz tamanho e melhora reconhecimento)
    // -ar 16000: Sample rate 16kHz (recomendado pelo IBM para melhor precisão)
    // -af "highpass=f=85,lowpass=f=3400,volume=1.3,compand=attacks=0.3:decays=0.8:points=-90/-90|-60/-60|-40/-30|-30/-20|-20/-10:gain=5": Filtros de áudio
    //   - highpass=f=85: Remove frequências muito baixas (ruído de fundo)
    //   - lowpass=f=3400: Remove frequências muito altas (foco na faixa de voz humana 85-3400Hz)
    //   - volume=1.3: Aumenta volume em 30% (melhora clareza)
    //   - compand: Compressor/expansor de dinâmica (melhora clareza da voz)
    // -f wav: Formato WAV
    const command = `"${ffmpegPath}" -i "${inputPath}" -acodec pcm_s16le -ac 1 -ar 16000 -af "highpass=f=85,lowpass=f=3400,volume=1.3,compand=attacks=0.3:decays=0.8:points=-90/-90|-60/-60|-40/-30|-30/-20|-20/-10:gain=5" -f wav "${outputPath}"`;

    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr && !stderr.includes('frame=')) {
        // FFmpeg escreve logs em stderr, mas isso é normal
        this.logger.debug('FFmpeg conversion output', { stderr });
      }
    } catch (error) {
      this.logger.error('Erro ao executar FFmpeg', {
        error: error.message,
        command,
      });
      throw new Error(`Falha na conversão de áudio: ${error.message}`);
    }
  }
}
