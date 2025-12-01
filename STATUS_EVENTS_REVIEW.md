# Lista de Status Events (SSE) e Mensagens de Feedback

Este documento lista todos os eventos de status enviados via SSE (Server-Sent Events) e as mensagens de feedback correspondentes retornadas ao widget.

## Tipos de Eventos de Status

### 1. `status.started`
**Quando é emitido:** No início do processamento da mensagem, antes de enviar para o Watson Orchestrate.

**Mensagens de feedback:**
- `"Planejando próximos passos"` - Emitido no início do `sendMessageStream` (watsonx.service.ts:593)

**Localização no código:**
- `watsonx.service.ts:590-596` - No início do `sendMessageStream`

---

### 2. `status.thinking`
**Quando é emitido:** Quando o Watson Orchestrate está processando thinking/reasoning steps.

**Mensagens de feedback:**
- `"Analisando contexto e planejando resposta"` - Fallback quando não há texto de thinking disponível
- Texto processado do thinking/reasoning do Watson Orchestrate (processado por `processThinkingText`)

**Exemplos de mensagens processadas:**
- Texto raw do Watson é transformado removendo termos técnicos
- Capitaliza primeira letra
- Remove termos como: "tool(", "function(", "api call", "endpoint", "request", "response", "payload", etc.

**Localização no código:**
- `watsonx.service.ts:737-743` - Quando detecta `message.thinking` no SSE
- `watsonx.service.ts:801-807` - Quando detecta `run.step.thinking`
- `watsonx.service.ts:836-842` - Quando detecta reasoning em `run.step.created` ou `run.step.in_progress`
- `watsonx.service.ts:1003-1008` - Durante polling de thread messages

---

### 3. `status.tool_call`
**Quando é emitido:** Quando uma tool/action é chamada pelo Watson Orchestrate.

**Mensagens de feedback:**
As mensagens são mapeadas pelo nome da tool usando `getToolStatusMessage()`:

| Nome da Tool | Mensagem de Feedback |
|--------------|---------------------|
| `identify_employee` | `"Verificando credenciais do funcionário"` |
| `identify_student` | `"Verificando credenciais do aluno"` |
| `decrypt_value` | `"Descriptografando informações sensíveis"` |
| `check_financial_reports` | `"Consultando permissões de acesso"` |
| `check_financial_reports_access` | `"Consultando permissões de acesso"` |
| `search` | `"Buscando na base de dados"` |
| `query` | `"Consultando informações"` |
| Qualquer outra tool | `"Executando ação"` (fallback) |

**Localização no código:**
- `watsonx.service.ts:763-770` - Quando detecta `tool_calls` em `run.step.created`
- `tool-status.constants.ts:5-23` - Mapeamento de tools para mensagens

---

### 4. `status.processing`
**Quando é emitido:** Quando um step está em progresso mas não há detalhes específicos de tool ou reasoning.

**Mensagens de feedback:**
- `"Consultando informações"` - Quando detecta `stepType === 'tool_calls'` sem detalhes específicos

**Localização no código:**
- `watsonx.service.ts:845-851` - Quando `run.step.created` ou `run.step.in_progress` tem tipo `tool_calls` mas sem reasoning

---

### 5. `status.completed`
**Quando é emitido:** Quando o stream SSE termina e a resposta está finalizada.

**Mensagens de feedback:**
- `"Finalizando resposta"` - Emitido quando o stream SSE termina

**Localização no código:**
- `watsonx.service.ts:888-894` - No evento `stream.on('end')`

---

### 6. `status.error`
**Quando é emitido:** Quando ocorre um erro ao processar a mensagem.

**Mensagens de feedback:**
- `"Erro ao processar"` - Emitido quando há erro no `sendMessageStream`

**Localização no código:**
- `watsonx.service.ts:604-610` - No catch do `sendMessageStream`

---

## Eventos Adicionais (Não são Status Events, mas são enviados via SSE)

### 7. `status` (genérico)
**Quando é emitido:** Evento inicial enviado pelo BrokerWidgetService antes de iniciar o processamento.

**Mensagens de feedback:**
- `"Preparando resposta"` - Mensagem inicial padrão
- `"Inicializando assistente"` - Quando é a primeira mensagem ou não há texto

**Localização no código:**
- `broker-widget.service.ts:310-313` - Determinação da mensagem inicial
- `broker-widget.service.ts:317-323` - Emissão do evento inicial

---

### 8. `error` (evento de erro)
**Quando é emitido:** Quando há erro no `executeWithStatusEvents`.

**Mensagens de feedback:**
- `error.message || 'Erro ao processar requisição'` - Mensagem de erro do catch

**Localização no código:**
- `broker-widget.service.ts:364-373` - No catch do `executeWithStatusEvents`

---

### 9. `response` (evento final)
**Quando é emitido:** Quando a resposta completa está pronta para ser enviada ao widget.

**Estrutura:**
```json
{
  "event": "response",
  "data": {
    "success": true,
    "messages": [...],
    "settings": {...},
    "context": {...}
  }
}
```

**Localização no código:**
- `broker-widget.service.ts:580-600` - Emissão da resposta final

---

## Fluxo de Eventos SSE

1. **Início:** `status` (genérico) - "Preparando resposta" ou "Inicializando assistente"
2. **Processamento:** `status.started` - "Planejando próximos passos"
3. **Durante processamento:**
   - `status.thinking` - Mensagens de thinking/reasoning processadas
   - `status.tool_call` - Quando tools são chamadas
   - `status.processing` - Processamento genérico
4. **Fim:** `status.completed` - "Finalizando resposta"
5. **Resposta final:** `response` - Dados completos da resposta

---

## Observações Importantes

1. **Processamento de Thinking:** O texto raw do Watson Orchestrate é processado por `processThinkingText()` para remover termos técnicos e tornar as mensagens mais amigáveis ao usuário.

2. **Mapeamento de Tools:** As mensagens de `status.tool_call` são mapeadas dinamicamente baseadas no nome da tool. Tools não mapeadas usam o fallback "Executando ação".

3. **Normalização de Nomes:** Os nomes das tools são normalizados (lowercase, remoção de prefixos `tool_` ou `action_`) antes de buscar no mapa.

4. **Timestamp:** Todos os eventos de status incluem um `timestamp` (Date.now()) para rastreamento.

5. **Tool Name:** Eventos `status.tool_call` incluem o campo `toolName` com o nome original da tool.

---

## Estrutura Completa de um StatusEvent

```typescript
interface StatusEvent {
  event: 'status.started' | 'status.tool_call' | 'status.processing' | 
        'status.thinking' | 'status.completed' | 'status.error';
  data: {
    message: string;        // Mensagem de feedback para o usuário
    toolName?: string;      // Nome da tool (apenas em status.tool_call)
    timestamp: number;       // Timestamp do evento
  };
}
```

---

## Estrutura do Evento SSE Enviado ao Widget

```json
{
  "event": "status",
  "data": {
    "message": "Mensagem de feedback",
    "toolName": "nome_da_tool",  // Opcional
    "timestamp": 1234567890,
    "type": "status.started"  // Tipo do evento original
  }
}
```

---

**Última atualização:** 2025-01-27
**Arquivos relacionados:**
- `src/watsonxorchestrate/tool-status.constants.ts`
- `src/watsonxorchestrate/watsonx.service.ts`
- `src/broker/broker-widget/broker-widget.service.ts`

