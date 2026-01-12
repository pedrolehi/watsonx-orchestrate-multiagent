import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MessageDocument = Message & Document;

@Schema({ timestamps: true })
export class Message {
  @Prop({ required: true, index: true })
  userId: string; // CPF criptografado do usuário

  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ required: true, index: true })
  threadId: string;

  @Prop({ required: true })
  messageId: string;

  @Prop({ type: 'string' })
  parentMessageId?: string;

  @Prop({ type: 'string', index: true })
  agentId?: string; // UUID do agent master no Watson Orchestrate

  @Prop({ type: 'string' })
  agentName?: string; // Nome do agent master

  @Prop({ type: 'string' })
  collaboratorAgentId?: string; // UUID do assistente colaborador acionado

  @Prop({ type: 'string', index: true })
  collaboratorAgentName?: string; // Nome/gerência do assistente colaborador (ex: 'GEP', 'GTAE', 'GCR', 'SUPORTE')

  @Prop({ type: Array, required: true })
  userMessages: Array<any>; // Array de mensagens do usuário como vêm da thread

  @Prop({ type: Array, required: true })
  assistantMessages: Array<any>; // Array de mensagens do assistente como vêm da thread

  @Prop({ type: Array, default: [] })
  stepHistory?: Array<any>;

  @Prop({ type: Object })
  toolInfo?: {
    toolName?: string;
    toolCallId?: string;
    payload?: any;
    response?: any;
    result?: string; // String do resultado da tool
    flowInstanceId?: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed';
    ragInfo?: {
      topic?: string;
      query?: string;
      source?: string;
      relevanceScore?: number;
    };
  };

  @Prop({ type: Object })
  thinking?: any;

  @Prop({ type: Object })
  context?: Record<string, any>;

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  @Prop({ type: Date, default: Date.now, index: true })
  timestamp?: Date;

  @Prop({ type: Number })
  responseTime?: number; // Tempo de resposta em ms

  @Prop({ type: String, enum: ['positive', 'negative', null], default: null })
  userFeedback?: 'positive' | 'negative' | null; // Feedback do usuário (polegar)

  @Prop({ type: Date })
  feedbackTimestamp?: Date; // Quando o feedback foi dado
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Índices compostos para performance
MessageSchema.index({ userId: 1, timestamp: -1 });
MessageSchema.index({ sessionId: 1, timestamp: -1 });
MessageSchema.index({ threadId: 1, timestamp: -1 });
MessageSchema.index({ agentId: 1, timestamp: -1 });
MessageSchema.index({ collaboratorAgentName: 1, timestamp: -1 });
MessageSchema.index({ 'toolInfo.toolName': 1, timestamp: -1 });
MessageSchema.index({ collaboratorAgentName: 1, 'toolInfo.toolName': 1 });
