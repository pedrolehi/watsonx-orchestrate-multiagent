import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class WidgetConversationDto {
  @ApiProperty({
    description: 'Quem está enviando a mensagem',
    example: 'user',
    required: true,
  })
  @IsString({ message: 'O sender deve ser uma string' })
  sender: string;

  @ApiProperty({
    description: 'Texto da mensagem',
    example: 'Olá, como você está?',
    required: true,
  })
  @IsString({ message: 'O texto deve ser uma string' })
  text: string;

  @ApiProperty({
    description: 'URL do avatar do usuário',
    example: 'https://example.com/avatar.jpg',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'O avatar deve ser uma string' })
  avatar?: string;

  @ApiProperty({
    description: 'Timestamp da mensagem',
    example: '2025-07-07T10:30:00.000Z',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'O timestamp deve ser uma string' })
  timestamp?: string;

  @ApiProperty({
    description: 'ID da sessão/conversa',
    example: 'session_123456',
    required: true,
  })
  @IsString({ message: 'O sessionId deve ser uma string' })
  sessionId: string;

  @ApiProperty({
    description: 'ID do assistente',
    example: 'assistant_watson_123',
    required: true,
  })
  @IsString({ message: 'O assistantId deve ser uma string' })
  assistantId: string;

  @ApiProperty({
    description: 'Dados do usuário',
    example: '{"chapa":"12345","emplid":"67890","unidade":"GTI"}',
    required: true,
  })
  @IsObject()
  user: any; // Simplificado para any pois UserDataDto foi removido
}
