# Arquitetura

```
Navegador (web/index.html)
   │  HTTP (estado, ações)   WebSocket (eventos em tempo real)
   ▼
Servidor Bancada (Node)
   │  SSH (ssh2)
   ▼
Servidores de trabalho
   ├─ repositório + git worktree por janela
   ├─ claude -p --output-format stream-json   (prompt pelo stdin)
   ├─ codex exec --json -                     (prompt pelo stdin)
   └─ ~/.bancada/hooks e ~/.bancada/approvals (hook do Claude Code)
```

## Estado
- Cada pessoa recebe uma versão filtrada do estado (`acl.js`), só com os projetos liberados.
- O que a pessoa envia é mesclado com o estado do servidor, revertendo o que ela não pode alterar.
- A tela é dona do **layout** (projetos, grupos, janelas, ligações, regras, playbooks) e envia o documento com `PUT /api/state`, sem conversas.
- O servidor é dono das **conversas**, diffs, commits, aprovações, consumo, execuções de playbook e auditoria. Tudo chega à tela por eventos WebSocket.
- `GET /api/state` junta os dois na carga inicial.

## Fluxo de uma mensagem
1. `POST /api/nodes/:id/message`
2. Mascaramento e checagem de padrões arriscados (pode virar aprovação).
3. Garante o worktree (`git worktree add -B <branch>`).
4. Monta o prompt com o contexto das janelas ligadas e roda o CLI no worktree, com retomada da sessão anterior.
5. Cada linha JSON da saída vira mensagem na tela (texto, ferramenta, erro).
6. Ao terminar: lê o diff, registra na auditoria e avisa no Telegram se a janela pedir.

## Orquestrador
Envia a mesma tarefa a todas as janelas de projeto ligadas, em paralelo, espera todas terminarem e devolve as respostas e um resumo.

## Playbooks
Cada passo pendente (`- [ ] ...`) roda em sessão limpa na janela de destino (ou em todos os projetos do orquestrador), em sequência. A agenda roda no servidor.

## API
| Método | Rota | Função |
|---|---|---|
| GET/PUT | `/api/state` | estado completo / salvar layout |
| POST | `/api/nodes/:id/message` | mensagem para agente ou orquestrador |
| POST | `/api/nodes/:id/exec` | comando no terminal da janela |
| POST | `/api/nodes/:id/stop` | interromper o agente |
| POST | `/api/nodes/:id/diff` | reler o diff |
| POST | `/api/nodes/:id/commit` | commitar arquivos selecionados |
| POST | `/api/nodes/:id/discard` | descartar arquivos selecionados |
| POST | `/api/nodes/:id/pr` | push e `gh pr create` |
| GET | `/api/nodes/:id/sessions` | sessões antigas dos CLIs |
| POST | `/api/nodes/:id/resume` | retomar uma sessão |
| POST | `/api/approvals/:id` | permitir ou negar |
| GET/POST | `/api/usage`, `/api/usage/refresh` | consumo dos planos |
| POST | `/api/playbooks/:id/run` | executar playbook |
| POST | `/api/notify/test` | testar avisos |
| POST | `/api/nodes/:id/held/flush` | enviar mensagens guardadas fora do turno |
| POST | `/api/schedules/:id/run` | executar agendamento agora |
| POST | `/api/skills/:id/install` | instalar skill do Claude Code nos servidores |
| POST | `/api/secrets` | guardar segredo de MCP no cofre |
| GET/POST/PUT | `/api/users`, `/api/users/:id` | pessoas e acessos |
| POST | `/api/users/:id/reset`, `/api/users/:id/revoke` | nova senha temporária, encerrar sessões |
| GET/POST | `/api/inbox`, `/api/inbox/read` | notificações |
| GET/POST | `/api/push/key`, `/api/push/subscribe` | push no aparelho |
| GET/POST | `/login`, `/logout`, `/account` | login, saída, senha e autenticador |
| POST | `/api/invites`, `/api/invites/:id/revoke` | criar e revogar convites |
| GET/POST | `/invite/:token` | página pública para aceitar convite |
| GET | `/api/projects/:id/files`, `/api/projects/:id/file` | árvore de arquivos (só leitura) |
