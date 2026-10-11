# Bancada

Painel para trabalhar com **Claude Code**, **Codex** e **Gemini CLI** em vários servidores e repositórios ao mesmo tempo, com várias pessoas, cada uma com o próprio acesso.

Cada agente vira uma janela num canvas: você dá nome e ícone, arrasta, liga janelas entre si, monta equipes com turno, agenda tarefas, revisa o diff antes de commitar e recebe avisos no aparelho, no Telegram ou na própria Bancada.

A Bancada **não usa chave de API nem reaproveita o login dos CLIs**. Ela entra nos servidores por SSH e roda o `claude` e o `codex` oficiais, já logados com a conta de cada servidor.

## Recursos

**Barra da área de trabalho**
- **Terminal**: novo agente Claude Code, Codex ou Gemini CLI, ou um terminal comum no servidor.
- **Nota**: anotações e instruções que os agentes ligados leem.
- **Arquivos**: árvore de arquivos do projeto, só leitura (bloqueia `.env`, chaves e credenciais).
- **Portal**: um navegador dentro da área de trabalho (para o app em desenvolvimento, staging etc.).
- **Conectar**: liga agentes, notas, arquivos e portais para compartilharem informações.
- **Orquestrador**, **Organizar**, **Ver tudo**, zoom e minimapa.

**Pessoas, colaboração e licenças**
- Quem tem a permissão "convidar" gera um **link de convite** com papel e projetos definidos; a pessoa cria login, senha e autenticador.
- Cada agente tem **dono** e **compartilhamento**: só o dono, quem acessa o projeto, ou pessoas escolhidas.
- Projetos **colaborativos** (todos veem e usam os agentes) ou **individuais** (cada pessoa vê só os próprios).
- **Contas de IA**: cada conta é um usuário do servidor logado no Claude Code, Codex ou Gemini. O dono decide se só ele usa ou se compartilha. Ao compartilhar, a tela mostra o aviso sobre termos de uso.

**Trabalho com agentes**
- Canvas com arrastar, redimensionar, zoom, minimapa e áreas de trabalho; funciona no celular.
- Agentes com nome, ícone, cor e motor (Claude Code ou Codex).
- Projetos e grupos; "Abrir grupo" liga todos os projetos a um orquestrador.
- Orquestrador: uma tarefa vai para todos os projetos ligados e as respostas voltam para ele.
- Contexto compartilhado entre janelas ligadas.
- Blocos de notas lidos antes de toda mensagem (para todos, por equipe ou por agente).
- Biblioteca de skills (enviadas como instrução e, se quiser, instaladas como skill do Claude Code no servidor).
- Catálogo de MCPs com segredos no cofre.
- `git worktree` por janela, revisão de diff, commit, descarte e PR.
- Terminal por janela, histórico e retomada de sessões antigas dos CLIs.

**Organização**
- Equipes com turno (dias e horário). Com "trabalhar só no turno", mensagens e agendamentos fora do horário ficam guardados e saem quando o turno começa.
- Agendador: texto ou playbook, uma vez, todo dia, em dias da semana ou a cada N horas. Roda no servidor, mesmo com a tela fechada.
- Playbooks: checklists executados passo a passo, cada passo em sessão limpa.

**Avisos**
- Central de notificações na Bancada, push no aparelho (Web Push), Telegram por pessoa e webhook.
- Cada pessoa escolhe quais eventos recebe e por onde: atividade concluída, pedido de aprovação, erro, agendamento e consumo perto do limite.

**Segurança e acesso** (detalhes em [docs/SEGURANCA.md](docs/SEGURANCA.md))
- Login individual com senha forte e aplicativo autenticador (2FA).
- Papéis (administrador, líder técnico, desenvolvedor, somente leitura), projetos liberados por pessoa e exceções de permissão.
- Aprovação de ações arriscadas, com quatro olhos em produção.
- Produção somente leitura, modo danger bloqueado em produção, mascaramento de dados sensíveis.
- Cofre cifrado para segredos e auditoria só de acréscimo.

## Requisitos

