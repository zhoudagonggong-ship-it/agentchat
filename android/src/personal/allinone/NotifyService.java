package personal.allinone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps one light long-poll to the hub so finished turns and approval requests reach the phone
 * while the app is in the background. Shows a quiet ongoing notification, as Android requires.
 */
public class NotifyService extends Service {
  private static final String CH_ONGOING = "ongoing";
  private static final String CH_MESSAGES = "messages";
  private static final String CH_QUIET = "quiet";
  private static final int ONGOING_ID = 1;
  private Thread worker;
  private volatile boolean running;

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (Hubs.hubUrl(this) == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    channels();
    Notification ongoing = new Notification.Builder(this, CH_ONGOING)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("AgentChat")
        .setContentText("在后台接收完成提醒")
        .setOngoing(true)
        .setContentIntent(open(null, 0))
        .build();
    if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
    else startForeground(ONGOING_ID, ongoing);
    if (worker == null || !worker.isAlive()) {
      running = true;
      worker = new Thread(this::loop, "notify");
      worker.start();
    }
    return START_STICKY;
  }

  private void loop() {
    long after = 0;
    long backoff = 5000;
    while (running) {
      String hub = Hubs.hubUrl(this);
      try {
        JSONObject reply = new JSONObject(Hubs.get(hub + "api/notify?after=" + after, 10000, 60000));
        long seq = reply.getLong("seq");
        // A hub that restarted starts counting again; take its number without replaying.
        if (after > 0 && seq >= after) {
          JSONArray events = reply.optJSONArray("events");
          for (int i = 0; events != null && i < events.length(); i++) post(events.getJSONObject(i));
        }
        after = seq;
        Hubs.saveMembers(this, reply.optJSONArray("members"));
        backoff = 5000;
      } catch (Exception e) {
        after = 0;
        Hubs.discover(this); // the hub may have moved
        sleep(backoff);
        backoff = Math.min(backoff * 2, 120000);
      }
    }
  }

  /** Unread reminders per conversation; their sum is the number on the app icon. */
  private static final Map<String, Integer> COUNTS = new ConcurrentHashMap<>();

  /** The conversation was read in the app: remove its reminder (and its share of the icon number). */
  static void clear(Context c, String session) {
    if (COUNTS.remove(session) != null) c.getSystemService(NotificationManager.class).cancel(session.hashCode());
  }

  private void post(JSONObject event) {
    if (!Hubs.settings(this).optBoolean("notify", true)) return;
    boolean quiet = Hubs.inQuietHours(this);
    boolean approval = "approval".equals(event.optString("type"));
    String session = event.optString("sessionId");
    int count = COUNTS.merge(session, 1, Integer::sum);
    // In quiet hours the reminder still appears, but on the silent channel.
    Notification n = new Notification.Builder(this, quiet ? CH_QUIET : CH_MESSAGES)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle((approval ? "需要你审批 · " + event.optString("title") : event.optString("title")) + (count > 1 ? "（" + count + " 条）" : ""))
        .setNumber(count)
        .setBadgeIconType(Notification.BADGE_ICON_SMALL)
        .setContentText(event.optString("text"))
        .setStyle(new Notification.BigTextStyle().bigText(event.optString("text")))
        .setAutoCancel(true)
        .setCategory(Notification.CATEGORY_MESSAGE)
        .setContentIntent(open(session, session.hashCode()))
        .build();
    getSystemService(NotificationManager.class).notify(session.hashCode(), n);
  }

  private PendingIntent open(String session, int code) {
    Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    if (session != null) intent.putExtra("session", session);
    return PendingIntent.getActivity(this, code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private void channels() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel ongoing = new NotificationChannel(CH_ONGOING, "后台连接", NotificationManager.IMPORTANCE_MIN);
    ongoing.setShowBadge(false);
    nm.createNotificationChannel(ongoing);
    nm.createNotificationChannel(new NotificationChannel(CH_MESSAGES, "完成与审批提醒", NotificationManager.IMPORTANCE_HIGH));
    nm.createNotificationChannel(new NotificationChannel(CH_QUIET, "免打扰时段的提醒", NotificationManager.IMPORTANCE_LOW));
  }

  private static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
    }
  }

  @Override
  public void onDestroy() {
    running = false;
    if (worker != null) worker.interrupt();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
