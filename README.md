# xtgl-talk-form · 谈心谈话手机端填写（PWA）

把「智慧学工 → 谈心谈话填写」搬到手机上：填完 → 预览确认 → 入队 → 由本地程序驱动浏览器落库。

版本 **1.1.0**。当前进度：**第一步已完成**（手机端表单 + 队列 + 常驻服务），第二步（CDP 自动填表落库）待接入。

## 结构

```
xtgl-talk-form/
├── server.mjs              # 零依赖 HTTP 服务（表单页 + 队列 API + 静态资源）
├── public/
│   ├── index.html          # 表单页（移动优先，字段枚举由服务端注入）
│   ├── manifest.webmanifest
│   ├── sw.js               # 离线缓存外壳
│   └── icon-{192,512}.png
└── data/
    ├── token.txt           # 访问令牌（600 权限，首次启动自动生成）
    └── queue.jsonl         # 待提交队列，一行一条
```

## 启动

```bash
cd ~/project/SciTools/xtgl-talk-form
node server.mjs                 # 监听 0.0.0.0:8787
TALK_PORT=9000 node server.mjs  # 换端口
```

访问：`http://127.0.0.1:8787/?k=<data/token.txt 里的值>`  
首次带 `?k=` 会写入 Cookie，之后直接开根路径即可。

## 常驻部署（systemd 用户服务）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/talk-form.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now talk-form
sudo loginctl enable-linger $USER     # 未登录/重启后仍运行
```

状态与日志：

```bash
systemctl --user status talk-form
journalctl --user -u talk-form -f
```

改代码后：`systemctl --user restart talk-form`。

## 字段与校验

| 字段 | 校验 |
|---|---|
| 姓名 xm | **必填**（重名时需补学号或提交后手动指定） |
| 学号 xh | 选填；填了必须是 6–14 位数字，用于精确锁定学生 |
| 日期 thrq / 时间 kssj | YYYY-MM-DD / HH:MM |
| 时长 thsc | 1–600 分钟 |
| 地点 thdd | 非空 |
| 方式/发起人/社会工作/自评/跟踪 | 必须命中枚举 |
| 类别 leibie | 至少一项（多选） |

枚举集中写在 `server.mjs` 的 `ENUMS`，与学工系统保持一致；改枚举只改这一处，页面自动跟着变。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/?k=<token>` | 表单页 |
| POST | `/api/submit` | 入队，返回 `{ok,id}`；校验失败返回 `{ok:false,errors[]}` |
| GET | `/api/items` | 最近 50 条（倒序） |
| GET | `/health` | 存活检查（无鉴权） |

提交示例：

```bash
T=$(cat data/token.txt)
curl -X POST "http://127.0.0.1:8787/api/submit?k=$T" -H 'content-type: application/json' -d '{
  "xh":"20241021036","xm":"谢鑫","thrq":"2026-10-28","kssj":"19:00","thsc":"20","thdd":"104",
  "fangshi":"面谈","famaoren":"辅导员","shegong":"无","leibie":["重点关注"],
  "guanjianci":"学业压力","yaodian":"…","fenxi":"…","zipin":"效果很好","genzong":"暂不需要跟踪"
}'
```

## 装到手机桌面（Tailscale + HTTPS）

Service Worker 只在安全上下文生效，`http://<内网IP>:8787` 只能当普通网页用，**装不成 PWA**。用 Tailscale 给一个真证书的 https 域名：

**1. 在 WSL 里装 Tailscale**（需要你输入 sudo 密码，我代不了）

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up          # 输出一个登录链接，浏览器打开并授权
```

**2. 手机装 Tailscale 客户端，登录同一个账号**

**3. 起 HTTPS 反代**

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status     # 看域名，形如 https://<机器名>.<tailnet>.ts.net
```

**4. 手机浏览器打开该域名 → 加入主屏 / 安装应用**

iOS：分享 → 添加到主屏幕；Android Chrome：菜单 → 安装应用。

之后桌面图标点开就是全屏表单，断网也能填（草稿存本地，提交时排队）。

## 安全

- 服务绑 `0.0.0.0`，靠 `token` 鉴权；**不要**把 8787 直接暴露到公网，只走 tailnet。
- `data/queue.jsonl` 含学生姓名、学号、手机号——属个人信息。建议 `chmod 700 data`，不要进版本库。
- 令牌泄露就删 `data/token.txt` 重启，会自动重生成。

## 下一步（第二步）

`queue.jsonl` 里的记录目前只是排队，还没有写进学工系统。第二步要做：

1. 消费队列 → CDP 打开「谈心谈话填写」页
2. 按学号选人 → 按标签定位填表 → 保存草稿
3. 截图回执 → 回写记录状态（`queued → drafted → confirmed`）
4. 提交前仍需一次人工确认（页面内或命令），避免解析错误直接落库
