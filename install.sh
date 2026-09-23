#!/usr/bin/env bash
#
# VanBotJS 一键安装脚本（Linux）
#
# 用法：
#   curl -fsSL https://你的域名/install_vanbot.sh | bash
#   或指定安装目录：
#   curl -fsSL https://你的域名/install_vanbot.sh | bash -s -- /opt/VanBotJS
#
set -e

# ============================================================
# 配置区（可根据需要修改）
# ============================================================
# 项目 Git 仓库地址（如果用 GitHub 托管）
REPO_URL="${REPO_URL:-https://github.com/Van-Zone/VanBotJS.git}"
# 项目压缩包地址（如果用网站直接下载 tarball，二选一）
TARBALL_URL="${TARBALL_URL:-}"
# 安装目录（默认 /opt/VanBotJS，可通过第一个参数覆盖）
INSTALL_DIR="${1:-/opt/VanBotJS}"
# Node.js 最低版本
NODE_MIN_VERSION="18"
# npm 镜像（国内用户默认淘宝镜像，留空用官方源）
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# ============================================================
# 颜色输出
# ============================================================
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ============================================================
# 检测系统和包管理器
# ============================================================
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID}"
        OS_NAME="${PRETTY_NAME}"
    elif [ -f /etc/redhat-release ]; then
        OS_ID="rhel"
        OS_NAME="$(cat /etc/redhat-release)"
    else
        OS_ID="unknown"
        OS_NAME="unknown"
    fi

    if command -v apt-get >/dev/null 2>&1; then
        PKG_MANAGER="apt"
    elif command -v yum >/dev/null 2>&1; then
        PKG_MANAGER="yum"
    elif command -v dnf >/dev/null 2>&1; then
        PKG_MANAGER="dnf"
    elif command -v apk >/dev/null 2>&1; then
        PKG_MANAGER="apk"
    else
        PKG_MANAGER="unknown"
    fi
    info "系统：${OS_NAME}（${OS_ID}），包管理器：${PKG_MANAGER}"
}

# ============================================================
# 安装基础依赖（git、curl、build-essential）
# ============================================================
install_base_deps() {
    info "安装基础依赖（git、curl、编译工具）..."
    case "${PKG_MANAGER}" in
        apt)
            apt-get update -qq
            apt-get install -y -qq git curl build-essential ca-certificates gnupg
            ;;
        yum|dnf)
            ${PKG_MANAGER} install -y -q git curl gcc gcc-c++ make ca-certificates
            ;;
        apk)
            apk add --no-cache git curl build-base ca-certificates
            ;;
        *)
            error "不支持的包管理器，请手动安装 git、curl、build-essential 后重试"
            ;;
    esac
    ok "基础依赖安装完成"
}

# ============================================================
# 安装 Node.js（如果未安装或版本过低）
# ============================================================
install_node() {
    local need_install=0

    if ! command -v node >/dev/null 2>&1; then
        info "未检测到 Node.js，准备安装..."
        need_install=1
    else
        local current_version
        current_version="$(node -v | sed 's/v//')"
        local major_version
        major_version="$(echo "${current_version}" | cut -d. -f1)"
        info "当前 Node.js 版本：v${current_version}"
        if [ "${major_version}" -lt "${NODE_MIN_VERSION}" ]; then
            warn "Node.js 版本过低（需要 >= ${NODE_MIN_VERSION}.x），准备升级..."
            need_install=1
        else
            ok "Node.js 版本满足要求"
        fi
    fi

    if [ "${need_install}" -eq 1 ]; then
        info "通过 NodeSource 安装 Node.js 20.x LTS..."
        case "${PKG_MANAGER}" in
            apt)
                curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
                apt-get install -y -qq nodejs
                ;;
            yum|dnf)
                curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
                ${PKG_MANAGER} install -y -q nodejs
                ;;
            apk)
                apk add --no-cache nodejs npm
                ;;
            *)
                error "无法自动安装 Node.js，请手动安装 Node.js >= ${NODE_MIN_VERSION} 后重试"
                ;;
        esac
        ok "Node.js 安装完成：$(node -v)"
    fi

    # 配置 npm 镜像
    if [ -n "${NPM_REGISTRY}" ]; then
        npm config set registry "${NPM_REGISTRY}"
        info "npm 镜像已设置为：${NPM_REGISTRY}"
    fi
}

