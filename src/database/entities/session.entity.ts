import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SessionDocument = Session & Document;

@Schema({ timestamps: true })
export class Session {
  @Prop({ type: 'string', index: true })
  sessionId?: string;

  @Prop({ type: 'string', index: true })
  threadId?: string;

  @Prop({ type: 'string', index: true })
  userId?: string; // CPF criptografado do usuário

  @Prop({ type: 'string' })
  agentId?: string; // UUID do agent master no Watson Orchestrate

  @Prop({ type: 'string' })
  channel?: string;

  @Prop({ type: Object })
  userInfo?: Record<string, any>;

  @Prop({ type: Date, default: Date.now })
  startedAt?: Date;

  @Prop({ type: Date, default: Date.now })
  lastActivityAt?: Date;

  @Prop({ type: Number, default: 0 })
  messageCount?: number;

  @Prop({ type: [String], default: [] })
  messages?: string[]; // Array de IDs das mensagens linkadas a esta sessão

  @Prop({
    type: 'string',
    enum: ['active', 'completed', 'abandoned'],
    default: 'active',
  })
  status?: 'active' | 'completed' | 'abandoned';

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

// Índices compostos para performance
SessionSchema.index({ userId: 1, lastActivityAt: -1 });
SessionSchema.index({ sessionId: 1 });
SessionSchema.index({ threadId: 1 });
SessionSchema.index({ agentId: 1 });
