#!/usr/bin/env bash
# Lounge XRAY Logs - unified installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Theraf1u/xray-log/main/install.sh | sudo bash
#
# Lets you pick what to install on this machine: only the Agent (log
# shipper, for an Xray/VPN node), only the Server (the analytics panel +
# Postgres + Redis), or both together on the same box. Delegates to
# scripts/install-server.sh and scripts/install-agent.sh for the actual
# work - this script is just the menu plus the bridging logic for "both"
# (reading the AGENT_TOKEN a freshly-installed local server generated and
# handing it straight to the agent installer, so there's no copy-pasting
# a token out of .env by hand).
#
# Installs itself as `xlog` on first run, so the menu is reachable from
# anywhere on the box afterward, not just from within the checkout.
#
# Server and agent share one .env and one INSTALL_DIR in this repo's
# layout (unlike a server/ + agent/ split) - install-agent.sh merges its
# keys into that file rather than overwriting it, specifically so this
# "both on one box" path can't wipe out the server's own config.
set -uo pipefail

REPO_URL="https://github.com/Theraf1u/xray-log.git"
DEFAULT_INSTALL_DIR="/opt/xray-analyzer"
XLOG_COMMAND="/usr/local/bin/xlog"
PROJECT_DIR=""

# ------------------------------------------------------------------
# Colors / box drawing
# ------------------------------------------------------------------
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_BORDER='\033[0;32m'
C_NICK='\033[1;35m'
C_SUB='\033[0;36m'
C_LABEL='\033[0;36m'
C_NUM='\033[1;33m'
C_OK='\033[0;32m'
C_OFF='\033[0;90m'
C_ERR='\033[0;31m'

BOX_WIDTH=62

hr() { printf '─%.0s' $(seq 1 "$BOX_WIDTH"); }
box_top()    { printf "${C_BORDER}┌%b┐${C_RESET}\n" "$(hr)"; }
box_bottom() { printf "${C_BORDER}└%b┘${C_RESET}\n" "$(hr)"; }
box_empty()  { printf "${C_BORDER}│${C_RESET}%${BOX_WIDTH}s${C_BORDER}│${C_RESET}\n" ""; }