Onde a Bancada roda:
- Node.js 20.12 ou mais novo
- Acesso SSH por chave aos servidores (ssh-agent ou arquivo de chave)
- HTTPS na frente (proxy) se for usar push no celular

Em cada servidor de trabalho:
- `git`, `bash`, `python3` e `tmux`
- `claude` e/ou `codex` instalados **e logados** (`claude` → `/login`; `codex login`)
- `gh` autenticado, se quiser abrir PR pela tela

## App para Mac (DMG)

A Bancada também roda como aplicativo no MacBook: o app sobe o servidor só na própria máquina e abre a tela numa janela.

- **Baixar**: no GitHub, aba **Actions**, workflow **App para macOS (DMG)**, última execução, artefato **Bancada-macOS**. Há um DMG para Apple Silicon (arm64) e outro para Intel (x64).
- **Instalar**: abra o DMG e arraste a Bancada para Aplicativos.
- **Primeira abertura**: enquanto o app não for assinado com certificado da Apple, o macOS bloqueia. Clique com o botão direito no app e escolha **Abrir**. Se aparecer "danificado", rode no Terminal: `xattr -cr /Applications/Bancada.app`.
- **Primeiro acesso**: o app pede para criar o administrador (nome, login e senha) e depois configurar o autenticador. Pela conta do administrador você cadastra e convida as outras pessoas.
- **Dados**: ficam em `~/Library/Application Support/Bancada/dados`. A chave do cofre é gerada no primeiro uso e protegida pelo Keychain do macOS.
- **SSH**: o app usa o ssh-agent do Mac ou, se não houver, a chave `~/.ssh/id_ed25519` (ou `id_rsa`).
- **Assinar e notarizar** (recomendado para distribuir no time): cadastre nos secrets do repositório `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID`. O workflow passa a gerar o DMG assinado.

Para gerar localmente num Mac: `npm install && npm run dist:mac` (o DMG sai em `dist/`). Para testar sem empacotar: `npm run app`.

O app do Mac é para uso pessoal ou de quem está na mesma máquina. Para várias pessoas acessando a mesma Bancada, rode a versão servidor (abaixo) num servidor do time.

## Instalação no servidor

```bash
git clone <este repositório>
cd bancada
npm install
cp .env.example .env
openssl rand -hex 32          # cole em BANCADA_SECRET_KEY no .env
npm start
```

Abra `http://127.0.0.1:8787` **na própria máquina**: na primeira vez aparece a tela para criar o administrador (por segurança, só funciona a partir da própria máquina). Depois configure o autenticador e, pela área **Administração** da sua conta, cadastre e convide as outras pessoas.

Se preferir pelo terminal: `npm run create-admin -- ana "Ana Souza"` mostra uma senha temporária uma única vez.

**Guarde a `BANCADA_SECRET_KEY` também fora do servidor** (cofre de senhas do time). Sem ela, segredos de MCP e autenticadores não podem ser lidos; seria preciso recadastrar tudo.

Para usar fora da máquina local, **não exponha a porta na internet**: use VPN (Tailscale, WireGuard), túnel SSH (`ssh -L 8787:127.0.0.1:8787 servidor`) ou proxy com HTTPS e `COOKIE_SECURE=1`.

## Papéis padrão

| Permissão | Admin | Líder | Dev | Leitura |
|---|:-:|:-:|:-:|:-:|
| Ver projetos e conversas | sim | sim | sim | sim |
| Mensagens, terminal, commit, PR | sim | sim | sim | |
| Agendar tarefas, editar blocos de notas | sim | sim | sim | |
| Aprovar ações arriscadas, modo danger | sim | sim | | |
| Equipes, agentes, skills, projetos, auditoria | sim | sim | | |
| Convidar pessoas | sim | sim | | |
| MCPs e segredos, regras, integrações, usuários | sim | | | |

Qualquer permissão pode ser dada ou retirada só para uma pessoa. Só administradores concedem acesso administrativo.

## Configuração

