# 谈心谈话 · 手机端填表 + 自动落库

把高校「智慧学工」里的**谈心谈话记录填写**搬到手机上：手机上填完 → 入队 → 本机浏览器（CDP）自动填进学工系统，附带重点关注学生的周期提醒、日历同步和 Android 常驻 App。

> 目标系统：大连理工大学 智慧学工（`dutxg.dlut.edu.cn`）。页面选择器是按这套系统写的，换学校需要改 `code/*.mjs` 里的选择器与 URL。

---

## 1. 它由哪几块组成

`§
手机浏览器 / Android App (WebView)
        │  HTTPS（Tailscale serve）
        ▼
   server.mjs  (Node，8787)  ←── data/token.txt 鉴权
        │  queue.jsonl
        ▼
   cdp_submit.mjs  ──CDP──▶  常驻 Chrome ──▶  学工系统（自动填表、截图回执）
        ▲
        └── focus.mjs / focus_cycle.mjs（重点关注名单 + 双周周期计算）
`§

| 组件 | 作用 |
|---|---|
| `server.mjs` | 零依赖 HTTP 服务：表单页、队列 API、SSE 事件流、日历提醒内容、附件库 |
| `public/` | 移动端 PWA：填表、名单、档案、关注、日志；离线可填、自动排队 |
| `code/cdp_submit.mjs` | 消费队列，驱动常驻 Chrome 把记录填进学工系统 |
| `code/focus.mjs` | 抓取「重点关注」名单（三表按下标拼接） |
| `code/focus_cycle.mjs` | 双周考核周期计算（周期 #0 = 2026-09-28 起，每 14 天） |
| `code/login.mjs` | 学工 CAS 自动登录（读 `~/pw.txt`） |
| `android/` | App 3.3：WebView 壳 + 前台 SSE 服务 + 顶部状态横幅 + 系统日历写入 |

---

## 2. 快速开始（只跑网页版）

需要 Node ≥ 18。唯一依赖是 `web-push`（Web Push 在国内基本连不上，不启用也不影响其他功能）。

`§bash
git clone <this-repo> talk-form && cd talk-form
npm install
node server.mjs          # 监听 0.0.0.0:8787
`§

首次启动会在 `data/token.txt` 自动生成访问令牌（权限 600）。

打开：`http://127.0.0.1:8787/?k=<token>`
带一次 `?k=` 后会写 Cookie，之后直接开根路径即可。

> `http://内网IP:8787` 只能当普通网页用；要装成 PWA（离线、桌面图标、通知），必须走 HTTPS，见第 4 节。

---

## 3. 接入学工系统（自动落库）

1. **准备账号**：把学工系统的账号、密码写进 `~/pw.txt`，两行，第一行账号、第二行密码。
   `§bash
   chmod 600 ~/pw.txt
   `§
2. **起一个常驻浏览器**（带 CDP，9222）：
   `§bash
   /opt/openbrowser/openbrowser --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.local/share/openbrowser-auto" \
     http://dutxg.dlut.edu.cn/gzsc/ &
   `§
   用 systemd 常驻见 `deploy/talk-browser.service`。
3. **登录**：`node code/login.mjs`（会话过期时服务端会自动调用它重登一次）。
4. **提交**：网页点「提交」入队后，服务端 watcher 会调用 `cdp_submit.mjs` 落库。

> 9222 是浏览器调试端口，别暴露到公网。

---

## 4. 手机安装（Tailscale + HTTPS）

Service Worker 只在安全上下文生效，所以需要一个真证书的 https 域名。最省事的是 Tailscale：

`§bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up                       # 打开输出的链接授权
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status                  # 拿到 https://<机器名>.<tailnet>.ts.net
`§

手机装 Tailscale 客户端登录同一账号 → 浏览器打开该域名 → 「添加到主屏幕 / 安装应用」。

---

## 5. 常驻部署（systemd 用户服务）

`§bash
mkdir -p ~/.config/systemd/user
cp deploy/talk-form.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now talk-form
sudo loginctl enable-linger $USER        # 未登录/重启后仍运行
`§