# $1 = plain text used only to compute padding, $2 = the (possibly
# colored) text actually printed - kept separate because ANSI escape
# bytes would otherwise get counted as visible width.
box_line() {
    local plain="  $1" colored="  $2"
    local pad=$(( BOX_WIDTH - ${#plain} ))
    [ "$pad" -lt 0 ] && pad=0
    printf "${C_BORDER}│${C_RESET}%b%*s${C_BORDER}│${C_RESET}\n" "$colored" "$pad" ""
}

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "Этот установщик нужно запускать от root (используй sudo)." >&2
        exit 1
    fi
}

# The node's public IP, not its hostname - an admin managing a dozen VPN
# nodes from the /nodes page recognizes "45.137.202.118" at a glance,
# while a generic cloud-provider hostname tells them nothing. Falls back
# to hostname if outbound access to ifconfig.me fails, so setup never
# hard-fails on it.
detect_node_ip() {
    local ip
    ip="$(curl -s -4 -m 3 ifconfig.me 2>/dev/null)"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$ip"
    else
        hostname
    fi
}

# If this script is already running from inside a checkout (scripts/ and
# docker-compose.yml sitting right next to it), use that instead of
# cloning a second copy - lets `cd xray-log && sudo bash install.sh` work
# too, not just the curl-pipe-bash one-liner or the installed `xlog`
# command.
resolve_project_dir() {
    local here
    here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd 2>/dev/null || echo "")"
    if [ -n "$here" ] && [ -f "$here/docker-compose.yml" ] && [ -f "$here/scripts/install-agent.sh" ]; then
        PROJECT_DIR="$here"
        return
    fi
    if [ -f "$DEFAULT_INSTALL_DIR/docker-compose.yml" ] && [ -f "$DEFAULT_INSTALL_DIR/scripts/install-agent.sh" ]; then
        PROJECT_DIR="$DEFAULT_INSTALL_DIR"
        return
    fi
    echo "[*] Клонирую Lounge XRAY Logs в $DEFAULT_INSTALL_DIR ..."
    if ! command -v git >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq git
    fi
    git clone --quiet "$REPO_URL" "$DEFAULT_INSTALL_DIR"
    PROJECT_DIR="$DEFAULT_INSTALL_DIR"
}

# Installs this script itself as `xlog` so the menu is reachable from
# anywhere afterward. A plain copy (not a symlink) - keeps working even
# if invoked via curl|bash, where there is no source file to link to.
install_xlog_command() {
    if [ -f "$XLOG_COMMAND" ] && cmp -s "$PROJECT_DIR/install.sh" "$XLOG_COMMAND" 2>/dev/null; then
        return
    fi
    # Write to a temp file and rename into place rather than overwriting
    # $XLOG_COMMAND directly - this process may itself be executing from
    # that exact inode (re-running `xlog` after a git pull), and an
    # in-place cp/write would truncate the file bash is still reading
    # from mid-script. A rename swaps the directory entry atomically and
    # leaves the old inode's contents intact for any process still using it.
    local tmp="${XLOG_COMMAND}.new.$$"
    cp "$PROJECT_DIR/install.sh" "$tmp"
    chmod +x "$tmp"
    mv -f "$tmp" "$XLOG_COMMAND"
}

# Server = xray-log-analyzer container exists (docker-compose up ran at
# least once for it); agent = xray-log-agent container exists. Presence
# is checked by container, not by .env, because server and agent share
# one .env file on this box - .env existing says nothing about which of
# the two was actually installed.
component_status() {
    local name="$1" # xray-log-analyzer | xray-log-agent
    if ! docker inspect "$name" >/dev/null 2>&1; then
        printf "${C_OFF}не установлен${C_RESET}"
        return
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]; then
        printf "${C_OK}установлен, работает${C_RESET}"
    else
        printf "${C_ERR}установлен, не запущен${C_RESET}"
    fi
}

server_installed() { docker inspect xray-log-analyzer >/dev/null 2>&1; }
agent_installed()  { docker inspect xray-log-agent >/dev/null 2>&1; }

# "THERAF1U" rendered in the ANSI Shadow figlet font.
print_logo() {
    printf "${C_NICK}"
    cat <<'LOGO'
████████╗██╗  ██╗███████╗██████╗  █████╗ ███████╗ ██╗██╗   ██╗
╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔══██╗██╔════╝███║██║   ██║
   ██║   ███████║█████╗  ██████╔╝███████║█████╗  ╚██║██║   ██║
   ██║   ██╔══██║██╔══╝  ██╔══██╗██╔══██║██╔══╝   ██║██║   ██║
   ██║   ██║  ██║███████╗██║  ██║██║  ██║██║      ██║╚██████╔╝
   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝      ╚═╝ ╚═════╝
LOGO
    printf "${C_RESET}"
}

print_banner() {
    clear 2>/dev/null || true
    echo
    print_logo
    printf "${C_SUB}Lounge XRAY Logs${C_RESET}\n"
    echo
    printf "${C_LABEL}Запуск из любой точки сервера:${C_RESET} ${C_BOLD}%s${C_RESET}\n" "xlog"
    printf "${C_LABEL}Server:${C_RESET} %b   ${C_LABEL}Agent:${C_RESET} %b\n" "$(component_status xray-log-analyzer)" "$(component_status xray-log-agent)"
    echo
}

