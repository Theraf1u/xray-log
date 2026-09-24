#!/usr/bin/env bash
# install-agent.sh — установка xray-log-agent на VPN/Xray-ноде
#
# Что делает:
#   1. Проверяет ОС, права, наличие Docker
#   2. Устанавливает Docker (если нет)
#   3. Клонирует репо в /opt/xray-analyzer (если запущен через curl|bash)
#   4. Создаёт .env с настройками агента (NODE_ID, SERVER_URL, AUTH_TOKEN)
#   5. Проверяет что /var/log/remnanode/access.log пишется xray'ем
#   6. Билдит image агента + поднимает контейнер
#   7. Проверяет что подключение к серверу работает
#
# Использование (рекомендуется через env-переменные):
#   curl -fsSL <url>/install-agent.sh | sudo \
#     SERVER_URL="wss://analyzer.example.com/ws" \
#     AUTH_TOKEN="<AGENT_TOKEN из server>" \
#     NODE_ID="germany-1" \
#     bash
#
# Или интерактивно — без env-переменных скрипт спросит значения.
#
# Идемпотентно: повторный запуск обновит до latest и перезапустит контейнер.

set -euo pipefail

# ─── Constants ──────────────────────────────────────────────────────────────

# Run non-interactively: without this, apt/needrestart can pop up a
# whiptail dialog (e.g. "Pending kernel upgrade") that blocks forever
# waiting for a keypress when this script runs in a real TTY (an admin's
# own SSH session) instead of piped through curl|bash with no TTY at all.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

REPO_URL="${REPO_URL:-https://github.com/Theraf1u/xray-log.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/xray-analyzer}"
COMPOSE_DIR="$INSTALL_DIR"
ENV_FILE="$COMPOSE_DIR/.env"
LOG_PATH_DEFAULT="/var/log/remnanode"

# ─── Colors ─────────────────────────────────────────────────────────────────

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

log()  { printf "%s[%s]%s %s\n"   "$BLUE"  "INFO"  "$RESET" "$*"; }
ok()   { printf "%s[%s]%s %s\n"   "$GREEN" " OK "  "$RESET" "$*"; }
warn() { printf "%s[%s]%s %s\n"   "$YELLOW" "WARN" "$RESET" "$*"; }
err()  { printf "%s[%s]%s %s\n"   "$RED"   "FAIL" "$RESET" "$*" >&2; }

die() { err "$*"; exit 1; }

# ─── Pre-flight ─────────────────────────────────────────────────────────────

[[ $EUID -eq 0 ]] || die "Запусти под root (sudo)"

if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    case "$ID" in
        ubuntu|debian) ;;
        *) warn "OS '$ID' не тестировалась; продолжаю на свой риск." ;;
    esac
fi

# ─── Collect parameters ─────────────────────────────────────────────────────

# Try env first; fall back to interactive prompts. Reading from /dev/tty
# specifically because stdin may be the curl pipe.
prompt_if_unset() {
    local var=$1 prompt=$2 default=${3:-}
    if [[ -z "${!var:-}" ]]; then
        if [[ -t 0 ]] || [[ -e /dev/tty ]]; then
            if [[ -n "$default" ]]; then
                read -r -p "$prompt [$default]: " val </dev/tty || true
                [[ -z "$val" ]] && val="$default"
            else
                read -r -p "$prompt: " val </dev/tty || true
            fi
            printf -v "$var" '%s' "$val"
        else
            die "Переменная $var не задана и нет интерактивного terminal'а"
        fi
    fi
}

