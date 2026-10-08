#!/data/data/com.termux/files/usr/bin/bash
# (Re)registra o Job 1002. period-ms=300000 (5 min) para acertar as janelas
# 06/08/12/16/20/22; o script descarta horários fora dessas janelas.

set -e
BASE="$HOME/shopee-grupos-automacao"
SCRIPT="$BASE/agendador-pipeline.sh"
JOB_ID=1002
PERIOD_MS=300000

if [ ! -f "$SCRIPT" ]; then
  echo "Script não encontrado: $SCRIPT"
  exit 1
fi
chmod +x "$SCRIPT" 2>/dev/null || true

termux-job-scheduler -c -j "$JOB_ID" 2>/dev/null || true

termux-job-scheduler \\
  -s "$SCRIPT" \\
  -j "$JOB_ID" \\
  --period-ms "$PERIOD_MS" \\
  --network any \\
  --charging false \\
  --battery-not-low false \\
  --storage-not-low false

echo "Job $JOB_ID registrado."
echo "  script: $SCRIPT"
echo "  period-ms: $PERIOD_MS (5 min)"
echo "  janelas no script: 06 08 12 16 20 22"
echo "Valide com: tail -f $BASE/agendador.log  e  cat $BASE/.ultima-execucao"
