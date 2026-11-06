package com.talk.notify;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

public class NotifyService extends Service {
    public static final String EXTRA_URL = "url";
    private static final String TAG = "TalkNotify";
    private static final int ONGOING_ID = 1001;
    private static final int ALERT_ID = 1002;
    private static final String CHANNEL_ONGOING = "ongoing";
    private static final String CHANNEL_ALERT = "alert";

    // 页面顶部横幅用的状态回调（App 内可见，即使通知栏被禁用）
    public interface StatusListener { void onStatus(String text); }
    private static volatile StatusListener listener;
    private static volatile String lastStatus = "正在连接服务器…";
    private static volatile long holdUntil = 0;      // 有提醒时先别被心跳状态覆盖

    public static void setListener(StatusListener l) {
        listener = l;
        if (l != null) { try { l.onStatus(lastStatus); } catch (Throwable ignored) {} }
    }

    public static String currentStatus() { return lastStatus; }

    private static void publish(String text) {
        lastStatus = text;
        StatusListener l = listener;
        if (l != null) { try { l.onStatus(text); } catch (Throwable ignored) {} }
    }

    // 展开通知时显示的大图标（用桌面图标位图，避免系统把自适应图标渲染成纯色块）
    private android.graphics.Bitmap largeIcon() {
        try {
            int id = getResources().getIdentifier("ic_launcher", "mipmap", getPackageName());
            if (id != 0) return android.graphics.BitmapFactory.decodeResource(getResources(), id);
        } catch (Throwable ignored) {}
        return null;
    }

    // 通知栏小图标（纯白剪影），找不到就退回系统图标
    private int smallIcon() {
        try {
            int id = getResources().getIdentifier("ic_stat_talk", "drawable", getPackageName());
            if (id != 0) return id;
        } catch (Throwable ignored) {}
        return android.R.drawable.stat_notify_chat;
    }

    private AtomicBoolean running = new AtomicBoolean(false);
    private Thread worker;
    private String url;

    // 真实连接状态：通知栏/横幅永远显示这个，而不是每次启动都被重置成「正在连接」
    private volatile String status = "正在连接服务器…";

    private void setStatus(String s) {
        if (s == null) return;
        status = s;
        publish(s);
        try { updateOngoing(s); } catch (Throwable ignored) {}
    }

    private static String hhmm(long ms) {
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.setTimeInMillis(ms);
        return String.format(java.util.Locale.CHINA, "%02d:%02d",
                c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getStringExtra(EXTRA_URL) != null) {
            url = intent.getStringExtra(EXTRA_URL);
        }
        if (url == null) url = Prefs.getUrl(this);
        Prefs.setUrl(this, url);

        createChannels();
        // 用当前真实状态刷新常驻通知：已经连着就不要又显示成「正在连接」
        startForeground(ONGOING_ID, buildOngoing(status));

        synchronized (this) {
            if (worker != null && worker.isAlive()) return START_STICKY;   // 线程活着，什么都不用做
            running.set(true);
            worker = new Thread(new Runnable() {
                @Override public void run() { loop(); }
            }, "sse");
            worker.start();
        }
        return START_STICKY;
    }

