import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { stringify } from 'qs';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  async getToken(): Promise<string> {
    try {
      this.logger.log('🔑 Solicitando token da API SENAC...');

      const config = {
        method: 'post',
        url: 'https://appsenac.sp.senac.br/rest/wsapimob/authenticationEntity',
        headers: {
          'Content-type': 'application/json; charset=UTF-8',
          TokenWS:
            'gjF17O1DFM3PGAAy5vxGnOQb+xvrFjyYXyE34tUGMnAjJRtggS4c58YRmG47OulS/0===',
          RestAction: 'getAuth',
        },
      };

      const response = await axios(config);

      if (response.data.CODE === 200 || response.data.CODE === '200') {
        this.logger.log('✅ Token obtido com sucesso');
        return response.data.GENERATIONTOKEN;
      } else {
        this.logger.error('❌ Erro ao obter token:', response.data);
        throw new Error('Erro ao gerar token');
      }
    } catch (error) {
      this.logger.error('❌ Erro na requisição de token:', error.message);
      throw new Error('Erro ao gerar token');
    }
  }

  async authenticateUser(
    username: string,
    password: string,
    token: string,
  ): Promise<any> {
    try {
      this.logger.log(`🔐 Autenticando usuário: ${username}`);
      this.logger.log(`🔑 Token recebido: ${token.substring(0, 20)}...`);

      const config = {
        method: 'post',
        url: 'https://appsenac.sp.senac.br/rest/wsapimob/autenticarapp',
        headers: {
          'Content-type': 'application/json; charset=UTF-8',
          Authorization: token,
          RestAction: 'getAccessFuncionario',
        },
        data: {
          setEmail: username,
          setSenha: password,
          setSistema: 'WEB',
          setUdid: '',
          setAmbiente: 'PROD',
        },
      };

      const response = await axios(config);

      // Log da resposta para debug
      this.logger.log(
        '📋 Resposta da API SENAC:',
        JSON.stringify(response.data, null, 2),
      );

      if (
        response.data.AUTHVALIDORESULT &&
        response.data.AUTHVALIDORESULT.length > 0
      ) {
        const userData = {
          emplid: response.data.AUTH[0].LRH.EMPLID,
          chapa: response.data.AUTH[0].LRH.DADOSDETALHE.WSDADOS.chapa,
          nome:
            response.data.AUTH[0].LRH.DADOSDETALHE.WSDADOS.nome ||
            username.toUpperCase(),
          email: username,
          unidade:
            response.data.AUTH[0].LRH.DADOSDETALHE.WSDADOS.unidade || 'GTI',
        };

        this.logger.log(`✅ Usuário autenticado: ${userData.nome}`);
        return userData;
      } else {
        this.logger.warn(`❌ Autenticação falhou para: ${username}`);
        throw new Error('Credenciais inválidas');
      }
    } catch (error) {
      this.logger.error(
        `❌ Erro na autenticação de ${username}:`,
        error.message,
      );
      throw new Error('Erro na autenticação');
    }
  }

  async decryptCredentials(
    encrypted: string,
    iv: string,
  ): Promise<{ username: string; password: string } | null> {
    try {
      this.logger.log('🔓 Descriptografando credenciais...');

      // Para compatibilidade com o fallback do frontend
      if (iv === 'fallback') {
        const decoded = atob(encrypted);
        const credentials = JSON.parse(decoded);
        this.logger.log('✅ Credenciais descriptografadas (fallback)');
        return credentials;
      }

      // Para o método simples
      if (iv === 'simple') {
        try {
          // Reverter o processo de criptografia simples
          const step3Decoded = atob(encrypted);
          const [step2, timestamp] = step3Decoded.split('_');
          const step1 = step2.split('').reverse().join('');
          const data = atob(step1);
          const credentials = JSON.parse(data);

          // Verificar se não é muito antigo (5 minutos)
          const now = Date.now();
          if (now - credentials.timestamp > 300000) {
            this.logger.warn('❌ Credenciais muito antigas');
            return null;
          }

          this.logger.log('✅ Credenciais descriptografadas (método simples)');
          return {
            username: credentials.username,
            password: credentials.password,
          };
        } catch (error) {
          this.logger.error(
            '❌ Erro na descriptografia simples:',
            error.message,
          );
          return null;
        }
      }

      // Fallback para método básico
      const decoded = atob(encrypted);
      const credentials = JSON.parse(decoded);
      this.logger.log('✅ Credenciais descriptografadas (básico)');
      return credentials;
    } catch (error) {
      this.logger.error('❌ Erro na descriptografia:', error.message);
      return null;
    }
  }

  /**
   * Valida token do Keycloak via introspecção
   */
  async validateKeycloakToken(token: string): Promise<{
    valid: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      const cleanToken = token.replace('Bearer ', '');

      const url = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token/introspect`;

      this.logger.log('🔍 Validando token com Keycloak...');

      const response = await axios.post(
        url,
        stringify({
          token: cleanToken,
          client_id: process.env.KEYCLOAK_CLIENT_ID,
          client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      this.logger.log(
        `✅ Token validado: ${response.data.active ? 'ATIVO' : 'INATIVO'}`,
      );

      return {
        valid: response.data.active,
        data: response.data,
      };
    } catch (error) {
      this.logger.error(
        '❌ Erro na validação do token Keycloak:',
        error.message,
      );
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  /**
   * Extrai dados do usuário do token do Keycloak
   */
  extractKeycloakUserData(tokenData: any): any {
    return {
      email: tokenData.email,
      username: tokenData.preferred_username,
      sub: tokenData.sub,
      name: tokenData.name,
      given_name: tokenData.given_name,
      family_name: tokenData.family_name,
      email_verified: tokenData.email_verified,
      realm_access: tokenData.realm_access,
      resource_access: tokenData.resource_access,
    };
  }

  /**
   * Identifica funcionário por CHAPA via senac-orchestrate
   * Retorna dados do funcionário e acesso a relatórios financeiros
   */
  async identifyEmployee(chapa: string): Promise<{
    success: boolean;
    data?: any;
    acessoRelatorios?: any;
    error?: string;
  }> {
    try {
      const orchestrateUrl =
        process.env.SENAC_ORCHESTRATE_URL || 'http://localhost:3001';

      this.logger.log(`🔐 Identificando funcionário por CHAPA: ${chapa}`);

      const response = await axios.post(
        `${orchestrateUrl}/tools/identify-employee`,
        { chapa },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );

      if (response.data.status === 200 && response.data.data?.DADOS) {
        this.logger.log(`✅ Funcionário identificado com sucesso`);
        return {
          success: true,
          data: response.data.data,
          acessoRelatorios: response.data.acessoRelatorios,
        };
      } else {
        this.logger.warn(`⚠️ Funcionário não encontrado ou erro na API`);
        return {
          success: false,
          error: response.data.error || 'Funcionário não encontrado',
        };
      }
    } catch (error) {
      this.logger.error(`❌ Erro ao identificar funcionário: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Identifica aluno por EMPLID via senac-orchestrate
   * Retorna dados do aluno e matrículas
   */
  async identifyStudent(emplid: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      const orchestrateUrl =
        process.env.SENAC_ORCHESTRATE_URL || 'http://localhost:3001';

      this.logger.log(`🎓 Identificando aluno por EMPLID: ${emplid}`);

      const response = await axios.post(
        `${orchestrateUrl}/tools/identify-student`,
        { emplid },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );

      if (response.data.status === 200) {
        this.logger.log(`✅ Aluno identificado com sucesso`);
        return {
          success: true,
          data: response.data,
        };
      } else {
        this.logger.warn(`⚠️ Aluno não encontrado ou erro na API`);
        return {
          success: false,
          error: response.data.error || 'Aluno não encontrado',
        };
      }
    } catch (error) {
      this.logger.error(`❌ Erro ao identificar aluno: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
