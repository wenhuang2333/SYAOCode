#!/usr/bin/env python3
"""
TUI 全指令压测驱动（开发工具，可选依赖）：
  pip3 install pyte pillow
  python3 scripts/tui-drive.py <输出目录>

在真实 pty 中启动 CLI TUI（100x40），按内置剧本逐条提交全部斜杠命令与多轮对话，
用 pyte 还原终端画面：每步保存 .txt（屏幕文本）+ .png（等宽字体渲染截图），
并输出 summary.json（进程存活/退出码/原始字节数）。用于回归 TUI 稳定性：
无堆栈、无双顶框、无挂起、/exit 能正常退出。

注意：pyte 与真实终端在 DECSC（ESC7/ESC8）随滚动调整上有差异——TUI 现已改为
纯相对光标移动（CUU/ED），该差异不再影响判定。
"""
import os, pty, sys, time, select, signal, json, subprocess, tempfile, shutil, re

import pyte
from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 100, 40
FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
]

def load_font(size=14):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

FONT = load_font()

class Driver:
    def __init__(self, entry_dir, outdir, home):
        self.entry_dir = entry_dir
        self.outdir = outdir
        self.home = home
        os.makedirs(outdir, exist_ok=True)
        self.master, slave = pty.openpty()
        import fcntl, termios, struct
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        env = dict(os.environ)
        env.update({
            "HOME": home,
            "TERM": "xterm-256color",
            "SYAO_MODEL": "mock:default",
            "SYAO_MOCK_SCRIPT": json.dumps([
                {"id": f"a{i}", "role": "assistant",
                 "content": [{"type": "text", "text": f"mock 回复 {i}：已收到指令，用于压测长文本滚动与多轮提交。"}],
                 "meta": {"createdAt": 0}}
                for i in range(1, 9)
            ]),
        })
        self.proc = subprocess.Popen(
            ["pnpm", "exec", "tsx", "src/main.ts", "--no-boot"],
            cwd=entry_dir, env=env, stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=os.setsid,
        )
        os.close(slave)
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = bytearray()
        self.crashed = False
        self.exit_code = None
        self.steps = []

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], min(0.05, max(0, end - time.time())))
            if self.master in r:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    self._check_exit()
                    return
                if not data:
                    self._check_exit()
                    return
                self.raw.extend(data)
                self.stream.feed(data)
            self._check_exit()
        self._check_exit()

    def _check_exit(self):
        if self.proc.poll() is not None and self.exit_code is None:
            self.exit_code = self.proc.returncode

    def send(self, text, delay=0.55):
        os.write(self.master, text.encode())
        self.pump(delay)

    def screen_text(self):
        return "\n".join(self.screen.display)

    def snapshot(self, name):
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
        txt = os.path.join(self.outdir, f"{safe}.txt")
        png = os.path.join(self.outdir, f"{safe}.png")
        self.render_png(png)
        text = self.screen_text()
        open(txt, "w", encoding="utf-8").write(text + "\n")
        self.steps.append({"name": safe, "alive": self.proc.poll() is None, "text": text})
        return safe

    def render_png(self, path):
        char_w = 8
        char_h = 17
        img = Image.new("RGB", (COLS * char_w + 16, ROWS * char_h + 16), (18, 18, 22))
        draw = ImageDraw.Draw(img)
        palette = {
            "default": (220, 220, 220), "black": (0, 0, 0), "red": (230, 90, 90),
            "green": (120, 200, 120), "brown": (200, 170, 60), "blue": (110, 150, 230),
            "magenta": (200, 120, 200), "cyan": (100, 200, 210), "white": (240, 240, 240),
        }
        for y in range(ROWS):
            line = self.screen.buffer[y]
            for x in range(COLS):
                cell = line[x]
                ch = cell.data
                if not ch or ch == " ":
                    continue
                fg = cell.fg
                if fg.startswith("bright"):
                    fg_name = fg.split("_")[-1]
                    color = tuple(min(255, c + 40) for c in palette.get(fg_name, palette["default"]))
                else:
                    color = palette.get(fg, palette["default"])
                if cell.reverse:
                    color = (20, 20, 20)
                draw.text((8 + x * char_w, 8 + y * char_h), ch, font=FONT, fill=color)
        img.save(path)

    def close(self):
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except Exception:
            pass


