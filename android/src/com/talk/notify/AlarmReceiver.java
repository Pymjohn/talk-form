package com.talk.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final PendingResult pr = goAsync();
        new Thread(new Runnable() {
            @Override public void run() {
                try { DailySync.run(ctx); } finally {
                    Reminder.schedule(ctx);   // 排下一次
                    pr.finish();
                }
            }
        }, "alarm-sync").start();
    }
}
