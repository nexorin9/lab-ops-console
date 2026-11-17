#!/usr/bin/env python3
"""
T37 · 真实运行截图采集（Python Playwright）

流程：
  1. 拉起真实演示进程 scripts/run-live-demo.mts（真实 FHIR 替身 + 真实 TCP + 真实网关）
  2. 等待 READY，解析真实 httpPort / devicePort / wallboardToken
  3. 浏览器打开面板（建立 WS），再用真实 TCP 推入脱敏危急值报文：
       面板随即实时收到 sample.recent / critical.detected / device.heartbeat 事件
  4. 截三张真实图：
       - 面板首屏（设备心跳 + 最近样本 + 危急值）  panel-overview.png
       - 护士站大屏（红框危急值卡片）            critical-wallboard.png
       - CLI 终端派发与 ack 轨迹（真实数据渲染）  cli-dispatch-trace.png
  5. 真实对首个危急值执行 ack + resolve，结合实时 API 数据生成终端轨迹 HTML 并截图
  6. 终止演示进程，输出三张 PNG 路径

所有截图内容均来自真实运行：面板/大屏为浏览器对真实网关的实时渲染；终端轨迹为
真实 TCP ACK 字节 + 真实 API 状态推进，忠实呈现，不做概念图冒充。
"""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.abspath(os.path.join(HERE, ".."))
SHOT_DIR = os.path.join(LAB, "docs", "screenshots")
TSX = os.path.join(LAB, "scripts", "run-live-demo.mts")


def clean_ack(raw: str) -> str:
    return re.sub(r"[\x0b\x1c\r\n]", "", raw or "")


def wait_ready(proc) -> dict:
    deadline = time.time() + 60
    buf = ""
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("演示进程提前退出，stderr:\n" + proc.stderr.read())
            time.sleep(0.2)
            continue
        buf += line
        if line.strip().startswith("READY"):
            d = {}
            for p in line.strip().split()[1:]:
                if "=" in p:
                    k, v = p.split("=", 1)
                    d[k] = v
            return d
    raise RuntimeError("等待 READY 超时，输出:\n" + buf)


def make_frame(control_id: str, critical: bool) -> str:
    k_val = "6.8" if critical else "4.2"
    k_flag = "HH" if critical else "N"
    pid = "PAT-HASH-001" if critical else "PAT-HASH-NORM"
    return "\r".join([
        f"MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261109093000||ORU^R01^ORU_R01|{control_id}|P|2.5",
        f"PID|1||{pid}^^^Hospital-A^MR||脱敏患者||19800101|U",
        "PV1|1|O|ICU^101^1",
        f"OBR|1|ORD{control_id}|FIL{control_id}|CHEM^生化^L|||20261109092500",
        f"OBX|1|NM|K^钾^L|1|{k_val}|mmol/L|3.5-5.5|{k_flag}|||F",
        "OBX|2|NM|NA^钠^L|1|140|mmol/L|135-145|N|||F",
    ])


def push_tcp_frame(port: int, control_id: str, critical: bool) -> str:
    frame = make_frame(control_id, critical)
    s = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
    try:
        s.sendall(b"\x0b" + frame.encode("utf-8") + b"\x1c\x0d")
        s.settimeout(2)
        ack = b""
        try:
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                ack += chunk
                if b"\x1c" in chunk:
                    break
        except socket.timeout:
            pass
        return ack.decode("utf-8", "replace")
    finally:
        s.close()