print_menu_box() {
    box_top
    box_line "1) Оба          - сервер (панель) и агент на этой машине" "${C_NUM}1)${C_RESET} Оба          - сервер (панель) и агент на этой машине"
    box_line "2) Agent        - только сборщик логов (для VPN-ноды)" "${C_NUM}2)${C_RESET} Agent        - только сборщик логов (для VPN-ноды)"
    box_line "3) Server       - только панель + БД (центральная точка)" "${C_NUM}3)${C_RESET} Server       - только панель + БД (центральная точка)"
    box_line "4) Статус       - что установлено и работает" "${C_NUM}4)${C_RESET} Статус       - что установлено и работает"
    box_line "5) Диагностика  - проверить установленные компоненты" "${C_NUM}5)${C_RESET} Диагностика  - проверить установленные компоненты"
    box_line "6) Управление скриптом  - переустановка, обновление" "${C_NUM}6)${C_RESET} Управление скриптом  - переустановка, обновление"
    box_line "7) Добавить ноду       - команда установки для новой VPN-ноды" "${C_NUM}7)${C_RESET} Добавить ноду       - команда установки для новой VPN-ноды"
    box_line "8) Сбросить ключ входа - новый пароль для входа в панель" "${C_NUM}8)${C_RESET} Сбросить ключ входа - новый пароль для входа в панель"
    box_empty
    box_line "0) Выход" "${C_NUM}0)${C_RESET} Выход"
    box_bottom
}

show_status() {
    echo
    printf "${C_LABEL}Server:${C_RESET} %b\n" "$(component_status xray-log-analyzer)"
    printf "${C_LABEL}Agent:${C_RESET}  %b\n" "$(component_status xray-log-agent)"
    if server_installed; then
        echo
        printf "${C_LABEL}Postgres:${C_RESET} %b   ${C_LABEL}Redis:${C_RESET} %b\n" "$(component_status analyzer-postgres)" "$(component_status analyzer-redis)"
    fi
    echo
    read -r -p "Enter - назад в меню" _ </dev/tty
}

# No dedicated doctor.sh in this repo (unlike a larger project with one
# per component) - this inline version covers the checks that actually
# catch real installs going wrong: Docker/Compose present, the containers
# each component depends on healthy, and (for the agent) that it's
# actually reading a growing access.log rather than sitting idle.
run_doctor() {
    echo
    if ! command -v docker >/dev/null 2>&1; then
        printf "${C_ERR}[FAIL]${C_RESET} Docker не установлен\n"
    else
        printf "${C_OK}[ OK ]${C_RESET} Docker: $(docker --version | cut -d, -f1)\n"
    fi
    if ! docker compose version >/dev/null 2>&1; then
        printf "${C_ERR}[FAIL]${C_RESET} Docker Compose plugin не найден\n"
    else
        printf "${C_OK}[ OK ]${C_RESET} Docker Compose: $(docker compose version --short 2>/dev/null)\n"
    fi

    if server_installed; then
        echo
        echo "== Server =="
        for name in xray-log-analyzer analyzer-postgres analyzer-redis; do
            local health running
            running="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
            health="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo "нет healthcheck")"
            if [ "$running" = "true" ]; then
                printf "${C_OK}[ OK ]${C_RESET} %s: запущен (%s)\n" "$name" "$health"
            else
                printf "${C_ERR}[FAIL]${C_RESET} %s: не запущен\n" "$name"
            fi
        done
        if [ -f "$PROJECT_DIR/.env" ] && grep -q '^API_TOKEN=.\+' "$PROJECT_DIR/.env"; then
            printf "${C_OK}[ OK ]${C_RESET} API_TOKEN задан в .env\n"
        else
            printf "${C_ERR}[FAIL]${C_RESET} API_TOKEN не задан в .env\n"
        fi
        if curl -fsS -m 3 http://localhost:8237/health >/dev/null 2>&1; then
            printf "${C_OK}[ OK ]${C_RESET} /health отвечает\n"
        else
            printf "${C_ERR}[FAIL]${C_RESET} /health не отвечает на localhost:8237\n"
        fi
    fi

    if agent_installed; then
        echo
        echo "== Agent =="
        local running
        running="$(docker inspect --format '{{.State.Running}}' xray-log-agent 2>/dev/null || echo false)"
        if [ "$running" = "true" ]; then
            printf "${C_OK}[ OK ]${C_RESET} xray-log-agent: запущен\n"
        else
            printf "${C_ERR}[FAIL]${C_RESET} xray-log-agent: не запущен\n"
        fi
        local log_path
        log_path="$(grep -E '^LOG_HOST_PATH=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2-)"
        log_path="${log_path:-/var/log/remnanode}/access.log"
        if [ -f "$log_path" ] && find "$log_path" -mmin -5 2>/dev/null | grep -q .; then
            printf "${C_OK}[ OK ]${C_RESET} %s обновлялся в последние 5 минут\n" "$log_path"
        elif [ -f "$log_path" ]; then
            printf "${C_ERR}[FAIL]${C_RESET} %s существует, но не обновлялся 5+ минут — xray пишет логи?\n" "$log_path"
        else
            printf "${C_ERR}[FAIL]${C_RESET} %s не найден — проверь LOG_HOST_PATH в .env\n" "$log_path"
        fi
        docker logs --tail 20 xray-log-agent 2>&1 | grep -qiE "401|403|forbidden|unauthorized" \
            && printf "${C_ERR}[FAIL]${C_RESET} В логах агента признаки неверного AUTH_TOKEN\n"
    fi

    if ! server_installed && ! agent_installed; then
        echo
        echo "Ничего не установлено — нечего проверять."
    fi
    echo
    read -r -p "Enter - назад в меню" _ </dev/tty
}

