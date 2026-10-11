# Segurança

## Contas e login
- Cada pessoa tem login próprio. Não existe senha compartilhada.
- Senhas guardadas com **scrypt** (sal aleatório). Ninguém, nem o administrador, consegue ver a senha de outra pessoa.
- Senha mínima de 12 caracteres (configurável para mais), recusando sequências óbvias.
- Conta nova e senha redefinida recebem **senha temporária**, mostrada uma única vez e trocada obrigatoriamente no primeiro acesso.
- **Autenticador (2FA, RFC 6238)** obrigatório por padrão. Até concluir senha e 2FA, a sessão só acessa a página da conta; a API responde 403.
- Bloqueio de 15 minutos após 5 erros seguidos na conta, e limite de 20 tentativas por endereço a cada 15 minutos.
- Mensagem de erro igual para login inexistente e senha errada.

## Sessões
- Cookie `HttpOnly`, `SameSite=Strict`, `Secure` com `COOKIE_SECURE=1`.
- Expiração absoluta (12 h por padrão) e por inatividade (30 min por padrão).
- Mudança de papel, projetos, permissões, senha, autenticador ou desativação derruba na hora todas as sessões e conexões em tempo real da pessoa.
- Pedidos que alteram algo exigem cabeçalho `Origin` do próprio painel, inclusive login e WebSocket.

## Permissões
- Papéis padrão (administrador, líder técnico, desenvolvedor, somente leitura) mais exceções por pessoa.
- Acesso por projeto: a pessoa só recebe projetos, janelas, ligações, aprovações, auditoria e eventos em tempo real dos projetos liberados.
- **Toda rota checa permissão no servidor.** A tela só esconde botões; não é ela que protege.
- Alterações enviadas pela tela passam por mescla: o que a pessoa não pode alterar volta ao valor do servidor (regras, modo danger, configuração de agentes, janelas de outros projetos).
- Só administradores concedem papel de administrador ou permissões administrativas (usuários, regras, MCPs, integrações).
- Ninguém reduz o próprio acesso, e sempre resta pelo menos um administrador ativo.
- Orquestrador exige acesso a todos os projetos ligados a ele.

## Convites
- Link de uso único, com validade de 1 a 7 dias; o servidor guarda só o hash do token.
- Quem convida só pode dar papel igual ou menor que o próprio e só projetos que acessa; só administradores convidam administradores.
- O convidado define a própria senha e configura o autenticador antes de entrar.
- Quem criou ou um administrador pode revogar; tudo fica na auditoria.

## Compartilhamento de agentes e contas de IA
- Cada agente tem dono. Agentes "só o dono" ou "pessoas escolhidas" não chegam a quem não está na lista, nem pela API nem pelo tempo real. Administradores enxergam tudo.
- Só o dono (ou administrador) muda compartilhamento e conta usada pelo agente.
- O servidor confere, a cada execução, se quem pediu pode usar a conta configurada. Agendamentos usam o acesso do dono do agente.
- Contas de IA não guardam senha nem token: são usuários do servidor já logados no CLI.

## Árvore de arquivos e portal
- Arquivos: só leitura, sem `..`, sem `.git`, sem links simbólicos, até 200 KB, e bloqueio de `.env`, chaves, certificados e credenciais. Cada leitura entra na auditoria.
- Portal: só `http` e `https`, em `iframe` com `sandbox` e sem referrer. Os endereços permitidos vêm de `PORTAL_FRAME_SRC`.

## Aprovações
- Padrões arriscados (em Regras) sempre pedem aprovação, inclusive no modo danger.
- Só quem tem a permissão "aprovar" e acesso ao projeto aprova.
- **Quatro olhos em produção**: quem pediu a ação não pode aprová-la.
- No Claude Code, um hook `PreToolUse` leva comandos Bash à Bancada por arquivos em `~/.bancada/approvals` (nenhuma porta aberta). Comandos comuns passam e ficam registrados.

## Agentes
- Cada janela trabalha num `git worktree` próprio.
- Produção: somente leitura por padrão (`--permission-mode plan` no Claude, `--sandbox read-only` no Codex) e terminal restrito a comandos de leitura.
- Modo danger bloqueado em produção pelo servidor.
- Commit, descarte e PR só aceitam arquivos presentes no diff atual.

## Segredos
- Cofre **AES-256-GCM** com a chave `BANCADA_SECRET_KEY` do `.env`. Guarde a chave também fora do servidor.
- Segredos de MCP, chaves dos autenticadores e a chave privada do push ficam cifrados.
- Valores de segredo nunca voltam para a tela; ela só sabe se existe ou não.
- O MCP do Claude Code recebe os segredos num arquivo temporário com permissão 600 no servidor, apagado ao fim de cada execução.
- Token do Telegram e URL do webhook ficam só no `.env`.

## SSH
- Só chave (ssh-agent ou arquivo). Nenhuma senha de servidor é guardada.
- Verificação da chave do host no primeiro acesso; se mudar, a conexão é recusada.
- Valores vindos da tela entram nos comandos com aspas escapadas; servidor, pasta, branch e arquivos são validados.

## Dados
- Mascaramento antes de ir ao agente: CPF, CNPJ, ICCID, telefone, e-mail, senhas e tokens comuns. É uma rede de proteção, não garantia: evite colar dados de clientes (LGPD).
- Não coloque segredos nem dados de clientes em blocos de notas ou skills: o conteúdo vai junto com as mensagens.
- `data/` fica com permissão 600/700 e está no `.gitignore`.

## Cabeçalhos HTTP
CSP restritiva (`frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, HSTS com HTTPS, `Cache-Control: no-store` na API e erros sem stack trace.

## Auditoria
`data/audit.jsonl` é só de acréscimo: quem fez o quê, onde e quando, incluindo logins, mudanças de acesso, segredos guardados (sem o valor), aprovações e comandos permitidos pelo hook.

## Limites conhecidos
- Os agentes rodam com a conta dos CLIs logada em cada servidor; a Bancada controla quem pede, não qual conta paga.
- A leitura de consumo depende do formato de `/usage` e `/status`; se mudar, mostra "indisponível".
- Push no celular exige HTTPS.