| Arquivo | Para quê |
|---|---|
| `.env` | chave do cofre, SSH, Telegram, webhook, push, servidor de leitura do consumo |
| `config/agents.json` | flags de cada CLI (permissões, retomada, saída JSON) |
| `config/skills/*.md` | skills de reserva, se a biblioteca da tela estiver vazia |

Os CLIs mudam com frequência. Antes de usar, confira com `claude --help` e `codex exec --help` se as flags em `config/agents.json` continuam válidas: no Claude Code, `-p`, `--output-format stream-json --verbose`, `--permission-mode`, `--resume`, `--settings`, `--append-system-prompt`, `--mcp-config` e `--dangerously-skip-permissions`; no Codex, `exec --json`, prompt por `-` (stdin), `--sandbox`, `exec resume <id>` e `--dangerously-bypass-approvals-and-sandbox`.

MCPs no Codex ainda não são instalados pela Bancada; configure no `~/.codex/config.toml` do servidor.

Gemini CLI: a Bancada envia o prompt pela entrada padrão e lê a resposta em texto. Não há modo somente leitura configurado, então ele fica bloqueado em projetos de produção.

Portal: o navegador interno só abre sites que permitem ser exibidos dentro de outra página. Ajuste quais endereços podem abrir com `PORTAL_FRAME_SRC` no `.env`.

## Licenças das contas de IA

Planos individuais (Claude Pro ou Max, ChatGPT Plus ou Pro) costumam ser de uso pessoal. Compartilhar uma conta dessas com outras pessoas pela Bancada pode violar os termos de uso. Para times, prefira planos Team ou Enterprise, ou chave de API, e confirme com o Jurídico. Por padrão, toda conta nasce como "só o dono".

## Estrutura

```
src/
  server.js       rotas HTTP e WebSocket, com permissão checada em cada uma
  auth.js         login, sessões, página da conta (senha e autenticador)
  users.js        contas, scrypt, bloqueio por tentativas
  totp.js         códigos do autenticador (RFC 6238)
  permissions.js  papéis e permissões
  acl.js          o que cada pessoa vê e pode alterar
  vault.js        cofre AES-256-GCM
  inbox.js        notificações, push, Telegram e webhook
  scheduler.js    agendador e turnos das equipes
  sessions.js     envio aos agentes, orquestrador, terminal e playbooks
  agents.js       comandos e leitura da saída dos CLIs
  approvals.js    aprovações e hook remoto do Claude Code
  context.js      contexto entre janelas e blocos de notas
  git.js          worktree, diff, commit, descarte e PR
  store.js        estado, conversas e auditoria em arquivos
  ssh.js          SSH com verificação da chave do host
  policy.js       mascaramento, padrões arriscados, comandos de leitura
  usage.js        leitura de /usage e /status
  history.js      sessões antigas dos CLIs
scripts/create-admin.js
electron/main.js  app para macOS (Electron)
.github/workflows/mac-dmg.yml  gera o DMG no GitHub Actions
web/index.html    a tela (funciona sozinha em modo demonstração)
web/sw.js         service worker do push
remote/           hook instalado nos servidores
docs/             arquitetura e segurança
```

## Testes

```bash
npm test
```

Cobrem mascaramento, regras, leitura da saída dos CLIs, autenticador, cofre, contas (senha, bloqueio, último administrador) e controle de acesso (o que cada papel vê e o que é revertido).

O fluxo completo também foi validado contra um servidor SSH local com CLI simulado: primeiro acesso com troca de senha e 2FA, acessos restritos, tentativas de burlar permissões, quatro olhos em produção, turnos, blocos de notas, skills, MCP com segredo e derrubada de sessão ao desativar a conta. Antes de usar em servidores da empresa, repita com os CLIs reais num servidor de desenvolvimento.

## Antes de usar na empresa

- Valide com Tecnologia/Segurança onde a Bancada roda, quem acessa e como (VPN ou HTTPS).
- Use um usuário próprio em cada servidor de trabalho: quem acessa esse usuário usa a conta dos CLIs logada nele.
- Confira os termos de uso das assinaturas do Claude e do ChatGPT para uso por várias pessoas.
- Defina a licença deste repositório com o Jurídico antes de compartilhar fora do time.