默认假设仓库放在 `~/talk-form`；放在别处就改 `WorkingDirectory`，或把 `TALK_ROOT` 写进 service 的 `Environment`。

---

## 6. Android App（可选）

App 提供：WebView 壳、前台 SSE 常驻连接、页面顶部蓝色横幅（连接状态 / 最新提醒）、把提醒写进系统日历。

### 6.1 改配置

`android/src/com/talk/notify/Const.java`：

`§java
public static final String BASE  = "https://your-host.example.com";  // 你的 HTTPS 地址
public static final String TOKEN = "REPLACE_WITH_YOUR_TOKEN";         // data/token.txt
`§

### 6.2 构建

不需要 Android Studio，用 apt 里的工具链即可：

`§bash
sudo apt install openjdk-17-jdk-headless android-sdk-build-tools
# android/platforms/android.jar（API 34）自己放进去，来源见 code/build_apk.sh 注释

cd android
keytool -genkeypair -keystore talk.keystore -alias talk -keyalg RSA -keysize 2048 \
  -validity 10000 -storepass changeit -keypass changeit -dname "CN=talk"
cd ..
TALK_KS_PASS=changeit bash code/build_apk.sh     # 产物在 public/apk/
`§

可用环境变量：`TALK_KEYSTORE`（签名文件）、`TALK_KS_PASS`（口令）、`TALK_OUT`（输出目录）。

App 内置自更新：`/api/app/version` + `/apk/talk-notify.apk`。把接口里的版本文件放在 `public/apk/talk-notify.version.json`。

---

## 7. 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `TALK_PORT` | 8787 | 服务端口 |
| `TALK_ROOT` | `~/talk-form` | 数据目录所在的项目根 |
| `TALK_PY` | `python3` | 带 pandas 的解释器（md→docx、名单导入） |
| `TALK_BASE` | — | Termux 脚本用的服务地址 |
| `TALK_TOKEN` | — | Termux 脚本用的令牌（或写 `~/.talk-token`） |
| `CDP_PORT` | 9222 | 常驻浏览器调试端口 |

字段枚举集中在 `server.mjs` 的 `ENUMS`，改一处页面自动跟着变。

---

## 8. 关键接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/?k=<token>` | 表单页 |
| POST | `/api/submit` | 入队 |
| GET | `/api/items` | 最近记录 |
| GET | `/api/daily-brief` | App 用的日历提醒内容（本周期剩余天数 + 未谈名单） |
| GET | `/api/focus` | 重点关注状态（含周期与剩余天数） |
| POST | `/api/focus/refresh` | 重新抓取名单（失败会自动登录重试） |
| GET | `/api/alerts/stream` | SSE 事件流（App / 网页实时提醒） |
| POST | `/api/alerts/test` | 发一条测试通知 |
| GET | `/health` | 存活检查（无鉴权） |

---

## 9. 安全与合规

- 服务默认绑 `0.0.0.0`，仅靠 token 鉴权：**只挂 tailnet 或反代加认证，不要直接暴露公网**。
- `data/` 下是学生个人信息（姓名、学号、谈话记录），已在 `.gitignore` 里；建议 `chmod 700 data`。
- `~/pw.txt` 是学工账号密码，权限 600，不要提交、不要进日志。
- 令牌泄露：删掉 `data/token.txt` 重启即可重生成，手机上重新带一次 `?k=`。
- 本工具只是把你自己有权限的重复操作自动化，请遵守学校系统的使用规定，不要用于批量抓取或他人账号。

---

## 10. 已知限制

1. 选择器绑定大工智慧学工，换学校要改 `cdp_submit.mjs` / `focus.mjs`。
2. 学工 CAS 会话会过期；服务端会自动重登一次，`~/pw.txt` 缺失时仍需手动。
3. 多标签页时学工表单要限定 `.ant-tabs-tabpane-active`，否则会填错面板。
4. Android 8+ 前台服务必须带通知；不想要通知栏可以在系统设置里关掉该渠道，服务仍运行。
5. 日历只在每天 18:00（闹钟）和打开 App 时同步，不是实时。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