def run_scenario(driver: Driver, scenario):
    """scenario: list of (label, action, delay)；action 为要发送的字符串或 None（仅截图）"""
    for label, action, delay in scenario:
        if action is not None:
            driver.send(action, delay)
        driver.snapshot(label)
        if driver.exit_code is not None:
            break


def main():
    # 路径相对本文件解析，仓库可移植（不写死开发者机器上的绝对路径）
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    entry_dir = os.path.join(repo_root, "packages", "cli")
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "syao-tui-shots")
    home = tempfile.mkdtemp(prefix="syao-drive-")
    os.makedirs(f"{home}/.syaocode", exist_ok=True)

    d = Driver(entry_dir, outdir, home)
    d.pump(3.0)  # 等启动（--no-boot 无动画）

    D = None
    scenario = [
        # 初始界面
        ("00-welcome", None, 0),
        # 信息类面板（逐条命令）
        ("01-help", "/help\r", 1.2),
        ("02-status", "/status\r", 1.2),
        ("03-cost", "/cost\r", 1.2),
        ("04-tools", "/tools\r", 1.2),
        ("05-doctor", "/doctor\r", 1.6),
        ("06-model", "/model\r", 1.4),
        # 权限：问答引导三问 + 快捷路径
        ("07-permissions-panel", "/permissions\r", 1.2),
        ("08-permissions-mode-q", None, 0),
        ("09-permissions-answer", "\r\r\r", 1.4),
        ("10-permission-fast", "/permission strict\r", 1.0),
        ("11-permissions-allow", "/permissions allow read\r", 1.0),
        # 模型切换 / 档案类
        ("12-model-use-mock", "/model use mock:default\r", 1.2),
        ("13-manage-empty", "/manage\r", 1.2),
        ("14-setup-wizard", "/setup\r", 1.2),
        ("15-setup-cancel", "\x1b", 0.8),
        # agent 群向导（新建 + 激活 + 面板 + 设置）
        ("16-set-agents", "/set-agents\r", 1.2),
        ("17-agents-name", "team\r", 1.0),
        ("18-agents-hyaki", "\r", 0.9),
        ("19-agents-sota", "\x1b[B\r", 0.9),
        ("20-agents-common", "\r", 0.9),
        ("21-agents-activate", "y\r", 1.6),
        ("22-model-panel-groups", "/model\r", 1.4),
        ("23-setting", "/setting\r", 1.2),
        ("24-setting-keep", "\r\r\r\r", 1.4),
        ("25-setting-activate", "y\r", 1.4),
        ("26-agents-mode", "/agents\r", 1.3),
        # 会话类
        ("27-clear", "/clear\r", 0.9),
        ("28-compact", "/compact\r", 1.0),
        ("29-resume", "/resume\r", 1.2),
        ("30-unknown", "/nosuchcmd\r", 0.9),
        # 普通对话（多轮提交压测）
        ("31-chat-1", "你好，压测第一轮\r", 1.2),
        ("32-chat-2", "第二轮\r", 1.2),
        ("33-chat-3", "第三轮\r", 1.2),
        ("34-chat-4", "第四轮\r", 1.2),
        # 连续提交（快速连发，模拟“多之后崩”）
        ("35-burst", "/status\r/status\r/status\r/status\r/status\r", 3.0),
        ("36-after-burst", "/help\r", 1.5),
        ("37-exit", "/exit\r", 1.2),
    ]
    run_scenario(d, scenario)
    summary = {
        "exit_code": d.exit_code,
        "steps": [{"name": s["name"], "alive": s["alive"]} for s in d.steps],
        "raw_bytes": len(d.raw),
    }
    open(os.path.join(outdir, "summary.json"), "w").write(json.dumps(summary, indent=2))
    # 崩溃文本全量留存
    open(os.path.join(outdir, "raw-output.bin"), "wb").write(bytes(d.raw))
    d.close()
    print(json.dumps(summary, indent=2)[:4000])

if __name__ == "__main__":
    main()
