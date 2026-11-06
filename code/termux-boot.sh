#!/data/data/com.termux/files/usr/bin/bash
# 开机自启：由 Termux:Boot 调用（需安装 Termux:Boot 并打开一次）
# 放置位置：~/.termux/boot/start-alerts.sh
termux-wake-lock 2>/dev/null
export PATH=/data/data/com.termux/files/usr/bin:$PATH
sleep 20            # 等系统网络就绪
nohup bash "$HOME/alerts.sh" >> "$HOME/alerts.log" 2>&1 &
