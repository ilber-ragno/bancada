#!/usr/bin/env bash
# Hook PreToolUse do Claude Code instalado pela Bancada.
# Pede aprovação ao painel antes de comandos Bash que não sejam só de leitura.
# A troca acontece por arquivos em ~/.bancada/approvals (nenhuma porta é aberta).
set -uo pipefail
DIR="$HOME/.bancada/approvals"
mkdir -p "$DIR"
INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)"

# Comandos simples de leitura passam direto
if printf '%s' "$CMD" | grep -Eq '^[[:space:]]*(ls|pwd|git (status|log|diff|show|branch)|rg|grep|head|tail|wc|find)( |$)' \
   && ! printf '%s' "$CMD" | grep -Eq '[;&|>`$]'; then
  exit 0
fi

ID="$(date +%s%N)-$$"
printf '%s' "$INPUT" > "$DIR/$ID.req.tmp" && mv "$DIR/$ID.req.tmp" "$DIR/$ID.req"
LIMIT="${BANCADA_APPROVAL_TIMEOUT:-900}"
for _ in $(seq 1 "$LIMIT"); do
  if [ -f "$DIR/$ID.res" ]; then
    R="$(cat "$DIR/$ID.res")"
    rm -f "$DIR/$ID.res" "$DIR/$ID.req"
    if [ "$R" = "allow" ]; then exit 0; fi
    echo "Comando negado pela Bancada." >&2
    exit 2
  fi
  sleep 1
done
rm -f "$DIR/$ID.req"
echo "Sem resposta da Bancada em ${LIMIT}s. Comando não executado." >&2
exit 2
