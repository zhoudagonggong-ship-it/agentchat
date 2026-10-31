package personal.allinone;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** The app is a thin shell: the interface is the hub's own web page; native code does what a page cannot. */
public class MainActivity extends Activity {
  private static final int REQ_NOTIFY = 2;
  private static final int REQ_CAMERA = 3;
  private static final int REQ_FILES = 4;
  private static final String TAILSCALE = "com.tailscale.ipn";
  private ValueCallback<Uri[]> fileCallback;
  private FrameLayout root;
  private WebView web;
  private PaneBrowser browser;
  private PermissionRequest cameraRequest;
  private boolean failingOver = false;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    web.setBackgroundColor(Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    web.addJavascriptInterface(new Bridge(), "AllinOneNative");
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(PermissionRequest request) {
        // Only the app's own scan page may use the camera.
        boolean camera = java.util.Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        String page = web.getUrl();
        if (!camera || !"file".equals(request.getOrigin().getScheme()) || page == null || !isLocalPage(Uri.parse(page))) {
          request.deny();
          return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
          request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
          cameraRequest = request;
          requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
        }
      }

      /** A video's full-screen button: the player covers everything, and turning the phone turns it. */
      private View fullscreen;

      @Override
      public void onShowCustomView(View view, CustomViewCallback callback) {
        if (fullscreen != null) {
          callback.onCustomViewHidden();
          return;
        }
        fullscreen = view;
        view.setBackgroundColor(Color.BLACK);
        root.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
      }

      @Override
      public void onHideCustomView() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
      }

