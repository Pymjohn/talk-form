package com.talk.notify;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

// 真正干活的地方：拉 /api/daily-brief → 写日历
public class DailySync {
    private static final String TAG = "TalkSync";

    public static boolean run(Context ctx) {
        try {
            if (!CalSync.hasPermission(ctx)) { Log.w(TAG, "no calendar permission"); return false; }
            String u = Const.BASE + "/api/daily-brief?k=" + Const.TOKEN;
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            if (c.getResponseCode() != 200) { c.disconnect(); return false; }
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            c.disconnect();

            JSONObject o = new JSONObject(sb.toString());
            boolean ok = CalSync.sync(ctx, o.optString("title", "谈心提醒"), o.optString("desc", ""));
            // 名单里的每个待谈项也写进日历（提前 30 分钟提醒）
            try { CalSync.syncPlans(ctx, o.optJSONArray("items")); } catch (Throwable ignored) {}
            Log.i(TAG, "sync " + (ok ? "ok" : "fail"));
            return ok;
        } catch (Throwable t) {
            Log.w(TAG, "sync error: " + t.getMessage());
            return false;
        }
    }
}
