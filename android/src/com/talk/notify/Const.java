package com.talk.notify;

public class Const {
    // 服务器地址与访问令牌（改这里重新编译即可）
    // 部署时改成你自己的地址：Tailscale serve 给的 https 域名（或任何能访问 8787 的 https 域名）
    public static final String BASE = "https://your-host.example.com";
    // 服务端 data/token.txt 里的令牌，首次启动自动生成
    public static final String TOKEN = "REPLACE_WITH_YOUR_TOKEN";

    public static String pageUrl() { return BASE + "/?k=" + TOKEN; }
    public static String streamUrl() { return BASE + "/api/alerts/stream?k=" + TOKEN; }
}
