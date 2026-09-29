"""微信 iLink 独立登录器：为 Harness 生成二维码、扫码、拿 token 并写回配置。

协议来源：腾讯官方插件 @tencent-weixin/openclaw-weixin 的 src/auth/login-qr.ts
- POST {base}/ilink/bot/get_bot_qrcode?bot_type=3   body: {local_token_list: [...]} → {qrcode, qrcode_img_content}
- GET  {base}/ilink/bot/get_qrcode_status?qrcode=<qrcode>[&verify_code=<code>]  → {status, bot_token, ilink_bot_id, ilink_user_id, baseurl}
状态：wait / scaned / confirmed / expired / scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect

用法：
    python weixin_login.py            # 生成二维码并等待扫码（默认 8 分钟）
    python weixin_login.py --no-write # 只登录，不写回 modelConfig.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_JSON = PROJECT_ROOT / "config" / "modelConfig.json"
# 密钥单独存放：微信 bot token 在 secrets.json（modelConfig.json 只有模型定义）。
SECRETS_JSON = PROJECT_ROOT / "config" / "secrets.json"
BASE_URL = "https://ilinkai.weixin.qq.com"
BOT_TYPE = "3"
# 客户端身份头：与官方插件一致（缺失会导致重新扫码时被当作新客户端、另发新 bot）。
ILINK_APP_ID = os.environ.get("WEIXIN_ILINK_APP_ID", "bot")
ILINK_APP_CLIENT_VERSION = os.environ.get("WEIXIN_ILINK_APP_VERSION", "132105")
LONG_POLL_TIMEOUT = 35
LOGIN_TIMEOUT = 480
MAX_QR_REFRESH = 3


def load_local_tokens(config_path: Path) -> list[str]:
    """收集本地已有的 bot token，交给服务端判断是否已绑定。

    token 现在放在 `config/secrets.json`（密钥单独存放）；这里也读一遍 modelConfig
    以兼容手工把 token 写回旧位置的配置。
    """
    tokens: list[str] = []
    for path in (SECRETS_JSON, config_path):
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        token = (config.get("weixin") or {}).get("token")
        if token:
            tokens.append(str(token))
    # 兼容 OpenClaw 的账号文件
    account_dir = Path(os.path.expanduser("~")) / ".openclaw" / "openclaw-weixin" / "accounts"
    if account_dir.is_dir():
        for file in sorted(account_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:10]:
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
                if data.get("token"):
                    tokens.append(str(data["token"]))
            except Exception:
                continue
    # 去重且最多 10 个
    seen: list[str] = []
    for token in tokens:
        if token not in seen:
            seen.append(token)
    return seen[:10]


def http_json(method: str, url: str, body: dict | None = None, timeout: int = 30) -> dict:
    """发一个 JSON 请求并返回解析后的结果。

    必须带 `iLink-App-Id` / `iLink-App-ClientVersion`：
    官方插件（@tencent-weixin/openclaw-weixin）的每个请求都带这两个头。
    缺失时服务端会把请求当成"陌生客户端"，**重新扫码会再发一只新 bot**，
    导致旧 token 立刻失效（表现为"token 老是过期"、每次都要求手机解绑）。
    带上后重新扫码才会返回 `binded_redirect`（已绑定，不发新凭据）。
    """
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("iLink-App-Id", ILINK_APP_ID)
    request.add_header("iLink-App-ClientVersion", ILINK_APP_CLIENT_VERSION)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", "ignore")
        return json.loads(text)
    except urllib.error.HTTPError as error:
        raise RuntimeError("HTTP %s: %s" % (error.code, error.read().decode("utf-8", "ignore")[:200])) from error


def fetch_qrcode() -> tuple[str, str]:
    """取二维码：返回 (qrcode 票据, 二维码内容/链接)。"""
    url = "%s/ilink/bot/get_bot_qrcode?bot_type=%s" % (BASE_URL, urllib.parse.quote(BOT_TYPE))
    payload = http_json("POST", url, {"local_token_list": load_local_tokens(CONFIG_JSON)})
    qrcode = payload.get("qrcode")
    content = payload.get("qrcode_img_content")
    if not qrcode or not content:
        raise RuntimeError("服务端未返回二维码：%s" % json.dumps(payload, ensure_ascii=False)[:300])
    return str(qrcode), str(content)


def render_qrcode(content: str) -> None:
    """在终端渲染二维码；失败时退回打印链接。"""
    try:
        import qrcode  # type: ignore
        code = qrcode.QRCode(border=1)
        code.add_data(content)
        code.make(fit=True)
        code.print_ascii(invert=True)
        return
    except Exception:
        pass
    print("（未安装 qrcode 库，无法在终端渲染）")


def poll_status(qrcode: str, base_url: str, verify_code: str | None) -> dict:
    """长轮询一次扫码状态。"""
    query = "qrcode=" + urllib.parse.quote(qrcode)
    if verify_code:
        query += "&verify_code=" + urllib.parse.quote(verify_code)
    url = "%s/ilink/bot/get_qrcode_status?%s" % (base_url, query)
    try:
        return http_json("GET", url, timeout=LONG_POLL_TIMEOUT)
    except Exception:
        # 网络抖动/网关超时视为 wait，继续轮询（与官方插件一致）
        return {"status": "wait"}


def write_token(token: str, bot_id: str, user_id: str, base_url: str | None) -> Path:
    """把新凭据写回配置：**token 进 secrets.json**，其余（botId/baseURL）进 modelConfig.json。

    @returns modelConfig.json 的备份路径（沿用原返回值，调用方只用来提示）。
    """
    # ① token → secrets.json（密钥唯一存放处）
    secrets: dict = {}
    if SECRETS_JSON.is_file():
        try:
            secrets = json.loads(SECRETS_JSON.read_text(encoding="utf-8"))
        except ValueError:
            secrets = {}
    weixin_secret = secrets.setdefault("weixin", {})
    weixin_secret["token"] = token
    SECRETS_JSON.write_text(json.dumps(secrets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ② 非密钥信息 → modelConfig.json（备份原文件）
    config = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
    backup = CONFIG_JSON.with_name("modelConfig.json.bak-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copyfile(CONFIG_JSON, backup)
    weixin = config.setdefault("weixin", {})
    weixin.pop("token", None)          # 老配置里若残留 token，顺手挪走
    if base_url:
        weixin["baseURL"] = base_url
    weixin["botId"] = bot_id
    weixin["botUserId"] = user_id
    CONFIG_JSON.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # 新凭据已写入，清掉运行期留下的"失效"标记，让启动器恢复正常判断。
    flag = Path(os.environ.get("DSH_HOME") or (Path(os.path.expanduser("~")) / ".dsh")) / "weixin-token-invalid.flag"
    try:
        flag.unlink()
        print("已清除失效标记：%s" % flag.name)
    except FileNotFoundError:
        pass
    return backup


def main() -> int:
    """执行扫码登录并（可选）写回配置。"""
    parser = argparse.ArgumentParser(description="微信 iLink 独立登录器")
    parser.add_argument("--no-write", action="store_true", help="登录后不写回 modelConfig.json")
    parser.add_argument("--timeout", type=int, default=LOGIN_TIMEOUT, help="等待扫码的秒数")
    args = parser.parse_args()

    print("=" * 60)
    print(" 微信 iLink 登录（为 Harness 直连获取 token）")
    print("=" * 60)

    try:
        qrcode, content = fetch_qrcode()
    except Exception as error:
        print("[失败] 获取二维码出错：%s" % error)
        return 1

    current_base = BASE_URL
    print("\n当前已有的本地 token 数：%d" % len(load_local_tokens(CONFIG_JSON)))
    print("\n请用手机微信扫描下面的二维码：\n")
    render_qrcode(content)
    print("\n若二维码无法显示，可打开这个链接继续：\n%s\n" % content)

    verify_code: str | None = None
    pending_verify: str | None = None
    scanned_printed = False
    refresh_count = 1
    deadline = time.time() + max(1000, args.timeout)

    while time.time() < deadline:
        status_payload = poll_status(qrcode, current_base, pending_verify)
        status = status_payload.get("status")

        if status == "wait":
            sys.stdout.write(".")
            sys.stdout.flush()
        elif status == "scaned":
            if pending_verify:
                print("\n[信息] 配对码已接受，继续等待确认…")
                pending_verify = None
            if not scanned_printed:
                print("\n[信息] 已扫描，正在验证…")
                scanned_printed = True
        elif status == "need_verifycode":
            prompt = "配对码不正确，请重新输入：" if pending_verify else "请输入手机微信上显示的数字："
            pending_verify = input(prompt).strip()
            continue
        elif status == "scaned_but_redirect":
            redirect_host = status_payload.get("redirect_host")
            if redirect_host:
                current_base = "https://" + str(redirect_host)
                print("\n[信息] 服务端要求切换接入点：%s" % current_base)
        elif status == "expired":
            refresh_count += 1
            if refresh_count > MAX_QR_REFRESH:
                print("\n[失败] 二维码多次失效，已停止。请重试。")
                return 1
            print("\n[信息] 二维码已过期，正在刷新（%d/%d）…" % (refresh_count, MAX_QR_REFRESH))
            qrcode, content = fetch_qrcode()
            scanned_printed = False
            render_qrcode(content)
            print("\n或打开链接：%s\n" % content)
        elif status == "verify_code_blocked":
            print("\n[失败] 配对码多次错误，请稍后再试。")
            return 1
        elif status == "binded_redirect":
            print("\n[信息] 此微信已绑定过，无需重复连接（现有凭据仍然有效）。")
            return 0
        elif status == "confirmed":
            bot_id = status_payload.get("ilink_bot_id")
            token = status_payload.get("bot_token")
            user_id = status_payload.get("ilink_user_id") or ""
            base_url = status_payload.get("baseurl")
            if not bot_id or not token:
                print("\n[失败] 服务端未返回 ilink_bot_id / bot_token。")
                return 1
            print("\n[成功] 登录完成")
            print("  bot_id  = %s" % bot_id)
            print("  用户 id = %s" % user_id)
            print("  token   = %s…%s (len=%d)" % (token[:14], token[-8:], len(token)))
            if base_url:
                print("  baseURL = %s" % base_url)
            if args.no_write:
                print("\n（按 --no-write 要求，未写回 modelConfig.json）")
            else:
                backup = write_token(str(token), str(bot_id), user_id, base_url)
                print("\n已写回 %s" % CONFIG_JSON)
                print("备份：%s" % backup.name)
                print("下一步：重启服务使新 token 生效（python start_stack.py）。")
            return 0

        time.sleep(1)

    print("\n[失败] 等待超时，请重试。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