show_menu() {
    print_banner
    print_menu_box
    echo
    local choice
    read -r -p "$(printf "${C_LABEL}Выбери действие${C_RESET} ${C_OFF}[0-8]${C_RESET}: ")" choice </dev/tty
    case "$choice" in
        1) install_both; read -r -p "Enter - назад в меню" _ </dev/tty; show_menu ;;
        2) exec bash "$PROJECT_DIR/scripts/install-agent.sh" ;;
        3) exec bash "$PROJECT_DIR/scripts/install-server.sh" ;;
        4) show_status; show_menu ;;
        5) run_doctor; show_menu ;;
        6) script_management_menu; show_menu ;;
        7) add_node_via_cli; read -r -p "Enter - назад в меню" _ </dev/tty; show_menu ;;
        8) reset_api_token; read -r -p "Enter - назад в меню" _ </dev/tty; show_menu ;;
        0) exit 0 ;;
        *) echo "Неверный выбор."; sleep 1; show_menu ;;
    esac
}

# jq is the one new dependency this needs (parsing the panel's JSON API
# from a shell script without it is real pain) - installed on demand, same
# bootstrap pattern as Docker itself, rather than assumed present.
ensure_jq() {
    command -v jq >/dev/null 2>&1 && return
    echo "[*] Устанавливаю jq ..."
    apt-get update -qq && apt-get install -y -qq jq
}