# ============================================================
# 下载项目代码
# ============================================================
download_project() {
    if [ -d "${INSTALL_DIR}" ] && [ "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]; then
        warn "安装目录 ${INSTALL_DIR} 已存在且非空"
        read -r -p "是否覆盖更新？[y/N] " confirm
        if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
            info "保留现有目录，跳过下载"
            return
        fi
        info "备份现有配置..."
        [ -f "${INSTALL_DIR}/config.json" ] && cp "${INSTALL_DIR}/config.json" "${INSTALL_DIR}/config.json.bak.$(date +%Y%m%d%H%M%S)"
        [ -d "${INSTALL_DIR}/Van_keyword" ] && cp -r "${INSTALL_DIR}/Van_keyword" "${INSTALL_DIR}/Van_keyword.bak.$(date +%Y%m%d%H%M%S)"
    fi

    mkdir -p "$(dirname "${INSTALL_DIR}")"

    if [ -n "${TARBALL_URL}" ]; then
        info "从压缩包下载项目：${TARBALL_URL}"
        local tmp_tar="/tmp/vanbot_$$.tar.gz"
        curl -fsSL "${TARBALL_URL}" -o "${tmp_tar}"
        mkdir -p "${INSTALL_DIR}"
        tar -xzf "${tmp_tar}" -C "${INSTALL_DIR}" --strip-components=1
        rm -f "${tmp_tar}"
    else
        info "从 Git 仓库克隆：${REPO_URL}"
        if [ -d "${INSTALL_DIR}/.git" ]; then
            cd "${INSTALL_DIR}"
            git pull --ff-only
        else
            rm -rf "${INSTALL_DIR}"
            git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
        fi
    fi

    cd "${INSTALL_DIR}"
    ok "项目代码已下载到：${INSTALL_DIR}"
}

# ============================================================
# 安装项目依赖
# ============================================================
install_deps() {
    cd "${INSTALL_DIR}"
    info "安装项目依赖（npm install）..."
    info "这可能需要几分钟，请耐心等待..."

    # skia-canvas 是可选原生依赖，部分环境（termux/无编译环境）装不上会自动跳过
    npm install --no-audit --no-fund 2>&1 | tail -5 || {
        warn "npm install 出现警告，尝试继续..."
    }

    ok "依赖安装完成"
    info "Node.js: $(node -v)，npm: $(npm -v)"
}

# ============================================================
# 初始化配置文件
# ============================================================
init_config() {
    cd "${INSTALL_DIR}"

    if [ ! -f config.json ]; then
        if [ -f config.example.json ]; then
            cp config.example.json config.json
            ok "已创建配置文件：config.json（基于 config.example.json）"
        else
            # 生成最小配置
            cat > config.json <<'EOF'
{
  "bots": [],
  "plugins": {
    "keyword": { "enable": true },
    "log": { "enable": true }
  },
  "hotReload": true
}
EOF
            ok "已创建最小配置文件：config.json"
        fi
    else
        info "配置文件 config.json 已存在，保留不动"
    fi

    # 确保插件数据目录存在
    mkdir -p Van_keyword
    ok "数据目录已就绪"
}

# ============================================================
# 安装 systemd 服务（可选）
# ============================================================
install_systemd() {
    if [ "${PKG_MANAGER}" = "apk" ]; then
        info "Alpine Linux 使用 OpenRC，跳过 systemd 服务安装"
        return
    fi

    if ! command -v systemctl >/dev/null 2>&1; then
        warn "未检测到 systemd，跳过服务安装"
        return
    fi

    read -r -p "是否安装 systemd 后台服务（开机自启）？[Y/n] " confirm
    if [ "${confirm}" = "n" ] || [ "${confirm}" = "N" ]; then
        info "跳过 systemd 服务安装"
        return
    fi

    local service_file="/etc/systemd/system/vanbot.service"
    cat > "${service_file}" <<EOF
[Unit]
Description=VanBotJS Bot Framework
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v npm) run dev
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# 如需使用国内镜像，取消下面注释：
# Environment=NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable vanbot.service
    ok "systemd 服务已安装并设置开机自启"
    echo ""
    info "服务管理命令："
    echo "  启动：systemctl start vanbot"
    echo "  停止：systemctl stop vanbot"
    echo "  重启：systemctl restart vanbot"
    echo "  状态：systemctl status vanbot"
    echo "  日志：journalctl -u vanbot -f"
}

# ============================================================
# 防火墙端口提示
# ============================================================
firewall_tips() {
    echo ""
    echo -e "${YELLOW}========== 端口提示 ==========${NC}"
    echo "如果使用以下适配器，需要在防火墙/安全组开放对应端口："
    echo "  - 微信公众号/服务号：80（HTTP）或 443（HTTPS）"
    echo "  - OneBot11 反向 WS：配置文件中指定的端口（默认 8080）"
    echo "  - Satori 反向 WS：配置文件中指定的端口"
    echo ""
    echo "常用防火墙命令："
    echo "  ufw:  ufw allow 8080/tcp"
    echo "  firewalld:  firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload"
    echo -e "${YELLOW}===============================${NC}"
}

# ============================================================
# 主流程
# ============================================================
main() {
    echo ""
    echo -e "${BOLD}${CYAN}========================================${NC}"
    echo -e "${BOLD}${CYAN}    VanBotJS 一键安装脚本（Linux）${NC}"
    echo -e "${BOLD}${CYAN}========================================${NC}"
    echo ""

    detect_os
    install_base_deps
    install_node
    download_project
    install_deps
    init_config
    install_systemd

    echo ""
    echo -e "${GREEN}${BOLD}========================================${NC}"
    echo -e "${GREEN}${BOLD}          安装完成！${NC}"
    echo -e "${GREEN}${BOLD}========================================${NC}"
    echo ""
    echo -e "安装目录：${CYAN}${INSTALL_DIR}${NC}"
    echo ""
    echo -e "${BOLD}下一步：${NC}"
    echo "  1. 编辑配置文件："
    echo "     cd ${INSTALL_DIR}"
    echo "     nano config.json"
    echo "     （填入各平台的 appId/appSecret/token 等）"
    echo ""
    echo "  2. 启动框架："
    echo "     npm run dev"
    echo "     或（已安装 systemd 服务）："
    echo "     systemctl start vanbot"
    echo ""
    echo "  3. 查看文档："
    echo "     项目 docs/ 目录，或访问在线文档"
    echo ""

    firewall_tips
}

main "$@"
