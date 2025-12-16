import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session, SessionDocument } from '../entities/session.entity';
import { Message, MessageDocument } from '../entities/message.entity';
import { CoreRunDto } from '../../core/dto/core.dto';
import { Types } from 'mongoose';

@Injectable()
export class PersistenceService {
  private readonly logger = new Logger(PersistenceService.name);

  constructor(
    @InjectModel(Session.name)
    private sessionModel: Model<SessionDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
  ) {}

  /**
   * Cria ou atualiza uma sessão
   */
  async saveSession(
    sessionId: string,
    threadId: string,
    agentId: string,
    userId?: string,
    userInfo?: Record<string, any>,
    channel?: string,
  ): Promise<SessionDocument> {
    const sessionData: Partial<Session> = {
      sessionId,
      threadId,
      agentId,
      channel: channel || 'widget',
      lastActivityAt: new Date(),
    };

    if (userId) {
      sessionData.userId = userId;
    }

    if (userInfo) {
      sessionData.userInfo = userInfo;
    }

    const existingSession = await this.sessionModel.findOne({ sessionId });

    if (existingSession) {
      // Atualizar sessão existente
      existingSession.threadId = threadId;
      existingSession.agentId = agentId;
      existingSession.lastActivityAt = new Date();
      if (userId) {
        existingSession.userId = userId;
      }
      if (userInfo) {
        existingSession.userInfo = userInfo;
      }
      // Inicializar array de messages se não existir
      if (!existingSession.messages) {
        existingSession.messages = [];
      }
      return await existingSession.save();
    } else {
      // Criar nova sessão
      sessionData.startedAt = new Date();
      sessionData.messageCount = 0;
      sessionData.messages = [];
      sessionData.status = 'active';
      return await this.sessionModel.create(sessionData);
    }
  }

  /**
   * Adiciona um messageId ao array de messages da sessão
   */
  async addMessageToSession(
    sessionId: string,
    messageId: string,
  ): Promise<SessionDocument | null> {
    const session = await this.sessionModel.findOne({ sessionId });

    if (!session) {
      this.logger.warn(`Session not found: ${sessionId}`);
      return null;
    }

    // Inicializar array se não existir
    if (!session.messages) {
      session.messages = [];
    }

    // Adicionar messageId se ainda não estiver no array
    const messageIdString = messageId.toString();
    if (!session.messages.includes(messageIdString)) {
      session.messages.push(messageIdString);
      session.messageCount = session.messages.length;
    }

    return await session.save();
  }

  /**
   * Busca uma sessão por sessionId
   */
  async findSessionBySessionId(
    sessionId: string,
  ): Promise<SessionDocument | null> {
    return await this.sessionModel.findOne({ sessionId }).exec();
  }

  /**
   * Busca uma sessão por threadId
   */
  async findSessionByThreadId(
    threadId: string,
  ): Promise<SessionDocument | null> {
    return await this.sessionModel.findOne({ threadId }).exec();
  }

  /**
   * Atualiza o status de uma sessão
   */
  async updateSessionStatus(
    sessionId: string,
    status: 'active' | 'completed' | 'abandoned',
  ): Promise<SessionDocument | null> {
    return await this.sessionModel
      .findOneAndUpdate({ sessionId }, { status }, { new: true })
      .exec();
  }

  /**
   * Salva uma mensagem (input + output em um único documento)
   */
  async saveMessage(
    userId: string,
    sessionId: string,
    threadId: string,
    messageId: string,
    userMessages: Array<any>,
    assistantMessages: Array<any>,
    stepHistory?: Array<any>,
    toolInfo?: {
      toolName?: string;
      toolCallId?: string;
      payload?: any;
      response?: any;
      flowInstanceId?: string;
      status?: 'pending' | 'processing' | 'completed' | 'failed';
      ragInfo?: {
        topic?: string;
        query?: string;
        source?: string;
        relevanceScore?: number;
      };
    },
    thinking?: any,
    context?: Record<string, any>,
    metadata?: Record<string, any>,
    agentId?: string,
    agentName?: string,
    collaboratorAgentId?: string,
    collaboratorAgentName?: string,
    parentMessageId?: string,
    responseTime?: number,
  ): Promise<MessageDocument> {
    try {
      const messageData: Partial<Message> = {
        userId,
        sessionId,
        threadId,
        messageId,
        userMessages,
        assistantMessages,
        timestamp: new Date(),
      };

      if (stepHistory) {
        messageData.stepHistory = stepHistory;
      }

      if (toolInfo) {
        messageData.toolInfo = toolInfo;
      }

      if (thinking) {
        messageData.thinking = thinking;
      }

      if (context) {
        messageData.context = context;
      }

      if (metadata) {
        messageData.metadata = metadata;
      }

      if (agentId) {
        messageData.agentId = agentId;
      }

      if (agentName) {
        messageData.agentName = agentName;
      }

      if (collaboratorAgentId) {
        messageData.collaboratorAgentId = collaboratorAgentId;
      }

      if (collaboratorAgentName) {
        messageData.collaboratorAgentName = collaboratorAgentName;
      }

      if (parentMessageId) {
        messageData.parentMessageId = parentMessageId;
      }

      if (responseTime !== undefined) {
        messageData.responseTime = responseTime;
      }

      const savedMessage = await this.messageModel.create(messageData);

      // Adicionar messageId ao array de messages da sessão
      await this.addMessageToSession(sessionId, savedMessage._id.toString());

      this.logger.debug(
        `Message saved: ${savedMessage._id} for session ${sessionId} (userId ${userId})`,
      );
      return savedMessage;
    } catch (error) {
      this.logger.error('Error saving message:', error);
      throw error;
    }
  }

  /**
   * Busca mensagens por userId
   */
  async findMessagesByUserId(
    userId: string,
    limit?: number,
  ): Promise<MessageDocument[]> {
    const query = this.messageModel.find({ userId }).sort({ timestamp: -1 });

    if (limit) {
      query.limit(limit);
    }

    return await query.exec();
  }

  /**
   * Busca mensagens por sessionId
   */
  async findMessagesBySessionId(
    sessionId: string,
    limit?: number,
  ): Promise<MessageDocument[]> {
    const query = this.messageModel.find({ sessionId }).sort({ timestamp: 1 });

    if (limit) {
      query.limit(limit);
    }

    return await query.exec();
  }

  /**
   * Busca mensagens por threadId
   */
  async findMessagesByThreadId(
    threadId: string,
    limit?: number,
  ): Promise<MessageDocument[]> {
    const query = this.messageModel.find({ threadId }).sort({ timestamp: 1 });

    if (limit) {
      query.limit(limit);
    }

    return await query.exec();
  }

  /**
   * Estatísticas da conversa (para analytics)
   */
  async getConversationStats(
    userId?: string,
    sessionId?: string,
  ): Promise<{
    totalMessages: number;
    totalSessions: number;
    averageMessagesPerSession: number;
  }> {
    const query: any = {};
    if (userId) {
      query.userId = userId;
    }
    if (sessionId) {
      query.sessionId = sessionId;
    }

    const totalMessages = await this.messageModel.countDocuments(query).exec();
    const totalSessions = await this.sessionModel.countDocuments(query).exec();

    return {
      totalMessages,
      totalSessions,
      averageMessagesPerSession:
        totalSessions > 0 ? totalMessages / totalSessions : 0,
    };
  }
}
