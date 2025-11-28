import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { stringify } from 'qs';
import { encryptValue } from '../helpers/crypto.helper';

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
   * Identifica funcionário por CHAPA diretamente na API do Senac
   * Retorna dados do funcionário (criptografados) e acesso a relatórios
   */
  async identifyEmployee(chapa: string): Promise<{
    success: boolean;
    data?: any;
    acessoRelatorios?: {
      status: number;
      acessoTotal: boolean;
      codPessoa?: number;
      error?: string;
    };
    error?: string;
  }> {
    const apiUrl = process.env.AUTENTICA_USUARIO_URL;
    const token = process.env.AUTENTICA_USUARIO_TOKEN;

    if (!apiUrl || !token) {
      this.logger.error(
        'AUTENTICA_USUARIO_URL e AUTENTICA_USUARIO_TOKEN são necessários',
      );
      return {
        success: false,
        error: 'Configuração de autenticação incompleta',
      };
    }

    try {
      this.logger.log(`🔐 Identificando funcionário por CHAPA: ${chapa}`);

      const response = await axios({
        method: 'GET',
        url: apiUrl,
        headers: {
          token: token,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ chapa: chapa || '' }),
        timeout: 30000,
      });

      this.logger.debug(
        'Resposta da API AUTENTICA_USUARIO (antes de criptografar)',
      );

      // Criptografar dados sensíveis
      if (response.data && response.data.DADOS) {
        response.data.DADOS.CPF = await encryptValue(response.data.DADOS.CPF);
        response.data.DADOS.EMAIL = await encryptValue(
          response.data.DADOS.EMAIL,
        );
        response.data.DADOS.NOME = await encryptValue(response.data.DADOS.NOME);
        if (
          response.data.DADOS.NOME_SOCIAL &&
          response.data.DADOS.NOME_SOCIAL !== ''
        ) {
          response.data.DADOS.NOME_SOCIAL = await encryptValue(
            response.data.DADOS.NOME_SOCIAL,
          );
        }
      }

      if (response.data?.CODIGO === '200' || response.data?.CODIGO === 200) {
        this.logger.log(`✅ Funcionário identificado com sucesso`);

        // Verificar acesso a relatórios financeiros em paralelo
        let acessoRelatorios: any = null;
        try {
          acessoRelatorios = await this.checkFinancialReportsAccess(chapa);
          this.logger.log(
            `📊 Acesso a relatórios: ${acessoRelatorios.acessoTotal ? 'SIM' : 'NÃO'}`,
          );
        } catch (err) {
          this.logger.warn(
            'Erro ao verificar acesso a relatórios',
            err.message,
          );
        }

        return {
          success: true,
          data: response.data,
          acessoRelatorios,
        };
      } else {
        this.logger.warn(`⚠️ Funcionário não encontrado ou erro na API`);
        return {
          success: false,
          error: response.data?.MENSAGEM || 'Funcionário não encontrado',
        };
      }
    } catch (error) {
      this.logger.error(`❌ Erro ao identificar funcionário: ${error.message}`);

      if (error.response?.status === 501) {
        return {
          success: false,
          error: error.response.data?.MENSAGEM || 'Token inválido',
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Identifica aluno por EMPLID diretamente na API do Senac
   * Retorna dados do aluno (criptografados)
   */
  async identifyStudent(emplid: string): Promise<{
    success: boolean;
    data?: any;
    alunoMaiorDeIdade?: boolean;
    error?: string;
  }> {
    const apiUrl = process.env.IDENTIFICA_ALUNO_URL;
    const token = process.env.IDENTIFICA_ALUNO_TOKEN;

    if (!apiUrl || !token) {
      this.logger.error(
        'IDENTIFICA_ALUNO_URL e IDENTIFICA_ALUNO_TOKEN são necessários',
      );
      return {
        success: false,
        error: 'Configuração de autenticação incompleta',
      };
    }

    try {
      this.logger.log(`🎓 Identificando aluno por EMPLID: ${emplid}`);

      const response = await axios({
        method: 'GET',
        url: apiUrl,
        headers: {
          TOKEN: token,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ emplid: emplid || '' }),
        timeout: 30000,
      });

      this.logger.debug(
        'Resposta da API IDENTIFICA_ALUNO (antes de criptografar)',
      );

      // Calcular se é maior de idade
      const birthDate = response.data?.DADOS?.DATANASCIMENTO;
      const alunoMaiorDeIdade = this.calculateIsAdult(birthDate);

      // Criptografar dados sensíveis
      if (response.data && response.data.DADOS) {
        if (response.data.DADOS.CONTRATO) {
          response.data.DADOS.CONTRATO = await encryptValue(
            response.data.DADOS.CONTRATO,
          );
        }
        response.data.DADOS.CPF = await encryptValue(response.data.DADOS.CPF);
        response.data.DADOS.DATANASCIMENTO = await encryptValue(
          response.data.DADOS.DATANASCIMENTO,
        );
        response.data.DADOS.EMAIL = await encryptValue(
          response.data.DADOS.EMAIL,
        );
        response.data.DADOS.NOME = await encryptValue(response.data.DADOS.NOME);
      }

      if (response.data?.CODIGO === '200' || response.data?.CODIGO === 200) {
        this.logger.log(`✅ Aluno identificado com sucesso`);
        return {
          success: true,
          data: response.data,
          alunoMaiorDeIdade,
        };
      } else {
        this.logger.warn(`⚠️ Aluno não encontrado ou erro na API`);
        return {
          success: false,
          error: response.data?.MENSAGEM || 'Aluno não encontrado',
        };
      }
    } catch (error) {
      this.logger.error(`❌ Erro ao identificar aluno: ${error.message}`);

      if (error.response?.status === 501) {
        return {
          success: false,
          error: error.response.data?.MENSAGEM || 'Token inválido',
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Calcula se o aluno é maior de idade baseado na data de nascimento
   */
  private calculateIsAdult(birthDate?: string): boolean {
    if (!birthDate) {
      return false;
    }

    try {
      const birth = new Date(birthDate);
      const today = new Date();
      const age = today.getFullYear() - birth.getFullYear();
      const monthDiff = today.getMonth() - birth.getMonth();

      if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getDate() < birth.getDate())
      ) {
        return age - 1 >= 18;
      }

      return age >= 18;
    } catch (error) {
      this.logger.warn('Erro ao calcular idade', { birthDate, error });
      return false;
    }
  }

  /**
   * Obtém token 3scale para acessar APIs protegidas
   */
  private async get3scaleToken(): Promise<string | null> {
    const tokenUrl = process.env.THREESCALE_TOKEN_URL;
    const userKey = process.env.THREESCALE_USERKEY;
    const user = process.env.THREESCALE_USER;
    const password = process.env.THREESCALE_PASSWORD;

    if (!tokenUrl || !userKey || !user || !password) {
      this.logger.warn('Configuração 3scale incompleta');
      return null;
    }

    try {
      const response = await axios({
        method: 'POST',
        url: tokenUrl,
        headers: {
          'Content-Type': 'application/json',
          user_key: userKey,
        },
        data: {
          usuario: user,
          senha: password,
        },
        timeout: 15000,
      });

      return response.data?.token || null;
    } catch (error) {
      this.logger.error('Erro ao obter token 3scale', error.message);
      return null;
    }
  }

  /**
   * Verifica se o funcionário tem acesso a relatórios financeiros
   */
  async checkFinancialReportsAccess(chapa: string): Promise<{
    status: number;
    acessoTotal: boolean;
    codPessoa?: number;
    error?: string;
  }> {
    const consultaUrl = process.env.CONSULTA_DADOS_USUARIO;
    const relConciliacaoUrl = process.env.REL_CONCILIACAO_CAIXA_URL;
    const relReversaoUrl = process.env.REL_REVERSAO_PGTO_URL;
    const relCancelamentoUrl = process.env.REL_CANCELAMENTO_URL;
    const relAnulacaoUrl = process.env.REL_ANULACAO_URL;
    const cancelamentoUserKey = process.env.CANCELAMENTO_USERKEY;
    const relUserKey = process.env.REL_USERKEY;
    const ambiente = process.env.AMBIENTE;

    // Verificar configuração mínima
    if (!consultaUrl || !relConciliacaoUrl) {
      this.logger.warn(
        'Configuração incompleta para verificação de acesso a relatórios',
      );
      return {
        status: 500,
        acessoTotal: false,
        error: 'Configuração incompleta',
      };
    }

    try {
      // Obter token 3scale
      const token = await this.get3scaleToken();
      if (!token) {
        return {
          status: 500,
          acessoTotal: false,
          error: 'Erro ao obter token 3scale',
        };
      }

      // Consultar dados do usuário
      const consultaResponse = await axios({
        method: 'GET',
        url: `${consultaUrl}?CodPessoaOrigem=${chapa}&DscOrigem=RHEV&DscDestino=CS&CodPessoaSecund=1`,
        headers: {
          accept: 'text/plain',
          HeaderAuthorization: `jwt:${token}`,
          ambiente: ambiente,
          user_key: cancelamentoUserKey,
        },
        timeout: 30000,
      });

      const dadosUnicos = consultaResponse.data;
      if (!dadosUnicos.data || dadosUnicos.data.length === 0) {
        this.logger.warn('Dados do usuário não encontrados');
        return {
          status: 404,
          acessoTotal: false,
          error: 'Dados do usuário não encontrados',
        };
      }

      // Processar registros - filtrar ativos
      let registros = dadosUnicos.data;
      if (registros.length > 1) {
        const ativos = registros.filter(
          (reg: any) => reg.codigoStatusRegistroOrigem === 'A',
        );
        if (ativos.length > 0) {
          registros =
            ativos.length > 1
              ? ativos.sort(
                  (a: any, b: any) =>
                    new Date(b.dataInclusao).getTime() -
                    new Date(a.dataInclusao).getTime(),
                )
              : ativos;
        }
      }

      const codPessoa = registros[0].codigoPessoa;
      this.logger.debug(`codPessoa selecionado: ${codPessoa}`);

      // Verificar acesso aos 4 relatórios em paralelo
      const [
        resultConciliacao,
        resultReversao,
        resultCancelamento,
        resultAnulacao,
      ] = await Promise.all([
        axios({
          method: 'GET',
          url: `${relConciliacaoUrl}?emplid=${codPessoa}`,
          headers: { token, user_key: relUserKey },
          timeout: 15000,
        }).catch(() => ({ data: { DADOS: [] } })),
        axios({
          method: 'GET',
          url: `${relReversaoUrl}?emplid=${codPessoa}`,
          headers: { token, user_key: relUserKey },
          timeout: 15000,
        }).catch(() => ({ data: { DADOS: [] } })),
        axios({
          method: 'GET',
          url: `${relCancelamentoUrl}?emplid=${codPessoa}`,
          headers: { token, user_key: relUserKey },
          timeout: 15000,
        }).catch(() => ({ data: { DADOS: [] } })),
        axios({
          method: 'GET',
          url: `${relAnulacaoUrl}?emplid=${codPessoa}`,
          headers: { token, user_key: relUserKey },
          timeout: 15000,
        }).catch(() => ({ data: { DADOS: [] } })),
      ]);

      // IDs com acesso total garantido
      const idsPermitidos = [1140131623, 1140356420, 1140241906, 1143133928];

      // Verificar se tem acesso a todos os relatórios
      const acessoTotal =
        (resultConciliacao.data?.DADOS?.length > 0 &&
          resultReversao.data?.DADOS?.length > 0 &&
          resultCancelamento.data?.DADOS?.length > 0 &&
          resultAnulacao.data?.DADOS?.length > 0) ||
        idsPermitidos.includes(codPessoa);

      return {
        status: 200,
        acessoTotal,
        codPessoa,
      };
    } catch (error: any) {
      this.logger.error('Erro em checkFinancialReportsAccess', error.message);
      return {
        status: error.response?.status || 500,
        acessoTotal: false,
        error: error.message,
      };
    }
  }
}
