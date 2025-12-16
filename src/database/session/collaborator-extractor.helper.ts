/**
 * Helper para extrair informações do assistente colaborador do step_history
 */

export interface CollaboratorInfo {
  collaboratorAgentId?: string;
  collaboratorAgentName?: string;
}

/**
 * Extrai informações do assistente colaborador do step_history
 * O step_history contém informações sobre chamadas de sub-agents
 */
export const extractCollaboratorFromStepHistory = (
  stepHistory?: Array<any>,
): CollaboratorInfo => {
  if (!stepHistory || !Array.isArray(stepHistory)) {
    return {};
  }

  // Procurar por informações de assistente colaborador no step_history
  // O formato pode variar, então vamos procurar em vários lugares possíveis
  for (const step of stepHistory) {
    // Verificar se há informações de sub-agent no step
    if (step.sub_agent_id || step.subAgentId) {
      return {
        collaboratorAgentId: step.sub_agent_id || step.subAgentId,
        collaboratorAgentName: step.sub_agent_name || step.subAgentName,
      };
    }

    // Verificar em step_details
    if (step.step_details && Array.isArray(step.step_details)) {
      for (const detail of step.step_details) {
        if (detail.sub_agent_id || detail.subAgentId) {
          return {
            collaboratorAgentId: detail.sub_agent_id || detail.subAgentId,
            collaboratorAgentName:
              detail.sub_agent_name || detail.subAgentName,
          };
        }

        // Verificar em tool_calls (pode indicar qual assistente foi acionado)
        if (detail.tool_calls && Array.isArray(detail.tool_calls)) {
          for (const toolCall of detail.tool_calls) {
            // Se o tool_call tem informações de agente colaborador
            if (toolCall.agent_id || toolCall.agentId) {
              return {
                collaboratorAgentId: toolCall.agent_id || toolCall.agentId,
                collaboratorAgentName:
                  toolCall.agent_name || toolCall.agentName,
              };
            }
          }
        }
      }
    }

    // Verificar diretamente no step por campos relacionados a agente
    if (step.agent_id || step.agentId) {
      // Verificar se não é o agent master (geralmente tem um padrão diferente)
      const agentId = step.agent_id || step.agentId;
      const agentName = step.agent_name || step.agentName;

      // Se tem nome e não parece ser o master, pode ser colaborador
      if (agentName && agentName !== 'master' && agentName !== 'orchestrator') {
        return {
          collaboratorAgentId: agentId,
          collaboratorAgentName: agentName,
        };
      }
    }
  }

  return {};
};

