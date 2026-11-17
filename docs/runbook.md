# 运维排障手册（runbook，T36）

面向信息科值班与飞检自查。所有操作尽量走 CLI（排障不碰数据库），数据库仅在极端情况直查。

## 0. 健康速览

```bash
node dist/gateway/cli.js status        # 通道状态 / 健康
node dist/gateway/cli.js doctor        # 工控机自检
journalctl -u lab-ops-console -n 200   # 最近日志（结构化 JSON）
```

## 1. 仪器送数但面板不显示 / 危急值不弹屏

1. `status` 看通道是否 `running`；若 `stopped` → `journalctl` 查启动报错（多为 `.env` 缺项或端口被占）。
2. 查死信：`data/lab-ops-console.sqlite` 的 `dlq` 表（或直接看日志 `error_code`）。常见：
   - `FRAME_MALFORMED`：仪器字段级脏数据，报告照常写、原始字节留 DLQ，属预期，核对仪器即可。
   - `FHIR_WRITE_FAIL` / `FHIR_SERVER_FAIL`：院内 FHIR 端点不可达或 5xx，写入进 `push_queue` 待回放。
3. 网络恢复后自动补推：`node dist/gateway/cli.js redeliver`（断网期间堆积的 pending 通知会循环补派）。

## 2. 危急值通知漏发

- WS 通道（护士站大屏 / 面板）无客户端时转 webhook 兜底，再失败进 `push_queue`。
- 看日志 `critical push failed; queued` 是否反复出现 → 说明 webhook 也失败，等网络恢复后 `redeliver`。
- 升级超时（5 分钟科主任 / 15 分钟医务科）会自动 `escalation_events`，飞检时按时间线倒查。

## 3. 飞检倒查（审计链）

- 每条危急值 Task 的 `AuditEvent` 四字段（agent / recorded / source / outcome）必填，缺字段台账导出会被拒绝（失败不静默）。
- 导出当月闭环台账：`node dist/gateway/cli.js export --month 2026-11 --out /tmp/close-loop-2026-11.csv`，逐行强校验，缺字段会列出 taskId。
- 倒查入口 `GET /api/critical/:id/audit`；拒收（denied）会落 `AUDIT_DENIED` 索引，反向可查「谁在什么环节卡住」。

## 4. 模型不可达（不影响主路径）

- 模型端点超时 / 不可达时，系统降级到值班表规则兜底（`MODEL_UNAVAILABLE_FALLBACK`），护士 ack / 处置不受影响。
- 审计里 `outcome=fallback_rules` 记为降级；飞检可据此说明「人仍为责任主体」。

## 5. 重启与回滚

```bash
sudo systemctl restart lab-ops-console       # 正常重启（优雅退出，跑完在途帧）
sudo systemctl stop   lab-ops-console         # 停机维护
# 回滚：保留上一版 dist 快照，npm run build 覆盖前先 cp -r dist dist.bak-<日期>
```

## 6. 容量与性能基线

- 实测：500 份标本（含 40 危急 + 10 脏数据）端到端 ~3 秒落库，吞吐 ~160 标本/秒；日常一台仪器远低于此。
- 若面板卡片堆积、WS 断线提示频繁，先看 `GET /api/summary`（5 分钟窗口运行摘要：入站 / 解析 / DLQ / 危急 / 模型降级 / 推送失败 / 限速 / 字典命中率）。
- 限速触发 `RATE_LIMITED`：说明单台仪器瞬时超阈，检查仪器是否重发风暴。

## 7. 日志与告警

- 日志为结构化 JSON（time / level / component / msg / taskId / ...），可直接进 Loki / ELK。
- 敏感字段（姓名 / 证件 / 电话 / 地址）在日志边界被脱敏（见 `src/shared/redact.ts`），飞检可现场演示不出现患者可定位明文。
- 错误码分级：`fatal/error/warn/info`，按 `category`（ingest / fhir / model / auth / critical / audit ...）聚合监控。
- 严重级别告警建议：连续 `FHIR_SERVER_FAIL`、`AUTH_TOKEN_EXPIRED`、`TASK_INVALID_TRANSITION`、`AUDIT_DENIED` 触发工单。