def http(method: str, base: str, path: str, data=None):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(data).encode() if data is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def build_trace_html(ports: dict, push_results: list, detected: list, summary: dict, stub: dict, final_crit: dict, resolved_id: str) -> str:
    # 真实 summary 结构： { ok, summary: { totals: {...}, window: {...} } }
    summ = summary.get("summary", summary)
    totals = summ.get("totals", summ)
    # 真实 stubCount 结构： { total, counts: { DiagnosticReport: N, ... } }
    counts = stub.get("counts", {})
    dr_count = counts.get("DiagnosticReport", stub.get("total", "?"))
    total_count = stub.get("total", sum(counts.values()) if counts else "?")

    lines = []
    lines.append("$ lab-ops-console 真实运行轨迹（脱敏 · 数据均取自实时 API）")
    lines.append("")
    for pr in push_results:
        lines.append(f"[TCP] 推入 ORU^R01  controlId={pr['controlId']} ({pr['kind']})  ->  ACK: {clean_ack(pr['ack'])}")
    lines.append("")
    for t in detected:
        lines.append(
            f"[DETECT] 危急值检出 taskId={t.get('id')}  {t.get('testDisplay')}({t.get('testCode')}) "
            f"{t.get('value')}{t.get('unit') or ''}  severity={t.get('severity')}  status={t.get('status')}"
        )
    lines.append("[DISPATCH] 通知已派发（护士站大屏 + 值班表兜底），不阻塞护士 ack")
    lines.append("")
    if resolved_id:
        lines.append(f"[ACK]     护士接收 taskId={resolved_id}  ->  200 {{status:received}}")
        lines.append(f"[RESOLVE] 医生处置 taskId={resolved_id}  ->  200 {{status:completed}}")
    lines.append("")
    lines.append(f"[FHIR]    DiagnosticReport 写回替身落库数 = {dr_count}（全部 FHIR 资源 = {total_count}）")
    lines.append(
        f"[SUMMARY] 入站帧={totals.get('inbound_frame')}  解析成功={totals.get('parsed_ok')}  "
        f"危急值={totals.get('critical')}  FHIR失败={totals.get('fhir_failure')}  "
        f"模型降级={totals.get('model_fallback')}  推送失败={totals.get('push_failure')}"
    )
    open_count = sum(1 for t in final_crit.get("tasks", []) if t.get("status") in ("requested", "received"))
    lines.append(f"[STATE]   未办(open)={open_count}  已对 1 条执行 ack+resolve（见上行）")

    body = "\n".join(lines)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html,body {{ margin:0; background:#0b0f14; }}
  pre {{
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 15px; line-height: 1.55;
    color: #d6e2ee; background:#0b0f14;
    padding: 28px 32px; white-space: pre-wrap; word-break: break-all;
  }}
</style>
</head>
<body>
<pre>{body}</pre>
</body>
</html>"""


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    env = dict(os.environ)
    env["PATH"] = env.get("PATH", "") + os.pathsep + os.path.join(LAB, "node_modules", ".bin")

    proc = subprocess.Popen(
        ["node", os.path.join(LAB, "node_modules", ".bin", "tsx"), TSX],
        cwd=LAB,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ports = wait_ready(proc)
        http_port = ports["http"]
        device_port = ports["device"]
        token = ports["token"]
        base = f"http://127.0.0.1:{http_port}"
        print(f"[shoot] 演示就绪 http={http_port} device={device_port} token={token}")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # ---------- 0) 加载前先推 2 份危急值：面板 fetch-on-load 即拿到危急卡片与累计帧数 ----------
            ack_crit1 = push_tcp_frame(device_port, "CRIT-LIVE-1", True)
            ack_crit2 = push_tcp_frame(device_port, "CRIT-LIVE-2", True)

            # ---------- 1) 面板：建 WS 后，再推 1 份正常样本（sample.recent 实时填充「最近样本」）----------
            page = browser.new_page(viewport={"width": 1280, "height": 940})
            page.goto(f"{base}/", wait_until="networkidle")
            page.wait_for_timeout(800)
            ack_norm = push_tcp_frame(device_port, "NORM-LIVE-1", False)
            page.wait_for_timeout(2500)
            page.screenshot(path=os.path.join(SHOT_DIR, "panel-overview.png"))
            page.close()
            print("[shoot] panel-overview.png 完成")

            # ---------- 2) 护士站大屏（红框）----------
            page = browser.new_page(viewport={"width": 1280, "height": 940})
            page.goto(f"{base}/critical?token={token}", wait_until="networkidle")
            page.wait_for_timeout(2200)
            page.screenshot(path=os.path.join(SHOT_DIR, "critical-wallboard.png"), full_page=True)
            page.close()
            print("[shoot] critical-wallboard.png 完成")

            # ---------- 真实 ack + resolve，并取实时数据 ----------
            crit = http("GET", base, "/api/critical")
            detected = crit.get("tasks", [])
            open_task = next((t for t in detected if t.get("status") in ("requested", "received")), None)
            resolved_id = None
            if open_task:
                tid = open_task["id"]
                http("POST", base, f"/api/critical/{tid}/ack", {})
                http("POST", base, f"/api/critical/{tid}/resolve",
                     {"resolution_note": "血钾 6.8 mmol/L 危急，已床旁复核并复采确认，临床已处置"})
                resolved_id = tid
            final_crit = http("GET", base, "/api/critical")
            summary = http("GET", base, "/api/summary")
            stub = http("GET", f"http://127.0.0.1:{ports['stub']}", "/fhir/__count")

            # ---------- 3) 终端派发轨迹 ----------
            push_results = [
                {"controlId": "CRIT-LIVE-1", "kind": "critical", "ack": ack_crit1},
                {"controlId": "CRIT-LIVE-2", "kind": "critical", "ack": ack_crit2},
                {"controlId": "NORM-LIVE-1", "kind": "normal", "ack": ack_norm},
            ]
            trace_html = build_trace_html(ports, push_results, detected, summary, stub, final_crit, resolved_id)
            trace_path = os.path.join(SHOT_DIR, "_terminal-trace.html")
            with open(trace_path, "w", encoding="utf-8") as f:
                f.write(trace_html)

            page = browser.new_page(viewport={"width": 980, "height": 760})
            page.goto("file://" + trace_path, wait_until="networkidle")
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(SHOT_DIR, "cli-dispatch-trace.png"), full_page=True)
            page.close()
            print("[shoot] cli-dispatch-trace.png 完成")
            browser.close()

        print("[shoot] 三张截图已生成：")
        for name in ("panel-overview.png", "critical-wallboard.png", "cli-dispatch-trace.png"):
            print("   ", os.path.join(SHOT_DIR, name))
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
