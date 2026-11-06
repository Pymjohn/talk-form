#!/data/data/com.termux/files/usr/bin/bash
# 重点周期 · 服务器指令接收端（Termux）
#
# 做的事：与服务器保持一条 SSE 长连接；服务器一有事件就推一行 JSON 过来，
#        脚本立刻用 termux-notification 弹出通知。不经过 FCM，也不用轮询。
#
# 安装：
#   pkg update && pkg install curl termux-api
#   （另需安装 Termux:API 这个 App）
# 运行：
#   bash termux-alerts.sh
# 常驻（关掉 Termux 也活着）：
#   termux-wake-lock
#   nohup bash termux-alerts.sh > ~/alerts.log 2>&1 &

# 部署时改这里：TALK_BASE 为你的 HTTPS 地址，TALK_TOKEN 为 data/token.txt 内容
BASE="${TALK_BASE:-https://your-host.example.com}"
TOKEN="${TALK_TOKEN:-$(cat "$HOME/.talk-token" 2>/dev/null)}"
URL="$BASE/api/alerts/stream?k=$TOKEN"

# 字段抽取（不依赖 jq）
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

termux-wake-lock 2>/dev/null

while true; do
  echo "[$(date '+%F %T')] 连接事件流…"
  # -N 关闭缓冲，收到一行就交给 while
  curl -sN --max-time 0 --keepalive-time 30 "$URL" | while IFS= read -r line; do
    case "$line" in
      data:*)
        json="${line#data: }"
        title=$(field "$json" title)
        body=$(field "$json" body)
        [ -z "$title" ] && title="重点关注"
        [ -z "$body" ] && body="$json"
        termux-notification \
          --id focus-alert \
          --title "$title" \
          --content "$body" \
          --priority high \
          --vibrate 250 2>/dev/null || echo "termux-notification 调用失败（装 Termux:API 了吗）"
        ;;
      :*) : ;;   # 心跳
    esac
  done
  echo "[$(date '+%F %T')] 连接断开，5 秒后重连"
  sleep 5
done
