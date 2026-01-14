import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';

/**
 * Serviço para envio de e-mails de alerta
 * Baseado em: senac-assistants-api/src/modules/utils/sendEmailToStakeholders.js
 *
 * Variáveis de Ambiente Necessárias (.env):
 * - ENVIO_EMAIL_URL: URL da API de envio de e-mails (ex: https://api.email.senac.br/send)
 * - ENVIO_EMAIL_TOKEN: Token de autenticação para a API de e-mails
 *
 * Se essas variáveis não estiverem configuradas, o serviço apenas logará um warning
 * e não enviará e-mails, sem bloquear o fluxo normal da aplicação.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly stakeholderEmails = [
    'erico.msousa@sp.senac.br',
    'priscila.jlrodolpho@sp.senac.br',
    'flavio.cmachado@sp.senac.br',
    'pedro.lrmuniz@sp.senac.br',
  ];

  constructor(private configService: ConfigService) {}

  /**
   * Dispara alerta de feedback negativo para stakeholders
   * Fire and forget: não bloqueia a resposta HTTP
   */
  async sendNegativeFeedbackAlert(alertData: {
    messageId: string;
    sessionId: string;
    aiResponse: string;
    feedbackReason: string;
    feedbackComment?: string;
  }): Promise<void> {
    const apiUrl = this.configService.get<string>('ENVIO_EMAIL_URL');
    const token = this.configService.get<string>('ENVIO_EMAIL_TOKEN');

    this.logger.log('Verificando configurações de e-mail:', {
      hasApiUrl: !!apiUrl,
      hasToken: !!token,
      apiUrl: apiUrl ? `${apiUrl.substring(0, 30)}...` : 'não configurado',
    });

    if (!apiUrl || !token) {
      this.logger.warn(
        'Configuração de e-mail não encontrada (ENVIO_EMAIL_URL ou ENVIO_EMAIL_TOKEN)',
      );
      return;
    }

    // Montar corpo do e-mail
    const emailBody = this.buildEmailBody(alertData);

    // Enviar para cada stakeholder
    for (const email of this.stakeholderEmails) {
      try {
        await this.sendEmail(apiUrl, token, email, emailBody);
        this.logger.log(`Alerta de feedback negativo enviado para: ${email}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Erro desconhecido';
        this.logger.error(
          `Falha ao enviar alerta para ${email}: ${errorMessage}`,
        );
        // Não propaga o erro - fire and forget
      }
    }
  }

  /**
   * Envia um único e-mail
   */
  private async sendEmail(
    apiUrl: string,
    token: string,
    destinatario: string,
    mensagem: string,
  ): Promise<void> {
    const payload = {
      method: 'POST',
      url: apiUrl,
      headers: {
        token,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      data: {
        assunto: 'Feedback Negativo - Assistente Virtual',
        mensagem: `<assistentevirtual@sp.senac.br> ${mensagem}`,
        remetente: 'assistentevirtual@sp.senac.br',
        destinatario,
      },
    };

    this.logger.debug('Enviando e-mail com payload:', {
      url: apiUrl,
      destinatario,
      hasToken: !!token,
      tokenLength: token?.length,
    });

    try {
      const response = await axios(payload);
      this.logger.debug('Resposta da API de e-mail:', {
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error: unknown) {
      const axiosError = error as {
        response?: { status?: number; statusText?: string; data?: unknown };
        message?: string;
      };
      this.logger.error('Erro detalhado ao enviar e-mail:', {
        destinatario,
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        errorData: axiosError.response?.data,
        message: axiosError.message || 'Erro desconhecido',
      });
      throw error;
    }
  }

  /**
   * Monta o corpo do e-mail HTML (simplificado para compatibilidade com ColdFusion)
   */
  private buildEmailBody(alertData: {
    messageId: string;
    sessionId: string;
    aiResponse: string;
    feedbackReason: string;
    feedbackComment?: string;
  }): string {
    const {
      messageId,
      sessionId,
      aiResponse,
      feedbackReason,
      feedbackComment,
    } = alertData;

    // HTML simplificado para compatibilidade com ColdFusion
    let body = '<strong>FEEDBACK NEGATIVO RECEBIDO</strong><br><br>';

    body += '<strong>Identificadores:</strong><br>';
    body += `ID da Mensagem: ${messageId}<br>`;
    body += `ID da Sessão: ${sessionId}<br><br>`;

    body += '<strong>Motivo do Feedback Negativo:</strong><br>';
    body += `${feedbackReason}<br>`;

    if (feedbackComment) {
      body += `<em>Comentário adicional: "${this.escapeHtml(feedbackComment)}"</em><br>`;
    }
    body += '<br>';

    body += '<strong>Resposta da IA que recebeu o dislike:</strong><br>';
    body += `${this.escapeHtml(aiResponse)}<br><br>`;

    body += '<hr>';
    body +=
      '<small>Este é um alerta automático do sistema de feedback do Assistente Virtual Senac.</small>';

    return body;
  }

  /**
   * Escapa caracteres HTML para prevenir XSS
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
