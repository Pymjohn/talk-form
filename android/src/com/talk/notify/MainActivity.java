package com.talk.notify;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final int RC_FILE = 1001;
    private WebView web;
    private ProgressBar bar;
    private TextView banner;
    private ValueCallback<Uri[]> fileCallback;
    private boolean offlineShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        setTitle("谈心提醒");
        applyLightChrome();
        // 顶部蓝色横幅（连接状态 / 最新提醒）：常驻，把网页整体挤下去
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        banner = new TextView(this);
        banner.setTextColor(0xFFFFFFFF);
        banner.setBackgroundColor(0xFF2563EB);
        banner.setTextSize(12);
        banner.setPadding(dp(10), dp(6), dp(10), dp(6));
        banner.setText(NotifyService.currentStatus());
        root.addView(banner, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout page = new FrameLayout(this);
        root.addView(page, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        web = new WebView(this);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);

        page.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 8);
        blp.topMargin = 0;
        page.addView(bar, blp);
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // 锁死缩放：不跟随系统字号放大、禁用双指缩放，避免布局被撑乱
        s.setTextZoom(100);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        if (Build.VERSION.SDK_INT >= 21) {
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && url.startsWith("http")) { v.loadUrl(url); return true; }
                return false;
            }
            @Override public void onPageFinished(WebView v, String url) { bar.setVisibility(View.GONE); }
            @Override public void onReceivedError(WebView v, int code, String desc, String url) {
                if (offlineShown) return;
                if (url != null && url.startsWith("file://")) return;
                offlineShown = true;
                v.loadUrl("file:///android_asset/offline.html");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int p) {
                bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
                bar.setProgress(p);
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                fileCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(Intent.createChooser(i, "选择文件"), RC_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // 给网页一个原生能力入口（检查更新）
        web.addJavascriptInterface(new NativeBridge(), "TalkNative");
        web.loadUrl(Const.pageUrl());

        syncCalendarInBackground();
        startNotifyService();
        askNotificationPermission();
        Toast.makeText(this, "提醒服务已启动，可返回桌面", Toast.LENGTH_SHORT).show();
        Updater.check(this, false);

        // 每天 18:00 准点更新「明天」的日历提醒（录入时网页还会额外触发一次）
        Reminder.schedule(this);
        if (!CalSync.hasPermission(this)) {
            CalSync.request(this, 2001);
        }
    }

    // 系统栏统一成页面底色，消除上下黑边
    private void applyLightChrome() {
        final int BG = 0xFFF6F7F9;
        try {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            getWindow().setStatusBarColor(BG);
            getWindow().setNavigationBarColor(BG);
            getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            if (Build.VERSION.SDK_INT >= 28) {
                android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                getWindow().setAttributes(lp);
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
            if (getActionBar() != null) {
                getActionBar().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
            }
        } catch (Throwable ignored) {}
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void startNotifyService() {
        try {
            Intent i = new Intent(this, NotifyService.class);
            i.putExtra(NotifyService.EXTRA_URL, Const.streamUrl());
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Throwable t) {
            Toast.makeText(this, "后台服务启动失败：" + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            try { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1); } catch (Throwable ignored) {}
        }
    }

    // 打开 App 时顺手同步一次日历，日常由每天 18:00 的闹钟负责
    private void syncCalendarInBackground() {
        new Thread(new Runnable() {
            @Override public void run() {
                try { DailySync.run(MainActivity.this); } catch (Throwable ignored) {}
            }
        }, "cal-sync").start();
    }

    // 供网页调用：window.TalkNative.checkUpdate()
    public class NativeBridge {
        @android.webkit.JavascriptInterface
        public void checkUpdate() {
            runOnUiThread(new Runnable() {
                @Override public void run() { Updater.check(MainActivity.this, true); }
            });
        }

        // 网页把「每天 18:00 提醒」的标题和正文传进来，写进系统日历
        @android.webkit.JavascriptInterface
        public String syncDaily(final String title, final String desc) {
            try {
                if (!CalSync.hasPermission(MainActivity.this)) {
                    runOnUiThread(new Runnable() {
                        @Override public void run() { CalSync.request(MainActivity.this, 2001); }
                    });
                    return "need-permission";
                }
                boolean ok = CalSync.sync(MainActivity.this, title, desc);
                return ok ? "ok" : "fail";
            } catch (Throwable t) {
                return "fail:" + t.getMessage();
            }
        }

        @android.webkit.JavascriptInterface
        public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == RC_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{ data.getData() };
            }
            if (fileCallback != null) { fileCallback.onReceiveValue(result); fileCallback = null; }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // 日历权限回来后重新同步一次
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == 2001) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (ok && web != null) {
                web.evaluateJavascript("try{pushCalendarReminder()}catch(e){}", null);
            } else {
                Toast.makeText(this, "没有日历权限，无法写入每日提醒", Toast.LENGTH_LONG).show();
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 横幅跟着连接状态走：连接中/已连接/重连/最新提醒
        NotifyService.setListener(new NotifyService.StatusListener() {
            @Override public void onStatus(final String text) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (banner != null) banner.setText(text == null ? "" : text);
                    }
                });
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        NotifyService.setListener(null);
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
