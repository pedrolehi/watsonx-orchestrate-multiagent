import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WidgetAuthDto {
  @ApiProperty({
    description: 'Chave de API para autenticação do widget',
    example: 'abc123def456ghi789',
    required: true
  })
  @IsString({ message: 'A API key deve ser uma string' })
  @IsNotEmpty({ message: 'A API key é obrigatória' })
  'api-key': string;
}
