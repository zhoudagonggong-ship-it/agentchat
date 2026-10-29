package personal.allinone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts, resume background reminders (only once paired). */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && Hubs.hubUrl(context) != null) {
      context.startForegroundService(new Intent(context, NotifyService.class).setAction("start"));
    }
  }
}
