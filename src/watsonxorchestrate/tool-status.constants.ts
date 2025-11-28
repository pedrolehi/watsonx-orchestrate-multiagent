/**
 * Mapeamento de nomes de tools para mensagens amigáveis de status
 * Usado para exibir feedback ao usuário enquanto as tools estão processando
 */
export const TOOL_STATUS_MAP: Record<string, string> = {
  // Autenticação
  identify_employee: 'Autenticando usuário',
  identify_student: 'Autenticando aluno',

  // Processamento de dados
  decrypt_value: 'Processando dados',

  // Relatórios financeiros
  check_financial_reports: 'Verificando permissões',
  check_financial_reports_access: 'Verificando permissões',

  // Consultas genéricas
  search: 'Buscando informações',
  query: 'Consultando dados',

  // Fallback
  default: 'Processando',
};

/**
 * Obtém a mensagem de status amigável para uma tool
 * @param toolName Nome da tool sendo executada
 * @returns Mensagem amigável para exibir ao usuário
 */
export const getToolStatusMessage = (toolName: string): string => {
  // Normalizar nome da tool (lowercase, remover prefixos/sufixos)
  const normalizedName = toolName.toLowerCase().replace(/^(tool_|action_)/, '');

  // Buscar no mapa, ou usar fallback
  return TOOL_STATUS_MAP[normalizedName] || TOOL_STATUS_MAP.default;
};

/**
 * Tipos de eventos de status que podem ser enviados ao widget
 */
export type StatusEventType =
  | 'status.started'
  | 'status.tool_call'
  | 'status.processing'
  | 'status.completed'
  | 'status.error';

/**
 * Interface para eventos de status
 */
export interface StatusEvent {
  event: StatusEventType;
  data: {
    message: string;
    toolName?: string;
    timestamp: number;
  };
}