    private void loop() {
        int fail = 0;
        while (running.get()) {
            HttpURLConnection conn = null;
            BufferedReader rd = null;
            try {
                setStatus(fail == 0 ? "正在连接服务器…" : "重连中（第 " + fail + " 次）…");
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setConnectTimeout(15000);
                // 服务端每 25 秒发一次心跳注释；45 秒读不到任何字节就认定链路已死，主动重连
                conn.setReadTimeout(45000);
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-cache");
                int code = conn.getResponseCode();
                if (code != 200) {
                    throw new Exception("HTTP " + code);
                }
                rd = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                setStatus("已连接，等待事件");
                String line;
                StringBuilder data = new StringBuilder();
                long lastBeat = System.currentTimeMillis();
                while (running.get() && (line = rd.readLine()) != null) {
                    fail = 0;
                    long now = System.currentTimeMillis();
                    if (now - lastBeat > 60000 && now > holdUntil) {   // 心跳节流：一分钟刷一次
                        lastBeat = now;
                        setStatus("已连接 · " + hhmm(now) + " 心跳");
                    }
                    if (line.startsWith("data:")) {
                        data.append(line.substring(5).trim());
                    } else if (line.isEmpty()) {
                        if (data.length() > 0) {
                            showAlert(data.toString());
                            data.setLength(0);
                        }
                    }
                }
                if (running.get()) setStatus("连接已断开，准备重连");
            } catch (java.net.SocketTimeoutException e) {
                Log.w(TAG, "read timeout");
                setStatus("心跳超时，重连中…");
            } catch (Exception e) {
                Log.w(TAG, "stream error: " + e.getMessage());
                setStatus("连接中断，重试中…");
            } finally {
                try { if (rd != null) rd.close(); } catch (Exception ignored) {}
                if (conn != null) conn.disconnect();
            }
            if (!running.get()) break;
            fail++;
            long wait = Math.min(20000L, 2000L * fail);
            try { Thread.sleep(wait); } catch (InterruptedException ignored) {}
        }
        running.set(false);
    }

    private void showAlert(String json) {
        // 服务器指令：立即同步日历
        String action = field(json, "action");
        if ("calendar".equals(action)) {
            new Thread(new Runnable() {
                @Override public void run() {
                    boolean ok = DailySync.run(NotifyService.this);
                    postText(ok ? "日历已同步" : "日历同步失败", ok ? "本周期提醒已写入系统日历" : "检查日历权限或网络");
                }
            }, "cmd-sync").start();
            return;
        }

        String title = field(json, "title");
        String body = field(json, "body");
        if (title == null || title.length() == 0) title = "重点关注";
        if (body == null) body = json;

        // 页面顶部蓝色横幅也显示这条提醒，30 秒内不让心跳状态盖掉
        holdUntil = System.currentTimeMillis() + 30000;
        setStatus("提醒 · " + title + (body.length() > 0 ? "：" + body : ""));
        showAlertNotification(title, body);
    }

    private void showAlertNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT);
        b.setSmallIcon(smallIcon())
         .setContentTitle(title)
         .setContentText(body)
         .setStyle(new Notification.BigTextStyle().bigText(body))
         .setAutoCancel(true)
         .setContentIntent(pi)
         .setDefaults(Notification.DEFAULT_ALL);
        android.graphics.Bitmap bi = largeIcon();
        if (bi != null) b.setLargeIcon(bi);
        try { nm.notify(ALERT_ID, b.build()); } catch (Throwable ignored) {}
    }

    // 轻提示（用于确认指令执行结果）
    private void postText(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
        b.setSmallIcon(smallIcon())
         .setContentTitle(title)
         .setContentText(body)
         .setAutoCancel(true)
         .setDefaults(Notification.DEFAULT_ALL);
        try { nm.notify(ALERT_ID + 1, b.build()); } catch (Throwable ignored) {}
    }

    private static String field(String json, String key) {
        String k = "\"" + key + "\":\"";
        int i = json.indexOf(k);
        if (i < 0) return null;
        int s = i + k.length();
        StringBuilder sb = new StringBuilder();
        for (int p = s; p < json.length(); p++) {
            char c = json.charAt(p);
            if (c == '\\' && p + 1 < json.length()) { sb.append(json.charAt(++p)); continue; }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel on = new NotificationChannel(CHANNEL_ONGOING, "后台连接", NotificationManager.IMPORTANCE_MIN);
        on.setShowBadge(false);
        nm.createNotificationChannel(on);
        NotificationChannel al = new NotificationChannel(CHANNEL_ALERT, "重点关注提醒", NotificationManager.IMPORTANCE_HIGH);
        al.enableVibration(true);
        nm.createNotificationChannel(al);
    }

    private Notification buildOngoing(String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ONGOING)
                : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT);
        return b.setSmallIcon(smallIcon())
                .setContentTitle("谈心提醒")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private void updateOngoing(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(ONGOING_ID, buildOngoing(text));
    }

    @Override
    public void onDestroy() {
        running.set(false);
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