      /** The composer's + button: the system picker (gallery, files, camera apps), several at once. */
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
        try {
          startActivityForResult(Intent.createChooser(pick, "选择图片或文件"), REQ_FILES);
        } catch (Exception e) {
          fileCallback = null;
          return false;
        }
        return true;
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (isLocalPage(uri)) return false; // the app's own setup / scan / offline pages
        if ("https".equals(uri.getScheme()) && Hubs.isMemberHost(MainActivity.this, uri.getHost())) {
          // The hub moved to another member computer: remember it and follow.
          String url = uri.getScheme() + "://" + uri.getHost() + ":" + uri.getPort() + "/";
          if (!url.equals(Hubs.hubUrl(MainActivity.this))) Hubs.save(MainActivity.this, url, null);
          return false;
        }
        startActivity(new Intent(Intent.ACTION_VIEW, uri)); // ordinary links open in the browser
        return true;
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) failOver();
      }
    });
    // The workbench page fills the screen; the right pane's browser floats over its slot when shown.
    FrameLayout root = new FrameLayout(this);
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    browser = new PaneBrowser(this, root, (json) -> web.evaluateJavascript("window.onBrowserState && window.onBrowserState(" + json + ")", null));
    fitSystemBars(root);
    setContentView(root);

    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
    }
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }
    if (!handle(getIntent())) loadHub(null);
  }

  /**
   * Android draws apps edge to edge: keep the page clear of the status bar (its clock and icons) and the
   * gesture bar and keyboard, give that strip the page's own colour, and use icons that show on it.
   */
  private void fitSystemBars(FrameLayout root) {
    this.root = root;
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
      Insets ime = insets.getInsets(WindowInsets.Type.ime());
      v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
      return WindowInsets.CONSUMED;
    });
    paintSystemBars();
  }

  /** Light or dark, following the system as the page does. */
  private void paintSystemBars() {
    boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    root.setBackgroundColor(night ? 0xFF111111 : 0xFFF7F7F7); // the page's --bg
    int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
    WindowInsetsController bars = getWindow().getInsetsController();
    if (bars != null) bars.setSystemBarsAppearance(night ? 0 : light, light); // dark icons on the light page
  }

  @Override
  public void onConfigurationChanged(Configuration config) {
    super.onConfigurationChanged(config);
    paintSystemBars(); // the manifest keeps the activity across a light/dark switch
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handle(intent);
  }

  /** Pairing links and notification taps. Returns true when it took care of loading. */
  private boolean handle(Intent intent) {
    Uri data = intent.getData();
    if (data != null && "allinone".equals(data.getScheme()) && "pair".equals(data.getHost())) {
      pair(data);
      return true;
    }
    String session = intent.getStringExtra("session");
    if (session != null) {
      loadHub(session);
      return true;
    }
    return false;
  }

  private void loadHub(String session) {
    String hub = Hubs.hubUrl(this);
    if (hub == null) {
      web.loadUrl("file:///android_asset/setup.html");
      return;
    }
    startForegroundService(new Intent(this, NotifyService.class).setAction("start"));
    String target = hub + (session != null ? "#s=" + Uri.encode(session) : "");
    String current = web.getUrl();
    if (session != null && current != null && current.startsWith(hub)) {
      web.evaluateJavascript("location.hash='s=" + Uri.encode(session) + "'", null);
    } else {
      web.loadUrl(target);
    }
  }

  private void pair(Uri link) {
    String host = link.getQueryParameter("hub");
    String port = link.getQueryParameter("port");
    String code = link.getQueryParameter("code");
    if (host == null || code == null || !host.endsWith(".ts.net")) {
      toast("二维码无效");
      return;
    }
    toast("正在配对…");
    new Thread(() -> {
      try {
        String url = "https://" + host + ":" + (port != null ? port : Hubs.PORT) + "/api/pair?code=" + Uri.encode(code);
        JSONObject reply = new JSONObject(Hubs.get(url, 8000, 15000));
        Hubs.save(this, reply.getString("url"), reply.optJSONArray("members"));
        runOnUiThread(() -> {
          toast("配对成功");
          loadHub(null);
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast("配对失败：" + e.getMessage() + "（请确认手机已连接 Tailscale）"));
      }
    }).start();
  }

  /** The hub did not answer: ask the member computers where it is now. */
  private void failOver() {
    if (failingOver) return;
    failingOver = true;
    new Thread(() -> {
      String found = Hubs.discover(this);
      runOnUiThread(() -> {
        failingOver = false;
        if (found != null && !found.equals(web.getUrl())) web.loadUrl(found);
        else web.loadUrl("file:///android_asset/offline.html");
      });
    }).start();
  }

  private void goBack() {
    if (browser.back()) return;
    web.evaluateJavascript("window.onNativeBack ? window.onNativeBack() : false", (handled) -> {
      if (!"true".equals(handled)) moveTaskToBack(true);
    });
  }

  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    goBack();
  }

  @Override
  @SuppressWarnings("deprecation")
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQ_FILES || fileCallback == null) return;
    Uri[] picked = null;
    if (resultCode == RESULT_OK && data != null) {
      ClipData clip = data.getClipData();
      if (clip != null) {
        picked = new Uri[clip.getItemCount()];
        for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
      } else if (data.getData() != null) {
        picked = new Uri[] {data.getData()};
      }
    }
    fileCallback.onReceiveValue(picked); // null: cancelled, the page stays as it was
    fileCallback = null;
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
    if (requestCode == REQ_CAMERA && cameraRequest != null) {
      if (granted) cameraRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
      else cameraRequest.deny();
      cameraRequest = null;
    }
  }

  // ---------- files the WebView cannot show ----------

  /** A file of the hub's, downloaded into the app's cache (only the hub's own files: the page names them). */
  private File fetch(String url, String name) throws Exception {
    File dir = new File(getCacheDir(), "files");
    dir.mkdirs();
    File file = new File(dir, safeName(name));
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setConnectTimeout(8000);
    conn.setReadTimeout(60000);
    try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
      byte[] buf = new byte[65536];
      for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    } finally {
      conn.disconnect();
    }
    return file;
  }

  private static String safeName(String name) {
    String n = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    return n.isEmpty() ? "file" : n;
  }

  private boolean fromHub(String url) {
    String hub = Hubs.hubUrl(this);
    return hub != null && url.startsWith(hub);
  }

  /** Into the phone's own collections, where the gallery and other apps find it: pictures, videos, music, else downloads. */
  private void saveFile(String url, String name, String mime) {
    if (!fromHub(url)) return;
    toast("正在保存 " + name);
    new Thread(() -> {
      try {
        Uri collection;
        String folder;
        if (mime.startsWith("image/")) {
          collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_PICTURES;
        } else if (mime.startsWith("video/")) {
          collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_MOVIES;
        } else if (mime.startsWith("audio/")) {
          collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_MUSIC;
        } else {
          collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
          folder = Environment.DIRECTORY_DOWNLOADS;
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName(name));
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/AgentChat");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = getContentResolver().insert(collection, values);
        if (item == null) throw new Exception("系统不让保存");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(60000);
        try (InputStream in = conn.getInputStream(); OutputStream out = getContentResolver().openOutputStream(item)) {
          byte[] buf = new byte[65536];
          for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
          getContentResolver().delete(item, null, null);
          throw e;
        } finally {
          conn.disconnect();
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContentResolver().update(item, values, null, null);
        String where = mime.startsWith("image/") ? "相册" : mime.startsWith("video/") ? "相册的视频" : mime.startsWith("audio/") ? "音乐" : "下载";
        runOnUiThread(() -> toast("已保存到" + where + "（AgentChat 文件夹）"));
      } catch (Exception e) {
        runOnUiThread(() -> toast("保存失败：" + e.getMessage()));
      }
    }).start();
  }

  /** To another app (WeChat, a photo editor…), through the system's share sheet. */
  private void shareFile(String url, String name, String mime) {
    if (!fromHub(url)) return;
    new Thread(() -> {
      try {
        File file = fetch(url, name);
        runOnUiThread(() -> {
          Uri uri = FilesProvider.uriFor(file);
          Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
          send.setClipData(ClipData.newRawUri(name, uri));
          startActivity(Intent.createChooser(send, "分享 " + name));
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast("分享失败：" + e.getMessage()));
      }
    }).start();
  }

  private void openFile(String url, String name, String mime) {
    if (!fromHub(url)) return; // only the hub's own files
    toast("正在打开 " + name);
    new Thread(() -> {
      try {
        File file = fetch(url, name);
        runOnUiThread(() -> {
          if ("application/pdf".equals(mime)) {
            startActivity(new Intent(this, PdfActivity.class).putExtra("path", file.getAbsolutePath()).putExtra("title", name));
          } else {
            Uri uri = FilesProvider.uriFor(file);
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
              startActivity(Intent.createChooser(view, name));
            } catch (Exception e) {
              toast("手机上没有能打开这种文件的应用");
            }
          }
        });
      } catch (Exception e) {
        runOnUiThread(() -> toast("打开失败：" + e.getMessage()));
      }
    }).start();
  }

  private static boolean isLocalPage(Uri uri) {
    return uri != null && "file".equals(uri.getScheme()) && uri.getPath() != null && uri.getPath().startsWith("/android_asset/");
  }

  private void toast(String text) {
    Toast.makeText(this, text, Toast.LENGTH_LONG).show();
  }

  /** Called from the page as window.AllinOneNative.*; runs on a WebView thread. */
  private final class Bridge {
    @JavascriptInterface public void openFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.openFile(url, name, mime));
    }
    @JavascriptInterface public void saveFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.saveFile(url, name, mime));
    }
    @JavascriptInterface public void shareFile(String url, String name, String mime) {
      runOnUiThread(() -> MainActivity.this.shareFile(url, name, mime));
    }
    /** A picture is open full screen: turning the phone turns it, even with the screen's rotation locked. */
    @JavascriptInterface public void viewerOpen(boolean open) {
      runOnUiThread(() -> setRequestedOrientation(open ? ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
    }
    @JavascriptInterface public void retry() {
      runOnUiThread(() -> loadHub(null));
    }
    @JavascriptInterface public String getSettings() {
      JSONObject s = Hubs.settings(MainActivity.this);
      try {
        s.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
      } catch (Exception ignored) {
        // version is informational
      }
      return s.toString();
    }
    @JavascriptInterface public void setSettings(String json) {
      try {
        Hubs.saveSettings(MainActivity.this, new JSONObject(json));
      } catch (Exception ignored) {
        // malformed input from the page: keep the previous settings
      }
    }
    // ---- the right pane's browser ----
    @JavascriptInterface public void browserOpen(String url) {
      if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) runOnUiThread(() -> browser.open(url));
    }
    @JavascriptInterface public void browserPlace(float x, float y, float w, float h) {
      runOnUiThread(() -> browser.place(x, y, w, h));
    }
    @JavascriptInterface public void browserHide() {
      runOnUiThread(() -> browser.hide());
    }
    @JavascriptInterface public void browserNav(String action) {
      runOnUiThread(() -> browser.nav(action));
    }
    @JavascriptInterface public void markRead(String sessionId) {
      NotifyService.clear(MainActivity.this, sessionId);
    }
    @JavascriptInterface public void scan() {
      runOnUiThread(() -> web.loadUrl("file:///android_asset/scan.html"));
    }
    // ---- the offline page: why the hub cannot be reached, and the way to fix it ----
    /** "missing" (Tailscale not installed), "off" (installed, its VPN not on) or "on". */
    @JavascriptInterface public String tailscaleState() {
      if (getPackageManager().getLaunchIntentForPackage(TAILSCALE) == null) return "missing";
      ConnectivityManager cm = getSystemService(ConnectivityManager.class);
      for (Network n : cm.getAllNetworks()) {
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "on";
      }
      return "off";
    }
    /** Opens Tailscale, or its store page when it is not installed. */
    @JavascriptInterface public void openTailscale() {
      runOnUiThread(() -> {
        Intent app = getPackageManager().getLaunchIntentForPackage(TAILSCALE);
        try {
          startActivity(app != null ? app : new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + TAILSCALE)));
        } catch (Exception e) {
          startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + TAILSCALE)));
        }
      });
    }
    /**
     * Battery saving closes Tailscale (and with it every connection): "self" asks the system to let this app run in the
     * background; "tailscale" opens Tailscale's app page, where 电池 → 不受限制 is one tap away.
     */
    @JavascriptInterface public void batterySettings(String which) {
      runOnUiThread(() -> {
        try {
          if ("self".equals(which)) {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
          } else {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + TAILSCALE)));
          }
        } catch (Exception e) {
          startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
      });
    }
    @JavascriptInterface public boolean batteryFree() {
      return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }
    /** From the in-app scanner: the text of the pairing QR code. */
    @JavascriptInterface public void pairLink(String link) {
      runOnUiThread(() -> {
        Uri uri = Uri.parse(link);
        if ("allinone".equals(uri.getScheme()) && "pair".equals(uri.getHost())) pair(uri);
        else toast("二维码无效");
      });
    }
  }
}
