import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import axios from 'axios';
import { Response } from 'express';
import { stringify } from 'qs';
import { AuthService } from './auth.service';

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Get('login/keycloak')
  async keycloakLogin(@Res() res: Response) {
    this.logger.log('🔐 Rota /login/keycloak chamada');

    const redirectUrl =
      `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth?` +
      `client_id=${process.env.KEYCLOAK_CLIENT_ID}` +
      `&response_type=code` +
      `&scope=openid email` +
      `&redirect_uri=${encodeURIComponent(process.env.KEYCLOAK_REDIRECT_URI || '')}`;

    this.logger.log(`🔐 Redirecionando para: ${redirectUrl}`);
    return res.redirect(redirectUrl);
  }

  @Get('login/callback')
  async authCallback(@Query('code') code: string, @Res() res: Response) {
    this.logger.log('🔍 Rota /login/callback chamada');

    if (!code) {
      this.logger.error('❌ Código ausente na callback');
      return res.status(400).send('Código ausente');
    }

    try {
      this.logger.log('🔄 Trocando código pelo access_token...');

      // Troca o código pelo access_token
      const tokenRes = await axios.post(
        `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
        stringify({
          grant_type: 'authorization_code',
          code,
          client_id: process.env.KEYCLOAK_CLIENT_ID,
          client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
          redirect_uri: process.env.KEYCLOAK_REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      const accessToken = tokenRes.data.access_token;
      this.logger.log('✅ Access token obtido com sucesso');

      // Introspecção do token
      this.logger.log('🔍 Validando token com introspecção...');
      const validation =
        await this.authService.validateKeycloakToken(accessToken);

      if (!validation.valid) {
        this.logger.error('❌ Token inválido ou expirado');
        return res.status(401).send('Token inválido ou expirado');
      }

      const tokenInfo = validation.data;

      // Extrai dados do usuário
      const keycloakData = this.authService.extractKeycloakUserData(tokenInfo);
      this.logger.log(
        `✅ Usuário Keycloak: ${keycloakData.username} (${keycloakData.email})`,
      );

      // Redireciona para o frontend com o token
      const redirectUrl = `${process.env.FRONT_REDIRECT_URL}?token=${accessToken}`;
      this.logger.log(`🔀 Redirecionando para: ${redirectUrl}`);

      return res.redirect(redirectUrl);
    } catch (error) {
      this.logger.error(
        '❌ Erro ao autenticar com Keycloak:',
        error.response?.data || error.message,
      );
      return res.status(500).send('Erro no login com Keycloak');
    }
  }

  @Get('users/validate-token')
  async validateToken(@Headers('authorization') authorization: string) {
    try {
      this.logger.log('🔍 Rota /users/validate-token chamada');

      if (!authorization) {
        this.logger.error('❌ Token não fornecido');
        return {
          success: false,
          message: 'Token não fornecido',
        };
      }

      // Valida o token com Keycloak
      const validation =
        await this.authService.validateKeycloakToken(authorization);

      if (!validation.valid) {
        this.logger.error('❌ Token inválido');
        return {
          success: false,
          message: 'Token inválido ou expirado',
        };
      }

      // Extrai dados do usuário
      const keycloakData = this.authService.extractKeycloakUserData(
        validation.data,
      );

      // Aplica fallback de email se necessário
      let searchEmail = keycloakData.email;
      if (
        (!keycloakData.email || keycloakData.email.endsWith('@localhost')) &&
        keycloakData.username
      ) {
        const fallbackDomain =
          process.env.FALLBACK_EMAIL_DOMAIN || 'sp.senac.br';
        searchEmail = `${keycloakData.username}@${fallbackDomain}`;
      }

      this.logger.log(
        `✅ Token validado com sucesso para: ${keycloakData.username}`,
      );

      return {
        success: true,
        user: {
          username: keycloakData.username,
          email: searchEmail,
          name: keycloakData.name,
          given_name: keycloakData.given_name,
          family_name: keycloakData.family_name,
          chapa: validation.data.chapa || '9999999',
          emplid: validation.data.emplid || '0000000',
          unidade: validation.data.unidade || 'GTI',
          permissions: keycloakData.realm_access?.roles || [],
        },
      };
    } catch (error) {
      this.logger.error('❌ Erro ao validar token:', error.message);
      return {
        success: false,
        message: 'Erro ao validar token',
      };
    }
  }

  @Get('login/token')
  async getToken() {
    try {
      this.logger.log('🔑 Rota /login/token chamada');
      const token = await this.authService.getToken();
      return { token: `Bearer ${token}` };
    } catch (error) {
      this.logger.error('❌ Erro ao obter token:', error.message);
      throw error;
    }
  }

  @Post('login/loguser')
  async authenticateUser(
    @Body() body: { username: string; password: string; token: string },
  ) {
    try {
      this.logger.log(`🔐 Rota /login/loguser chamada para: ${body.username}`);

      const { username, password, token } = body;

      if (!username || !password || !token) {
        this.logger.warn('❌ Dados incompletos na requisição');
        throw new Error('Dados de autenticação incompletos');
      }

      // Remover "Bearer " do token se presente
      const cleanToken = token.replace('Bearer ', '');

      const userData = await this.authService.authenticateUser(
        username,
        password,
        cleanToken,
      );

      this.logger.log(`✅ Login bem-sucedido para: ${userData.nome}`);
      return userData;
    } catch (error) {
      this.logger.error('❌ Erro no login:', error.message);
      throw error;
    }
  }

  @Post('login/loguser-secure')
  async authenticateUserSecure(
    @Body()
    body: {
      encrypted: string;
      iv: string;
      timestamp: number;
      token: string;
    },
  ) {
    try {
      this.logger.log(
        '🔐 Rota /login/loguser-secure chamada (credenciais criptografadas)',
      );

      const { encrypted, iv, timestamp, token } = body;

      if (!encrypted || !iv || !timestamp || !token) {
        this.logger.warn('❌ Dados criptografados incompletos na requisição');
        throw new Error('Dados de autenticação criptografados incompletos');
      }

      // Verificar se a requisição não é muito antiga (5 minutos)
      const now = Date.now();
      if (now - timestamp > 300000) {
        this.logger.warn('❌ Requisição muito antiga');
        throw new Error('Requisição expirada');
      }

      // Remover "Bearer " do token se presente
      const cleanToken = token.replace('Bearer ', '');

      // Descriptografar credenciais
      const credentials = await this.authService.decryptCredentials(
        encrypted,
        iv,
      );

      if (!credentials || !credentials.username || !credentials.password) {
        this.logger.warn('❌ Falha na descriptografia das credenciais');
        throw new Error('Falha na descriptografia das credenciais');
      }

      const userData = await this.authService.authenticateUser(
        credentials.username,
        credentials.password,
        cleanToken,
      );

      this.logger.log(`✅ Login seguro bem-sucedido para: ${userData.nome}`);
      return userData;
    } catch (error) {
      this.logger.error('❌ Erro no login seguro:', error.message);
      throw error;
    }
  }
}
