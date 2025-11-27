import { Test, TestingModule } from '@nestjs/testing';
import {
  mockAxios,
  mockAxiosError,
  mockAxiosResponse,
} from '../__mocks__/axios';
import { AuthService } from './auth.service';

// Mock axios
jest.mock('axios', () => mockAxios);

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuthService],
    }).compile();

    service = module.get<AuthService>(AuthService);

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('getToken', () => {
    it('should successfully get token from SENAC API', async () => {
      const mockResponse = {
        CODE: 200,
        GENERATIONTOKEN: 'test-token-12345',
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.getToken();

      expect(mockAxios).toHaveBeenCalledWith({
        method: 'post',
        url: 'https://appsenac.sp.senac.br/rest/wsapimob/authenticationEntity',
        headers: {
          'Content-type': 'application/json; charset=UTF-8',
          TokenWS:
            'gjF17O1DFM3PGAAy5vxGnOQb+xvrFjyYXyE34tUGMnAjJRtggS4c58YRmG47OulS/0===',
          RestAction: 'getAuth',
        },
      });

      expect(result).toBe('test-token-12345');
    });

    it('should handle string CODE response', async () => {
      const mockResponse = {
        CODE: '200',
        GENERATIONTOKEN: 'test-token-12345',
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.getToken();

      expect(result).toBe('test-token-12345');
    });

    it('should throw error when CODE is not 200', async () => {
      const mockResponse = {
        CODE: 401,
        GENERATIONTOKEN: null,
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      await expect(service.getToken()).rejects.toThrow('Erro ao gerar token');
    });

    it('should handle HTTP errors', async () => {
      mockAxios.mockRejectedValue(mockAxiosError('Network Error', 500));

      await expect(service.getToken()).rejects.toThrow('Erro ao gerar token');
    });

    it('should handle axios errors', async () => {
      const error = new Error('Axios Error');
      mockAxios.mockRejectedValue(error);

      await expect(service.getToken()).rejects.toThrow('Erro ao gerar token');
    });
  });

  describe('authenticateUser', () => {
    it('should successfully authenticate user', async () => {
      const mockResponse = {
        AUTHVALIDORESULT: ['success'],
        AUTH: [
          {
            LRH: {
              EMPLID: '123456',
              DADOSDETALHE: {
                WSDADOS: {
                  chapa: 'CH123',
                  nome: 'Test User',
                  unidade: 'GTI',
                },
              },
            },
          },
        ],
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.authenticateUser(
        'test@senac.br',
        'password123',
        'test-token',
      );

      expect(mockAxios).toHaveBeenCalledWith({
        method: 'post',
        url: 'https://appsenac.sp.senac.br/rest/wsapimob/autenticarapp',
        headers: {
          'Content-type': 'application/json; charset=UTF-8',
          Authorization: 'test-token',
          RestAction: 'getAccessFuncionario',
        },
        data: {
          setEmail: 'test@senac.br',
          setSenha: 'password123',
          setSistema: 'WEB',
          setUdid: '',
          setAmbiente: 'PROD',
        },
      });

      expect(result).toEqual({
        emplid: '123456',
        chapa: 'CH123',
        nome: 'Test User',
        email: 'test@senac.br',
        unidade: 'GTI',
      });
    });

    it('should use email as name when nome is not provided', async () => {
      const mockResponse = {
        AUTHVALIDORESULT: ['success'],
        AUTH: [
          {
            LRH: {
              EMPLID: '123456',
              DADOSDETALHE: {
                WSDADOS: {
                  chapa: 'CH123',
                  nome: null,
                  unidade: 'GTI',
                },
              },
            },
          },
        ],
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.authenticateUser(
        'test@senac.br',
        'password123',
        'test-token',
      );

      expect(result.nome).toBe('TEST@SENAC.BR');
    });

    it('should use default unidade when not provided', async () => {
      const mockResponse = {
        AUTHVALIDORESULT: ['success'],
        AUTH: [
          {
            LRH: {
              EMPLID: '123456',
              DADOSDETALHE: {
                WSDADOS: {
                  chapa: 'CH123',
                  nome: 'Test User',
                  unidade: null,
                },
              },
            },
          },
        ],
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.authenticateUser(
        'test@senac.br',
        'password123',
        'test-token',
      );

      expect(result.unidade).toBe('GTI');
    });

    it('should throw error when authentication fails', async () => {
      const mockResponse = {
        AUTHVALIDORESULT: [],
        AUTH: [],
      };

      mockAxios.mockResolvedValue(mockAxiosResponse(mockResponse));

      await expect(
        service.authenticateUser(
          'test@senac.br',
          'wrongpassword',
          'test-token',
        ),
      ).rejects.toThrow('Credenciais inválidas');
    });

    it('should handle HTTP errors', async () => {
      mockAxios.mockRejectedValue(mockAxiosError('Network Error', 500));

      await expect(
        service.authenticateUser('test@senac.br', 'password123', 'test-token'),
      ).rejects.toThrow('Erro na autenticação');
    });
  });

  describe('decryptCredentials', () => {
    it('should decrypt credentials using fallback method', () => {
      const encrypted = btoa(
        JSON.stringify({ username: 'test@senac.br', password: 'password123' }),
      );
      const iv = 'fallback';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toEqual({
        username: 'test@senac.br',
        password: 'password123',
      });
    });

    it('should decrypt credentials using simple method', () => {
      const credentials = {
        username: 'test@senac.br',
        password: 'password123',
        timestamp: Date.now(),
      };
      const step1 = btoa(JSON.stringify(credentials));
      const step2 = step1.split('').reverse().join('');
      const step3 = btoa(`${step2}_${credentials.timestamp}`);
      const encrypted = step3;
      const iv = 'simple';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toEqual({
        username: 'test@senac.br',
        password: 'password123',
      });
    });

    it('should return null for expired simple method credentials', () => {
      const credentials = {
        username: 'test@senac.br',
        password: 'password123',
        timestamp: Date.now() - 400000,
      }; // 6+ minutes ago
      const step1 = btoa(JSON.stringify(credentials));
      const step2 = step1.split('').reverse().join('');
      const step3 = btoa(`${step2}_${credentials.timestamp}`);
      const encrypted = step3;
      const iv = 'simple';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toBeNull();
    });

    it('should decrypt credentials using basic method', () => {
      const encrypted = btoa(
        JSON.stringify({ username: 'test@senac.br', password: 'password123' }),
      );
      const iv = 'basic';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toEqual({
        username: 'test@senac.br',
        password: 'password123',
      });
    });

    it('should return null for invalid encrypted data', () => {
      const encrypted = 'invalid-base64';
      const iv = 'fallback';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toBeNull();
    });

    it('should return null for invalid simple method data', () => {
      const encrypted = 'invalid-data';
      const iv = 'simple';

      const result = service.decryptCredentials(encrypted, iv);

      expect(result).toBeNull();
    });
  });

  describe('validateKeycloakToken', () => {
    it('should successfully validate active token', async () => {
      const mockResponse = {
        active: true,
        sub: 'user-123',
        email: 'test@senac.br',
        preferred_username: 'testuser',
      };

      mockAxios.post.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.validateKeycloakToken('Bearer test-token');

      expect(mockAxios.post).toHaveBeenCalledWith(
        `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token/introspect`,
        expect.any(String), // URL encoded data
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      expect(result).toEqual({
        valid: true,
        data: mockResponse,
      });
    });

    it('should handle inactive token', async () => {
      const mockResponse = {
        active: false,
      };

      mockAxios.post.mockResolvedValue(mockAxiosResponse(mockResponse));

      const result = await service.validateKeycloakToken(
        'Bearer expired-token',
      );

      expect(result).toEqual({
        valid: false,
        data: mockResponse,
      });
    });

    it('should clean Bearer prefix from token', async () => {
      const mockResponse = { active: true };
      mockAxios.post.mockResolvedValue(mockAxiosResponse(mockResponse));

      await service.validateKeycloakToken('Bearer test-token');

      // Verify that the token was cleaned (no Bearer prefix)
      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('test-token'),
        expect.any(Object),
      );
    });

    it('should handle HTTP errors', async () => {
      mockAxios.post.mockRejectedValue(mockAxiosError('Network Error', 500));

      const result = await service.validateKeycloakToken('Bearer test-token');

      expect(result).toEqual({
        valid: false,
        error: 'Network Error',
      });
    });

    it('should handle axios errors', async () => {
      const error = new Error('Axios Error');
      mockAxios.post.mockRejectedValue(error);

      const result = await service.validateKeycloakToken('Bearer test-token');

      expect(result).toEqual({
        valid: false,
        error: 'Axios Error',
      });
    });
  });

  describe('extractKeycloakUserData', () => {
    it('should extract user data from token data', () => {
      const tokenData = {
        email: 'test@senac.br',
        preferred_username: 'testuser',
        sub: 'user-123',
        name: 'Test User',
        given_name: 'Test',
        family_name: 'User',
        email_verified: true,
        realm_access: { roles: ['user'] },
        resource_access: { 'test-client': { roles: ['user'] } },
      };

      const result = service.extractKeycloakUserData(tokenData);

      expect(result).toEqual({
        email: 'test@senac.br',
        username: 'testuser',
        sub: 'user-123',
        name: 'Test User',
        given_name: 'Test',
        family_name: 'User',
        email_verified: true,
        realm_access: { roles: ['user'] },
        resource_access: { 'test-client': { roles: ['user'] } },
      });
    });

    it('should handle missing fields in token data', () => {
      const tokenData = {
        email: 'test@senac.br',
        sub: 'user-123',
      };

      const result = service.extractKeycloakUserData(tokenData);

      expect(result).toEqual({
        email: 'test@senac.br',
        username: undefined,
        sub: 'user-123',
        name: undefined,
        given_name: undefined,
        family_name: undefined,
        email_verified: undefined,
        realm_access: undefined,
        resource_access: undefined,
      });
    });
  });
});
