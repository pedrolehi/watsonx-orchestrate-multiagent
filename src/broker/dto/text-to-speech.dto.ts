import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength } from 'class-validator';

export class TextToSpeechDto {
  @ApiProperty({
    description: 'Texto a ser sintetizado em áudio',
    example: 'Olá! Como posso ajudar?',
    required: true,
  })
  @IsString()
  @MinLength(1)
  text: string;

  @ApiProperty({
    description: 'Voz a ser usada (opcional, usa padrão se não fornecido)',
    example: 'pt-BR_IsabelaV3Voice',
    required: false,
  })
  @IsOptional()
  @IsString()
  voice?: string;
}
