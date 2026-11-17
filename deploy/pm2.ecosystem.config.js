/**
 * pm2 进程守护配置 —— 工控机常驻运行
 *
 * 用法：
 *   cd /opt/lab-ops-console
 *   pm2 start deploy/pm2.ecosystem.config.js
 *   pm2 save && pm2 startup   # 开机自启（systemd 接管 pm2 自身）
 *
 * 说明：
 * - 运行编译产物 dist/index.js（先 npm run build）
 * - env_file 走 .env（dotenv 格式）；也可改用 systemd 注入，二者不冲突
 * - fork 模式（单进程）即可，仪器接入与面板共用一个事件循环，无需 cluster
 * - 日志落 /var/log/lab-ops-console/，配合 logrotate 滚动
 */

module.exports = {
  apps: [
    {
      name: 'lab-ops-console',
      script: 'dist/index.js',
      cwd: '/opt/lab-ops-console',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 2000,
      kill_timeout: 8000,
      // 与 src/shared/env.ts 的必填项一致；正式环境把 .env 放项目根目录
      env_file: '/opt/lab-ops-console/.env',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      error_file: '/var/log/lab-ops-console/err.log',
      out_file: '/var/log/lab-ops-console/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      vizion: false,
      // 优雅退出：先跑完在途帧再关
      listen_timeout: 10000,
    },
  ],
};
