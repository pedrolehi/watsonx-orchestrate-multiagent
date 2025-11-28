import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class WidgetButtonDto {
  @ApiProperty({
    description: 'Label/texto do botão',
    example: 'Opção 1',
    required: true,
  })
  @IsString()
  label: string;

  @ApiProperty({
    description: 'Valor do botão',
    example: 'option1',
    required: true,
  })
  @IsString()
  value: string;
}

export class WidgetMessageDto {
  @ApiProperty({
    description: 'Remetente da mensagem',
    example: 'ai',
    required: true,
  })
  @IsString()
  sender: string;

  @ApiProperty({
    description: 'Conteúdo da mensagem/texto',
    example: 'Olá! Como posso ajudar?',
    required: false,
  })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiProperty({
    description: 'ID único da mensagem',
    example: 'msg_123456',
    required: true,
  })
  @IsString()
  messageId: string;

  @ApiProperty({
    description: 'Timestamp da mensagem',
    example: '2025-01-08T10:30:00.000Z',
    required: true,
  })
  @IsString()
  timestamp: string;

  @ApiProperty({
    description: 'URL do avatar',
    example: 'https://example.com/avatar.jpg',
    required: false,
  })
  @IsOptional()
  @IsString()
  avatar?: string;

  @ApiProperty({
    description: 'Tipo de componente (select, autocomplete, etc)',
    example: 'select',
    required: false,
  })
  @IsOptional()
  @IsString()
  component?: string;

  @ApiProperty({
    description: 'Nome/ID do componente (usado para file_upload)',
    example: 'upload_fd1a25ca-0e4c-4418-ba71-d60cdf316263',
    required: false,
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'Título para componentes',
    example: 'Selecione uma opção',
    required: false,
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({
    description:
      'Opções para select/autocomplete ou configurações de datepicker',
    required: false,
  })
  @IsOptional()
  options?: WidgetButtonDto[] | any;

  @ApiProperty({
    description: 'Botões para interação',
    type: [WidgetButtonDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  buttons?: WidgetButtonDto[];

  @ApiProperty({
    description: 'URL ou código de arquivo para download',
    example: 'data:application/pdf;base64,JVBERi0xLjQ...',
    required: false,
  })
  @IsOptional()
  @IsString()
  downloadUrl?: string;

  @ApiProperty({
    description: 'Nome do arquivo para download',
    example: 'certificado_curso_EJS.pdf',
    required: false,
  })
  @IsOptional()
  @IsString()
  filename?: string;
}

export class WidgetContextDto {
  @ApiProperty({
    description: 'Flag para multiselect',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  multiselect?: boolean;

  @ApiProperty({
    description: 'Flag para múltiplos cursos',
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  multipleCourses?: boolean;

  @ApiProperty({
    description: 'Flag para múltiplos certificados',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  multipleCertificates?: boolean;

  @ApiProperty({
    description: 'OPÇÕES da lista de cursos',
    type: [WidgetButtonDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  resultListaCursosOptions?: WidgetButtonDto[];

  @ApiProperty({
    description: 'OPÇÕES da lista de certificados',
    type: [WidgetButtonDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  resultCertificadosOptions?: WidgetButtonDto[];

  // As opções de declaração agora são unificadas com lista de cursos
  // resultDeclaracaoMatriculaOptions DEPRECATED - usar resultListaCursosOptions

  @ApiProperty({
    description: 'Status do resultado de cursos',
    example: 200,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  'resultListaCursos.status'?: number;

  @ApiProperty({
    description: 'Status do resultado de certificados',
    example: 200,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  'resultCertificados.status'?: number;

  @ApiProperty({
    description: 'Status do resultado de declaração de matrícula',
    example: 200,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  'resultDeclaracaoMatricula.status'?: number;

  @ApiProperty({
    description: 'EmplID do usuário',
    example: '1143036957',
    required: false,
  })
  @IsOptional()
  @IsString()
  emplid?: string;

  @ApiProperty({
    description: 'Chapa do usuário',
    example: '1142626810',
    required: false,
  })
  @IsOptional()
  @IsString()
  chapa?: string;

  @ApiProperty({
    description: 'Unidade do usuário',
    example: 'GTI',
    required: false,
  })
  @IsOptional()
  @IsString()
  unidade?: string;

  // Propriedades dinâmicas do contexto
  [key: string]: any;
}

export class WidgetSettingsDto {
  // Propriedades dinâmicas das configurações
  [key: string]: any;
}

export class WidgetDebugDto {
  @ApiProperty({
    description: 'Nós visitados pelo Watson Assistant',
    type: [Object],
    required: false,
  })
  @IsOptional()
  @IsArray()
  nodesVisited?: any[];

  @ApiProperty({
    description: 'Erros do Watson Assistant',
    type: [Object],
    required: false,
  })
  @IsOptional()
  @IsArray()
  errors?: any[];

  @ApiProperty({
    description: 'Logs de mensagens do Watson',
    type: [Object],
    required: false,
  })
  @IsOptional()
  @IsArray()
  logMessages?: any[];

  @ApiProperty({
    description: 'Informações adicionais de debug',
    required: false,
  })
  @IsOptional()
  @IsObject()
  additionalInfo?: any;
}

export class WidgetConversationResponseDto {
  @ApiProperty({
    description: 'Indica se a requisição foi bem-sucedida',
    example: true,
    required: true,
  })
  @IsBoolean()
  success: boolean;

  @ApiProperty({
    description: 'Lista de mensagens padronizadas para o widget',
    type: [WidgetMessageDto],
    required: true,
  })
  @IsArray()
  messages: WidgetMessageDto[];

  @ApiProperty({
    description: 'Configurações adicionais',
    type: WidgetSettingsDto,
    required: false,
  })
  @IsOptional()
  @IsObject()
  settings?: WidgetSettingsDto;

  @ApiProperty({
    description: 'Contexto unificado com variáveis para debug',
    type: WidgetContextDto,
    required: false,
  })
  @IsOptional()
  @IsObject()
  context?: WidgetContextDto;

  @ApiProperty({
    description: 'Arquivos associados à conversação',
    type: [Object],
    required: false,
  })
  @IsOptional()
  @IsArray()
  files?: any[];

  @ApiProperty({
    description: 'Informações de debug do Watson Assistant',
    type: WidgetDebugDto,
    required: false,
  })
  @IsOptional()
  @IsObject()
  debug?: WidgetDebugDto;
}