# Flow 3 from the "add a node" trio: run this ON the panel server, pick a
# Remnawave node from a plain numbered list (same linking logic as
# clicking "Добавить ноду" in the web UI — see handleCreateNodeFromPanel),
# and get back the one-line command to go paste on the actual VPN node's
# own terminal.
add_node_via_cli() {
    if ! server_installed; then
        echo "Server не установлен на этой машине — команду добавления ноды может выдать только сервер." >&2
        return 1
    fi
    ensure_jq

    local api_token
    api_token="$(grep -E '^API_TOKEN=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2-)"
    if [ -z "$api_token" ]; then
        echo "API_TOKEN не найден в $PROJECT_DIR/.env" >&2
        return 1
    fi

    echo
    echo "[*] Загружаю список нод панели ..."
    local resp
    resp="$(curl -fsS -H "Authorization: Bearer $api_token" http://localhost:8237/api/remnawave/nodes/list)" \
        || { echo "Не удалось получить список нод (сервер отвечает?)" >&2; return 1; }

    # Enabled and not yet linked — same default view as the web picker.
    # linked_to is only present in the JSON when set (omitempty), so
    # `.linked_to == null` covers both "absent" and "explicit null".
    local rows
    rows="$(echo "$resp" | jq -r '[.[] | select(.is_disabled==false and (.linked_to==null))] | sort_by(.name) | .[] | "\(.uuid)\t\(.name)\t\(.address):\(.port)"')"
    if [ -z "$rows" ]; then
        echo "Нет доступных нод — все включённые ноды панели уже привязаны."
        echo "Полный список и переключение фильтров — в веб-панели, «Добавить ноду»."
        return 0
    fi

    echo
    echo "Доступные ноды панели (включённые, ещё не привязанные):"
    echo
    local i=1 uuids=() names=()
    while IFS=$'\t' read -r uuid name addr; do
        printf "  ${C_NUM}%2d)${C_RESET} %-30s %s\n" "$i" "$name" "$addr"
        uuids+=("$uuid")
        names+=("$name")
        i=$((i + 1))
    done <<< "$rows"

    echo
    local choice
    read -r -p "Выбери номер (0 - отмена): " choice </dev/tty
    [ "$choice" = "0" ] && { echo "Отменено."; return 0; }
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#uuids[@]}" ]; then
        echo "Неверный выбор." >&2
        return 1
    fi
    local uuid="${uuids[$((choice - 1))]}" name="${names[$((choice - 1))]}"

    local link_resp node_id command
    link_resp="$(curl -fsS -X POST -H "Authorization: Bearer $api_token" -H "Content-Type: application/json" \
        -d "{\"remna_uuid\":\"${uuid}\"}" http://localhost:8237/api/nodes/create-from-panel)" \
        || { echo "Не удалось привязать ноду" >&2; return 1; }
    node_id="$(echo "$link_resp" | jq -r '.node_id')"
    command="$(echo "$link_resp" | jq -r '.command')"
    if [ -z "$node_id" ] || [ "$node_id" = "null" ]; then
        echo "Сервер не вернул node_id: $link_resp" >&2
        return 1
    fi

    cat <<MSG

${C_OK}Нода «${name}» привязана как node_id=${node_id}${C_RESET}

Выполни эту команду на сервере ${C_BOLD}этой самой ноды${C_RESET} (не здесь) по SSH, от root:

${command}

MSG
}

# The API_TOKEN is what the login screen checks — resetting it
# immediately logs out every open browser session, which is the whole
# point (e.g. the token leaked, or someone who had it shouldn't anymore).
reset_api_token() {
    if ! server_installed; then
        echo "Server не установлен на этой машине." >&2
        return 1
    fi
    echo
    echo "Это сгенерирует новый ключ входа в панель и перезапустит Server."
    echo "Все, кто сейчас залогинен, будут разлогинены и введут новый ключ."
    local confirm
    read -r -p "Продолжить? (y/n): " confirm </dev/tty
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Отменено."
        return 0
    fi

    local new_token
    new_token="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)"
    sed -i "s|^API_TOKEN=.*|API_TOKEN=${new_token}|" "$PROJECT_DIR/.env"

    echo "[*] Перезапускаю Server ..."
    (cd "$PROJECT_DIR" && docker compose up -d --force-recreate xray-log-analyzer) >/dev/null

    cat <<MSG

${C_OK}Новый ключ входа: ${C_BOLD}${new_token}${C_RESET}

Сохрани его — старый больше не работает, включая уже открытые вкладки панели.
MSG
}

install_both() {
    if server_installed; then
        echo "[*] Server уже установлен — пропускаю установку сервера."
    else
        echo
        echo "[*] Устанавливаю Server ..."
        if ! bash "$PROJECT_DIR/scripts/install-server.sh"; then
            echo "[FAILED] Установка сервера не завершилась. Смотри ошибку выше." >&2
            exit 1
        fi
    fi

    if agent_installed; then
        echo
        echo "[*] Agent уже установлен — пропускаю установку агента."
        echo "[OK] Готово. Server и Agent уже установлены на этой машине."
        return
    fi

    local agent_token
    agent_token="$(grep -E '^AGENT_TOKEN=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2-)"
    if [ -z "$agent_token" ]; then
        echo "[FAILED] Не нашёл AGENT_TOKEN в $PROJECT_DIR/.env — сервер установился без него?" >&2
        exit 1
    fi

    echo
    local node_id
    node_id="$(detect_node_ip)"
    echo "[*] Настраиваю Agent на этой же машине (SERVER_URL=ws://127.0.0.1:8237/ws, NODE_ID=$node_id)"
    echo "    Меняется потом в $PROJECT_DIR/.env, если нужно другое имя."

    if ! SERVER_URL="ws://127.0.0.1:8237/ws" AUTH_TOKEN="$agent_token" NODE_ID="$node_id" \
        bash "$PROJECT_DIR/scripts/install-agent.sh"; then
        echo "[FAILED] Установка агента не завершилась. Смотри ошибку выше." >&2
        exit 1
    fi

    echo
    echo "[OK] Server + Agent установлены и запущены на этой машине."
    echo "     Панель: http://$(hostname -I | awk '{print $1}'):3925"
}

# Actual teardown work, no prompts - shared by uninstall_all() and
# reinstall_all() so there's exactly one place that knows how to fully
# remove the thing, instead of two copies that can drift apart.
#
# `down` alone (no -v) leaves both the named volumes (analyzer-data,
# analyzer-redis-data) and the bind-mounted Postgres path intact.
# uninstall_all() asks separately before wiping data, since that's the one
# step in this whole flow that's actually irreversible.
_do_compose_down() {
    if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
        (cd "$PROJECT_DIR" && docker compose down --rmi local 2>/dev/null) || true
    fi
    if [ -f "$PROJECT_DIR/docker-compose.agent.yml" ]; then
        (cd "$PROJECT_DIR" && docker compose -f docker-compose.agent.yml down --rmi local 2>/dev/null) || true
    fi
    docker rm -f xray-log-analyzer xray-log-agent analyzer-postgres analyzer-redis >/dev/null 2>&1 || true
}

# Postgres in this repo's docker-compose.yml is a bind mount to a host
# path (/mnt/storage/xray-analyzer/postgres by default), not a named
# volume - `docker compose down -v` would not touch it. Reads the actual
# path out of docker-compose.yml instead of hardcoding it, since it's
# meant to be changed per-deployment (see the storage-monitor mount next
# to it).
postgres_data_path() {
    grep -oP '(?<=- )[^:]+(?=:/var/lib/postgresql/data)' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null | head -1
}

uninstall_all() {
    echo
    echo "Это удалит с этой машины ВСЁ, что относится к Lounge XRAY Logs:"
    echo "  - контейнеры и образы (сервер, агент, Postgres, Redis)"
    echo "  - CLI-команду xlog"
    echo "  - всю папку проекта: $PROJECT_DIR"
    echo
    local confirm
    read -r -p "Продолжить? (y/n): " confirm </dev/tty
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Отменено."
        return
    fi
    local wipe_data
    read -r -p "Также стереть данные Postgres (собранные логи, найденные домены и т.д.)? (y/n): " wipe_data </dev/tty

    _do_compose_down
    if [[ "$wipe_data" =~ ^[Yy]$ ]]; then
        local pg_path
        pg_path="$(postgres_data_path)"
        if [ -n "$pg_path" ] && [ -d "$pg_path" ]; then
            echo "[*] Удаляю данные Postgres в $pg_path ..."
            rm -rf "${pg_path:?}"
        fi
        (cd "$PROJECT_DIR" && docker compose down -v 2>/dev/null) || true
    else
        echo "[*] Данные Postgres оставлены нетронутыми."
    fi

    rm -f "$XLOG_COMMAND"
    echo "[*] Удаляю $PROJECT_DIR ..."
    cd /
    rm -rf "${PROJECT_DIR:?}"

    echo
    echo "[OK] Lounge XRAY Logs полностью удалён с этой машины."
}

reinstall_all() {
    echo
    echo "Это остановит и снесёт текущие контейнеры и образы (данные Postgres"
    echo "останутся, если явно не согласиться их стереть отдельным вопросом),"
    echo "и сразу откроет мастер установки заново."
    echo
    local confirm
    read -r -p "Продолжить? (y/n): " confirm </dev/tty
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Отменено."
        return
    fi
    _do_compose_down
    echo
    echo "[*] Ставлю заново ..."
    resolve_project_dir
    install_xlog_command
    show_menu
}

# Pulls the latest code and rebuilds/restarts whichever components are
# actually installed - skips a component entirely if it was never set up,
# same "only touch what's there" rule as the rest of the menu.
update_all() {
    echo
    echo "[*] Обновляю Lounge XRAY Logs ..."
    if [ ! -d "$PROJECT_DIR/.git" ]; then
        echo "[!] $PROJECT_DIR — это не git-checkout, обновление кода невозможно." >&2
        echo "    Переустанови через пункт «Управление скриптом -> Переустановить»." >&2
        return 1
    fi
    if ! (cd "$PROJECT_DIR" && git fetch --quiet origin && git reset --quiet --hard origin/main); then
        echo "[ОШИБКА] Не удалось забрать обновления с git." >&2
        return 1
    fi
    install_xlog_command

    local touched=0
    if server_installed; then
        echo "[*] Пересобираю Server ..."
        (cd "$PROJECT_DIR" && docker compose build && docker compose up -d --force-recreate) && touched=1
    fi
    if agent_installed; then
        echo "[*] Пересобираю Agent ..."
        (cd "$PROJECT_DIR" && docker compose -f docker-compose.agent.yml build && docker compose -f docker-compose.agent.yml up -d --force-recreate) && touched=1
    fi
    if [ "$touched" -eq 0 ]; then
        echo "[*] Ничего не установлено — код обновлён, пересобирать нечего."
    fi
    echo
    echo "[OK] Обновление завершено."
}

print_script_menu_box() {
    box_top
    box_line "1) Переустановить  - снести контейнеры и поставить заново" "${C_NUM}1)${C_RESET} Переустановить  - снести контейнеры и поставить заново"
    box_line "2) Удалить         - снести всё, что тут стоит" "${C_NUM}2)${C_RESET} Удалить         - снести всё, что тут стоит"
    box_line "3) Обновить        - git pull + пересборка компонентов" "${C_NUM}3)${C_RESET} Обновить        - git pull + пересборка компонентов"
    box_empty
    box_line "0) Назад" "${C_NUM}0)${C_RESET} Назад"
    box_bottom
}

script_management_menu() {
    while true; do
        print_banner
        printf "${C_LABEL}Управление скриптом${C_RESET}\n\n"
        print_script_menu_box
        echo
        local choice
        read -r -p "$(printf "${C_LABEL}Выбор${C_RESET} ${C_OFF}[0-3]${C_RESET}: ")" choice </dev/tty
        case "$choice" in
            1) reinstall_all; return ;;
            2) uninstall_all; exit 0 ;;
            3) update_all; read -r -p "Enter - назад в меню" _ </dev/tty ;;
            0) return ;;
            *) echo "Неверный выбор."; sleep 1 ;;
        esac
    done
}

main() {
    check_root
    resolve_project_dir
    install_xlog_command
    show_menu
}

main "$@"
