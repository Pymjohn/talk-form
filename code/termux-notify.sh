#!/data/data/com.termux/files/usr/bin/bash
# 重点周期本地提醒（Termux 版）
# 不走 FCM/推送服务：定时请求你自己的服务器，有未谈的就弹本地通知。
#
# 安装（手机 Termux 里执行）：
#   pkg update && pkg install curl termux-api
#   另需安装 "Termux:API" 这个 App（F-Droid / 应用商店）
# 运行：
#   bash termux-notify.sh
# 常驻：
#   termux-wake-lock; nohup bash termux-notify.sh >/dev/null 2>&1 &

# 部署时改这里：TALK_BASE 为你的 HTTPS 地址，TALK_TOKEN 为 data/token.txt 内容
BASE="${TALK_BASE:-https://your-host.example.com}"
TOKEN="${TALK_TOKEN:-$(cat "$HOME/.talk-token" 2>/dev/null)}"
URL="$BASE/api/focus/brief?k=$TOKEN"
INTERVAL=21600          # 6 小时
LAST=""

while true; do
  body=$(curl -s --max-time 25 "$URL")
  need=$(printf '%s' "$body" | sed -n 's/.*"need":\([0-9]*\).*/\1/p')
  text=$(printf '%s' "$body" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p')
  period=$(printf '%s' "$body" | sed -n 's/.*"period":"\([^"]*\)".*/\1/p')

  if [ -n "$need" ] && [ "$need" -gt 0 ]; then
    key="$period|$need|$text"
    if [ "$key" != "$LAST" ]; then
      termux-notification \
        --id focus-cycle \
        --title "重点关注 · ${need} 人本周期未谈" \
        --content "${text}（${period} 截止）" \
        --priority high \
        --vibrate 200
      LAST="$key"
    fi
  fi
  sleep "$INTERVAL"
done
