package personal.allinone;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Remembers where the hub is and the member computers that can tell us where it moved. */
final class Hubs {
  static final int PORT = 18801;
  private static final String PREFS = "allinone";

  private Hubs() {}

  private static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** e.g. https://my-pc.tail1234.ts.net:18801/ — null until paired. */
  static String hubUrl(Context c) {
    return prefs(c).getString("hubUrl", null);
  }

  static void save(Context c, String hubUrl, JSONArray members) {
    SharedPreferences.Editor e = prefs(c).edit().putString("hubUrl", hubUrl);
    if (members != null && members.length() > 0) e.putString("members", members.toString());
    e.apply();
  }

  static void saveMembers(Context c, JSONArray members) {
    if (members != null && members.length() > 0) prefs(c).edit().putString("members", members.toString()).apply();
  }

  // ---------- reminder settings (set from the Devices page) ----------

  static JSONObject settings(Context c) {
    SharedPreferences p = prefs(c);
    JSONObject s = new JSONObject();
    try {
      s.put("notify", p.getBoolean("notify", true));
      s.put("quiet", p.getBoolean("quiet", false));
      s.put("quietFrom", p.getString("quietFrom", "23:00"));
      s.put("quietTo", p.getString("quietTo", "08:00"));
    } catch (Exception ignored) {
      // put() only fails on non-finite numbers
    }
    return s;
  }

  static void saveSettings(Context c, JSONObject s) {
    prefs(c).edit()
        .putBoolean("notify", s.optBoolean("notify", true))
        .putBoolean("quiet", s.optBoolean("quiet", false))
        .putString("quietFrom", s.optString("quietFrom", "23:00"))
        .putString("quietTo", s.optString("quietTo", "08:00"))
        .apply();
  }

  /** Whether a reminder may make a sound right now. */
  static boolean inQuietHours(Context c) {
    JSONObject s = settings(c);
    if (!s.optBoolean("quiet")) return false;
    int now = java.time.LocalTime.now().toSecondOfDay() / 60;
    int from = minutes(s.optString("quietFrom"));
    int to = minutes(s.optString("quietTo"));
    return from <= to ? now >= from && now < to : now >= from || now < to;
  }

  private static int minutes(String hhmm) {
    try {
      String[] p = hhmm.split(":");
      return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
    } catch (Exception e) {
      return 0;
    }
  }

  static boolean isMemberHost(Context c, String host) {
    if (host == null) return false;
    String hub = hubUrl(c);
    if (hub != null && host.equalsIgnoreCase(hostOf(hub))) return true;
    try {
      JSONArray members = new JSONArray(prefs(c).getString("members", "[]"));
      for (int i = 0; i < members.length(); i++) if (host.equalsIgnoreCase(members.getString(i))) return true;
    } catch (Exception ignored) {
      // no members stored yet
    }
    return false;
  }

  private static String hostOf(String url) {
    try {
      return new URL(url).getHost();
    } catch (Exception e) {
      return "";
    }
  }

  /** Asks every remembered computer "are you the hub?". Returns the hub URL, or null. Run off the main thread. */
  static String discover(Context c) {
    try {
      JSONArray members = new JSONArray(prefs(c).getString("members", "[]"));
      for (int i = 0; i < members.length(); i++) {
        try {
          JSONObject info = new JSONObject(get("https://" + members.getString(i) + ":" + PORT + "/api/info", 4000, 4000));
          if (info.optBoolean("hub")) {
            String url = info.getString("url");
            save(c, url, info.optJSONArray("members"));
            return url;
          }
        } catch (Exception ignored) {
          // that computer is offline or not the hub
        }
      }
    } catch (Exception ignored) {
      // nothing remembered
    }
    return null;
  }

  static String get(String url, int connectMs, int readMs) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setConnectTimeout(connectMs);
    conn.setReadTimeout(readMs);
    conn.setUseCaches(false);
    try {
      int status = conn.getResponseCode();
      InputStream in = status < 400 ? conn.getInputStream() : conn.getErrorStream();
      String body = read(in);
      if (status >= 400) {
        String message = body;
        try {
          message = new JSONObject(body).optString("error", body);
        } catch (Exception ignored) {
          // plain text error
        }
        throw new Exception(message.isEmpty() ? "HTTP " + status : message);
      }
      return body;
    } finally {
      conn.disconnect();
    }
  }

  static String read(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    in.close();
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }
}
