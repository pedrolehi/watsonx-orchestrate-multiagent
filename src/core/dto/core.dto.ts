import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

class MessageDto {
  @IsString()
  type: string;

  @IsString()
  text: string;

  @IsString()
  @IsOptional()
  mediaUrl?: string;

  @IsString()
  @IsOptional()
  mimeType?: string;
}

export class CoreRunDto {
  @IsObject()
  @ValidateNested()
  @Type(() => MessageDto)
  message: MessageDto;

  @IsString()
  conversationId: string;

  @IsString()
  profileName: string;

  @IsObject()
  @IsOptional()
  context?: any; // Simplificado para evitar dependência de UserDataDto legado

  @IsString()
  channel: string;

  @IsString()
  @IsOptional()
  agentId?: string; // Agent ID na raiz do payload (vem do widget como assistantId)
}

export class CoreRunResponseDto {
  response: any;
  context: any; // Simplificado
  settings: Record<string, any>;
}
