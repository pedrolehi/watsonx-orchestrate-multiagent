import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';

export class SpeechToTextDto {
  @ApiProperty({
    description: 'Tipo MIME do áudio',
    example: 'audio/wav',
    required: false,
    enum: ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/ogg;codecs=opus'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['audio/wav', 'audio/flac', 'audio/ogg', 'audio/ogg;codecs=opus'])
  contentType?: string;
}