# ─── Pairing (no AUTH_TOKEN yet) ────────────────────────────────────────────
#
# Three ways to end up with NODE_ID/SERVER_URL/AUTH_TOKEN set: paste the
# whole command the panel's "Добавить ноду" button generated (all three
# already in the env, this block is skipped entirely) — or, if AUTH_TOKEN
# is missing, request a short pairing code from the panel and wait for an
# admin to approve it there. Pairing needs only the panel's own URL, never
# a token, since a fresh node has no token yet to prove it's legitimate —
# that's the admin's job, approving the code against a specific Remnawave
# node in the panel.
pairing_flow() {
    prompt_if_unset PANEL_URL "PANEL_URL (https://analyzer.example.com — без токена)"
    PANEL_URL="${PANEL_URL%/}"

    local ip hint
    ip="$(curl -s -4 -m 3 ifconfig.me 2>/dev/null)"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || ip="unknown"
    hint="$(hostname) ($ip)"

    log "Запрашиваю код привязки у $PANEL_URL ..."
    local resp code
    resp="$(curl -fsS -m 10 -X POST "$PANEL_URL/api/nodes/pair/request" \
        -H "Content-Type: application/json" \
        -d "{\"hint\":\"${hint}\"}")" || die "Не смог достучаться до $PANEL_URL — проверь адрес и что панель доступна отсюда"
    code="$(echo "$resp" | grep -oP '"code"\s*:\s*"\K[^"]+')"
    [[ -n "$code" ]] || die "Панель не вернула код: $resp"

    cat <<MSG

${BOLD}${YELLOW}════════════════════════════════════════════════════════════════════${RESET}
  Код привязки: ${BOLD}${GREEN}${code}${RESET}
${BOLD}${YELLOW}════════════════════════════════════════════════════════════════════${RESET}

  Открой панель → ${BOLD}Ноды${RESET} → ${BOLD}Добавить ноду${RESET} → раздел «Есть код с ноды» →
  введи ${BOLD}${code}${RESET} и выбери, какой нодой Remnawave физически является этот сервер.

  Жду подтверждения (код живёт 15 минут)...

MSG

    local deadline=$(( $(date +%s) + 900 ))
    while (( $(date +%s) < deadline )); do
        resp="$(curl -fsS -m 10 "$PANEL_URL/api/nodes/pair/status?code=${code}" 2>/dev/null)" || true
        if echo "$resp" | grep -q '"approved"\s*:\s*true'; then
            NODE_ID="$(echo "$resp" | grep -oP '"node_id"\s*:\s*"\K[^"]+')"
            SERVER_URL="$(echo "$resp" | grep -oP '"server_url"\s*:\s*"\K[^"]+')"
            AUTH_TOKEN="$(echo "$resp" | grep -oP '"auth_token"\s*:\s*"\K[^"]+')"
            [[ -n "$NODE_ID" && -n "$SERVER_URL" && -n "$AUTH_TOKEN" ]] || die "Панель подтвердила код, но не прислала параметры: $resp"
            ok "Привязано к ноде «$NODE_ID» — продолжаю установку"
            return
        fi
        sleep 5
    done
    die "Код не подтверждён за 15 минут — запусти установку заново"
}

if [[ -z "${AUTH_TOKEN:-}" ]]; then
    pairing_flow
fi

prompt_if_unset NODE_ID    "NODE_ID (уникальный id ноды, e.g. germany-1)" "$(hostname)"
prompt_if_unset SERVER_URL "SERVER_URL (wss://analyzer.example.com/ws)"
prompt_if_unset AUTH_TOKEN "AUTH_TOKEN (AGENT_TOKEN из server .env)"

LOG_PATH="${LOG_PATH:-$LOG_PATH_DEFAULT}"
BATCH_SIZE="${BATCH_SIZE:-1000}"
BATCH_TIMEOUT="${BATCH_TIMEOUT:-5s}"

# Validate
[[ -n "$NODE_ID" ]]    || die "NODE_ID не задан"
[[ -n "$SERVER_URL" ]] || die "SERVER_URL не задан"
[[ -n "$AUTH_TOKEN" ]] || die "AUTH_TOKEN не задан"
[[ "$SERVER_URL" =~ ^wss?:// ]] || die "SERVER_URL должен начинаться с ws:// или wss://"

ok "Параметры: NODE_ID=$NODE_ID  SERVER_URL=$SERVER_URL  LOG_PATH=$LOG_PATH"

# ─── Install Docker ─────────────────────────────────────────────────────────

add_docker_apt_repo() {
    apt-get update -qq
    apt-get install -qq -y ca-certificates curl gnupg

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/${ID}/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/${ID} \
        $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
}

if ! command -v docker >/dev/null 2>&1; then
    log "Docker не найден. Устанавливаю..."
    add_docker_apt_repo
    apt-get install -qq -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin

    systemctl enable --now docker
    ok "Docker установлен"
else
    ok "Docker уже установлен ($(docker --version))"
fi

# Некоторые провайдеры предустанавливают Docker без плагина docker compose
# (например голый docker.io из apt) — без него билд/запуск агента падает молча.
if ! docker compose version >/dev/null 2>&1; then
    log "Плагин docker compose не найден. Устанавливаю docker-compose-plugin..."
    if [[ ! -f /etc/apt/sources.list.d/docker.list ]]; then
        add_docker_apt_repo
    fi
    apt-get install -qq -y docker-compose-plugin docker-buildx-plugin \
        || die "Не удалось установить docker-compose-plugin"
    docker compose version >/dev/null 2>&1 \
        || die "docker compose всё ещё недоступен после установки плагина"
    ok "docker-compose-plugin установлен ($(docker compose version --short 2>/dev/null))"
fi

# ─── Verify Xray writes access log ──────────────────────────────────────────

if [[ ! -d "$LOG_PATH" ]]; then
    warn "$LOG_PATH не существует. Создаю — но xray должен туда писать."
    mkdir -p "$LOG_PATH"
fi

ACCESS_LOG="$LOG_PATH/access.log"
if [[ ! -f "$ACCESS_LOG" ]]; then
    warn "$ACCESS_LOG не существует. Возможно xray ещё не настроен на запись access log."
    warn "Проверь Remnawave Config Profile:"
    cat <<'EOF'
  "log": {
    "access":   "/var/log/remnanode/access.log",
    "error":    "/var/log/remnanode/error.log",
    "loglevel": "warning"
  }
EOF
    warn "А также volume в docker-compose.yml у remnanode: /var/log/remnanode:/var/log/remnanode"
    warn "Скрипт продолжит, но агент не будет видеть данных пока xray не начнёт писать."
elif [[ ! -s "$ACCESS_LOG" ]]; then
    warn "$ACCESS_LOG существует, но пустой. Возможно xray не пишет туда сейчас."
else
    ACCESS_LINES=$(wc -l < "$ACCESS_LOG")
    ACCESS_AGE=$(( $(date +%s) - $(stat -c %Y "$ACCESS_LOG") ))
    if (( ACCESS_AGE > 300 )); then
        warn "$ACCESS_LOG не обновлялся ${ACCESS_AGE}s — xray мог перестать писать"
    else
        ok "$ACCESS_LOG: ${ACCESS_LINES} строк, обновлён ${ACCESS_AGE}s назад ✓"
    fi
fi

# Logrotate setup — без него access.log разрастётся до GBs
LOGROTATE_FILE=/etc/logrotate.d/remnanode
if [[ ! -f "$LOGROTATE_FILE" ]]; then
    log "Настраиваю logrotate для $LOG_PATH/*.log"
    cat > "$LOGROTATE_FILE" <<EOF
$LOG_PATH/*.log {
    size 500M
    rotate 0
    notifempty
    missingok
    copytruncate
}
EOF
    ok "Создан $LOGROTATE_FILE"
fi

# ─── Clone repo ─────────────────────────────────────────────────────────────

if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Репо уже клонирован — git pull..."
    git -C "$INSTALL_DIR" fetch --quiet origin
    git -C "$INSTALL_DIR" checkout --quiet main
    git -C "$INSTALL_DIR" pull --quiet --ff-only origin main
    ok "Репо обновлён до $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
else
    if [[ -d "$INSTALL_DIR" ]]; then
        die "$INSTALL_DIR существует, но не git-repo. Удали его или используй INSTALL_DIR=..."
    fi
    log "Клонирую $REPO_URL → $INSTALL_DIR"
    if ! command -v git >/dev/null; then apt-get install -qq -y git; fi
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
    ok "Клонирован: $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

[[ -d "$COMPOSE_DIR" ]] || die "Не нашёл $COMPOSE_DIR — структура репо изменилась?"

# ─── Write .env ─────────────────────────────────────────────────────────────

# server and agent share one .env in this repo layout (unlike two separate
# component directories) — install-server.sh may have already written
# POSTGRES_PASSWORD/API_TOKEN/REMNAWAVE_*/TELEGRAM_* into this exact file
# on a box running both. A plain `cat >` here used to truncate the file
# and wipe all of that out from under a running server. set_env_var
# upserts one KEY=VALUE line at a time — updates it in place if present,
# appends it if not — so pre-existing keys this script doesn't own are
# left untouched.
set_env_var() {
    local key="$1" value="$2"
    if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

log "Записываю параметры агента в $ENV_FILE..."
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
set_env_var "NODE_ID" "$NODE_ID"
set_env_var "SERVER_URL" "$SERVER_URL"
set_env_var "AUTH_TOKEN" "$AUTH_TOKEN"
set_env_var "LOG_HOST_PATH" "$LOG_PATH"
set_env_var "LOG_FILE_PATH" "/var/log/remnanode/access.log"
set_env_var "BATCH_SIZE" "$BATCH_SIZE"
set_env_var "BATCH_TIMEOUT" "$BATCH_TIMEOUT"
set_env_var "ENABLE_COMPRESSION" "true"
ok ".env обновлён (существующие ключи сервера, если есть, не тронуты)"

# ─── Build & start ──────────────────────────────────────────────────────────

cd "$COMPOSE_DIR"

log "Билдим xray-log-agent image (~30s)..."
docker compose -f docker-compose.agent.yml build xray-log-agent 2>&1 | tail -3

log "Запускаю агент..."
docker compose -f docker-compose.agent.yml up -d --force-recreate xray-log-agent

# ─── Verify connection ─────────────────────────────────────────────────────

log "Жду 8 секунд и проверяю logs..."
sleep 8

LOGS=$(docker logs --tail 30 xray-log-agent 2>&1)

if echo "$LOGS" | grep -qiE "connected|websocket.*open|connection established"; then
    ok "Агент подключился к серверу ✓"
elif echo "$LOGS" | grep -qiE "401|403|forbidden|unauthorized"; then
    err "AUTH_TOKEN неправильный — сервер отклоняет."
    err "Проверь что AUTH_TOKEN на агенте совпадает с AGENT_TOKEN на сервере."
    err "Logs:"
    echo "$LOGS" | tail -10
    exit 1
elif echo "$LOGS" | grep -qiE "tls|x509|certificate"; then
    err "TLS / cert error. Возможно SERVER_URL имеет неверный domain или TLS на reverse-proxy не работает."
    err "Logs:"
    echo "$LOGS" | tail -10
    exit 1
elif echo "$LOGS" | grep -qiE "connection refused|no route to host|name or service not known"; then
    err "Не могу достучаться до $SERVER_URL"
    err "Проверь что reverse-proxy на сервере настроен и DNS резолвится."
    err "Logs:"
    echo "$LOGS" | tail -10
    exit 1
else
    warn "Не вижу явного сигнала об успешном подключении. Logs:"
    echo "$LOGS" | tail -15
    warn "Это может быть ОК — последи 30 секунд:"
    warn "  docker compose -f $COMPOSE_DIR/docker-compose.agent.yml logs -f xray-log-agent"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

cat <<EOF

${BOLD}${GREEN}════════════════════════════════════════════════════════════════════${RESET}
${BOLD}${GREEN}✓ Агент установлен${RESET}
${BOLD}${GREEN}════════════════════════════════════════════════════════════════════${RESET}

${BOLD}NODE_ID:${RESET}     $NODE_ID
${BOLD}SERVER:${RESET}      $SERVER_URL
${BOLD}LOG:${RESET}         $ACCESS_LOG

${BOLD}Полезные команды:${RESET}
  cd $COMPOSE_DIR

  # Логи в реальном времени
  docker compose -f docker-compose.agent.yml logs -f xray-log-agent

  # Restart
  docker compose -f docker-compose.agent.yml restart xray-log-agent

  # Stop
  docker compose -f docker-compose.agent.yml down

  # Update до latest версии
  git -C $INSTALL_DIR pull origin main
  docker compose -f docker-compose.agent.yml build xray-log-agent
  docker compose -f docker-compose.agent.yml up -d --force-recreate

${BOLD}Проверь что нода появилась на сервере:${RESET}
  curl -sS -H "Authorization: Bearer <API_TOKEN>" \\
    https://analyzer.example.com/api/nodes | jq '.[] | select(.node_id == "$NODE_ID")'

EOF
