package com.talk.notify;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.widget.Toast;

import java.util.Calendar;
import java.util.TimeZone;

// 把「每天 6 点的提醒」写进系统日历：由系统负责响铃，不依赖长连接
public class CalSync {
    private static final String PREF = "cal";
    private static final String KEY_EVENT = "eventId";
    private static final String KEY_DAY = "dayStamp";

    public static boolean hasPermission(Context c) {
        return c.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
                && c.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    public static void request(Activity a, int code) {
        a.requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}, code);
    }

    // 找一个可写日历（优先主日历）
    private static long writableCalendar(ContentResolver cr) {
        String[] proj = new String[]{
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.IS_PRIMARY
        };
        Cursor c = cr.query(CalendarContract.Calendars.CONTENT_URI, proj,
                CalendarContract.Calendars.VISIBLE + "=1", null, null);
        long fallback = -1;
        try {
            while (c != null && c.moveToNext()) {
                long id = c.getLong(0);
                int lvl = c.getInt(1);
                int primary = c.getInt(2);
                if (lvl >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) {
                    if (primary == 1) return id;
                    if (fallback < 0) fallback = id;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return fallback;
    }

    // summary 为标题，desc 为正文；每天 6:00 一条，重复
    // 把「待谈名单」写成日历事件（提前 30 分钟提醒），谈完/删除后自动移除
    public static void syncPlans(Context ctx, org.json.JSONArray items) {
        if (items == null || !hasPermission(ctx)) return;
        ContentResolver cr = ctx.getContentResolver();
        long calId = writableCalendar(cr);
        if (calId < 0) return;

        SharedPreferences sp = ctx.getSharedPreferences("calplans", Context.MODE_PRIVATE);
        org.json.JSONObject map;
        try { map = new org.json.JSONObject(sp.getString("map", "{}")); } catch (Exception e) { map = new org.json.JSONObject(); }
        org.json.JSONObject next = new org.json.JSONObject();
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA);

        for (int i = 0; i < items.length(); i++) {
            org.json.JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String id = it.optString("id");
            if (id.length() == 0) continue;
            long startMs;
            try { startMs = fmt.parse(it.optString("thrq") + " " + it.optString("kssj", "09:00")).getTime(); }
            catch (Exception e) { continue; }
            long endMs = startMs + 30 * 60 * 1000;

            String bj = it.optString("bj", "");
            String xm = it.optString("xm", "");
            String dd = it.optString("thdd", "");
            ContentValues cv = new ContentValues();
            cv.put(CalendarContract.Events.CALENDAR_ID, calId);
            cv.put(CalendarContract.Events.TITLE, "谈话 · " + xm + (bj.length() > 0 ? "（" + bj + "）" : ""));
            cv.put(CalendarContract.Events.DESCRIPTION, "学号 " + it.optString("xh", "未填") + "\n地点 " + (dd.length() > 0 ? dd : "104"));
            cv.put(CalendarContract.Events.DTSTART, startMs);
            cv.put(CalendarContract.Events.DTEND, endMs);
            cv.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
            cv.putNull(CalendarContract.Events.RRULE);
            cv.put(CalendarContract.Events.HAS_ALARM, 1);

            try {
                long evId = map.optLong(id, -1);
                if (evId > 0) {
                    Uri u = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, evId);
                    if (cr.update(u, cv, null, null) > 0) {
                        ensureReminder(cr, evId, 30);
                        next.put(id, evId);
                        continue;
                    }
                }
                Uri ins = cr.insert(CalendarContract.Events.CONTENT_URI, cv);
                if (ins != null) {
                    long nid = ContentUris.parseId(ins);
                    ensureReminder(cr, nid, 30);
                    next.put(id, nid);
                }
            } catch (Exception ignored) {}
        }

        // 清掉已经谈完 / 被删掉的名单事件
        java.util.Iterator<String> keys = map.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (next.has(k)) continue;
            long evId = map.optLong(k, -1);
            if (evId <= 0) continue;
            try {
                Uri u = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, evId);
                cr.delete(u, null, null);
            } catch (Exception ignored) {}
        }
        sp.edit().putString("map", next.toString()).apply();
    }

    public static boolean sync(Context ctx, String summary, String desc) {
        if (!hasPermission(ctx)) return false;
        ContentResolver cr = ctx.getContentResolver();
        long calId = writableCalendar(cr);
        if (calId < 0) return false;

        Calendar start = Calendar.getInstance();
        start.set(Calendar.HOUR_OF_DAY, 18);   // 晚上 6 点
        start.set(Calendar.MINUTE, 0);
        start.set(Calendar.SECOND, 0);
        start.set(Calendar.MILLISECOND, 0);
        // 固定指向「明天 18:00」：由录入动作触发更新
        start.add(Calendar.DAY_OF_MONTH, 1);
        long startMs = start.getTimeInMillis();
        long endMs = startMs + 15 * 60 * 1000;

        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        long eventId = sp.getLong(KEY_EVENT, -1);

        ContentValues cv = new ContentValues();
        cv.put(CalendarContract.Events.CALENDAR_ID, calId);
        cv.put(CalendarContract.Events.TITLE, summary);
        cv.put(CalendarContract.Events.DESCRIPTION, desc);
        cv.put(CalendarContract.Events.DTSTART, startMs);
        cv.put(CalendarContract.Events.DTEND, endMs);
        cv.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
        // 显式清空 RRULE：2.4 建的是每日重复事件，升级后要把它变回单次
        cv.putNull(CalendarContract.Events.RRULE);
        cv.put(CalendarContract.Events.HAS_ALARM, 1);
        cv.put(CalendarContract.Events.EVENT_LOCATION, "");

        try {
            if (eventId > 0) {
                Uri u = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId);
                int n = cr.update(u, cv, null, null);
                if (n > 0) { ensureReminder(cr, eventId); return true; }
            }
            Uri ins = cr.insert(CalendarContract.Events.CONTENT_URI, cv);
            if (ins == null) return false;
            long id = ContentUris.parseId(ins);
            sp.edit().putLong(KEY_EVENT, id).apply();
            ensureReminder(cr, id);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void ensureReminder(ContentResolver cr, long eventId) { ensureReminder(cr, eventId, 0); }

    private static void ensureReminder(ContentResolver cr, long eventId, int minutes) {
        Cursor c = cr.query(CalendarContract.Reminders.CONTENT_URI,
                new String[]{CalendarContract.Reminders._ID},
                CalendarContract.Reminders.EVENT_ID + "=?", new String[]{String.valueOf(eventId)}, null);
        boolean has = c != null && c.moveToFirst();
        if (c != null) c.close();
        if (has) return;
        ContentValues r = new ContentValues();
        r.put(CalendarContract.Reminders.EVENT_ID, eventId);
        r.put(CalendarContract.Reminders.MINUTES, minutes);
        r.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
        try { cr.insert(CalendarContract.Reminders.CONTENT_URI, r); } catch (Exception ignored) {}
    }

    public static void toast(Context c, String s) {
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
    }
}
