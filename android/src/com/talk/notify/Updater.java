package com.talk.notify;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Environment;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class Updater {
    private static final long DL_ID = 9001L;
    private static BroadcastReceiver receiver;

    public static void check(final Activity act, final boolean manual) {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    String u = Const.BASE + "/api/app/version?k=" + Const.TOKEN;
                    HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(10000);
                    if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                    StringBuilder sb = new StringBuilder();
                    BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                    String l;
                    while ((l = r.readLine()) != null) sb.append(l);
                    r.close();
                    c.disconnect();

                    JSONObject o = new JSONObject(sb.toString());
                    final int remote = o.optInt("versionCode", 0);
                    final String name = o.optString("versionName", "");
                    int installed = act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionCode;

                    if (remote <= installed) {
                        if (manual) act.runOnUiThread(new Runnable() { public void run() { toast(act, "已是最新版本 " + name); } });
                        return;
                    }
                    act.runOnUiThread(new Runnable() {
                        @Override public void run() { prompt(act, remote, name); }
                    });
                } catch (final Exception e) {
                    if (manual) act.runOnUiThread(new Runnable() { public void run() { toast(act, "检查更新失败：" + e.getMessage()); } });
                }
            }
        }, "updater").start();
    }

    private static void prompt(final Activity act, final int code, final String name) {
        new AlertDialog.Builder(act)
                .setTitle("发现新版本 " + name)
                .setMessage("是否下载并安装？安装包约 17 KB。\n\n首次更新时，系统会要求允许「安装未知应用」，允许一次即可。")
                .setPositiveButton("立即更新", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) { download(act, code); }
                })
                .setNegativeButton("以后再说", null)
                .show();
    }

    private static void download(final Activity act, int code) {
        try {
            DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
            Uri uri = Uri.parse(Const.BASE + "/apk/talk-notify.apk?k=" + Const.TOKEN + "&v=" + code);
            DownloadManager.Request req = new DownloadManager.Request(uri);
            req.setTitle("谈心提醒 更新");
            req.setDescription("下载完成后会自动拉起安装");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "talk-notify-" + code + ".apk");
            req.setMimeType("application/vnd.android.package-archive");
            final long id = dm.enqueue(req);
            toast(act, "开始下载…");

            if (receiver != null) {
                try { act.unregisterReceiver(receiver); } catch (Exception ignored) {}
            }
            receiver = new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent intent) {
                    if (id != intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)) return;
                    try {
                        Uri apk = ((DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE)).getUriForDownloadedFile(id);
                        Intent i = new Intent(Intent.ACTION_VIEW);
                        i.setDataAndType(apk, "application/vnd.android.package-archive");
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(i);
                    } catch (Exception e) {
                        toast(ctx, "安装失败：" + e.getMessage());
                    }
                }
            };
            act.registerReceiver(receiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        } catch (Exception e) {
            toast(act, "下载失败：" + e.getMessage());
        }
    }

    private static void toast(Context c, String s) { Toast.makeText(c, s, Toast.LENGTH_LONG).show(); }
}
