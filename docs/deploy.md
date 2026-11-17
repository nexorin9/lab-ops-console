# 部署与运维交付（T36）

检验仪器接入与危急值闭环系统的院内落地指引。目标是让信息科在工控机上完成「装好即开机自启、配置缺项一眼可见」。

## 1. 运行环境

| 项 | 要求 |
| --- | --- |
| 操作系统 | Linux（推荐 Debian 12 / Ubuntu 22.04 LTS） |
| Node | ≥ 20（LTS，已验证 20 / 22） |
| 内存 | ≥ 2 GB（单实例，已设 MemoryMax=2G） |
| 磁盘 | ≥ 20 GB（SQLite 数据库 + 日志滚动） |
| 网络 | 出网到院内 FHIR / 模型网关；入网开放仪器接入端口（默认 2575）与面板端口（默认 3000） |

## 2. 安装步骤

```bash
# 以专用低权限账号运行（不要 root 直跑业务）
sudo useradd -r -s /usr/sbin/nologin labops
sudo mkdir -p /opt/lab-ops-console /var/log/lab-ops-console
sudo chown -R labops:labops /opt/lab-ops-console /var/log/lab-ops-console

# 放置源码 / 构建产物
sudo cp -r . /opt/lab-ops-console/
cd /opt/lab-ops-console

# 安装依赖并构建（CI 里建议 npm ci）
sudo -u labops npm ci
sudo -u labops npm run build

# 配置凭据：从模板复制并补齐 8 项必填
sudo -u labops cp .env.example .env
sudo -u labops vi .env          # 至少填 DEVICE_LISTEN_PORT / LIS_FHIR_* / FHIR_* / MODELS_*

# 配置仪器通道
sudo -u labops cp -r channels /opt/lab-ops-console/channels   # 至少一份 *.yaml
```

### 必填环境变量（与 `src/shared/env.ts` 对齐）

| 变量 | 含义 |
| --- | --- |
| `DEVICE_LISTEN_PORT` | 仪器 TCP 接入端口（默认 2575） |
| `LIS_FHIR_BASE_URL` | LIS 侧 FHIR R4 端点 baseUrl |
| `LIS_FHIR_TOKEN` | LIS FHIR 静态 bearer token |
| `FHIR_BASE_URL` | 医院 FHIR 端点 baseUrl（写回与审计目标） |
| `FHIR_TOKEN` | 医院 FHIR 静态 bearer token |
| `MODELS_BASE_URL` | 模型网关 baseUrl（OpenAI-compatible） |
| `MODELS_API_KEY` | 模型网关 key |
| `MODELS_MODEL` | 模型名（如 qwen / 本地 unsloth 暴露的模型 id） |

选填项见 `.env.example`（`DEVICE_ENCODING` / `NOTIFY_WEBHOOK_URL` / `SERIAL_PORT` / `HTTP_PORT` / `DATA_DIR` / `LOG_LEVEL` 等）。

`.env` 既可由应用自身经 dotenv 读取（推荐，简单），也可由 systemd 的 `EnvironmentFile=` 或 pm2 的 `env_file` 注入；二者不冲突，已注入的变量不会被 dotenv 覆盖。

## 3. 开机自启（二选一）

### 3.1 systemd（推荐，原生开机自启）

```bash
sudo cp deploy/lab-ops-console.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lab-ops-console
sudo systemctl status lab-ops-console      # 确认 active (running)
journalctl -u lab-ops-console -f            # 看结构化日志
```

单元文件要点：`WorkingDirectory` 指向安装目录，应用经 dotenv 读 `.env`；`ExecStartPre` 启动前先跑 `doctor` 自检，缺项直接拦截；`Restart=on-failure` 崩了自动拉起；`TimeoutStopSec=15` 给优雅退出留 10s 跑完在途帧。

### 3.2 pm2（若工控机已装 pm2）

```bash
sudo npm i -g pm2
cd /opt/lab-ops-console
pm2 start deploy/pm2.ecosystem.config.js
pm2 save
pm2 startup                         # 跟随系统开机（pm2 自身由 systemd 接管）
```

## 4. 装机自检

```bash
bash scripts/install-check.sh       # Node / 构建产物 / .env 必填 / 通道配置 / doctor 综合
```

该脚本会逐项给中文结论，存在阻断项时退出码为 1，便于装机流水线判断。

## 5. 验证服务

```bash
node dist/gateway/cli.js status      # 看 /healthz 与通道状态
node dist/gateway/cli.js doctor      # 工控机环境自检（CLI 入口）
```

## 6. 升级

```bash
cd /opt/lab-ops-console
sudo -u labops git pull              # 或重新 rsync 源码
sudo -u labops npm ci && sudo -u labops npm run build
sudo systemctl restart lab-ops-console   # 或 pm2 restart lab-ops-console
```

升级前建议 `node dist/gateway/cli.js export --month YYYY-MM` 先导出当月闭环台账留底。
