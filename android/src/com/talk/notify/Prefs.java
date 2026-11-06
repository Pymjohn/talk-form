package com.talk.notify;

import android.content.Context;
import android.content.SharedPreferences;

public class Prefs {
    private static final String FILE = "talk";
    private static final String KEY_URL = "url";

    public static void setUrl(Context c, String url) {
        if (url == null) return;
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
    }

    public static String getUrl(Context c) {
        SharedPreferences sp = c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        return sp.getString(KEY_URL, Const.streamUrl());
    }
}
